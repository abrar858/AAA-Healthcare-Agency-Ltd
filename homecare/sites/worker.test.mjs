import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('hosted access is scoped, identity-bound, and revocable', async () => {
  const target=mkdtempSync(join(tmpdir(),'aaa-worker-test-'));
  const storage=new DatabaseSync(':memory:');
  try {
    mkdirSync(join(target,'.openai'));
    writeFileSync(join(target,'.openai/hosting.json'),'{"d1":"DB","r2":"BUCKET"}');
    execFileSync(process.execPath,[fileURLToPath(new URL('./build.mjs',import.meta.url)),target]);
    const {default:worker}=await import(pathToFileURL(join(target,'dist/server/index.js')));
    for(const file of ['0000_aaa_workspace','0001_aaa_staff_access','0002_aaa_team_leaders','0003_aaa_diary']) {
      storage.exec(readFileSync(new URL('./drizzle/'+file+'.sql',import.meta.url),'utf8'));
    }
    const files=new Map();
    const env={AAA_ORIGIN:'https://aaa.example.invalid',AAA_OWNER_EMAIL:'owner@example.invalid',
      DB:{prepare(sql){
        const statement=storage.prepare(sql);
        const bound=(...args)=>({
          first:async()=>statement.get(...args),
          run:async()=>({meta:statement.run(...args)}),
          all:async()=>({results:statement.all(...args)})
        });
        return {...bound(),bind:bound};
      }},
      BUCKET:{put:async(key,body)=>files.set(key,body),get:async key=>files.has(key)?{body:files.get(key)}:null,delete:async key=>files.delete(key)}};
    const owner='owner', manager='manager';
    const request=(path,user,body,opts={})=>worker.fetch(new Request(env.AAA_ORIGIN+path,{
      method:body?'POST':'GET',headers:{
        ...(user?{'oai-authenticated-user-id':opts.identity??user+'-id','oai-authenticated-user-email':user+'@example.invalid'}:{}),
        ...(body?{Origin:opts.origin??env.AAA_ORIGIN,'Content-Type':'application/json'}:{})
      },...(body?{body:JSON.stringify(body)}:{})
    }),env);
    const action=(user,action,fields,id='')=>request(action==='save-compliance'?'/api/compliance':'/api/action',user,{action,id,fields});
    const grant={email:manager+'@example.invalid',label:'Preston Manager',role:'manager',branch:'Preston',version:'0'};
    const access=(user,action,fields,opts)=>request('/api/access',user,{action,fields},opts);
    assert.equal((await request('/api/state')).status,401);
    assert.equal((await request('/api/state',manager)).status,403);
    assert.equal((await action(owner,'add-branch',{name:'Preston'})).status,200);
    assert.equal((await action(owner,'add-branch',{name:'Blackburn'})).status,200);
    assert.equal((await access(owner,'save-access',grant,{origin:'https://another.invalid'})).status,403);
    assert.equal((await access(owner,'save-access',{...grant,email:env.AAA_OWNER_EMAIL})).status,400);
    assert.equal((await access(owner,'save-access',{...grant,role:'admin'})).status,400);
    const member=(await (await access(owner,'save-access',grant)).json())[0];
    assert.equal(member.enabled,1);
    assert.equal((await access(owner,'save-access',grant)).status,409);
    assert.match(await (await request('/',owner)).text(),/"access":\[\{"email":"manager@example.invalid"/);
    assert.deepEqual((await (await request('/api/state',manager)).json()).branches,['Preston']);
    assert.equal((await request('/api/state',manager,null,{identity:'different-id'})).status,403);
    assert.equal((await request('/api/access',manager)).status,403);
    assert.equal((await access(manager,'save-access',{...grant,branch:'Blackburn',version:member.version})).status,403);
    assert.equal((await action(manager,'add-patch',{name:'North',branch:'Blackburn'})).status,403);
    const patch=(await (await action(manager,'add-patch',{name:'Central',branch:'Preston'})).json()).patches[0];
    const client=(await (await action(manager,'add-client',{name:'Fictional Client',patch:patch.id})).json()).clients[0];
    const reviewed=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const pdf=btoa('%PDF-1.7\nExample upload');
    const item=(await (await action(manager,'save-compliance',{type:'client',subject:client.id,item:'care-plan',previous:'',status:'recorded',reviewed,pdf})).json()).compliance[0];
    const file='/api/compliance-pdf/'+item.id;
    assert.equal(await (await request(file,manager)).text(),atob(pdf));
    const other={...grant,email:'other@example.invalid',label:'Blackburn Manager',branch:'Blackburn'};
    assert.equal((await access(owner,'save-access',other)).status,200);
    assert.equal((await request(file,'other')).status,404);
    const templateFields={title:'Custom safety form',subject:'client',branch:'Preston',questions:[
      {label:'Outcome',type:'choice',options:['Pass','Review'],required:true},
      {label:'Notes',type:'long',required:false}
    ]};
    const template=(await (await action(manager,'add-assessment-template',templateFields)).json()).assessment.templates.find(item=>item.title===templateFields.title);
    const leader={...grant,email:'leader@example.invalid',label:'Preston Team Leader',role:'team_leader'};
    assert.equal((await access(owner,'save-access',leader)).status,200);
    const leaderState=await (await request('/api/state','leader')).json();
    assert.deepEqual(leaderState.branches,['Preston']);
    assert.equal(leaderState.assessment.canBuild,false);
    assert.equal(leaderState.clients[0].id,client.id);
    assert.equal(leaderState.compliance.length,0);
    assert.equal((await action('leader','add-assessment-template',templateFields)).status,403);
    assert.equal((await action('other','save-assessment',{template:template.id,subject:client.id,date:reviewed,answers:['Pass',''],complete:true})).status,403);
    const form={template:template.id,subject:client.id,date:reviewed,answers:['','<script>test</script>'],complete:false};
    const draft=(await (await action('leader','save-assessment',form)).json()).assessment.records[0];
    assert.equal(draft.completedAt,null);
    const documentPath='/api/assessment-document/'+draft.id;
    assert.equal((await request(documentPath,'leader')).status,404);
    assert.equal((await action('leader','save-assessment',{...form,version:draft.version,complete:true},draft.id)).status,400);
    assert.equal((await action('leader','save-assessment',{...form,version:draft.version,answers:['Pass',form.answers[1]],complete:true},draft.id)).status,200);
    assert.equal((await action('leader','save-assessment',{...form,version:draft.version+1},draft.id)).status,409);
    assert.equal((await request(documentPath,'other')).status,404);
    const download=await request(documentPath,'manager');
    assert.match(download.headers.get('content-disposition'),/^attachment;/);
    const exported=await download.text();
    assert.match(exported,/&lt;script&gt;test&lt;\/script&gt;/);
    assert.doesNotMatch(exported,/<script>/);
    assert.match(await (await request(documentPath+'?view=1','leader')).text(),/Print \/ Save as PDF/);
    assert.equal((await action(manager,'archive-assessment-template',{},template.id)).status,200);
    assert.equal((await action('leader','save-assessment',{...form,answers:['Pass',''],complete:true})).status,403);
    assert.equal((await request(documentPath,'leader')).status,200);
    const note={type:'client',subject:client.id,date:reviewed,time:'10:30',category:'Visit change',note:'Sample visit extended to 12:00.'};
    assert.equal((await request('/api/diary','other',note)).status,403);
    const logged=await request('/api/diary','leader',note);
    assert.equal(logged.status,201);
    const entry=await logged.json();
    const personDiary='/api/diary?type=client&subject='+client.id;
    assert.equal((await request(personDiary,'other')).status,403);
    assert.equal((await request('/api/diary?entry='+entry.id,'other')).status,404);
    const clientLog=await (await request(personDiary,'manager')).json();
    assert.equal(clientLog.entries[0].occurred_time,'10:30');
    assert.equal(clientLog.entries[0].author,leader.label);
    const staffFields={branch:'Preston',name:'Fictional Staff'};
    const staff=(await (await action(owner,'add-staff',staffFields)).json()).staff[0];
    const carerNote={...note,type:'carer',subject:staff.id,category:'Phone call'};
    assert.equal((await request('/api/diary','leader',{...carerNote,related:entry.id})).status,403);
    assert.equal((await request('/api/diary','leader',carerNote)).status,201);
    assert.equal((await request('/api/diary','manager',{...note,time:'11:00',category:'Follow-up / correction',note:'Sample time confirmed.',related:entry.id})).status,201);
    const afterFollowup=await (await request(personDiary,'manager')).json();
    assert.equal(afterFollowup.entries.length,2);
    assert.equal(afterFollowup.entries[0].related,entry.id);
    assert.equal(afterFollowup.entries[1].note,note.note);
    assert.equal((await (await request('/api/diary?type=carer&category=Phone+call','manager')).json()).entries.length,1);
    assert.equal((await request('/api/diary?type=client&branch=Blackburn','manager')).status,403);
    const revoked=(await (await access(owner,'revoke-access',{email:grant.email,version:member.version})).json()).find(row=>row.email===grant.email);
    assert.equal(revoked.enabled,0);
    assert.equal((await request('/api/state',manager)).status,403);
    assert.equal((await request(file,manager)).status,403);
    assert.equal((await request(personDiary,manager)).status,403);
    assert.equal((await access(owner,'save-access',{...grant,version:revoked.version})).status,200);
    assert.equal((await request('/api/state',manager)).status,200);
  } finally {
    storage.close();
    rmSync(target,{recursive:true,force:true});
  }
});
