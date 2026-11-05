import { randomUUID } from 'node:crypto';

const item = (key, label, optional = false, restricted = false, options = {}) => ({key,label,optional,restricted,...options});
export const catalog = {
  client: [
    item('assessment','Initial assessment and agreed care package'),
    item('support-plan','Support plan / commissioning instructions',true),
    item('care-plan','Care plan'),
    item('cpli','CPLI'),
    item('risks','Risk assessments'),
    item('consent','Consent to care and treatment'),
    item('media-consent','Consent to media',true),
    item('best-interest','Best-interest decision (where required)',true),
    item('lpa-finance','Lasting power of attorney for finance',true),
    item('lpa-health','Lasting power of attorney for health and welfare',true),
    item('capacity','Mental capacity and best interests records',true),
    item('emergency','Emergency and contingency arrangements'),
    item('prescription','Prescription review / current medicines list',true),
    item('mar','MAR charts / eMAR evidence',true),
    item('medication-risk','Medication support assessment and instructions',true),
    item('specialist','Specialist care instructions',true),
    item('visit-notes','Daily care notes and visit records'),
    item('care-plan-audit','Care plan audit',true,false,{reviewMonths:6}),
    item('medication-audit','Medication audit',true,false,{reviewMonths:1}),
    item('moving-audit','Moving and handling audit',true,false,{reviewMonths:3}),
    item('review','Care plan review and evaluation',false,false,{reviewMonths:6}),
    item('manager-final-check','Registered Manager final check (QCS-CA14)',true),
    item('rota-scheduled','Rota scheduled',true,false,{evidenceOptional:true}),
    item('self-medication-risk','Self-administration of medication risk assessment (QCS-CM03)',true,false,{reviewMonths:6}),
    item('service-agreement','Service level agreement / commissioning confirmation',true),
    item('telephone-review','Telephone quality review (QCS-QQ16)',true,false,{reviewMonths:3}),
    item('updated-cpli','Updated CPLI',true),
    item('updated-cpli-2','Updated CPLI 2',true)
  ],
  carer: [
    item('identity','Identity and right-to-work evidence',false,true),
    item('dbs','DBS and recruitment suitability checks',false,true),
    item('references','References and employment history',false,true),
    item('induction','Induction and shadowing'),
    item('training','Training record'),
    item('competencies','Role and task competencies'),
    item('medication-competency','Medication competency',true),
    item('moving-competency','Moving and handling competency',true),
    item('specialist-competency','Specialist care competency',true),
    item('supervision','Supervision'),
    item('appraisal','Appraisal'),
    item('spot-check','Spot check or observed practice'),
    item('driving','Driving and vehicle evidence',true,true)
  ]
};
export function complianceSubject(state, type, id) {
  const people = type === 'client' ? state.clients : type === 'carer' ? state.staff : [];
  return people.find(person => person.id === id);
}
function allowed(actor, type, person, definition) {
  if (!person || !definition || (actor.branch && actor.branch !== person.branch)) return false;
  if (actor.role === 'admin') return true;
  if (type === 'client') return actor.role === 'manager';
  return actor.role === 'hr' || (actor.role === 'manager' && !definition.restricted);
}
export function permittedCatalog(actor) {
  return Object.fromEntries(Object.entries(catalog).map(([type,items])=>[
    type, items.filter(definition=>allowed(actor,type,{branch:actor.branch},definition))
  ]));
}
export function complianceView(state, actor) {
  return (state.compliance ?? []).filter(entry=>allowed(actor,entry.type,
    complianceSubject(state,entry.type,entry.subject),catalog[entry.type]?.find(item=>item.key===entry.item)));
}
export const todayUK = () => new Intl.DateTimeFormat('en-CA',{
  timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'
}).format(new Date());
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value+'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().startsWith(value);
}
function addReviewMonths(date, months) {
  const value = new Date(date+'T00:00:00Z');
  const day = value.getUTCDate();
  value.setUTCMonth(value.getUTCMonth()+months+1,0);
  value.setUTCDate(Math.min(day,value.getUTCDate()));
  return value.toISOString().slice(0,10);
}
export function recordCompliance(state,actor,fields,file,requireCondition) {
  const {type,subject,item:key,status,reviewed,previous} = fields;
  const person = complianceSubject(state,type,subject);
  const definition = Object.hasOwn(catalog,type) ? catalog[type].find(item=>item.key===key) : null;
  requireCondition(allowed(actor,type,person,definition)&&!person.archivedAt,'You do not have access to this checklist item.',403);
  requireCondition(['recorded','missing','not-applicable'].includes(status),'Choose a status.');
  const reference = typeof fields.reference==='string' ? fields.reference.trim() : '';
  const notes = typeof fields.notes==='string' ? fields.notes.trim() : '';
  requireCondition(reference.length<=200 && notes.length<=1000,'Shorten the evidence reference or notes.');
  state.compliance ??= [];
  const current = state.compliance.find(entry=>entry.type===type&&entry.subject===subject&&entry.item===key);
  requireCondition((current?.id ?? '')===previous,'Another user updated this item. Refresh the page and try again.',409);
  const reviewMonths = type==='client' ? Number(fields.reviewMonths ?? current?.reviewMonths ?? definition.reviewMonths ?? 0) : 0;
  requireCondition(Number.isInteger(reviewMonths)&&reviewMonths>=0&&reviewMonths<=60,'Enter a review interval from 0 to 60 months.');
  const pdfSource = type==='client' && !file && status==='recorded' && fields.keepPdf==='on'
    ? (current?.hasPdf ? current.id : current?.pdfSource) : undefined;
  let due = fields.due;
  requireCondition(!file || status==='recorded','Attach evidence only to a recorded item.');
  if (status === 'recorded') {
    requireCondition(validDate(reviewed)&&reviewed<=todayUK(),'Enter the date the evidence was reviewed.');
    if (!due && reviewMonths) due = addReviewMonths(reviewed,reviewMonths);
    requireCondition(!due||(validDate(due)&&due>=reviewed),'Next review cannot be before the review date.');
    requireCondition(reference || file || pdfSource || definition.evidenceOptional,'Attach a PDF or enter a reference to the existing evidence.');
  } else if (status === 'not-applicable') {
    requireCondition(definition.optional && notes,'Explain why this item does not apply.');
  }
  const entry = {
    id:randomUUID(),type,subject,item:key,status,reviewed:status==='recorded'?reviewed:null,
    due:status==='recorded'&&due?due:null,reference:status==='recorded'?reference:'',
    ...(type==='client'?{reviewMonths,manualDue:Boolean(fields.due)&&status==='recorded'}:{}),notes,hasPdf:Boolean(file),pdfSource,by:actor.label,at:new Date().toISOString()
  };
  state.compliance.unshift(entry);
  return entry;
}

