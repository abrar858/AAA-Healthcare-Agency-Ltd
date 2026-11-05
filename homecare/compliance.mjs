import { randomUUID } from 'node:crypto';

const item = (key, label, optional = false, restricted = false) => ({key,label,optional,restricted});
export const catalog = {
  client: [
    item('assessment','Initial assessment and agreed care package'),
    item('support-plan','Support plan / commissioning instructions',true),
    item('care-plan','Care plan'),
    item('cpli','CPLI'),
    item('risks','Risk assessments'),
    item('consent','Consent record'),
    item('capacity','Mental capacity and best interests records',true),
    item('emergency','Emergency and contingency arrangements'),
    item('prescription','Current prescription or medicines list',true),
    item('mar','MAR charts / eMAR evidence',true),
    item('medication-risk','Medication support assessment and instructions',true),
    item('specialist','Specialist care instructions',true),
    item('visit-notes','Daily care notes and visit records'),
    item('care-plan-audit','Care plan audit',true),
    item('medication-audit','Medication audit',true),
    item('review','Care review and evaluation')
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
export function recordCompliance(state,actor,fields,file,requireCondition) {
  const {type,subject,item:key,status,reviewed,due,previous} = fields;
  const person = complianceSubject(state,type,subject);
  const definition = Object.hasOwn(catalog,type) ? catalog[type].find(item=>item.key===key) : null;
  requireCondition(allowed(actor,type,person,definition),'You do not have access to this checklist item.',403);
  requireCondition(['recorded','missing','not-applicable'].includes(status),'Choose a status.');
  const reference = typeof fields.reference==='string' ? fields.reference.trim() : '';
  const notes = typeof fields.notes==='string' ? fields.notes.trim() : '';
  requireCondition(reference.length<=200 && notes.length<=1000,'Shorten the evidence reference or notes.');
  state.compliance ??= [];
  const current = state.compliance.find(entry=>entry.type===type&&entry.subject===subject&&entry.item===key);
  requireCondition((current?.id ?? '')===previous,'Another user updated this item. Refresh the page and try again.',409);
  requireCondition(!file || status==='recorded','Attach evidence only to a recorded item.');
  if (status === 'recorded') {
    requireCondition(validDate(reviewed)&&reviewed<=todayUK(),'Enter the date the evidence was reviewed.');
    requireCondition(!due||(validDate(due)&&due>=reviewed),'Next review cannot be before the review date.');
    requireCondition(reference || file,'Attach a PDF or enter a reference to the existing evidence.');
  } else if (status === 'not-applicable') {
    requireCondition(definition.optional && notes,'Explain why this item does not apply.');
  }
  const entry = {
    id:randomUUID(),type,subject,item:key,status,reviewed:status==='recorded'?reviewed:null,
    due:status==='recorded'&&due?due:null,reference:status==='recorded'?reference:'',
    notes,hasPdf:Boolean(file),by:actor.label,at:new Date().toISOString()
  };
  state.compliance.unshift(entry);
  return entry;
}
