// Built together with the shared domain, compliance rules and HTML by build.mjs.
const json = (body,status=200) => response(JSON.stringify(body),status,{'Content-Type':'application/json; charset=utf-8'});
function response(body,status=200,headers={}) {
  return new Response(body,{status,headers:{
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",...headers
  }});
}
function publicState(state,actor) {
  return {...domain.project(state,actor),compliance:compliance.complianceView(state,actor)};
}
function authenticate(request,env) {
  const id=request.headers.get('oai-authenticated-user-id');
  const email=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  domain.requireCondition(id && email,'Sign in to continue.',401);
  domain.requireCondition(env.AAA_OWNER_EMAIL && email===env.AAA_OWNER_EMAIL,'This account has no access to the workspace.',403);
  return {label:'Head Office Admin',role:'admin',branch:null,staff:null};
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
async function update(request,env,actor,isCompliance) {
  domain.requireCondition(request.headers.get('content-type')?.split(';')[0]==='application/json','Use JSON for this request.',415);
  const body=await readJson(request,isCompliance?7*1024*1024+12000:12000);
  domain.requireCondition(body && typeof body.action==='string' && typeof body.id==='string' && body.fields && typeof body.fields==='object' && !Array.isArray(body.fields),'Invalid action request.');
  const {action,id,fields}=body;
  domain.requireCondition((action==='save-compliance')===isCompliance,'Invalid action endpoint.');
  const {state,rev}=await workspace(env);
  let file, entry;
  if (isCompliance) {
    file=parsePdf(fields.pdf);
    entry=compliance.recordCompliance(state,actor,fields,file,domain.requireCondition);
  } else domain.applyAction(state,actor,action,id,fields);
  const snapshot=JSON.stringify(state);
  domain.requireCondition(new TextEncoder().encode(snapshot).length<=1024*1024,'Workspace has reached its current storage limit.',507);
  if (file) await env.BUCKET.put('compliance/'+entry.id,file);
  const result=await env.DB.prepare('UPDATE aaa_workspace SET body=?, rev=rev+1 WHERE id=1 AND rev=?').bind(snapshot,rev).run();
  if (result.meta.changes!==1) {
    if (file) await env.BUCKET.delete('compliance/'+entry.id);
    throw new domain.AppError(409,'Another update was saved. Refresh the page and try again.');
  }
  return json(publicState(state,actor));
}

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    try {
      const actor=authenticate(request,env);
      if (request.method==='POST') domain.requireCondition(env.AAA_ORIGIN && request.headers.get('Origin')===env.AAA_ORIGIN,'Invalid request origin.',403);
      if (request.method==='POST' && path==='/logout') return response(null,303,{Location:'/signout-with-chatgpt?return_to=%2F'});
      if (request.method==='GET' && path==='/') {
        const {state}=await workspace(env);
        const app=JSON.stringify({actor,db:publicState(state,actor),catalog:compliance.permittedCatalog(actor)}).replaceAll('<','\\u003c');
        const nonce=crypto.randomUUID().replaceAll('-','');
        return response(html.replace('<script>','<script nonce="'+nonce+'">').replace('const live = null;',()=> 'const live = '+app+';'),200,{
          'Content-Type':'text/html; charset=utf-8',
          'Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        });
      }
      if (request.method==='GET' && path==='/api/state') return json(publicState((await workspace(env)).state,actor));
      const pdfId=/^\/api\/compliance-pdf\/([a-f0-9-]{36})$/.exec(path)?.[1];
      if (request.method==='GET' && pdfId) {
        const {state}=await workspace(env);
        const entry=compliance.complianceView(state,actor).find(item=>item.id===pdfId && item.hasPdf);
        const file=entry && await env.BUCKET.get('compliance/'+pdfId);
        domain.requireCondition(file,'Document not found.',404);
        return response(file.body,200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="compliance-evidence.pdf"'});
      }
      if (request.method==='POST' && ['/api/action','/api/compliance'].includes(path)) return await update(request,env,actor,path==='/api/compliance');
      return json({error:'Page not found.'},404);
    } catch(error) {
      if (error.status===401 && path==='/') return response(null,303,{Location:'/signin-with-chatgpt?return_to=%2F'});
      if (!(error instanceof domain.AppError)) console.error('Homecare request failed',error.name);
      return json({error:error instanceof domain.AppError?error.message:'The request could not be completed.'},error instanceof domain.AppError?error.status:500);
    }
  }
};
