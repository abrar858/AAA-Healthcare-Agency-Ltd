import { createServer } from 'node:http';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { initialState, roles, applyAction, project, AppError, requireCondition } from './domain.mjs';

const scrypt = promisify(scryptCallback);
const dbPath = resolve(process.env.AAA_DB || resolve(homedir(), '.aaa-homecare/homecare.sqlite'));
process.umask(0o077);
mkdirSync(dirname(dbPath), {recursive:true, mode:0o700});
const db = new DatabaseSync(dbPath);
chmodSync(dbPath,0o600);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY, label TEXT NOT NULL, role TEXT NOT NULL, branch TEXT,
    staff TEXT UNIQUE, password_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES users(email), expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
`);
db.prepare('INSERT OR IGNORE INTO workspace (id,body) VALUES (1,?)').run(JSON.stringify(initialState()));
const readState = () => JSON.parse(db.prepare('SELECT body FROM workspace WHERE id=1').get().body);
const hash = value => createHash('sha256').update(value).digest('hex');
const normalEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const dummyHash = randomBytes(16).toString('hex')+':'+randomBytes(64).toString('hex');
const actorOf = ({label,role,branch,staff}) => ({label,role,branch,staff});
async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return salt+':'+(await scrypt(password,salt,64)).toString('hex');
}
async function validPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const computed = await passwordHash(password, stored.split(':')[0]);
  return timingSafeEqual(Buffer.from(computed),Buffer.from(stored));
}
async function passwordFromInput() {
  requireCondition(!process.stdin.isTTY, 'Pass the password through standard input from a password manager.');
  let password = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    password += chunk;
    requireCondition(password.length <= 258, 'Password is too long.');
  }
  password = password.replace(/\r?\n$/,'');
  requireCondition(password.length >= 14 && password.length <= 256,'Use 14 to 256 characters for the password.');
  return passwordHash(password);
}
async function accountCommand(command, args) {
  const email = normalEmail(args[0]);
  if (command === 'list-staff') {
    console.table(readState().staff.map(({id,name,branch})=>({id,name,branch})));
    return;
  }
  requireCondition(validEmail(email),'Enter a valid account email.');
  if (command === 'add-user') {
    const [,role,label,branchArg,staff] = args;
    const branch = branchArg === '-' ? null : branchArg ?? null;
    const state = readState();
    requireCondition(roles.includes(role) && label?.trim() && label.trim().length <= 100, 'Enter a valid role and display name.');
    requireCondition(branch ? state.branches.includes(branch) : ['admin','hr','accounts'].includes(role), 'Choose an existing branch for this role.');
    requireCondition(role !== 'admin' || !branch, 'Head Office Admin always has company-wide access.');
    requireCondition(role === 'carer' ? state.staff.some(person=>person.id===staff && person.branch===branch) : !staff,
      'A carer login must be linked to a staff record in the same branch.');
    requireCondition(!db.prepare('SELECT 1 FROM users WHERE email=?').get(email),'This account already exists.');
    db.prepare('INSERT INTO users (email,label,role,branch,staff,password_hash) VALUES (?,?,?,?,?,?)')
      .run(email,label.trim(),role,branch,staff ?? null,await passwordFromInput());
    console.log('Account created.');
    return;
  }
  requireCondition(['reset-password','disable-user'].includes(command),'Unknown account command.');
  requireCondition(db.prepare('SELECT 1 FROM users WHERE email=?').get(email),'Account not found.');
  const replacement = command === 'reset-password' ? await passwordFromInput() : null;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (replacement) db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(replacement,email);
    else db.prepare('UPDATE users SET enabled=0 WHERE email=?').run(email);
    db.prepare('DELETE FROM sessions WHERE email=?').run(email);
    db.exec('COMMIT');
  } catch(error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(replacement ? 'Password changed and sessions revoked.' : 'Account disabled and sessions revoked.');
}

function startServer() {
  const origin = new URL(process.env.AAA_ORIGIN || 'http://127.0.0.1:4174');
  const secure = origin.protocol === 'https:';
  requireCondition(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash &&
    (secure || (origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname))),
    'Set AAA_ORIGIN to an HTTPS origin or a loopback HTTP origin for local testing.');
  const host = process.env.AAA_HOST || '127.0.0.1';
  requireCondition(secure || ['127.0.0.1','::1','localhost'].includes(host),'A public listener requires an HTTPS origin.');
  const port = Number(process.env.PORT || 4174);
  const html = readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const cookieName = secure ? '__Host-aaa_session' : 'aaa_session';
  const ttl = 8*60*60*1000;
  const cookie = (value,maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;
  const tokenOf = req => (req.headers.cookie ?? '').split(';').map(item=>item.trim()).find(item=>item.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const attempts = new Map();
  const attemptsWindow = 10*60*1000;

  function rateLimit(req) {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!attempts.has(ip) && attempts.size >= 10000) throw new AppError(429,'Try again later.');
    const entry = attempts.get(ip) ?? {count:0,until:now+attemptsWindow};
    requireCondition(entry.count < 12,'Too many sign-in attempts. Try again later.',429);
    entry.count += 1;
    attempts.set(ip,entry);
  }
  function userOf(req) {
    const token = tokenOf(req);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return db.prepare('SELECT users.* FROM sessions JOIN users USING(email) WHERE token_hash=? AND expires>? AND enabled=1').get(hash(token),Date.now());
  }
  function write(res,status,body,type='text/html; charset=utf-8') {
    res.writeHead(status,{'Content-Type':type});
    res.end(body);
  }
  function json(res,status,body) { write(res,status,JSON.stringify(body),'application/json; charset=utf-8'); }
  function redirect(res,path) {res.writeHead(303,{Location:path});res.end();}
  function login(res,status=200,message='') {
    write(res,status,`<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in | AAA Homecare</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef6f1;color:#16342a;font:16px system-ui}main{box-sizing:border-box;width:min(430px,calc(100% - 28px));padding:26px;border:1px solid #d2e7db;border-radius:16px;background:white}h1{margin:0 0 8px}p{margin:0 0 16px}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{padding:10px;border:1px solid #b1c8ba;border-radius:8px;margin:5px 0 14px;font:inherit}button{background:#145f4a;color:white;cursor:pointer}small{color:#923c32}</style>
