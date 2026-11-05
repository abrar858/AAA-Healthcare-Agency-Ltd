// Fills a LOCAL development database with fictional test data for every tab.
// Usage (PowerShell):  $env:AAA_DB = "$HOME\.aaa-homecare\dev.sqlite"; node homecare/seed-demo.mjs
// Refuses to run without AAA_DB, or if the workspace already has clients (pass --force to add anyway).
// Every record goes through the app's own validation functions. Never point this at live data.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { applyAction, requireCondition } from './domain.mjs';
import { recordCompliance, todayUK } from './compliance.mjs';
import { changeAssessment } from './assessments.mjs';
import * as diary from './diary.mjs';
import * as calendar from './calendar.mjs';

if (!process.env.AAA_DB) { console.error('Set AAA_DB to your local development database first.'); process.exit(1); }
const db = new DatabaseSync(resolve(process.env.AAA_DB));
db.exec('PRAGMA busy_timeout=5000');
const hasTable = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
if (!hasTable('workspace') || !hasTable('aaa_calendar')) { console.error('Start the server once against this database before seeding.'); process.exit(1); }

const state = JSON.parse(db.prepare('SELECT body FROM workspace WHERE id=1').get().body);
if (state.clients.length && !process.argv.includes('--force')) {
  console.error('This workspace already has clients. Pass --force to add another set of test data.'); process.exit(1);
}

const admin = {label:'Head Office Admin', role:'admin', branch:null, staff:null};
const adminKey = 'admin@example.invalid';
const today = todayUK();
const day = offset => { const d = new Date(today+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+offset); return d.toISOString().slice(0,10); };
const last = list => list[list.length-1];
const act = (action, fields, id = '', actor = admin) => applyAction(state, actor, action, id, fields);

// --- Branches, patches, clients, carers ---------------------------------
const plan = {
  Preston:   {patches:['Fulwood','Ashton'],  clients:['Margaret Testwell','Harold Sample','Edith Demo','Walter Example'], carers:[['Alex Reed',true],['Jordan Lane',true],['Priya Placeholder',false]]},
  Blackburn: {patches:['Darwen'],            clients:['Dorothy Mockley','Frank Trial'],                                  carers:[['Robin West',true],['Casey Fiction',true]]},
  Blackpool: {patches:['South Shore'],       clients:['Irene Fakeham','Stanley Pretend'],                                carers:[['Sam Ellis',true],['Taylor Dummy',false]]}
};
for (const b of Object.keys(plan)) if (!state.branches.includes(b)) act('add-branch', {name:b});
const clients = {}, carers = {};
for (const [branch, p] of Object.entries(plan)) {
  for (const name of p.patches) act('add-patch', {branch, name});
  const patches = state.patches.filter(x => x.branch === branch);
  p.clients.forEach((name, i) => { act('add-client', {name, patch:patches[i % patches.length].id}); clients[name] = last(state.clients); });
  for (const [name, cleared] of p.carers) {
    act('add-staff', cleared ? {name, branch, checks:'on', training:'on', cleared:'on'} : {name, branch, checks:'on'});
    carers[name] = last(state.staff);
  }
}

