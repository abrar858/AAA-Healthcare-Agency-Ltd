// Built together with the shared domain, compliance rules and HTML by build.mjs.
const json = (body,status=200) => response(JSON.stringify(body),status,{'Content-Type':'application/json; charset=utf-8'});
function response(body,status=200,headers={}) {
  return new Response(body,{status,headers:{
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",...headers
  }});
}
function publicState(state,actor) {
  return {...domain.project(state,actor),compliance:compliance.complianceView(state,actor),assessment:assessments.assessmentView(state,actor),diary:diary.diaryView(actor),calendar:calendar.calendarView(actor),actions:actionList.actionsView(actor)};
}
const staffRoles=['manager','team_leader','hr','rota','accounts'];
const denied='This account has no access to the workspace.';
function memberOf(env,email) {
  return env.DB.prepare('SELECT email,label,role,branch,staff,identity_id,enabled,version FROM aaa_staff_access WHERE email=?').bind(email).first();
}
async function authenticate(request,env) {
  const id=request.headers.get('oai-authenticated-user-id');
  const email=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  domain.requireCondition(id && email,'Sign in to continue.',401);
  domain.requireCondition(env.AAA_OWNER_EMAIL,'Workspace sign-in is unavailable.',503);
  if (email===env.AAA_OWNER_EMAIL) return {calendarKey:id,actor:{label:'Head Office Admin',role:'admin',branch:null,staff:null}};
  let member=await memberOf(env,email);
  domain.requireCondition(member?.enabled && member.role!=='carer' && (!member.identity_id || member.identity_id===id),denied,403);
  if (!member.identity_id) {
    await env.DB.prepare('UPDATE OR IGNORE aaa_staff_access SET identity_id=? WHERE email=? AND enabled=1 AND identity_id IS NULL').bind(id,email).run();
    member=await memberOf(env,email);
  }
  domain.requireCondition(member?.enabled && member.role!=='carer' && member.identity_id===id,denied,403);
  const {label,role,branch,staff,version}=member;
  return {calendarKey:id,actor:{label,role,branch,staff},membership:{email,id,version}};
}
async function staffAccess(env) {
  const list=await env.DB.prepare('SELECT email,label,role,branch,staff,enabled,version,updated_at FROM aaa_staff_access ORDER BY enabled DESC, label COLLATE NOCASE, email').all();
  return list.results;
}
async function changeAccess(request,env) {
  domain.requireCondition(request.headers.get('content-type')?.split(';')[0]==='application/json','Use JSON for this request.',415);
  const body=await readJson(request,12000);
  const fields=body?.fields;
  const email=typeof fields?.email==='string'?fields.email.trim().toLowerCase():'';
  domain.requireCondition(email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Enter a valid sign-in email.');
  domain.requireCondition(email!==env.AAA_OWNER_EMAIL,'The site owner’s access is managed separately.');
  const version=Number(fields.version), at=new Date().toISOString();
  domain.requireCondition(Number.isSafeInteger(version) && version>=0,'Invalid access version.');
  let result;
  if (body.action==='revoke-access') {
    result=await env.DB.prepare('UPDATE aaa_staff_access SET enabled=0,version=version+1,updated_at=? WHERE email=? AND version=? AND enabled=1').bind(at,email,version).run();
  } else {
    domain.requireCondition(body.action==='save-access','Invalid access action.');
    const label=typeof fields.label==='string'?fields.label.trim():'';
    const {role,branch}=fields;
    const {state}=await workspace(env);
    domain.requireCondition(label && label.length<=100 && staffRoles.includes(role) && state.branches.includes(branch),'Enter a name, role and existing branch.');
    const staff=role==='carer'?fields.staff:null;
    domain.requireCondition(role!=='carer' || state.staff.some(person=>person.id===staff && person.branch===branch),'Link a carer to their staff record in the selected branch.');
    if(staff) {
      const existing=await env.DB.prepare('SELECT email FROM aaa_staff_access WHERE staff=? AND enabled=1 AND email<>?').bind(staff,email).first();
      domain.requireCondition(!existing,'This carer already has an active login.',409);
    }
    if(version===0) {
      result=await env.DB.prepare('INSERT OR IGNORE INTO aaa_staff_access (email,label,role,branch,staff,updated_at) VALUES (?,?,?,?,?,?)')
        .bind(email,label,role,branch,staff,at).run();
    } else {
      result=await env.DB.prepare('UPDATE OR IGNORE aaa_staff_access SET label=?,role=?,branch=?,staff=?,enabled=1,version=version+1,updated_at=? WHERE email=? AND version=?')
        .bind(label,role,branch,staff,at,email,version).run();
    }
  }
  domain.requireCondition(result.meta.changes===1,'This access entry changed. Refresh the page and try again.',409);
  return json(await staffAccess(env));
}
async function workspace(env) {
  const row=await env.DB.prepare('SELECT body, rev FROM aaa_workspace WHERE id=1').first();
  domain.requireCondition(row,'Workspace storage is unavailable.',503);
  return {state:JSON.parse(row.body),rev:row.rev};
}
async function readJson(request,limit) {
  const length=Number(request.headers.get('content-length'));
  domain.requireCondition(!length || length<=limit,'Request is too large.',413);
  const reader=request.body?.getReader();
  domain.requireCondition(reader,'Request body is required.');
  const decoder=new TextDecoder();
  let total=0, input='';
  for (;;) {
    const {done,value}=await reader.read();
    if (done) break;
    total+=value.byteLength;
    if (total>limit) {
      await reader.cancel();
      throw new domain.AppError(413,'Request is too large.');
    }
    input+=decoder.decode(value,{stream:true});
  }
  try { return JSON.parse(input+decoder.decode()); }
  catch { throw new domain.AppError(400,'Invalid JSON request.'); }
}
function parsePdf(value) {
  if (!value) return null;
  domain.requireCondition(typeof value==='string' && value.length<=6990510 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),'Invalid PDF upload.');
  let binary;
  try { binary=atob(value); } catch { throw new domain.AppError(400,'Invalid PDF upload.'); }
  domain.requireCondition(binary.length<=5*1024*1024 && binary.startsWith('%PDF-'),'Upload a PDF of up to 5 MB.');
  return Uint8Array.from(binary,char=>char.charCodeAt(0));
}
async function update(request,env,{actor,membership},isCompliance) {
  domain.requireCondition(request.headers.get('content-type')?.split(';')[0]==='application/json','Use JSON for this request.',415);
  const body=await readJson(request,isCompliance?7*1024*1024+12000:128*1024);
  domain.requireCondition(body && typeof body.action==='string' && typeof body.id==='string' && body.fields && typeof body.fields==='object' && !Array.isArray(body.fields),'Invalid action request.');
  const {action,id,fields}=body;
  domain.requireCondition((action==='save-compliance')===isCompliance,'Invalid action endpoint.');
  const {state,rev}=await workspace(env);
  let file, entry;
  if (isCompliance) {
    file=parsePdf(fields.pdf);
    entry=compliance.recordCompliance(state,actor,fields,file,domain.requireCondition);
  } else if (['add-assessment-template','archive-assessment-template','restore-assessment-template','save-assessment'].includes(action)) {
    assessments.changeAssessment(state,actor,action,id,fields,domain.requireCondition);
  } else domain.applyAction(state,actor,action,id,fields);
  const snapshot=JSON.stringify(state);
  domain.requireCondition(new TextEncoder().encode(snapshot).length<=1024*1024,'Workspace has reached its current storage limit.',507);
  if (file) await env.BUCKET.put('compliance/'+entry.id,file);
  const writeSql='UPDATE aaa_workspace SET body=?, rev=rev+1 WHERE id=1 AND rev=?';
  const result=membership
    ? await env.DB.prepare(writeSql+' AND EXISTS (SELECT 1 FROM aaa_staff_access WHERE email=? AND identity_id=? AND version=? AND enabled=1)')
      .bind(snapshot,rev,membership.email,membership.id,membership.version).run()
    : await env.DB.prepare(writeSql).bind(snapshot,rev).run();
  if (result.meta.changes!==1) {
    if (file) await env.BUCKET.delete('compliance/'+entry.id);
    throw new domain.AppError(409,'Another update was saved. Refresh the page and try again.');
  }
  return json(publicState(state,actor));
}

