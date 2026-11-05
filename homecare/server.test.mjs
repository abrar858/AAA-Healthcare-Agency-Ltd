import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./server.mjs', import.meta.url));
const password = 'Fictional test password only';

test('authenticated branch workflow survives restart and rejects unauthorised requests', async () => {
  const directory = mkdtempSync(join(tmpdir(),'aaa-homecare-test-'));
  const listener = createServer();
  listener.listen(0,'127.0.0.1');
  await once(listener,'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = 'http://127.0.0.1:'+port;
  const env = {...process.env, AAA_DB:join(directory,'test.sqlite'), AAA_HOST:'127.0.0.1', AAA_ORIGIN:origin, PORT:String(port)};
  let server;
  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server,'exit');
      server.kill();
      await exited;
    }
  }
  async function start() {
    server = spawn(process.execPath,[script],{env,stdio:['ignore','pipe','pipe']});
    const running = await Promise.race([once(server.stdout,'data'),once(server,'exit')]);
    assert.match(String(running[0]),/listening/);
  }
  function provision(name,role,branch,staff) {
    const args = [script,'add-user',name+'@example.invalid',role,name,branch,staff].filter(value=>value!==undefined);
    const command = spawnSync(process.execPath,args,{env,input:password+'\n',encoding:'utf8'});
    assert.equal(command.status,0,command.stderr);
  }
  async function request(path, options = {}) {
    return fetch(origin+path,{redirect:'manual',...options});
  }
  async function signIn(name) {
    const response = await request('/login',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({email:name+'@example.invalid',password})});
    assert.equal(response.status,303);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie,/HttpOnly; SameSite=Strict/);
    return cookie.split(';')[0];
  }
  async function state(cookie) {
    const response = await request('/api/state',{headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    return response.json();
  }
  async function action(cookie,action,id='',fields={},status=200,from=origin) {
    const response = await request('/api/action',{method:'POST',headers:{Cookie:cookie,Origin:from,'Content-Type':'application/json'},body:JSON.stringify({action,id,fields})});
    const result = await response.json();
    assert.equal(response.status,status,JSON.stringify(result));
    return result;
  }
  try {
    provision('admin','admin');
    await start();
    assert.equal((await request('/api/state')).status,401);
    assert.equal((await request('/')).headers.get('location'),'/login');
    const admin = await signIn('admin');
    const page = await request('/',{headers:{Cookie:admin}});
    assert.match(page.headers.get('content-security-policy'),/script-src 'nonce-/);
    assert.match(await page.text(),/const live = \{"actor":\{"label":"admin"/);
    await action(admin,'add-branch','',{name:'Preston'},403,'https://elsewhere.invalid');
    await action(admin,'add-branch','',{name:'Preston'});
    await action(admin,'add-branch','',{name:'Blackburn'});
    provision('preston','manager','Preston');
    provision('blackburn','manager','Blackburn');
    provision('hr','hr','Preston');
    provision('accounts','accounts','Blackburn');
    const preston = await signIn('preston');
    const blackburn = await signIn('blackburn');
    const hr = await signIn('hr');
    const accounts = await signIn('accounts');
    const staffFields = {name:'Demo Carer',branch:'Preston',cleared:'on',checks:'on',training:'on'};
    await action(preston,'add-staff','',staffFields,403);
    await action(hr,'add-staff','',{...staffFields,branch:'Blackburn'},403);
    await action(hr,'add-staff','',{...staffFields,checks:''},400);
    const person = (await action(hr,'add-staff','',staffFields)).staff[0];
    provision('carer','carer','Preston',person.id);
    const carer = await signIn('carer');
    const patch = (await action(blackburn,'add-patch','',{name:'North',branch:'Blackburn'})).patches[0];
    const client = (await action(blackburn,'add-client','',{name:'Fictional Blackburn Client',patch:patch.id})).clients[0];
    await action(preston,'add-client','',{name:'Wrong branch',patch:patch.id},403);
    const visit = (await action(blackburn,'add-visit','',{client:client.id,date:'2026-11-05',time:'12:00',minutes:'30',required:'1'})).visits[0];
    assert.deepEqual((await state(preston)).branches,['Preston']);
    assert.equal((await state(preston)).clients.length,0);
    assert.equal((await state(carer)).visits.length,0);
    await action(preston,'cancel-visit',visit.id,{reason:'Unauthorised'},403);
    await action(carer,'record',visit.id,{note:'Unassigned',minutes:'30'},403);
    const cover = (await action(blackburn,'request',visit.id,{staff:person.id})).requests[0];
    const receivingView = await state(preston);
    assert.equal(receivingView.requests[0].id,cover.id);
    assert.equal(receivingView.visits[0].client,undefined);
    assert.equal(receivingView.staff[0].checks,undefined);
    await action(blackburn,'approve',cover.id,{},403);
    await action(preston,'urgent',cover.id,{},403);
    await action(preston,'approve',cover.id);
    assert.equal((await state(carer)).clients[0].name,client.name);
    await action(carer,'record',visit.id,{note:'Fictional care note',minutes:'31'});
    await action(carer,'record',visit.id,{note:'Duplicate',minutes:'29'},409);
    const hours = await state(accounts);
    assert.equal(hours.visits[0].assignments[0].minutes,31);
    assert.equal(hours.visits[0].assignments[0].note,undefined);
    assert.equal(hours.clients.length,0);
    await stop();
    await start();
    assert.equal((await state(admin)).visits[0].assignments[0].note,'Fictional care note');
    assert.equal((await request('/logout',{method:'POST',headers:{Cookie:carer,Origin:origin}})).status,303);
    assert.equal((await request('/api/state',{headers:{Cookie:carer}})).status,401);
    const revoke=spawnSync(process.execPath,[script,'disable-user','preston@example.invalid'],{env,encoding:'utf8'});
    assert.equal(revoke.status,0,revoke.stderr);
    assert.equal((await request('/api/state',{headers:{Cookie:preston}})).status,401);
  } finally {
    await stop();
    rmSync(directory,{recursive:true,force:true});
  }
});
