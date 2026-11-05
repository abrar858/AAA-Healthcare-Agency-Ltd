import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const target=resolve(process.argv[2] ?? '.');
const output=resolve(target,'dist');
const read=file=>readFileSync(resolve(root,file),'utf8');

function bundleModule(file,name) {
  const source=read(file);
  const imports=source.match(/^import .+$/gm);
  if (imports && (imports.length!==1 || imports[0]!=="import { randomUUID } from 'node:crypto';")) throw new Error('Unexpected imports in '+file);
  const names=Array.from(source.matchAll(/^export (?:const|(?:async )?function|class) (\w+)/gm),match=>match[1]);
  if (!names.length) throw new Error('Missing shared exports in '+file);
  const implementation=(imports?source.replace(imports[0],"const randomUUID = () => crypto.randomUUID();"):source).replace(/^export /gm,'');
  return 'const '+name+' = (() => {\n'+implementation+'\nreturn {'+names.join(',')+'};\n})();\n';
}
const code='const html = '+JSON.stringify(read('index.html'))+';\n'+bundleModule('domain.mjs','domain')+
  bundleModule('compliance.mjs','compliance')+bundleModule('assessments.mjs','assessments')+bundleModule('diary.mjs','diary')+bundleModule('calendar.mjs','calendar')+bundleModule('actions.mjs','actionList')+read('sites/worker.mjs');
rmSync(output,{recursive:true,force:true});
mkdirSync(resolve(output,'server'),{recursive:true});
mkdirSync(resolve(output,'.openai'),{recursive:true});
writeFileSync(resolve(output,'server/index.js'),code);
copyFileSync(resolve(target,'.openai/hosting.json'),resolve(output,'.openai/hosting.json'));
