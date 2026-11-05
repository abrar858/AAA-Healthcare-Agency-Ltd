import { randomUUID } from 'node:crypto';

const roles = ['admin','manager','team_leader'];
const types = ['client','carer'];
const categories = ['General note','Phone call','Communication','Visit change','Concern / escalation','Follow-up / correction'];
const columns = 'id,type,subject,branch,person,category,occurred_date,occurred_time,note,author,created_at,related';
export const diaryPageSize = 15;
export const diaryView = actor => roles.includes(actor.role) ? {categories} : null;
const canUse = (actor,branch) => roles.includes(actor.role) && (!actor.branch||actor.branch===branch);
const people = (state,type) => type==='client'?state.clients:type==='carer'?state.staff:[];
export const canReadDiaryEntry = (actor,entry) => Boolean(entry&&canUse(actor,entry.branch));
export const diaryEntrySql = 'SELECT '+columns+' FROM aaa_diary WHERE id=?';

export function diaryListQuery(state,actor,params,requireCondition) {
  const type=params.get('type'), branch=params.get('branch')||actor.branch||'';
  const subject=params.get('subject')||'', category=params.get('category')||'';
  const page=Number(params.get('page')||0);
  requireCondition(roles.includes(actor.role)&&(!branch||canUse(actor,branch)),'You do not have access to this diary.',403);
  requireCondition(types.includes(type)&&(!branch||state.branches.includes(branch))&&(!category||categories.includes(category))&&Number.isInteger(page)&&page>=0&&page<=10000,'Invalid diary filter.');
  if(subject) requireCondition(people(state,type).some(person=>person.id===subject&&canUse(actor,person.branch)&&(!branch||person.branch===branch)),'You do not have access to this diary.',403);
  const where=['type=?'], values=[type];
  for(const [column,value] of [['branch',branch],['subject',subject],['category',category]]) {
    if(value) {where.push(column+'=?');values.push(value);}
  }
  return {sql:'SELECT '+columns+' FROM aaa_diary WHERE '+where.join(' AND ')+
    ' ORDER BY occurred_date DESC, occurred_time DESC, created_at DESC, id DESC LIMIT ? OFFSET ?',
    values:[...values,diaryPageSize+1,page*diaryPageSize]};
}
export function prepareDiaryEntry(state,actor,fields,parent,requireCondition) {
  const {type,subject,date}=fields, time=fields.time||null;
  const person=people(state,type).find(item=>item.id===subject);
  requireCondition(person&&canUse(actor,person.branch),'You do not have access to this diary.',403);
  if(fields.related) requireCondition(parent&&parent.id===fields.related&&parent.type===type&&parent.subject===subject&&parent.branch===person.branch,
    'The related entry is unavailable.',403);
  const note=typeof fields.note==='string'?fields.note.trim():'';
  const parsed=typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)?new Date(date+'T00:00:00Z'):null;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  requireCondition(parsed&&Number.isFinite(+parsed)&&parsed.toISOString().startsWith(date)&&date<=today,'Enter an event date up to today.');
  requireCondition(!time||(typeof time==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time)),'Enter a valid time.');
  requireCondition(categories.includes(fields.category)&&note&&note.length<=3500,'Choose a category and enter a note of up to 3,500 characters.');
  return [randomUUID(),type,subject,person.branch,person.name,fields.category,date,time,note,actor.label,new Date().toISOString(),parent?.id??null];
}
export const diaryInsertSql = 'INSERT INTO aaa_diary ('+columns+') SELECT '+Array(12).fill('?').join(',');
export function diaryList(rows) { return {entries:rows.slice(0,diaryPageSize),hasNext:rows.length>diaryPageSize}; }
