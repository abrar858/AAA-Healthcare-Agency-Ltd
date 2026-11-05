const types={client:'clients',carer:'staff'};
export const peopleView=actor=>['admin','manager','team_leader'].includes(actor.role);
export function profilePerson(state,actor,type,id) {
  if(!peopleView(actor)||!Object.hasOwn(types,type)) return null;
  const person=state[types[type]].find(item=>item.id===id&&(!actor.branch||actor.branch===item.branch));
  if(!person) return null;
  const patch=type==='client'&&state.patches.find(item=>item.id===person.patch&&item.branch===person.branch);
  return {id:person.id,type,name:person.name,branch:person.branch,patch:patch?.name??null,archived:Boolean(person.archivedAt)};
}
export function profileDirectory(state,actor,branch) {
  return Object.keys(types).flatMap(type=>state[types[type]].filter(person=>!person.archivedAt&&(!branch||person.branch===branch))
    .map(person=>profilePerson(state,actor,type,person.id)).filter(Boolean));
}
export function profileDocuments(entries,catalog,person) {
  const list=new Map();
  for(const entry of entries) {
    if(entry.subject!==person.id||entry.type!==person.type) continue;
    const label=catalog[entry.type].find(item=>item.key===entry.item)?.label;
    if(!label) continue;
    if(!list.has(entry.item)) list.set(entry.item,{item:entry.item,label,status:entry.status,due:entry.due,files:[],reference:entry.reference,reviewed:entry.reviewed});
    if(entry.hasPdf) list.get(entry.item).files.push({id:entry.id,reviewed:entry.reviewed});
  }
  return [...list.values()].sort((a,b)=>a.label.localeCompare(b.label));
}
export function personAssessmentRecords(view,person) {
  return (view?.records??[]).filter(record=>record.template.subject===person.type&&record.subject===person.id&&record.branch===person.branch)
    .map(record=>({id:record.id,title:record.template.title,date:record.date,completedAt:record.completedAt,by:record.updatedBy}));
}
export function personAutomaticActions(items,person,assessments) {
  const assessmentIds=new Set(assessments.map(record=>record.id));
  return items.filter(item=>{
    const [kind,typeOrId,id]=item.source.split(':');
    return item.branch===person.branch&&(kind==='compliance'&&typeOrId===person.type&&id===person.id||
      kind==='assessment'&&assessmentIds.has(typeOrId));
  });
}

export async function personProfile({state,actor,key,person,read,write,ownerRows,compliance,assessment,actions,diary,calendar,requireCondition}) {
  const records=personAssessmentRecords(assessment.assessmentView(state,actor),person);
  const evidence=profileDocuments(compliance.complianceProfileView(state,actor),compliance.catalog,person);
  const query=diary.diaryListQuery(state,actor,new URLSearchParams({branch:person.branch,type:person.type,subject:person.id}),requireCondition);
  const [diaryRows,appointmentRows,actionRows,manualRows,staff]=await Promise.all([
    read(query.sql,query.values),
    read(calendar.calendarPersonSql,[person.branch,person.type,person.id,key]),
    read(actions.actionRowsSql+' WHERE branch=?',[person.branch]),
    read(actions.diaryRowsSql+' WHERE d.branch=? AND d.type=? AND d.subject=?',[person.branch,person.type,person.id]),
    ownerRows(person.branch)
  ]);
  const owners=await actions.ownerAliases(staff);
  const automatic=personAutomaticActions(actions.automaticActions(state,actor,compliance.permittedCatalog(actor),person.branch),person,records);
  const rows=new Map(actionRows.map(row=>[row.source,row]));
  const defaults=automatic.filter(item=>!item.due&&!rows.has(item.source)).map(actions.defaultAction);
  if(defaults.length) {
    await write(actions.seedMissingSql,[new Date().toISOString(),JSON.stringify(defaults)]);
    for(const row of await read(actions.actionRowsSql+' WHERE branch=?',[person.branch])) rows.set(row.source,row);
  }
  const open=[...automatic,...manualRows.map(row=>actions.diaryAction(state,actor,row)).filter(Boolean)]
    .map(item=>actions.actionDetails(item,rows.get(item.source),owners)).filter(item=>item.status==='open')
    .sort((a,b)=>a.due.localeCompare(b.due)).map(({choices,...item})=>item);
  return {person,documents:evidence,assessments:records,diary:diary.diaryList(diaryRows),
    appointments:appointmentRows.slice(0,30).map(row=>calendar.calendarEntry(actor,key,row)),
    moreAppointments:appointmentRows.length>30,actions:open};
}
