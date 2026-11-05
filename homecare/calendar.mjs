import { randomUUID } from 'node:crypto';

const roles=['admin','manager','team_leader'];
const types=['Appointment','Reminder','Assessment due','Compliance review','Meeting','Other'];
const statuses=['scheduled','completed','cancelled'];
const fields='id,owner_key,author,branch,title,kind,start_at,end_at,reminder_at,audience,carer_summary,status,notes,version,updated_by,updated_at,subject_type,subject_id';
export const calendarView=actor=>roles.includes(actor.role)?{types}:null;
export const calendarReadSql='SELECT '+fields+' FROM aaa_calendar WHERE id=?';
export const calendarHistorySql='SELECT version,status,title,kind,start_at,end_at,reminder_at,audience,carer_summary,notes,updated_by,updated_at,subject_type,subject_id FROM aaa_calendar_history WHERE event_id=? ORDER BY version DESC LIMIT 100';
export const calendarInsertSql='INSERT INTO aaa_calendar ('+fields+') SELECT '+Array(18).fill('?').join(',');
export const calendarUpdateSql='UPDATE aaa_calendar SET title=?,kind=?,start_at=?,end_at=?,reminder_at=?,audience=?,carer_summary=?,status=?,notes=?,version=?,updated_by=?,updated_at=?,subject_type=?,subject_id=? WHERE id=? AND version=?';
export const calendarPersonSql='SELECT '+fields+" FROM aaa_calendar WHERE branch=? AND subject_type=? AND subject_id=? AND (owner_key=? OR audience='branch') ORDER BY start_at DESC,id LIMIT 31";
const inBranch=(actor,branch)=>!actor.branch||actor.branch===branch;
export const canReadCalendar=(actor,key,row)=>Boolean(row&&calendarView(actor)&&inBranch(actor,row.branch)&&(row.owner_key===key||row.audience==='branch'));
export const canEditCalendar=(actor,key,row)=>canReadCalendar(actor,key,row)&&(row.owner_key===key||['admin','manager'].includes(actor.role));
export function calendarEntry(actor,key,row) {
  const {owner_key,...details}=row;
  return {...details,mine:owner_key===key,canEdit:canEditCalendar(actor,key,row)};
}
function localDateTime() {
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .format(new Date()).replace(' ','T');
}
export function calendarQuery(state,actor,key,params,requireCondition) {
  const branch=params.get('branch')||actor.branch||'';
  const now=localDateTime();
  const month=params.get('month')||now.slice(0,7);
  const filter=params.get('view')||'all';
  requireCondition(calendarView(actor)&&inBranch(actor,branch),'You do not have access to this calendar.',403);
  requireCondition((!branch||state.branches.includes(branch))&&/^\d{4}-(0[1-9]|1[0-2])$/.test(month)&&['all','mine','branch'].includes(filter),'Invalid calendar filter.');
  const where=["(owner_key=? OR audience='branch')"], args=[key];
  if(branch) {where.push('branch=?');args.push(branch);}
  if(filter==='mine') {where.push('owner_key=?');args.push(key);}
  if(filter==='branch') where.push("audience='branch'");
  const base='SELECT '+fields+' FROM aaa_calendar WHERE '+where.join(' AND ');
  return {
    branch,month,filter,today:now.slice(0,10),
    events:{sql:base+' AND substr(start_at,1,7)=? ORDER BY start_at,id LIMIT 400',args:[...args,month]},
    reminders:{sql:base+" AND status='scheduled' AND reminder_at IS NOT NULL AND reminder_at<=? ORDER BY reminder_at,id LIMIT 30",args:[...args,now]}
  };
}
export function calendarPayload(events,reminders,compliance) {
  const due=compliance.reminders.sort((a,b)=>a.reminder_at.localeCompare(b.reminder_at)||a.id.localeCompare(b.id));
  return {
    events:[...events,...compliance.events].sort((a,b)=>a.start_at.localeCompare(b.start_at)||a.id.localeCompare(b.id)),
    reminders:[...reminders,...due.slice(0,50)].sort((a,b)=>a.reminder_at.localeCompare(b.reminder_at)||a.id.localeCompare(b.id)),
    additionalComplianceReminders:Math.max(0,due.length-50)
  };
}
function validDateTime(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  const parsed=new Date(value+':00Z');
  return Number.isFinite(+parsed)&&parsed.toISOString().slice(0,16)===value;
}
export function prepareCalendar(state,actor,key,body,prior,requireCondition) {
  const {id,version,branch:requestedBranch,kind,audience,status}=body;
  const branch=prior?.branch??requestedBranch;
  requireCondition(calendarView(actor)&&state.branches.includes(branch)&&inBranch(actor,branch),'You do not have access to this calendar.',403);
  if(id) {
    requireCondition(canEditCalendar(actor,key,prior),'You do not have access to this calendar item.',403);
    requireCondition(Number(version)===prior.version,'This event has changed. Refresh and try again.',409);
    requireCondition(prior.owner_key===key||audience===prior.audience,'Only the creator can change who sees this event.',403);
  }
  const title=typeof body.title==='string'?body.title.trim():'';
  const notes=typeof body.notes==='string'?body.notes.trim():'';
  const carerSummary=typeof body.carer_summary==='string'?body.carer_summary.trim():'';
  const start=body.start_at,end=body.end_at||null,reminder=body.reminder_at||null;
  requireCondition(title&&title.length<=160&&notes.length<=3000&&carerSummary.length<=300&&types.includes(kind)&&['private','branch'].includes(audience)&&statuses.includes(status),'Enter a valid title, category and visibility.');
  requireCondition(!carerSummary||audience==='branch','Carer sharing is available for branch events only.');
  requireCondition(validDateTime(start)&&(!end||(validDateTime(end)&&end>=start))&&(!reminder||(validDateTime(reminder)&&reminder<=start)),'Check the event time, end time and reminder time.');
  const subjectType=(Object.hasOwn(body,'subject_type')?body.subject_type:prior?.subject_type)||null;
  const subjectId=(Object.hasOwn(body,'subject_id')?body.subject_id:prior?.subject_id)||null;
  requireCondition(Boolean(subjectType)===Boolean(subjectId),'Choose a linked person.');
  if(subjectType) {
    const people=subjectType==='client'?state.clients:subjectType==='carer'?state.staff:[];
    const kept=prior?.subject_type===subjectType&&prior?.subject_id===subjectId;
    requireCondition(people.some(person=>person.id===subjectId&&person.branch===branch&&(!person.archivedAt||kept)),
      'Choose a person in this branch.',403);
  }
  const versionNext=(prior?.version??0)+1, now=new Date().toISOString();
  const common=[title,kind,start,end,reminder,audience,carerSummary,status,notes,versionNext,actor.label,now,subjectType,subjectId];
  const eventId=prior?.id??randomUUID();
  return {id:eventId,sql:prior?calendarUpdateSql:calendarInsertSql,args:prior?
    [...common,eventId,prior.version]:[eventId,key,actor.label,branch,...common]};
}