// --- Visits: completed, allocated, needing cover, cover request, cancelled ---
const visit = (client, date, time, minutes = 45, required = 1) => {
  act('add-visit', {client:clients[client].id, date, time, minutes:String(minutes), required:String(required)});
  return last(state.visits);
};
const allocate = (v, carer) => act('allocate', {staff:carers[carer].id}, v.id);
const record = (v, carer, minutes, note) => {
  const c = carers[carer];
  act('record', {minutes:String(minutes), note}, v.id, {label:c.name, role:'carer', branch:c.branch, staff:c.id});
};
let v;
v = visit('Margaret Testwell', day(-2), '08:00', 45); allocate(v,'Alex Reed'); record(v,'Alex Reed',50,'Breakfast and medication prompt. All well.');
v = visit('Harold Sample', day(-1), '09:30', 30); allocate(v,'Jordan Lane'); record(v,'Jordan Lane',30,'Personal care completed.');
v = visit('Dorothy Mockley', day(-1), '10:00', 60); allocate(v,'Robin West'); record(v,'Robin West',55,'Shopping call. Fridge restocked.');
v = visit('Irene Fakeham', day(-3), '14:00', 45); allocate(v,'Sam Ellis'); record(v,'Sam Ellis',45,'Lunch call. Mentioned feeling tired.');
v = visit('Margaret Testwell', day(0), '12:00', 30); allocate(v,'Alex Reed');
v = visit('Edith Demo', day(0), '18:00', 60, 2); allocate(v,'Jordan Lane');               // needs a second carer
visit('Walter Example', day(1), '09:00', 45);                                             // unallocated, needs cover
v = visit('Harold Sample', day(2), '11:00', 30); act('request', {staff:carers['Robin West'].id}, v.id);   // cross-branch cover request
v = visit('Frank Trial', day(1), '15:00', 45); allocate(v,'Casey Fiction');
visit('Stanley Pretend', day(2), '10:30', 30);                                            // needs cover
v = visit('Irene Fakeham', day(3), '08:30', 45); act('cancel-visit', {reason:'Client in hospital (test data)'}, v.id);

// --- Compliance registers: recorded, overdue, due soon, not applicable, PDF ---
const pdfs = [];
const comply = (type, person, item, f) => {
  const current = (state.compliance ?? []).find(e => e.type===type && e.subject===person.id && e.item===item);
  const entry = recordCompliance(state, admin, {type, subject:person.id, item, previous:current?.id ?? '', ...f}, f.pdf ?? null, requireCondition);
  if (f.pdf) pdfs.push([entry.id, f.pdf]);
};
const ok = (reviewed, due, reference = 'Office file (test)') => ({status:'recorded', reviewed, due, reference});
const testPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
for (const name of ['Margaret Testwell','Harold Sample','Dorothy Mockley','Irene Fakeham']) {
  const c = clients[name];
  comply('client', c, 'assessment', ok(day(-60), day(120)));
  comply('client', c, 'care-plan', ok(day(-40), day(140)));
  comply('client', c, 'consent', ok(day(-60), ''));
  comply('client', c, 'lpa-finance', {status:'not-applicable', notes:'No LPA in place (test data).'});
}
comply('client', clients['Margaret Testwell'], 'risks', {...ok(day(-200), day(-10)), notes:'Overdue review (test).'});
comply('client', clients['Harold Sample'], 'review', ok(day(-170), day(12)));
comply('client', clients['Dorothy Mockley'], 'emergency', ok(day(-300), day(-3)));
comply('client', clients['Irene Fakeham'], 'risks', {status:'recorded', reviewed:day(-5), due:day(25), reference:'', pdf:testPdf});
comply('client', clients['Edith Demo'], 'assessment', {status:'missing', notes:'Awaiting assessment visit (test).'});
for (const name of ['Alex Reed','Jordan Lane','Robin West','Sam Ellis','Casey Fiction']) {
  const c = carers[name];
  comply('carer', c, 'identity', ok(day(-400), ''));
  comply('carer', c, 'dbs', ok(day(-300), day(800)));
  comply('carer', c, 'induction', ok(day(-380), ''));
  comply('carer', c, 'training', ok(day(-90), day(275)));
}
comply('carer', carers['Alex Reed'], 'supervision', ok(day(-100), day(-8)));
comply('carer', carers['Jordan Lane'], 'competencies', ok(day(-340), day(20)));
comply('carer', carers['Sam Ellis'], 'spot-check', ok(day(-30), day(5)));
comply('carer', carers['Robin West'], 'driving', {status:'not-applicable', notes:'Does not drive for work (test).'});

