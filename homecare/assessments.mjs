import { randomUUID } from 'node:crypto';

const question = (label,type='long',required=true) => ({label,type,required});
const starter = (id,title,subject,questions) => ({id,title,subject,branch:null,questions,builtIn:true});
const followUp = question('Actions, owner and timescale','long',false);
const starters = [
  starter('initial','Initial homecare assessment','client',[question('Needs, preferences and outcomes'),question('Support and equipment required'),question('Risks and agreed controls'),followUp]),
  starter('risk','Client risk assessment','client',[question('Activity or hazard'),question('Who may be affected and how'),question('Controls and residual risk'),followUp]),
  starter('review','Client care review','client',[question('What has changed since the last review?'),question('Views of the person and others involved'),question('Changes to the care plan or support'),followUp]),
  starter('competency','Carer competency assessment','carer',[question('Task or competency assessed','short'),question('Observed practice and evidence'),{label:'Outcome',type:'choice',required:true,options:['Competent','Further development required','Reassessment required']},followUp]),
  starter('supervision','Carer supervision','carer',[question('Discussion and feedback'),question('Training or support needs'),question('Agreed actions and timescales')]),
  starter('spot-check','Observed practice / spot check','carer',[question('Practice observed'),question('Evidence and feedback'),question('Any concerns or escalation'),followUp])
];
const allowed = (actor,branch) => ['admin','manager','team_leader'].includes(actor.role) && (!actor.branch || actor.branch===branch);
const canBuild = actor => ['admin','manager'].includes(actor.role);
const allTemplates = state => [...starters,...(state.assessmentTemplates??[])];
const sameBranch = (actor,item) => allowed(actor,item.branch);
const escapeHtml = value => String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

export function assessmentView(state,actor) {
  if (!['admin','manager','team_leader'].includes(actor.role)) return null;
  return {canBuild:canBuild(actor),canComplete:['admin','team_leader'].includes(actor.role),
    templates:allTemplates(state).filter(item=>!item.branch||sameBranch(actor,item)),
    records:(state.assessments??[]).filter(item=>sameBranch(actor,item))};
}

