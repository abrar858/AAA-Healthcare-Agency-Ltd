import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { backupTables, checkManifest, exportPartData, snapshotDocuments, validBackupId, validRecoveryKey } from './backups.mjs';

const migrations=fileURLToPath(new URL('./drizzle/',import.meta.url));
function requireBackup(condition,message) {if(!condition) throw new Error(message);}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function exact(fd,length,position) {
  const bytes=Buffer.allocUnsafe(length);
  let read=0;
  while(read<length) {
    const count=readSync(fd,bytes,read,length-read,position+read);
    requireBackup(count>0,'The backup archive is incomplete.');
    read+=count;
  }
  return bytes;
}
function collect(fd) {
  const limit=fstatSync(fd).size, parts=new Map();
  let position=0, ended=false;
  while(position+512<=limit) {
    const header=exact(fd,512,position);
    if(header.every(byte=>byte===0)) {
      requireBackup(position+1024===limit&&exact(fd,512,position+512).every(byte=>byte===0),'The backup has an invalid ending.');
      ended=true;
      break;
    }
    const path=header.subarray(0,100).toString('ascii').split('\0')[0];
    const octal=header.subarray(124,136).toString('ascii').trim().replace(/\0.*$/,'');
    const size=/^[0-7]+$/.test(octal)?parseInt(octal,8):-1;
    requireBackup(!parts.has(path)&&size>0&&size<=16*1024*1024+28&&header[156]===48,'Unexpected backup archive entry.');
    parts.set(path,{size,offset:position+512});
    position+=512+Math.ceil(size/512)*512;
  }
  requireBackup(ended&&parts.size>0,'The backup manifest or archive ending is missing.');
  return parts;
}

function decryptExportPart(fd,part,key,id,path) {
  requireBackup(part&&part.size>=28,'Encrypted backup component is missing or invalid.');
  const packed=exact(fd,part.size,part.offset);
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,packed.subarray(0,12),{authTagLength:16});
    decipher.setAAD(exportPartData(id,path));
    decipher.setAuthTag(packed.subarray(-16));
    return Buffer.concat([decipher.update(packed.subarray(12,-16)),decipher.final()]);
  } catch {
    throw new Error('Backup authentication failed. Check the recovery key and archive integrity.');
  }
}

export function restoreBackup(archive,destination,recoveryKey=process.env.AAA_BACKUP_RECOVERY_KEY) {
  const output=resolve(destination);
  requireBackup(!existsSync(output),'Choose a new destination folder. Existing folders are never overwritten.');
  const fd=openSync(archive,'r');
  let created=false, db;
  try {
    const parts=collect(fd);
    const first=parts.keys().next().value;
    const encrypted=first.startsWith('encrypted/');
    const id=encrypted?first.slice('encrypted/'.length):null;
    if(encrypted) {
      requireBackup(validBackupId(id),'The encrypted backup reference is invalid.');
      requireBackup(validRecoveryKey(recoveryKey),'Set AAA_BACKUP_RECOVERY_KEY to the recovery key saved for this download.');
    }
    const key=encrypted?Buffer.from(recoveryKey,'hex'):null;
    const readPart=path=>{
      const stored=parts.get(path);
      requireBackup(stored,'Backup component is missing.');
      return encrypted?decryptExportPart(fd,stored,key,id,path):exact(fd,stored.size,stored.offset);
    };
    const manifest=JSON.parse(readPart(encrypted?first:'manifest.json').toString('utf8'));
    checkManifest(manifest,id??manifest.id);
    requireBackup(parts.size===manifest.parts.length+1,'Unexpected files in the backup.');
    const verified=(part,index)=>{
      const bytes=readPart(encrypted?'parts/'+index+'.aesgcm':part.path);
      requireBackup(bytes.length===part.bytes&&hash(bytes)===part.sha256,'Backup checksum failed.');
      return bytes;
    };
    const snapshot=JSON.parse(verified(manifest.parts[0],0).toString('utf8'));
    const paths=snapshotDocuments(snapshot);
    requireBackup(JSON.stringify(paths)===JSON.stringify(manifest.parts.slice(1).map(part=>part.path).sort()),'Database and document references do not match.');

    mkdirSync(output,{mode:0o700});
    created=true;
    mkdirSync(join(output,'documents','compliance'),{recursive:true,mode:0o700});
    for(const [index,part] of manifest.parts.slice(1).entries()) {
      const bytes=verified(part,index+1);
      requireBackup(bytes.subarray(0,5).toString()==='%PDF-','A restored document is not a PDF.');
      writeFileSync(join(output,part.path),bytes,{mode:0o600,flag:'wx'});
    }

    const dbPath=join(output,'aaa-homecare.sqlite');
    writeFileSync(dbPath,'',{mode:0o600,flag:'wx'});
    db=new DatabaseSync(dbPath);
    for(const file of readdirSync(migrations).filter(name=>/^000[0-79]_.*\.sql$/.test(name)).sort()) db.exec(readFileSync(join(migrations,file),'utf8'));
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON; DELETE FROM aaa_workspace;');
    for(const name of backupTables) {
      const columns=db.prepare('PRAGMA table_info('+name+')').all().map(column=>column.name);
      const insert=db.prepare('INSERT INTO '+name+' ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')');
      for(const row of snapshot[name]??[]) {
        const added=(name==='aaa_calendar'||name==='aaa_calendar_history')?['subject_type','subject_id']:name==='aaa_actions'?['completed_at']:[];
        requireBackup(row&&Object.keys(row).every(column=>columns.includes(column))&&columns.every(column=>Object.hasOwn(row,column)||added.includes(column)),
          'Database columns do not match the recovery schema.');
        insert.run(...columns.map(column=>row[column]??null));
      }
    }
    db.exec('COMMIT;');
    requireBackup(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0,'Database integrity check failed.');
    writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    return {id:manifest.id,...(manifest.branch?{branch:manifest.branch}:{}),tables:Object.keys(snapshot).length,documents:paths.length};
  } catch(error) {
    if(db) {db.close();db=null;}
    if(created) rmSync(output,{recursive:true,force:true});
    throw error;
  } finally {
    if(db) db.close();
    closeSync(fd);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const fromStdin=process.argv.length===5&&process.argv[4]==='--key-stdin';
    requireBackup(process.argv.length===4||fromStdin,
      'Usage: node restore-backup.mjs <backup.aaa.tar> <new-private-folder> [--key-stdin]');
    const key=fromStdin?readFileSync(0,'utf8').trim():undefined;
    console.log(JSON.stringify(restoreBackup(process.argv[2],process.argv[3],key)));
  } catch(error) {console.error('Recovery failed:',error.message);process.exitCode=1;}
}