// --- Assessments: completed and draft ---
changeAssessment(state, admin, 'save-assessment', '', {template:'initial', subject:clients['Margaret Testwell'].id, date:day(-60), complete:true,
  answers:['Wants to stay independent at home.','Walking frame, key safe.','Falls risk: frame in reach, clear walkways.','Review in 6 months.']}, requireCondition);
changeAssessment(state, admin, 'save-assessment', '', {template:'risk', subject:clients['Edith Demo'].id, date:day(-1), complete:false,
  answers:['Kitchen use','Client','',''], version:0}, requireCondition);
changeAssessment(state, admin, 'save-assessment', '', {template:'competency', subject:carers['Alex Reed'].id, date:day(-20), complete:true,
  answers:['Medication prompting','Observed correct MAR completion.','Competent','']}, requireCondition);
changeAssessment(state, admin, 'save-assessment', '', {template:'supervision', subject:carers['Sam Ellis'].id, date:day(-2), complete:false,
  answers:['Settling in well.','',''], version:0}, requireCondition);

// --- Diary entries ---
const diaryRows = [];
const note = (type, person, category, offset, time, text) =>
  diaryRows.push(diary.prepareDiaryEntry(state, admin, {type, subject:person.id, date:day(offset), time, category, note:text}, null, requireCondition));
note('client', clients['Margaret Testwell'], 'Phone call', -1, '10:15', 'Daughter called to confirm Friday visit time (test).');
note('client', clients['Irene Fakeham'], 'Concern / escalation', -3, '15:00', 'Client reported tiredness. GP contact suggested (test).');
note('client', clients['Dorothy Mockley'], 'Visit change', 0, '09:00', 'Requested later morning calls from next week (test).');
note('client', clients['Harold Sample'], 'General note', -5, null, 'New key safe code issued by office (test).');
note('carer', carers['Jordan Lane'], 'Communication', -2, '16:30', 'Asked about extra weekend shifts (test).');
note('carer', carers['Sam Ellis'], 'Follow-up / correction', -1, '11:00', 'Timesheet corrected for Tuesday (test).');

// --- Calendar: branch and private events, reminders, linked people ---
const events = [];
const event = (branch, title, kind, offset, time, f = {}) =>
  events.push(calendar.prepareCalendar(state, admin, adminKey, {branch, title, kind, start_at:day(offset)+'T'+time, audience:'branch', status:'scheduled', notes:'', ...f}, null, requireCondition));
event('Preston', 'Team meeting', 'Meeting', 1, '10:00', {end_at:day(1)+'T11:00'});
event('Preston', 'Care review visit', 'Appointment', 3, '14:00', {subject_type:'client', subject_id:clients['Harold Sample'].id, reminder_at:day(2)+'T09:00'});
event('Preston', 'Supervision with Alex Reed', 'Appointment', 6, '13:00', {subject_type:'carer', subject_id:carers['Alex Reed'].id});
event('Preston', 'Order PPE stock', 'Reminder', 0, '16:00', {reminder_at:day(0)+'T08:00', audience:'private'});
event('Blackburn', 'Initial assessment', 'Assessment due', 4, '11:00', {subject_type:'client', subject_id:clients['Frank Trial'].id});
event('Blackpool', 'Spot check', 'Appointment', 2, '09:30', {subject_type:'carer', subject_id:carers['Sam Ellis'].id});
event('Blackpool', 'Training day', 'Other', 10, '09:00', {end_at:day(10)+'T16:00'});

// --- Save everything in one transaction ---
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
  for (const [id, body] of pdfs) db.prepare('INSERT INTO compliance_pdfs VALUES (?,?)').run(id, body);
  for (const row of diaryRows) db.prepare(diary.diaryInsertSql).run(...row);
  for (const e of events) db.prepare(e.sql).run(...e.args);
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }
console.log(`Seeded ${Object.keys(clients).length} clients, ${Object.keys(carers).length} carers, ${state.visits.length} visits, `+
  `${state.compliance.length} compliance entries, ${state.assessments.length} assessments, ${diaryRows.length} diary notes, ${events.length} calendar events.`);
