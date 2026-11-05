// Built together with the shared domain, compliance rules and HTML by build.mjs.
const json = (body,status=200) => response(JSON.stringify(body),status,{'Content-Type':'application/json; charset=utf-8'});
function response(body,status=200,headers={}) {
  return new Response(body,{status,headers:{
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",...headers
  }});
}
function publicState(state,actor) {
  return {...domain.project(state,actor),compliance:compliance.complianceView(state,actor),assessment:assessments.assessmentView(state,actor),diary:diary.diaryView(actor),calendar:calendar.calendarView(actor),actions:actionList.actionsView(actor),people:people.peopleView(actor),reports:reports.reportsView(actor)};
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
  if (email===env.AAA_OWNER_EMAIL) return {calendarKey:id,actorEmail:email,actor:{label:'Head Office Admin',role:'admin',branch:null,staff:null}};
  let member=await memberOf(env,email);
  domain.requireCondition(member?.enabled && member.role!=='carer' && (!member.identity_id || member.identity_id===id),denied,403);
  if (!member.identity_id) {
    await env.DB.prepare('UPDATE OR IGNORE aaa_staff_access SET identity_id=? WHERE email=? AND enabled=1 AND identity_id IS NULL').bind(id,email).run();
    member=await memberOf(env,email);
  }
  domain.requireCondition(member?.enabled && member.role!=='carer' && member.identity_id===id,denied,403);
  const {label,role,branch,staff,version}=member;
  return {calendarKey:id,actorEmail:email,actor:{label,role,branch,staff},membership:{email,id,version}};
}
const auditColumns='id,occurred_at,actor_email,actor_label,actor_role,action,branch,target_id';
function auditStatement(env,{actor,actorEmail},action,branch=null,target=null,afterChange=false) {
  return env.DB.prepare('INSERT INTO aaa_access_log (occurred_at,actor_email,actor_label,actor_role,action,branch,target_id) '+
    'SELECT ?,?,?,?,?,?,?'+(afterChange?' WHERE changes()=1':''))
    .bind(new Date().toISOString(),actorEmail,actor.label,actor.role,action,branch,target);
}
async function recordAccess(env,auth,action,branch,target) {
  await auditStatement(env,auth,action,branch,target).run();
}
async function readAccessLog(env,auth,params) {
  const cursor=params.get('before');
  const before=cursor===null?null:Number(cursor);
  domain.requireCondition(cursor===null||(/^\d+$/.test(cursor)&&Number.isSafeInteger(before)&&before>0),'Invalid access log cursor.');
  const query='SELECT '+auditColumns+' FROM aaa_access_log'+(before===null?'':' WHERE id < ?')+' ORDER BY id DESC LIMIT 51';
  const statement=env.DB.prepare(query);
  const {results}=await (before===null?statement:statement.bind(before)).all();
  const entries=results.slice(0,50);
  await recordAccess(env,auth,'access_log_viewed');
  return json({entries,nextBefore:results.length>50?entries.at(-1).id:null});
}
async function staffAccess(env) {
  const list=await env.DB.prepare('SELECT email,label,role,branch,staff,enabled,version,updated_at FROM aaa_staff_access ORDER BY enabled DESC, label COLLATE NOCASE, email').all();
  return list.results;
}
async function changeAccess(request,env,auth) {
  domain.requireCondition(request.headers.get('content-type')?.split(';')[0]==='application/json','Use JSON for this request.',415);
  const body=await readJson(request,12000);
  const fields=body?.fields;
  const email=typeof fields?.email==='string'?fields.email.trim().toLowerCase():'';
  domain.requireCondition(email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Enter a valid sign-in email.');
  domain.requireCondition(email!==env.AAA_OWNER_EMAIL,'The site owner’s access is managed separately.');
  const version=Number(fields.version), at=new Date().toISOString();
  domain.requireCondition(Number.isSafeInteger(version) && version>=0,'Invalid access version.');
  let mutation, event, branch;
  if (body.action==='revoke-access') {
    branch=(await memberOf(env,email))?.branch;
    event='staff_access_revoked';
    mutation=env.DB.prepare('UPDATE aaa_staff_access SET enabled=0,version=version+1,updated_at=? WHERE email=? AND version=? AND enabled=1').bind(at,email,version);
  } else {
    domain.requireCondition(body.action==='save-access','Invalid access action.');
    const label=typeof fields.label==='string'?fields.label.trim():'';
    const {role}=fields;
    branch=fields.branch;
    event=version===0?'staff_access_granted':'staff_access_updated';
    const {state}=await workspace(env);
    domain.requireCondition(label && label.length<=100 && staffRoles.includes(role) && state.branches.includes(branch),'Enter a name, role and existing branch.');
    const staff=role==='carer'?fields.staff:null;
    domain.requireCondition(role!=='carer' || state.staff.some(person=>person.id===staff && person.branch===branch),'Link a carer to their staff record in the selected branch.');
    if(staff) {
      const existing=await env.DB.prepare('SELECT email FROM aaa_staff_access WHERE staff=? AND enabled=1 AND email<>?').bind(staff,email).first();
      domain.requireCondition(!existing,'This carer already has an active login.',409);
    }
    if(version===0) {
      mutation=env.DB.prepare('INSERT OR IGNORE INTO aaa_staff_access (email,label,role,branch,staff,updated_at) VALUES (?,?,?,?,?,?)')
        .bind(email,label,role,branch,staff,at);
    } else {
      mutation=env.DB.prepare('UPDATE OR IGNORE aaa_staff_access SET label=?,role=?,branch=?,staff=?,enabled=1,version=version+1,updated_at=? WHERE email=? AND version=?')
        .bind(label,role,branch,staff,at,email,version);
    }
  }
  const [result]=await env.DB.batch([mutation,auditStatement(env,auth,event,branch??null,email,true)]);
  domain.requireCondition(result.meta.changes===1,'This access entry changed. Refresh the page and try again.',409);
  return json(await staffAccess(env));
}
async function workspace(env) {
  const row=await env.DB.prepare('SELECT body, rev FROM aaa_workspace WHERE id=1').first();
  domain.requireCondition(row,'Workspace storage is unavailable.',503);
  return {state:JSON.parse(row.body),rev:row.rev};
}
async function readRequestText(request,limit) {
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
  return input+decoder.decode();
}
async function readJson(request,limit) {
  const input=await readRequestText(request,limit);
  try { return JSON.parse(input); }
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

function managerBackupSnapshot(snapshot,{actor,calendarKey},current,visibleEventIds) {
  const {branch}=actor;
  const [workspace]=snapshot.aaa_workspace;
  const state=JSON.parse(workspace.body);
  const projected=domain.project(state,actor);
  const local=item=>item.branch===branch;
  const currentClientIds=new Set(current.clients.filter(local).map(person=>person.id));
  const currentStaffIds=new Set(current.staff.filter(local).map(person=>person.id));
  const clients=projected.clients.filter(person=>currentClientIds.has(person.id));
  const clientIds=new Set(clients.map(person=>person.id));
  const staff=projected.staff.filter(person=>local(person)&&currentStaffIds.has(person.id));
  const staffIds=new Set(staff.map(person=>person.id));
  const visibleSubject=(type,id)=>(type==='client'?clientIds:staffIds).has(id);
  const body={
    branches:[branch],clients,patches:projected.patches,staff,
    visits:projected.visits.filter(visit=>local(visit)&&clientIds.has(visit.client)).map(visit=>({...visit,
      assignments:visit.assignments.filter(assignment=>staffIds.has(assignment.staff))})),
    requests:[],audit:[],
    compliance:compliance.complianceView(state,actor).filter(item=>visibleSubject(item.type,item.subject)),
    assessments:assessments.assessmentView(state,actor).records.filter(item=>visibleSubject(item.template.subject,item.subject)),
    assessmentTemplates:(state.assessmentTemplates??[]).filter(item=>!item.branch||local(item))
  };
  const events=snapshot.aaa_calendar.filter(event=>visibleEventIds.has(event.id)&&calendar.canReadCalendar(actor,calendarKey,event)&&
    (!event.subject_id||visibleSubject(event.subject_type,event.subject_id)));
  return {
    aaa_workspace:[{...workspace,body:JSON.stringify(body)}],
    aaa_staff_access:[],
    aaa_diary:snapshot.aaa_diary.filter(entry=>local(entry)&&visibleSubject(entry.type,entry.subject)),
    aaa_calendar:events.map(event=>({...event,owner_key:event.owner_key===calendarKey?calendarKey:''})),
    aaa_calendar_history:[],
    aaa_actions:[],
    aaa_access_log:[]
  };
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
        const isAdmin=!auth.membership&&actor.role==='admin';
        const isManager=actor.role==='manager'&&Boolean(actor.branch);
        domain.requireCondition(isAdmin||isManager,'Only Head Office Admin and branch managers can access backups.',403);
        if(path==='/api/backups'&&request.method==='GET') {
          const entries=await backups.listBackups(env);
          return json(isAdmin?entries:entries.map(({id,createdAt,verifiedAt,mode})=>({id,createdAt,verifiedAt,mode})));
        }
        if(path==='/api/backups'&&request.method==='POST') {
          domain.requireCondition(isAdmin,'Only Head Office Admin can create a backup.',403);
          return await createBackup(env,'manual');
        }
        const id=/^\/api\/backups\/([^/]+)\/download$/.exec(path)?.[1];
        if(id) {
          if(request.method!=='POST') return json({error:'Use the encrypted download form.'},405);
          domain.requireCondition(backups.validBackupId(id),'Backup not found.',404);
          domain.requireCondition(request.headers.get('content-type')?.split(';')[0]==='application/x-www-form-urlencoded','Use the encrypted download form.',415);
          const fields=new URLSearchParams(await readRequestText(request,256));
          const key=fields.get('recovery_key');
          domain.requireCondition(backups.validRecoveryKey(key),'A valid recovery key is required.');
          let scopeSnapshot=null;
          if(isManager) {
            const [{state},events]=await Promise.all([
              workspace(env),
              env.DB.prepare("SELECT id FROM aaa_calendar WHERE branch=? AND (owner_key=? OR audience='branch')")
                .bind(actor.branch,auth.calendarKey).all()
            ]);
            const visibleEventIds=new Set(events.results.map(event=>event.id));
            scopeSnapshot=snapshot=>managerBackupSnapshot(snapshot,auth,state,visibleEventIds);
          }
          const stream=await backups.openBackup(env,id,key,scopeSnapshot,isManager?actor.branch:null);
          await recordAccess(env,auth,'backup_download_started',actor.branch,id);
          return response(stream,200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="AAA-Homecare-'+(isManager?'Branch-':'')+id+'.aaa.tar"'});
        }
        return json({error:'Page not found.'},404);
      }
      if(path==='/api/access-log'&&request.method==='GET') {
        domain.requireCondition(actor.role==='admin'&&!auth.membership,'Only Head Office Admin can view the access log.',403);
        return await readAccessLog(env,auth,new URL(request.url).searchParams);
      }
      if (path==='/api/access') {
        domain.requireCondition(!auth.membership,'Only the site owner can manage access.',403);
        if (request.method==='GET') {
          const entries=await staffAccess(env);
          await recordAccess(env,auth,'staff_access_viewed');
          return json(entries);
        }
        if (request.method==='POST') return await changeAccess(request,env,auth);
      }
      if (request.method==='GET' && path==='/') {
        const {state}=await workspace(env);
        const app=JSON.stringify({actor,db:publicState(state,actor),catalog:compliance.permittedCatalog(actor),site:true,backupAccess:actor.role==='admin'||actor.role==='manager',access:auth.membership?null:await staffAccess(env)}).replaceAll('<','\\u003c');
        await recordAccess(env,auth,'workspace_viewed',actor.branch);
        const nonce=crypto.randomUUID().replaceAll('-','');
        return response(html.replace('<script>','<script nonce="'+nonce+'">').replace('const live = null;',()=> 'const live = '+app+';'),200,{
          'Content-Type':'text/html; charset=utf-8',
          'Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        });
      }
      if (request.method==='GET' && path==='/api/state') {
        const state=publicState((await workspace(env)).state,actor);
        await recordAccess(env,auth,'workspace_viewed',actor.branch);
        return json(state);
      }
      if(path==='/api/reports/weekly'&&request.method==='GET') {
        domain.requireCondition(reports.reportsView(actor),'You do not have access to branch reports.',403);
        const {state}=await workspace(env),params=new URL(request.url).searchParams;
        const branch=params.get('branch')||actor.branch||'';
        domain.requireCondition(!branch||(state.branches.includes(branch)&&(!actor.branch||actor.branch===branch)),'You do not have access to this branch.',403);
        const week=reports.reportWeek(params.get('date'),domain.requireCondition);
        const read=async(sql,args)=>(await env.DB.prepare(sql).bind(...args).all()).results;
        const report=await reports.weeklyReport({state,actor,branch,week,read,
          write:(sql,args)=>env.DB.prepare(sql).bind(...args).run(),
          ownerRows:branchName=>read("SELECT email,label,role,branch FROM aaa_staff_access WHERE enabled=1 AND role IN ('manager','team_leader')"+(branchName?' AND branch=?':''),branchName?[branchName]:[]),
          compliance,assessment:assessments,actions:actionList});
        await recordAccess(env,auth,'weekly_report_viewed',branch||null);
        return json(report);
      }
      if(path==='/api/people'&&request.method==='GET') {
        domain.requireCondition(people.peopleView(actor),'You do not have access to people profiles.',403);
        const {state}=await workspace(env), params=new URL(request.url).searchParams;
        const branch=params.get('branch')||actor.branch||'';
        domain.requireCondition(!branch||(state.branches.includes(branch)&&(!actor.branch||actor.branch===branch)),'You do not have access to this branch.',403);
        if(!params.has('id')) {
          const directory=people.profileDirectory(state,actor,branch);
          await recordAccess(env,auth,'people_directory_viewed',branch||null);
          return json(directory);
        }
        const person=people.profilePerson(state,actor,params.get('type'),params.get('id'));
        domain.requireCondition(person&&(!branch||person.branch===branch),'Person not found.',404);
        const read=async(sql,args)=>(await env.DB.prepare(sql).bind(...args).all()).results;
        const profile=await people.personProfile({state,actor,key:auth.calendarKey,person,read,
          write:(sql,args)=>env.DB.prepare(sql).bind(...args).run(),
          ownerRows:branchName=>read("SELECT email,label,role,branch FROM aaa_staff_access WHERE enabled=1 AND role IN ('manager','team_leader') AND branch=?",[branchName]),
          compliance,assessment:assessments,actions:actionList,diary,calendar,requireCondition:domain.requireCondition});
        await recordAccess(env,auth,person.type==='client'?'client_profile_viewed':'carer_profile_viewed',person.branch,person.id);
        return json(profile);
      }
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
            const detail=actionList.actionDetails(item,await env.DB.prepare(actionList.actionRowSql).bind(source).first(),owners);
            await recordAccess(env,auth,'action_viewed',item.branch,item.source);
            return json(detail);
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
          const items=[...auto,...manual].map(item=>actionList.actionDetails(item,rows.get(item.source),owners));
          await recordAccess(env,auth,'action_list_viewed',branch||null);
          return json(items);
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
            const history=(await env.DB.prepare(calendar.calendarHistorySql).bind(row.id).all()).results;
            await recordAccess(env,auth,'calendar_history_viewed',row.branch,row.id);
            return json(history);
          }
          const query=calendar.calendarQuery(state,actor,key,params,domain.requireCondition);
          const result=await Promise.all([query.events,query.reminders].map(item=>env.DB.prepare(item.sql).bind(...item.args).all()));
          const [events,reminders]=result.map(queryResult=>queryResult.results.map(row=>calendar.calendarEntry(actor,key,row)));
          await recordAccess(env,auth,'calendar_viewed',query.branch||null);
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
            await recordAccess(env,auth,'diary_entry_viewed',record.branch,record.id);
            return json(record);
          }
          const query=diary.diaryListQuery(state,actor,params,domain.requireCondition);
          const entries=diary.diaryList((await env.DB.prepare(query.sql).bind(...query.values).all()).results);
          await recordAccess(env,auth,'diary_list_viewed',params.get('branch')||actor.branch,params.get('subject')||null);
          return json(entries);
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
        await recordAccess(env,auth,preview?'assessment_viewed':'assessment_downloaded',record.branch,record.id);
        return response(assessments.assessmentDocument(record,nonce),200,{
          'Content-Type':'text/html; charset=utf-8',
          'Content-Disposition':preview?'inline':'attachment; filename="aaa-assessment-'+record.id+'.html"',
          'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"+(nonce?"; script-src 'nonce-"+nonce+"'":"")
        });
      }
      const pdfId=/^\/api\/compliance-pdf\/([a-f0-9-]{36})$/.exec(path)?.[1];
      if (request.method==='GET' && pdfId) {
        const {state}=await workspace(env);
        const entry=compliance.complianceProfileView(state,actor).find(item=>item.id===pdfId && item.hasPdf);
        const file=entry && await env.BUCKET.get('compliance/'+pdfId);
        domain.requireCondition(file,'Document not found.',404);
        const subject=compliance.complianceSubject(state,entry.type,entry.subject);
        await recordAccess(env,auth,'compliance_pdf_download_started',subject?.branch??null,pdfId);
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
