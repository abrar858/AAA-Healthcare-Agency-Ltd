import { randomUUID } from 'node:crypto';

export const roles = ['admin', 'manager', 'hr', 'rota', 'accounts', 'carer'];
export const initialState = () => ({branches: [], patches: [], clients: [], staff: [], visits: [], requests: [], audit: []});
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireCondition(condition, message, status = 400) {
  if (!condition) throw new AppError(status, message);
}
const allowed = (actor, branch, ...roles) => roles.includes(actor.role) && (!actor.branch || actor.branch === branch);
const eligible = person => person?.cleared && person.checks && person.training;
const open = visit => !visit.cancelled && visit.assignments.length < visit.required;
const find = (list, id) => list.find(item => item.id === id);
const scoped = (actor, branch) => !actor.branch || actor.branch === branch;
const schedule = (actor, branch) => allowed(actor, branch, 'admin', 'manager', 'rota');
const requestCover = (actor, branch) => allowed(actor, branch, 'admin', 'manager');
const hr = (actor, branch) => allowed(actor, branch, 'admin', 'hr');

function text(value, max) {
  requireCondition(typeof value === 'string' && value.trim() && value.trim().length <= max, 'Enter a valid value.');
  return value.trim();
}
function minutes(value) {
  const number = Number(value);
  requireCondition(Number.isInteger(number) && number >= 1 && number <= 720, 'Enter between 1 and 720 minutes.');
  return number;
}
function start(visit) { return Date.parse(visit.date+'T'+visit.time+'Z'); }
function available(state, person, visit) {
  return eligible(person) && !state.visits.some(other => !other.cancelled && other.assignments.some(item => item.staff === person.id)
    && start(visit) < start(other)+other.minutes*60000 && start(other) < start(visit)+visit.minutes*60000);
}
function closeRequests(state, visit, status) {
  for (const request of state.requests) if (request.visit === visit.id && request.status === 'Pending') request.status = status;
}
function assign(state, visit, person) {
  visit.assignments.push({staff: person.id});
  if (!open(visit)) closeRequests(state, visit, 'Closed · filled');
}
function audit(state, actor, branch, message, area = 'operations', relatedBranch = null) {
  state.audit.unshift({branch, relatedBranch, message, area, by:actor.label, at:new Date().toISOString()});
}
const noAccess = condition => requireCondition(condition, 'You do not have access to this action.', 403);

export function applyAction(state, actor, action, id, fields) {
  if (action === 'add-branch') {
    noAccess(actor.role === 'admin');
    const branch = text(fields.name, 50);
    requireCondition(branch.toLowerCase() !== 'all branches' && !state.branches.some(name => name.toLowerCase() === branch.toLowerCase()), 'Enter a unique branch name.');
    state.branches.push(branch);
    audit(state, actor, branch, 'Branch created: '+branch+'.');
    return;
  }
  if (action === 'add-staff' || action === 'edit-staff') {
    const person = action === 'edit-staff' ? find(state.staff, id) : null;
    if (action === 'edit-staff') noAccess(person);
    const branch = person?.branch ?? fields.branch;
    noAccess(state.branches.includes(branch) && hr(actor, branch));
    const name = text(fields.name, 80);
    const checks = fields.checks === 'on', training = fields.training === 'on', cleared = fields.cleared === 'on';
    requireCondition(!cleared || (checks && training), 'Review both HR checks and training before clearing this carer.');
    const record = {id: person?.id ?? randomUUID(), name, branch, checks, training, cleared};
    if (person) Object.assign(person, record);
    else state.staff.push(record);
    audit(state, actor, branch, cleared ? name+' cleared for work.' : name+' saved as not cleared.', 'hr');
    return;
  }
  if (action === 'add-patch') {
    const branch = fields.branch;
    noAccess(state.branches.includes(branch) && requestCover(actor, branch));
    const name = text(fields.name, 60);
    requireCondition(!state.patches.some(patch => patch.branch === branch && patch.name.toLowerCase() === name.toLowerCase()), 'This branch already has a patch with that name.');
    state.patches.push({id:randomUUID(), name, branch});
    audit(state, actor, branch, 'Patch added: '+name+'.');
    return;
  }
  if (action === 'add-client') {
    const patch = find(state.patches, fields.patch);
    noAccess(patch && requestCover(actor, patch.branch));
    const name = text(fields.name, 80);
    state.clients.push({id:randomUUID(), name, branch:patch.branch, patch:patch.id});
    audit(state, actor, patch.branch, 'Client added: '+name+'.');
    return;
  }
  if (action === 'add-visit') {
    const client = find(state.clients, fields.client);
    noAccess(client && schedule(actor, client.branch));
    const {date, time} = fields, required = Number(fields.required);
    requireCondition(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && Number.isFinite(start({date,time})) && new Date(start({date,time})).toISOString().startsWith(date) && [1,2].includes(required), 'Enter a valid date, time and carer count.');
    state.visits.push({id:randomUUID(), client:client.id, branch:client.branch, date, time, minutes:minutes(fields.minutes), required, assignments:[], cancelled:false});
    audit(state, actor, client.branch, 'Visit scheduled for '+client.name+'.');
    return;
  }
  if (['approve','urgent','decline','withdraw'].includes(action)) {
    const request = find(state.requests, id);
    noAccess(request);
    const homeManager = actor.role === 'manager' && actor.branch === request.from;
    const admin = actor.role === 'admin';
    noAccess(action === 'withdraw' ? requestCover(actor, request.to) :
      action === 'urgent' ? admin : action === 'decline' ? homeManager || admin : homeManager);
    requireCondition(request.status === 'Pending', 'This request has already been resolved.', 409);
    const visit = find(state.visits, request.visit), person = find(state.staff, request.staff);
    if (action === 'withdraw') request.status = 'Withdrawn';
    else if (action === 'decline') request.status = 'Declined';
    else {
      requireCondition(visit && open(visit) && available(state, person, visit), 'The carer or visit is no longer available.', 409);
      request.status = action === 'urgent' ? 'Approved · urgent' : 'Approved';
      assign(state, visit, person);
    }
    audit(state, actor, request.to, 'Cover request for '+person.name+': '+request.status+'.', 'operations', request.from);
    return;
  }
  requireCondition(['allocate','request','cancel-visit','record'].includes(action), 'Unknown action.');
  const visit = find(state.visits, id);
  noAccess(visit);
  if (action === 'record') {
    const assignment = visit.assignments.find(item => item.staff === actor.staff);
    noAccess(actor.role === 'carer' && assignment);
    requireCondition(!visit.cancelled && assignment.minutes === undefined, 'This visit cannot be recorded.', 409);
    assignment.minutes = minutes(fields.minutes);
    assignment.note = text(fields.note, 500);
    audit(state, actor, visit.branch, 'Visit recorded by '+actor.label+'.');
    return;
  }
  noAccess(action === 'request' ? requestCover(actor, visit.branch) : schedule(actor, visit.branch));
  if (action === 'cancel-visit') {
    requireCondition(!visit.cancelled && visit.assignments.every(item => item.minutes === undefined), 'This visit cannot be cancelled.', 409);
    visit.cancelReason = text(fields.reason, 120);
    visit.cancelled = true;
    closeRequests(state, visit, 'Closed · cancelled');
    audit(state, actor, visit.branch, 'Visit cancelled for '+find(state.clients,visit.client).name+'. Reason: '+visit.cancelReason);
    return;
  }
  const person = find(state.staff, fields.staff);
  requireCondition(open(visit) && available(state, person, visit) && (action === 'request' ? person.branch !== visit.branch : person.branch === visit.branch), 'The carer or visit is no longer available.', 409);
  if (action === 'request') {
    requireCondition(!state.requests.some(item => item.visit === id && item.staff === person.id && item.status === 'Pending'), 'A pending request already exists for this carer.', 409);
    state.requests.push({id:randomUUID(), visit:id, staff:person.id, from:person.branch, to:visit.branch, status:'Pending'});
    audit(state, actor, visit.branch, 'Cover requested from '+person.branch+' for '+person.name+'.', 'operations', person.branch);
  } else {
    assign(state, visit, person);
    audit(state, actor, visit.branch, person.name+' allocated to the visit.');
  }
}

