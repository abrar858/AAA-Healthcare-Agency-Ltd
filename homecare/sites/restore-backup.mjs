import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { backupTables, checkManifest, snapshotDocuments } from './backups.mjs';

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
    requireBackup(!parts.has(path)&&size>0&&size<=16*1024*1024&&header[156]===48,'Unexpected backup archive entry.');
    parts.set(path,{size,offset:position+512});
    position+=512+Math.ceil(size/512)*512;
  }
  requireBackup(ended&&parts.has('manifest.json'),'The backup manifest or archive ending is missing.');
  return parts;
}

export function restoreBackup(archive,destination) {
  const output=resolve(destination);
  requireBackup(!existsSync(output),'Choose a new destination folder. Existing folders are never overwritten.');
  const fd=openSync(archive,'r');
  let created=false, db;
  try {
    const parts=collect(fd);
    const manifestPart=parts.get('manifest.json');
    const manifest=JSON.parse(exact(fd,manifestPart.size,manifestPart.offset).toString('utf8'));
    checkManifest(manifest,manifest.id);
    requireBackup(parts.size===manifest.parts.length+1,'Unexpected files in the backup.');
    const verified=part=>{
      const stored=parts.get(part.path);
      requireBackup(stored?.size===part.bytes,'Backup component is missing or the size changed.');
      const bytes=exact(fd,stored.size,stored.offset);
      requireBackup(hash(bytes)===part.sha256,'Backup checksum failed.');
      return bytes;
    };
    const snapshot=JSON.parse(verified(manifest.parts[0]).toString('utf8'));
    const paths=snapshotDocuments(snapshot);
    requireBackup(JSON.stringify(paths)===JSON.stringify(manifest.parts.slice(1).map(part=>part.path).sort()),'Database and document references do not match.');

    mkdirSync(output,{mode:0o700});
    created=true;
    mkdirSync(join(output,'documents','compliance'),{recursive:true,mode:0o700});
    for(const part of manifest.parts.slice(1)) {
      const bytes=verified(part);
      requireBackup(bytes.subarray(0,5).toString()==='%PDF-','A restored document is not a PDF.');
      writeFileSync(join(output,part.path),bytes,{mode:0o600,flag:'wx'});
    }

    const dbPath=join(output,'aaa-homecare.sqlite');
    writeFileSync(dbPath,'',{mode:0o600,flag:'wx'});
    db=new DatabaseSync(dbPath);
    for(const file of readdirSync(migrations).filter(name=>/^000[0-7]_.*\.sql$/.test(name)).sort()) db.exec(readFileSync(join(migrations,file),'utf8'));
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON; DELETE FROM aaa_workspace;');
    for(const name of backupTables) {
      const columns=db.prepare('PRAGMA table_info('+name+')').all().map(column=>column.name);
      const insert=db.prepare('INSERT INTO '+name+' ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')');
      for(const row of snapshot[name]) {
        const added=(name==='aaa_calendar'||name==='aaa_calendar_history')?['subject_type','subject_id']:name==='aaa_actions'?['completed_at']:[];
        requireBackup(row&&Object.keys(row).every(column=>columns.includes(column))&&columns.every(column=>Object.hasOwn(row,column)||added.includes(column)),
          'Database columns do not match the recovery schema.');
        insert.run(...columns.map(column=>row[column]??null));
      }
    }
    db.exec('COMMIT;');
    requireBackup(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0,'Database integrity check failed.');
    writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    return {id:manifest.id,tables:backupTables.length,documents:paths.length};
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
    requireBackup(process.argv.length===4,'Usage: node restore-backup.mjs <backup.tar> <new-private-folder>');
    console.log(JSON.stringify(restoreBackup(process.argv[2],process.argv[3])));
  } catch(error) {console.error('Recovery failed:',error.message);process.exitCode=1;}
}