<main><h1>AAA Homecare</h1><p>Sign in to your branch workspace.</p>${message ? `<p role="alert"><small>${message}</small></p>` : ''}
<form method="post" action="/login"><label>Email<input name="email" type="email" autocomplete="username" required maxlength="254"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button>Sign in</button></form></main></html>`);
  }
  async function readBody(req) {
    let bytes = 0;
    const parts = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      requireCondition(bytes <= 12000,'Request is too large.',413);
      parts.push(chunk);
    }
    return Buffer.concat(parts).toString('utf8');
  }
  function mutate(actor, action, id, fields) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = readState();
      applyAction(state,actor,action,id,fields);
      db.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
      db.exec('COMMIT');
      return project(state,actor);
    } catch(error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const server = createServer(async (req,res)=>{
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    if(secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const {pathname:path} = new URL(req.url,origin);
      if (req.method === 'POST') requireCondition(req.headers.origin === origin.origin,'Invalid request origin.',403);
      if (req.method === 'GET' && path === '/login') return userOf(req) ? redirect(res,'/') : login(res);
      if (req.method === 'POST' && path === '/login') {
        rateLimit(req);
        const fields = new URLSearchParams(await readBody(req));
        const email = normalEmail(fields.get('email'));
        const user = validEmail(email) ? db.prepare('SELECT * FROM users WHERE email=? AND enabled=1').get(email) : null;
        const valid = await validPassword(fields.get('password'),user?.password_hash ?? dummyHash);
        const current = user && db.prepare('SELECT password_hash FROM users WHERE email=? AND enabled=1').get(email);
        if (!valid || !current || current.password_hash !== user.password_hash) return login(res,401,'Email or password is incorrect.');
        const token = randomBytes(32).toString('hex');
        db.prepare('DELETE FROM sessions WHERE expires<=? OR token_hash=?').run(Date.now(),hash(tokenOf(req) ?? ''));
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),email,Date.now()+ttl);
        res.setHeader('Set-Cookie',cookie(token,ttl/1000));
        return redirect(res,'/');
      }
      const user = userOf(req);
      if (!user) return path.startsWith('/api/') ? json(res,401,{error:'Sign in to continue.'}) : redirect(res,'/login');
      const actor = actorOf(user);
      if (req.method === 'POST' && path === '/logout') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(tokenOf(req)));
        res.setHeader('Set-Cookie',cookie('',0));
        return redirect(res,'/login');
      }
      if (req.method === 'GET' && path === '/') {
        const state = JSON.stringify({actor,db:project(readState(),actor)}).replaceAll('<','\\u003c');
        return write(res,200,html.replace('<script>',`<script nonce="${nonce}">`).replace('const live = null;',()=>`const live = ${state};`));
      }
      if (req.method === 'GET' && path === '/api/state') return json(res,200,project(readState(),actor));
      if (req.method === 'POST' && path === '/api/action') {
        requireCondition((req.headers['content-type'] ?? '').split(';')[0] === 'application/json','Use JSON for this request.',415);
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch(error) { if (error instanceof AppError) throw error; throw new AppError(400,'Invalid JSON request.'); }
        requireCondition(body && typeof body.action === 'string' && typeof body.id === 'string' && body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields),'Invalid action request.');
        // Re-read after the asynchronous body read so revoked sessions cannot write.
        const current = userOf(req);
        requireCondition(current,'Sign in to continue.',401);
        return json(res,200,mutate(actorOf(current),body.action,body.id,body.fields));
      }
      return json(res,404,{error:'Page not found.'});
    } catch(error) {
      if (!(error instanceof AppError)) console.error('Homecare server error:',error.message);
      return json(res,error.status ?? 500,{error:error.status ? error.message : 'The request could not be completed.'});
    }
  });
  server.requestTimeout = 15000;
  server.listen(port,host,()=>console.log('AAA Homecare listening on '+host+':'+port));
}
const [, , command, ...args] = process.argv;
try { if (command) await accountCommand(command,args); else startServer(); }
catch(error) { console.error(error.message); process.exitCode=1; }