// Calendar entries are projections of the current checklist version, not copied events.
export function complianceCalendar(state,actor,{branch,filter,month,today}) {
  const events=[], reminders=[];
  if(filter==='mine') return {events,reminders};
  const seen=new Set();
  for(const entry of complianceView(state,actor)) {
    const key=[entry.type,entry.subject,entry.item].join(':');
    if(seen.has(key)) continue;
    seen.add(key);
    if(entry.status!=='recorded'||!validDate(entry.due)) continue;
    if(!entry.due.startsWith(month+'-')&&entry.due>today) continue;
    const person=complianceSubject(state,entry.type,entry.subject);
    if(person.archivedAt||(branch&&person.branch!==branch)) continue;
    const definition=catalog[entry.type].find(item=>item.key===entry.item);
    const source='compliance:'+key;
    const event={id:source,source,title:definition.label+' review · '+person.name,
      branch:person.branch,kind:'Compliance review',start_at:entry.due,reminder_at:entry.due,
      audience:'branch',status:'scheduled',mine:false,canEdit:false};
    if(entry.due.startsWith(month+'-')) events.push(event);
    if(entry.due<=today) reminders.push(event);
  }
  return {events,reminders};
}

// Team leaders can read operational evidence on a person page, without gaining
// access to restricted recruitment records or checklist editing.
export function complianceProfileView(state,actor) {
  return complianceView(state,actor.role==='team_leader'?{...actor,role:'manager'}:actor);
}