export function changeAssessment(state,actor,action,id,fields,requireCondition) {
  const demand = (condition,message='You do not have access to this assessment.',status=403)=>requireCondition(condition,message,status);
  const value = (input,max) => {
    demand(typeof input==='string' && input.trim() && input.trim().length<=max,'Enter a valid value.',400);
    return input.trim();
  };
  state.assessmentTemplates??=[];
  state.assessments??=[];
  if(action==='add-assessment-template') {
    const {subject,questions}=fields;
    const branch=fields.branch||null;
    demand(canBuild(actor) && (branch ? state.branches.includes(branch)&&allowed(actor,branch) : actor.role==='admin'));
    demand(['client','carer'].includes(subject) && Array.isArray(questions) && questions.length>=1 && questions.length<=30,'Choose a subject and add between 1 and 30 questions.',400);
    const title=value(fields.title,120);
    const clean=questions.map(item=>{
      demand(item && ['short','long','choice','yesno','date','number'].includes(item.type),'Choose a supported answer type.',400);
      const {type}=item;
      const result=question(value(item.label,180),type,item.required===true);
      if(type==='choice') {
        demand(Array.isArray(item.options)&&item.options.length>=2&&item.options.length<=12,'Add between 2 and 12 options for each choice question.',400);
        result.options=item.options.map(option=>value(option,100));
        demand(new Set(result.options).size===result.options.length,'Remove duplicate choices.',400);
      }
      return result;
    });
    state.assessmentTemplates.push({id:randomUUID(),title,subject,branch,questions:clean});
    return;
  }
  if(action==='archive-assessment-template') {
    const template=state.assessmentTemplates.find(item=>item.id===id);
    demand(template && canBuild(actor) && (template.branch?allowed(actor,template.branch):actor.role==='admin'));
    template.archived=true;
    return;
  }
  demand(action==='save-assessment','Unknown assessment action.',400);
  demand(['admin','team_leader'].includes(actor.role),'A team leader or Head Office Admin must complete this assessment.',403);
  const prior=id?state.assessments.find(item=>item.id===id):null;
  if(id) demand(prior&&sameBranch(actor,prior));
  if(prior) demand(!prior.completedAt&&Number(fields.version)===prior.version,'This assessment has already changed. Reload before editing.',409);
  const template=prior?.template??allTemplates(state).find(item=>item.id===fields.template&&!item.archived);
  demand(template);
  const people=template.subject==='client'?state.clients:state.staff;
  const subject=people.find(person=>person.id===(prior?.subject??fields.subject));
  demand(subject && allowed(actor,subject.branch) && (!template.branch||template.branch===subject.branch));
  const {date,answers}=fields;
  demand(typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().startsWith(date),'Enter a valid assessment date.',400);
  demand(Array.isArray(answers)&&answers.length===template.questions.length,'The answers do not match this template.',400);
  const complete=fields.complete===true;
  const response=template.questions.map((item,index)=>{
    const answer=typeof answers[index]==='string'?answers[index].trim():'';
    demand(answer.length<=(item.type==='long'?2400:300),'An answer is too long.',400);
    demand(!complete||!item.required||answer,'Complete all required questions before finalising.',400);
    if(answer && item.type==='choice') demand(item.options.includes(answer),'Choose a listed answer.',400);
    if(answer && item.type==='yesno') demand(['Yes','No','Not applicable'].includes(answer),'Choose a listed answer.',400);
    if(answer && item.type==='number') demand(Number.isFinite(Number(answer)),'Enter a valid number.',400);
    if(answer && item.type==='date') demand(/^\d{4}-\d{2}-\d{2}$/.test(answer)&&Number.isFinite(Date.parse(answer+'T00:00:00Z'))&&new Date(answer+'T00:00:00Z').toISOString().startsWith(answer),'Enter a valid date.',400);
    return answer;
  });
  const now=new Date().toISOString();
  const record={id:prior?.id??randomUUID(),template,branch:subject.branch,subject:subject.id,subjectName:subject.name,
    date,answers:response,version:(prior?.version??0)+1,createdBy:prior?.createdBy??actor.label,
    updatedBy:actor.label,updatedAt:now,completedAt:complete?now:null};
  if(prior) Object.assign(prior,record); else state.assessments.unshift(record);
}

export function assessmentDocument(record,nonce='') {
  const h=escapeHtml;
  const title=h(record.template.title);
  return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+title+
    ' | AAA Homecare</title><style>body{font:16px/1.55 system-ui;color:#172624;margin:0 auto;padding:24px;max-width:780px}h1{line-height:1.15}dt{font-weight:700}dd{margin:0 0 16px;white-space:pre-wrap;overflow-wrap:anywhere}section{border-top:1px solid #ddd;padding-top:12px}button{padding:9px 14px;cursor:pointer}@media print{button,.hint{display:none}body{padding:0}dt{break-after:avoid}}</style></head><body><header><strong>AAA Homecare</strong><h1>'+title+'</h1><p>'+
    h(record.subjectName)+' · '+h(record.branch)+'<br>Assessment date: '+h(record.date.split('-').reverse().join('/'))+
    '<br>Completed by: '+h(record.updatedBy)+'<br>Record ID: '+h(record.id)+'</p></header>'+
    (nonce?'<button id="print">Print / Save as PDF</button><p class="hint">Select Save as PDF in your print dialog where available.</p>':'')+
    '<section><dl>'+record.template.questions.map((item,index)=>'<dt>'+h(item.label)+'</dt><dd>'+h(record.answers[index]||'—')+'</dd>').join('')+
    '</dl></section>'+(nonce?'<script nonce="'+h(nonce)+'">document.getElementById("print").addEventListener("click",()=>window.print());</script>':'')+'</body></html>';
}