function backupJobAuthorised(request,env) {
  const given=request.headers.get('X-AAA-Backup-Key')||'', expected=env.AAA_BACKUP_SERVICE_KEY||'';
  if(expected.length<24||given.length!==expected.length) return false;
  let difference=0;
  for(let index=0;index<expected.length;index++) difference|=given.charCodeAt(index)^expected.charCodeAt(index);
  return difference===0;
}
async function createBackup(env,mode) {
  try {return json(await backups.takeBackup(env,mode),201);}
  catch(error) {
    console.error('Backup was not completed:',error.name);
    return json({error:'Backup failed. No incomplete backup was marked as verified.'},503);
  }
}

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    try {
      if(path==='/api/backup-job') {
        domain.requireCondition(backupJobAuthorised(request,env),'Backup service access denied.',403);
        if(request.method==='POST') return await createBackup(env,'scheduled');
        return json({error:'Method not allowed.'},405);
      }
      const auth=await authenticate(request,env);
      const {actor}=auth;
      if (request.method==='POST') domain.requireCondition(env.AAA_ORIGIN && request.headers.get('Origin')===env.AAA_ORIGIN,'Invalid request origin.',403);
      if (request.method==='POST' && path==='/logout') return response(null,303,{Location:'/signout-with-chatgpt?return_to=%2F'});
      if (path==='/api/backups'||path.startsWith('/api/backups/')) {
        domain.requireCondition(!auth.membership&&actor.role==='admin','Only Head Office Admin can access backups.',403);
        if(path==='/api/backups'&&request.method==='GET') return json(await backups.listBackups(env));
        if(path==='/api/backups'&&request.method==='POST') return await createBackup(env,'manual');
        if(request.method==='GET'&&path.endsWith('/download')) {
          const id=path.split('/')[3];
          domain.requireCondition(backups.validBackupId(id),'Backup not found.',404);
          const stream=await backups.openBackup(env,id);
          return response(stream,200,{'Content-Type':'application/x-tar','Content-Disposition':'attachment; filename="AAA-Homecare-'+id+'.tar"'});
        }
        return json({error:'Page not found.'},404);
      }
      if (path==='/api/access') {
        domain.requireCondition(!auth.membership,'Only the site owner can manage access.',403);
        if (request.method==='GET') return json(await staffAccess(env));
        if (request.method==='POST') return await changeAccess(request,env);
      }
      if (request.method==='GET' && path==='/') {
        const {state}=await workspace(env);
        const app=JSON.stringify({actor,db:publicState(state,actor),catalog:compliance.permittedCatalog(actor),site:true,backupAccess:!auth.membership&&actor.role==='admin',access:auth.membership?null:await staffAccess(env)}).replaceAll('<','\\u003c');
        const nonce=crypto.randomUUID().replaceAll('-','');
        return response(html.replace('<script>','<script nonce="'+nonce+'">').replace('const live = null;',()=> 'const live = '+app+';'),200,{
          'Content-Type':'text/html; charset=utf-8',
          'Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        });
      }
      if (request.method==='GET' && path==='/api/state') return json(publicState((await workspace(env)).state,actor));
      if (path==='/api/actions') {
        domain.requireCondition(actionList.actionsView(actor),'You do not have access to the action list.',403);
        const {state}=await workspace(env);
        const params=new URL(request.url).searchParams;
        const branch=params.get('branch')||actor.branch||'';
        domain.requireCondition(!branch||(state.branches.includes(branch)&&(!actor.branch||actor.branch===branch)),'You do not have access to this branch.',403);
        const people=await env.DB.prepare("SELECT email,label,role,branch FROM aaa_staff_access WHERE enabled=1 AND role IN ('manager','team_leader')"+(branch?' AND branch=?':'')).bind(...(branch?[branch]:[])).all();
        const owners=await actionList.ownerAliases(people.results);
        const definitions=compliance.permittedCatalog(actor);
        const automatic=()=>actionList.automaticActions(state,actor,definitions,branch);
        if(request.method==='GET') {
          const source=params.get('source');
          if(source) {
            domain.requireCondition(source.startsWith('diary:'),'Invalid diary follow-up.');
            const item=actionList.diaryAction(state,actor,await env.DB.prepare(diary.diaryEntrySql).bind(source.slice(6)).first());
            domain.requireCondition(item&&(!branch||item.branch===branch),'This action is unavailable.',404);
            return json(actionList.actionDetails(item,await env.DB.prepare(actionList.actionRowSql).bind(source).first(),owners));
          }
          const auto=automatic();
          const rowScope=branch?' WHERE branch=?':'';
          const args=branch?[branch]:[];
          const previous=(await env.DB.prepare(actionList.actionRowsSql+rowScope).bind(...args).all()).results;
          const rows=new Map(previous.map(item=>[item.source,item]));
          const defaults=auto.filter(item=>!item.due&&!rows.has(item.source)).map(actionList.defaultAction);
          for(let index=0;index<defaults.length;index+=200) {
            await env.DB.prepare(actionList.seedMissingSql).bind(new Date().toISOString(),JSON.stringify(defaults.slice(index,index+200))).run();
          }
          if(defaults.length) {
            for(const row of (await env.DB.prepare(actionList.actionRowsSql+rowScope).bind(...args).all()).results) rows.set(row.source,row);
          }
          const diaryRows=(await env.DB.prepare(actionList.diaryRowsSql+(branch?' WHERE d.branch=?':'')).bind(...args).all()).results;
          const manual=diaryRows.map(row=>actionList.diaryAction(state,actor,row)).filter(Boolean);
          return json([...auto,...manual].map(item=>actionList.actionDetails(item,rows.get(item.source),owners)));
        }
        if(request.method==='POST') {
          domain.requireCondition(request.headers.get('content-type')?.split(';')[0]==='application/json','Use JSON for this request.',415);
          const fields=await readJson(request,12000);
          domain.requireCondition(fields && typeof fields.source==='string' && fields.source.length<240,'Invalid action.');
          const item=fields.source.startsWith('diary:')?
            actionList.diaryAction(state,actor,await env.DB.prepare(diary.diaryEntrySql).bind(fields.source.slice(6)).first()):
            automatic().find(entry=>entry.source===fields.source);
          domain.requireCondition(item&&(!branch||item.branch===branch),'This action is unavailable.',404);
          const row=await env.DB.prepare(actionList.actionRowSql).bind(item.source).first();
          const update=actionList.updateAction(item,row,fields,owners,actor,domain.requireCondition);
          const membership=auth.membership;
          const condition=(row?' AND':' WHERE')+' EXISTS (SELECT 1 FROM aaa_staff_access WHERE email=? AND identity_id=? AND version=? AND enabled=1)';
          const result=membership?await env.DB.prepare(update.sql+condition).bind(...update.args,membership.email,membership.id,membership.version).run():
            await env.DB.prepare(update.sql).bind(...update.args).run();
          domain.requireCondition(result.meta.changes===1,'Your access or this action changed. Reload and try again.',409);
          return json({source:item.source});
        }
      }
      if (path==='/api/calendar') {
        domain.requireCondition(calendar.calendarView(actor),'You do not have access to this calendar.',403);
        const {state}=await workspace(env);
        const key=auth.calendarKey;
        if(request.method==='GET') {
          const params=new URL(request.url).searchParams;
          if(params.has('history')) {
            const row=await env.DB.prepare(calendar.calendarReadSql).bind(params.get('history')).first();
            domain.requireCondition(calendar.canReadCalendar(actor,key,row)&&row.owner_key===key,'Calendar history not found.',404);
            return json((await env.DB.prepare(calendar.calendarHistorySql).bind(row.id).all()).results);
          }
          const query=calendar.calendarQuery(state,actor,key,params,domain.requireCondition);
          const result=await Promise.all([query.events,query.reminders].map(item=>env.DB.prepare(item.sql).bind(...item.args).all()));
          const [events,reminders]=result.map(queryResult=>queryResult.results.map(row=>calendar.calendarEntry(actor,key,row)));
          return json(calendar.calendarPayload(events,reminders,compliance.complianceCalendar(state,actor,query)));
        }
        if(request.method==='POST') {
          domain.requireCondition(request.headers.get('content-type')?.split(';')[0]==='application/json','Use JSON for this request.',415);
          const body=await readJson(request,24000);
          domain.requireCondition(body && typeof body==='object' && !Array.isArray(body) && (!body.id||typeof body.id==='string'),'Invalid calendar item.');
          const prior=body.id?await env.DB.prepare(calendar.calendarReadSql).bind(body.id).first():null;
          const event=calendar.prepareCalendar(state,actor,key,body,prior,domain.requireCondition);
          const membership=auth.membership;
          const condition=(prior?' AND':' WHERE')+' EXISTS (SELECT 1 FROM aaa_staff_access WHERE email=? AND identity_id=? AND version=? AND enabled=1)';
          const result=membership
            ?await env.DB.prepare(event.sql+condition).bind(...event.args,membership.email,membership.id,membership.version).run()
            :await env.DB.prepare(event.sql).bind(...event.args).run();
          domain.requireCondition(result.meta.changes===1,'Your access or this event changed. Reload and try again.',409);
          return json({id:event.id},prior?200:201);
        }
      }
      if (path==='/api/diary') {
        domain.requireCondition(diary.diaryView(actor),'You do not have access to this diary.',403);
        const {state}=await workspace(env);
        if (request.method==='GET') {
          const params=new URL(request.url).searchParams;
          if(params.has('entry')) {
            const record=await env.DB.prepare(diary.diaryEntrySql).bind(params.get('entry')).first();
            domain.requireCondition(diary.canReadDiaryEntry(actor,record),'Diary entry not found.',404);
            return json(record);
          }
          const query=diary.diaryListQuery(state,actor,params,domain.requireCondition);
          return json(diary.diaryList((await env.DB.prepare(query.sql).bind(...query.values).all()).results));
        }
        if (request.method==='POST') {
          domain.requireCondition(request.headers.get('content-type')?.split(';')[0]==='application/json','Use JSON for this request.',415);
          const fields=await readJson(request,24000);
          domain.requireCondition(fields && typeof fields==='object' && !Array.isArray(fields) && (!fields.related || typeof fields.related==='string'),'Invalid diary entry.');
          const parent=fields.related?await env.DB.prepare(diary.diaryEntrySql).bind(fields.related).first():null;
          const entry=diary.prepareDiaryEntry(state,actor,fields,parent,domain.requireCondition);
          const membership=auth.membership;
          const result=membership
            ? await env.DB.prepare(diary.diaryInsertSql+' WHERE EXISTS (SELECT 1 FROM aaa_staff_access WHERE email=? AND identity_id=? AND version=? AND enabled=1)')
              .bind(...entry,membership.email,membership.id,membership.version).run()
            : await env.DB.prepare(diary.diaryInsertSql).bind(...entry).run();
          domain.requireCondition(result.meta.changes===1,'Your access changed. Reload and try again.',403);
          return json({id:entry[0]},201);
        }
      }
      const assessmentId=/^\/api\/assessment-document\/([a-f0-9-]{36})$/.exec(path)?.[1];
      if (request.method==='GET' && assessmentId) {
        const {state}=await workspace(env);
        const record=assessments.assessmentView(state,actor)?.records.find(item=>item.id===assessmentId&&item.completedAt);
        domain.requireCondition(record,'Assessment not found.',404);
        const preview=new URL(request.url).searchParams.get('view')==='1';
        const nonce=preview?crypto.randomUUID().replaceAll('-',''):'';
        return response(assessments.assessmentDocument(record,nonce),200,{
          'Content-Type':'text/html; charset=utf-8',
          'Content-Disposition':preview?'inline':'attachment; filename="aaa-assessment-'+record.id+'.html"',
          'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"+(nonce?"; script-src 'nonce-"+nonce+"'":"")
        });
      }
      const pdfId=/^\/api\/compliance-pdf\/([a-f0-9-]{36})$/.exec(path)?.[1];
      if (request.method==='GET' && pdfId) {
        const {state}=await workspace(env);
        const entry=compliance.complianceView(state,actor).find(item=>item.id===pdfId && item.hasPdf);
        const file=entry && await env.BUCKET.get('compliance/'+pdfId);
        domain.requireCondition(file,'Document not found.',404);
        return response(file.body,200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="compliance-evidence.pdf"'});
      }
      if (request.method==='POST' && ['/api/action','/api/compliance'].includes(path)) return await update(request,env,auth,path==='/api/compliance');
      return json({error:'Page not found.'},404);
    } catch(error) {
      if (error.status===401 && path==='/') return response(null,303,{Location:'/signin-with-chatgpt?return_to=%2F'});
      if (!(error instanceof domain.AppError)) console.error('Homecare request failed',error.name);
      return json({error:error instanceof domain.AppError?error.message:'The request could not be completed.'},error instanceof domain.AppError?error.status:500);
    }
  }
};
