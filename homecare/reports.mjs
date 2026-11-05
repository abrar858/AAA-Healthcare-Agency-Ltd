export const reportsView=actor=>actor.role==='admin'||actor.role==='manager';
const formatDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
function dateKey(value) {
  const date=new Date(value);
  return Number.isFinite(+date)?formatDate.format(date):'';
}
export function reportWeek(value,requireCondition) {
  const today=formatDate.format(new Date()), chosen=value||today;
  const date=new Date(chosen+'T00:00:00Z');
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(chosen)&&Number.isFinite(+date)&&date.toISOString().slice(0,10)===chosen&&chosen<=today,'Choose a valid date up to today.');
  date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
  const start=date.toISOString().slice(0,10);
  date.setUTCDate(date.getUTCDate()+6);
  const end=date.toISOString().slice(0,10);
  return {start,end,today};
}

export async function weeklyReport({state,actor,branch,week,read,write,ownerRows,compliance,assessment,actions}) {
  const branchNames=state.branches.filter(name=>(!actor.branch||actor.branch===name)&&(!branch||branch===name));
  const applies=name=>branchNames.includes(name);
  const inWeek=value=>{
    if(!value) return false;
    const day=dateKey(value);
    return day>=week.start&&day<=week.end;
  };
  const [previous,diaryRows,staff]=await Promise.all([
    read(actions.actionRowsSql+(branch?' WHERE branch=?':''),branch?[branch]:[]),
    read(actions.diaryRowsSql+(branch?' WHERE d.branch=?':''),branch?[branch]:[]),
    ownerRows(branch)
  ]);
  const owners=await actions.ownerAliases(staff), rows=new Map(previous.map(item=>[item.source,item]));
  const automatic=actions.automaticActions(state,actor,compliance.permittedCatalog(actor),branch);
  const defaults=automatic.filter(item=>!item.due&&!rows.has(item.source)).map(actions.defaultAction);
  for(let index=0;index<defaults.length;index+=200) {
    await write(actions.seedMissingSql,[new Date().toISOString(),JSON.stringify(defaults.slice(index,index+200))]);
  }
  if(defaults.length) {
    for(const row of await read(actions.actionRowsSql+(branch?' WHERE branch=?':''),branch?[branch]:[])) rows.set(row.source,row);
  }
  const diary=diaryRows.map(row=>actions.diaryAction(state,actor,row)).filter(Boolean);
  const open=[...automatic,...diary].map(item=>actions.actionDetails(item,rows.get(item.source),owners))
    .filter(item=>item.status==='open').sort((a,b)=>a.due.localeCompare(b.due)||a.title.localeCompare(b.title))
    .map(({choices,...item})=>item);
  const finished=[];
  for(const item of diary) {
    const row=rows.get(item.source);
    if(row?.status==='complete'&&inWeek(row.completed_at)) {
      const detail=actions.actionDetails(item,row,owners);
      finished.push({source:item.source,person:item.person,branch:item.branch,title:item.title,category:'Diary follow-up closed',date:dateKey(row.completed_at),owner:detail.ownerName});
    }
  }
  for(const record of assessment.assessmentView(state,actor)?.records??[]) {
    if(applies(record.branch)&&inWeek(record.completedAt)) finished.push({assessment:record.id,person:record.subjectName,branch:record.branch,
      title:record.template.title,category:'Assessment completed',date:dateKey(record.completedAt),owner:record.updatedBy});
  }
  const recorded=[];
  for(const entry of compliance.complianceView(state,actor)) {
    if(entry.status!=='recorded'||!inWeek(entry.at)) continue;
    const person=compliance.complianceSubject(state,entry.type,entry.subject);
    if(!person||!applies(person.branch)) continue;
    const definition=compliance.catalog[entry.type].find(item=>item.key===entry.item);
    recorded.push({source:'compliance:'+entry.type+':'+entry.subject+':'+entry.item,person:person.name,branch:person.branch,
      title:definition.label,date:dateKey(entry.at),owner:entry.by,profile:entry.type+':'+entry.subject});
  }
  const newest=(a,b)=>b.date.localeCompare(a.date)||a.person.localeCompare(b.person);
  return {week,open,finished:finished.sort(newest),recorded:recorded.sort(newest),branches:branchNames.map(branchName=>({
    branch:branchName,open:open.filter(item=>item.branch===branchName).length,
    overdue:open.filter(item=>item.branch===branchName&&item.due<week.today).length,
    closed:finished.filter(item=>item.branch===branchName).length,
    evidence:recorded.filter(item=>item.branch===branchName).length
  }))};
}
