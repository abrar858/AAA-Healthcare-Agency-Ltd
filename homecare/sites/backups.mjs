const prefix='backups/v1/';
const encoder=new TextEncoder(), decoder=new TextDecoder('utf-8',{fatal:true});
const maxMetadata=16*1024*1024, maxDocument=5*1024*1024;
export const backupTables=['aaa_workspace','aaa_staff_access','aaa_diary','aaa_calendar','aaa_calendar_history','aaa_actions'];
export const validBackupId=id=>typeof id==='string'&&/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export const validDocumentPath=path=>typeof path==='string'&&/^documents\/compliance\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pdf$/.test(path);
const shaPattern=/^[a-f0-9]{64}$/;
export const validRecoveryKey=value=>typeof value==='string'&&shaPattern.test(value);
export const exportPartData=(id,path)=>encoder.encode('AAA encrypted export v1:'+id+':'+path);
const requireBackup=(condition,message)=>{if(!condition) throw new Error(message);};
function jsonBytes(value) {return encoder.encode(JSON.stringify(value));}
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
}
async function keyOf(secret) {
  requireBackup(validRecoveryKey(secret),'Backup encryption is not configured.');
  const raw=Uint8Array.from(secret.match(/../g),pair=>parseInt(pair,16));
  return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
function dataKey(id,path) {return prefix+'snapshots/'+id+'/'+path;}
function indexKey(id) {return prefix+'index/'+id+'.json';}
function partData(id,path) {return encoder.encode('AAA backup v1:'+id+':'+path);}
async function encryptPart(key,data,bytes) {
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:data},key,bytes));
  const packed=new Uint8Array(12+encrypted.length);
  packed.set(nonce);packed.set(encrypted,12);
  return packed;
}
async function storePart(bucket,key,id,path,bytes) {
  await bucket.put(dataKey(id,path),await encryptPart(key,partData(id,path),bytes));
}
async function readPart(bucket,key,id,path,limit) {
  const object=await bucket.get(dataKey(id,path));
  requireBackup(object&&object.size>=28&&object.size<=limit+28,'A backup component is missing or invalid.');
  const packed=new Uint8Array(await object.arrayBuffer());
  return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:packed.subarray(0,12),additionalData:partData(id,path)},key,packed.subarray(12)));
}
export function snapshotDocuments(snapshot) {
  requireBackup(snapshot&&backupTables.every(name=>Array.isArray(snapshot[name]))&&Object.keys(snapshot).length===backupTables.length,'Unexpected backup tables.');
  requireBackup(snapshot.aaa_workspace.length===1&&snapshot.aaa_workspace[0].id===1,'Workspace record is missing.');
  const workspace=JSON.parse(snapshot.aaa_workspace[0].body);
  requireBackup(workspace&&Array.isArray(workspace.clients)&&Array.isArray(workspace.staff),'Workspace record is invalid.');
  const paths=(workspace.compliance??[]).filter(item=>item.hasPdf).map(item=>'documents/compliance/'+item.id+'.pdf');
  requireBackup(paths.every(validDocumentPath),'A document reference is invalid.');
  return [...new Set(paths)].sort();
}
export function checkManifest(manifest,id) {
  requireBackup(manifest?.format==='aaa-homecare-backup-v1'&&manifest.id===id&&validBackupId(id)&&Array.isArray(manifest.parts),'Backup manifest is invalid.');
  const [database,...documents]=manifest.parts;
  requireBackup(database?.path==='database.json'&&documents.every(part=>validDocumentPath(part.path))&&
    new Set(manifest.parts.map(part=>part.path)).size===manifest.parts.length,'Backup paths are invalid.');
  for(const part of manifest.parts) {
    const limit=part.path==='database.json'?maxMetadata:maxDocument;
    requireBackup(Number.isSafeInteger(part.bytes)&&part.bytes>0&&part.bytes<=limit&&typeof part.sha256==='string'&&shaPattern.test(part.sha256),'Backup part details are invalid.');
  }
  return manifest;
}
async function readManifest(env,id,key) {
  requireBackup(validBackupId(id),'Invalid backup reference.');
  const bytes=await readPart(env.BUCKET,key,id,'manifest.json',maxMetadata);
  return {manifest:checkManifest(JSON.parse(decoder.decode(bytes)),id),bytes};
}
async function checkPart(env,key,id,part) {
  const bytes=await readPart(env.BUCKET,key,id,part.path,part.bytes);
  requireBackup(bytes.length===part.bytes&&await sha256(bytes)===part.sha256,'A backup component failed verification.');
  return bytes;
}
export async function takeBackup(env,mode) {
  const bucket=env.BUCKET;
  const createdAt=new Date().toISOString();
  const day=createdAt.slice(0,10);
  const dailyKey=prefix+'daily/'+day+'.json';
  if(mode==='scheduled') {
    const existing=await bucket.get(dailyKey);
    if(existing) {
      const previous=await existing.json();
      if(validBackupId(previous.id)&&await bucket.head(indexKey(previous.id))) return {...previous,reused:true};
    }
  }
  const id=createdAt.slice(0,19).replace(/[-:]/g,'')+'Z-'+crypto.randomUUID();
  const key=await keyOf(env.AAA_BACKUP_ENCRYPTION_KEY);
  // D1 batch reads all tables in one database transaction.
  const result=await env.DB.batch(backupTables.map(name=>env.DB.prepare('SELECT * FROM '+name)));
  const snapshot=Object.fromEntries(backupTables.map((name,index)=>[name,result[index].results]));
  const documents=snapshotDocuments(snapshot);
  const database=jsonBytes(snapshot);
  requireBackup(database.length<=maxMetadata,'The database exceeds the backup size limit.');
  const parts=[], written=[];
  let published=false;
  async function write(path,bytes) {
    const part={path,bytes:bytes.length,sha256:await sha256(bytes)};
    written.push(dataKey(id,path));
    await storePart(bucket,key,id,path,bytes);
    parts.push(part);
  }
  try {
    await write('database.json',database);
    for(const path of documents) {
      const liveKey=path.slice('documents/'.length,-'.pdf'.length);
      const source=await bucket.get(liveKey);
      requireBackup(source&&source.size>0&&source.size<=maxDocument,'A source document is missing or invalid.');
      const bytes=new Uint8Array(await source.arrayBuffer());
      requireBackup(decoder.decode(bytes.subarray(0,5))==='%PDF-','A source document is not a PDF.');
      await write(path,bytes);
    }
    const manifest={format:'aaa-homecare-backup-v1',id,createdAt,parts};
    written.push(dataKey(id,'manifest.json'));
    await storePart(bucket,key,id,'manifest.json',jsonBytes(manifest));
    const readback=await readManifest(env,id,key);
    for(const part of readback.manifest.parts) await checkPart(env,key,id,part);
    const summary={id,createdAt,verifiedAt:new Date().toISOString(),documents:documents.length,tables:backupTables.length,
      bytes:parts.reduce((sum,part)=>sum+part.bytes,0),mode};
    await bucket.put(indexKey(id),JSON.stringify(summary));
    published=true;
    if(mode==='scheduled') await bucket.put(dailyKey,JSON.stringify(summary));
    return summary;
  } catch(error) {
    if(!published) {
      for(let index=0;index<written.length;index+=100) {
        try {await bucket.delete(written.slice(index,index+100));} catch { /* Incomplete snapshots stay unlisted. */ }
      }
    }
    throw error;
  }
}
export async function listBackups(env) {
  const bucket=env.BUCKET, records=[];
  let cursor;
  do {
    const page=await bucket.list({prefix:prefix+'index/',limit:1000,...(cursor?{cursor}:{})});
    records.push(...page.objects);
    cursor=page.truncated?page.cursor:undefined;
  } while(cursor);
  const newest=records.sort((a,b)=>b.key.localeCompare(a.key)).slice(0,30);
  return (await Promise.all(newest.map(async row=>(await bucket.get(row.key))?.json()))).filter(Boolean);
}
function tarHeader(path,size) {
  const header=new Uint8Array(512);
  const put=(offset,text)=>header.set(encoder.encode(text),offset);
  const octal=(number,width)=>number.toString(8).padStart(width-1,'0')+'\0';
  put(0,path);put(100,'0000600\0');put(108,'0000000\0');put(116,'0000000\0');
  put(124,octal(size,12));put(136,octal(0,12));put(148,'        ');put(156,'0');
  put(257,'ustar\0');put(263,'00');
  put(148,header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ');
  return header;
}
export async function openBackup(env,id,recoveryKey,scopeSnapshot=null,branch=null) {
  requireBackup(validBackupId(id)&&await env.BUCKET.head(indexKey(id)),'Backup not found.');
  const storageKey=await keyOf(env.AAA_BACKUP_ENCRYPTION_KEY);
  const exportKey=await keyOf(recoveryKey);
  const {manifest}=await readManifest(env,id,storageKey);
  const database=await checkPart(env,storageKey,id,manifest.parts[0]);
  const exportDatabase=scopeSnapshot?jsonBytes(scopeSnapshot(JSON.parse(decoder.decode(database)))):database;
  const paths=new Set(snapshotDocuments(JSON.parse(decoder.decode(exportDatabase))));
  const documents=manifest.parts.slice(1).filter(part=>paths.has(part.path));
  requireBackup(documents.length===paths.size,'A backup document is missing.');
  const exportManifest={...manifest,...(branch?{branch}:{}),parts:[
    {path:'database.json',bytes:exportDatabase.length,sha256:await sha256(exportDatabase)},...documents
  ]};
  checkManifest(exportManifest,id);
  const manifestBytes=jsonBytes(exportManifest);
  requireBackup(manifestBytes.length<=maxMetadata,'The export manifest exceeds the backup size limit.');

  function* file(path,body) {
    yield tarHeader(path,body.length);
    yield body;
    const pad=(512-body.length%512)%512;
    if(pad) yield new Uint8Array(pad);
  }
  async function* tar() {
    const manifestPath='encrypted/'+id;
    yield* file(manifestPath,await encryptPart(exportKey,exportPartData(id,manifestPath),manifestBytes));
    for(const [index,part] of exportManifest.parts.entries()) {
      const path='parts/'+index+'.aesgcm';
      const bytes=index===0?exportDatabase:await checkPart(env,storageKey,id,part);
      yield* file(path,await encryptPart(exportKey,exportPartData(id,path),bytes));
    }
    yield new Uint8Array(1024);
  }
  const chunks=tar();
  return new ReadableStream({async pull(controller){
    try {
      const next=await chunks.next();
      if(next.done) controller.close(); else controller.enqueue(next.value);
    } catch(error) {controller.error(error);}
  },cancel(){return chunks.return();}});
}
