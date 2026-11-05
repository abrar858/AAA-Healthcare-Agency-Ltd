const allowedRoles=['admin','manager','team_leader'];
export const actionsView=actor=>allowedRoles.includes(actor.role);
const typeMap={client:'clients',carer:'staff'};
const scoped=(actor,branch)=>actionsView(actor)&&(!actor.branch||actor.branch===branch);
export const actionsToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const addDays=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&addDays(value,0)===value;
const competenceKeys=['competencies','medication-competency','moving-competency','specialist-competency'];
const sourceRecord=(source,branch,person,title,category,due)=>({source,branch,person,title,category,due});

export function automaticActions(state,actor,catalog,branch='') {
  const today=actionsToday(), soon=addDays(today,30);
  const view=branchName=>scoped(actor,branchName)&&(!branch||branch===branchName);
  const latest=new Map();
  for(const item of state.compliance??[]) {
    const key=[item.type,item.subject,item.item].join(':');
    if(!latest.has(key)) latest.set(key,item);
  }
  const list=[];
  for(const type of ['client','carer']) {
    for(const person of state[typeMap[type]].filter(person=>!person.archivedAt&&view(person.branch))) {
      for(const definition of catalog[type]) {
        const key=[type,person.id,definition.key].join(':');
        const entry=latest.get(key);
        const missing=entry?.status==='missing'||(!entry&&!definition.optional);
        const overdue=entry?.status==='recorded'&&entry.due&&entry.due<today;
        const expiring=entry?.status==='recorded'&&entry.due&&entry.due>=today&&entry.due<=soon&&type==='carer'&&competenceKeys.includes(definition.key);
        if(!missing&&!overdue&&!expiring) continue;
        const category=missing?'Missing evidence':overdue?'Overdue review':'Expiring competency';
        list.push({...sourceRecord('compliance:'+key+':'+(entry?.id??'missing'),person.branch,person.name,definition.label,category,
          missing?null:entry.due),restricted:Boolean(definition.restricted)});
      }
    }
  }
  for(const record of state.assessments??[]) {
    const person=state[typeMap[record.template.subject]]?.find(item=>item.id===record.subject);
    if(!record.completedAt&&person&&!person.archivedAt&&view(record.branch)) {
      list.push(sourceRecord('assessment:'+record.id,record.branch,record.subjectName,record.template.title,'Unfinished assessment',record.date));
    }
  }
  return list;
}
export function diaryAction(state,actor,row) {
  if(!row||!scoped(actor,row.branch)) return null;
  const person=state[typeMap[row.type]]?.find(item=>item.id===row.subject&&item.branch===row.branch);
  if(!person) return null;
  return sourceRecord('diary:'+row.id,row.branch,row.person,row.category,'Diary follow-up',null);
}
export async function ownerAliases(rows) {
  return Promise.all(rows.map(async row=>{
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.email));
    const key=Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
    return {key,label:row.label,role:row.role,branch:row.branch};
  }));
}
export function ownerChoices(owners,item) {
  const choices=[{key:'head-office',label:'Head Office Admin'}];
  if(item.restricted) return choices;
  return [{key:'branch-manager',label:'Branch manager (queue)'},...choices,
    ...owners.filter(owner=>owner.branch===item.branch&&(owner.role==='manager'||!item.source.startsWith('compliance:')))];
}
export function defaultAction(item) {
  return {source:item.source,branch:item.branch,owner:item.restricted?'head-office':'branch-manager',due:item.due??addDays(actionsToday(),7),status:'open',version:0};
}
export function actionDetails(item,row,owners) {
  const choices=ownerChoices(owners,item);
  const fallback=defaultAction(item);
  const owner=choices.find(owner=>owner.key===row?.owner);
  return {...item,sourceDue:item.due,due:row?.due??fallback.due,owner:owner?.key??fallback.owner,
    ownerName:owner?.label??choices[0].label,ownerUnavailable:Boolean(row&&!owner),
    status:row?.status??'open',version:row?.version??0,choices};
}
export const actionRowSql='SELECT source,branch,owner,due,status,version,completed_at FROM aaa_actions WHERE source=?';
export const actionRowsSql='SELECT source,branch,owner,due,status,version,completed_at FROM aaa_actions';
export const diaryRowsSql="SELECT d.id,d.type,d.subject,d.branch,d.person,d.category FROM aaa_actions a JOIN aaa_diary d ON a.source='diary:'||d.id";
export const seedMissingSql="INSERT OR IGNORE INTO aaa_actions(source,branch,owner,due,status,version,changed_by,changed_at) SELECT json_extract(value,'$.source'),json_extract(value,'$.branch'),json_extract(value,'$.owner'),json_extract(value,'$.due'),'open',0,'System',? FROM json_each(?)";
export function updateAction(item,row,fields,owners,actor,requireCondition) {
  requireCondition(item,'This action is unavailable or has been resolved.',404);
  const owner=fields.owner, due=fields.due, status=fields.status;
  requireCondition(ownerChoices(owners,item).some(option=>option.key===owner)&&validDate(due),'Choose an authorised owner and a valid due date.');
  requireCondition(status==='open'||(item.source.startsWith('diary:')&&status==='complete'),'Resolve automatic actions at their source.');
  requireCondition(Number(fields.version)===(row?.version??0),'This action has changed. Reload before editing.',409);
  const version=(row?.version??0)+1, changedAt=new Date().toISOString();
  const completedAt=status==='complete'?(row?.status==='complete'?row.completed_at:changedAt):null;
  const sql=row?
    'UPDATE aaa_actions SET owner=?,due=?,status=?,version=?,changed_by=?,changed_at=?,completed_at=? WHERE source=? AND version=?':
    'INSERT OR IGNORE INTO aaa_actions(owner,due,status,version,changed_by,changed_at,completed_at,source,branch) SELECT ?,?,?,?,?,?,?,?,?';
  return {sql,args:[owner,due,status,version,actor.label,changedAt,completedAt,item.source,row?.version??item.branch]};
}