const summary = person => ({id:person.id, name:person.name, branch:person.branch, cleared:Boolean(eligible(person)), eligibilityOnly:true});
export function project(state, actor) {
  if (actor.role === 'admin') return state;
  const result = {...initialState(), branches:state.branches.filter(branch => scoped(actor,branch))};
  if (actor.role === 'hr') {
    result.staff = state.staff.filter(person => scoped(actor, person.branch));
    return result;
  }
  if (actor.role === 'carer') {
    result.visits = state.visits.filter(visit => visit.assignments.some(item => item.staff === actor.staff))
      .map(visit => ({...visit, assignments:visit.assignments.filter(item => item.staff === actor.staff), cancelReason:undefined}));
    result.clients = state.clients.filter(client => result.visits.some(visit => visit.client === client.id)).map(({id,name})=>({id,name}));
    return result;
  }
  const localVisits = state.visits.filter(visit => scoped(actor, visit.branch));
  const assignedStaff = new Set(localVisits.flatMap(visit => visit.assignments.map(item => item.staff)));
  if (actor.role === 'accounts') {
    result.visits = localVisits.map(visit => ({id:visit.id, branch:visit.branch, date:visit.date, time:visit.time,
      assignments:visit.assignments.filter(item => item.minutes !== undefined).map(({staff,minutes})=>({staff,minutes}))}));
    result.staff = state.staff.filter(person => assignedStaff.has(person.id)).map(({id,name,branch})=>({id,name,branch}));
    return result;
  }
  result.clients = state.clients.filter(client => scoped(actor, client.branch));
  result.patches = state.patches.filter(patch => scoped(actor, patch.branch));
  result.requests = actor.role === 'manager' ? state.requests.filter(request => actor.branch === request.from || actor.branch === request.to) : [];
  if (actor.role === 'rota') {
    result.visits = localVisits.map(visit => ({...visit, assignments:visit.assignments.map(({staff,minutes})=>({staff,minutes}))}));
    result.staff = state.staff.filter(person => scoped(actor, person.branch) || assignedStaff.has(person.id)).map(summary);
    return result;
  }
  const incoming = new Set(result.requests.filter(request => request.to !== actor.branch).map(request => request.visit));
  result.visits = [...localVisits, ...state.visits.filter(visit=>incoming.has(visit.id)).map(({id,branch,date,time})=>({id,branch,date,time,assignments:[]}))];
  result.coverCandidates = actor.role === 'manager' ? state.staff.filter(person=>person.branch!==actor.branch && eligible(person)).map(summary) : [];
  const coverStaff = new Set(result.requests.map(request => request.staff));
  result.staff = state.staff.filter(person => scoped(actor, person.branch) || assignedStaff.has(person.id) || coverStaff.has(person.id)).map(summary);
  result.audit = state.audit.filter(item => item.area !== 'hr' && (scoped(actor, item.branch) || actor.branch === item.relatedBranch));
  return result;
}
