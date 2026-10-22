import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
const clone = value => structuredClone(value);
const roles = ['owner', 'member', 'viewer'];
const statuses = ['todo', 'active', 'review', 'done', 'blocked'];
export function collabError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function requireValue(ok, code = 'INVALID_INPUT', status = 400) { if (!ok) throw collabError(code, status); }
function text(value, max = 2000, required = false) { requireValue(typeof value === 'string' && value.length <= max && (!required || value.trim())); return value.trim(); }
function date(value, day = false) { if (!value) return ''; requireValue(typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) && (!day || /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value)); return value; }
function ids(value) { requireValue(Array.isArray(value) && value.length <= 80 && value.every(v => typeof v === 'string' && v.length < 80)); return [...new Set(value)]; }
const digest = token => createHash('sha256').update(token).digest('hex');
const groupFields = ['name', 'goal', 'content', 'deliverables', 'startDate', 'endDate', 'deadline', 'materials', 'sharing'];
const stepFields = ['name', 'description', 'ownerId', 'participantIds', 'startsAt', 'dueAt', 'dependsOn', 'criteria', 'result', 'reviewerId', 'methodId'];
const criticalStep = ['ownerId', 'participantIds', 'reviewerId', 'criteria', 'startsAt', 'dueAt', 'dependsOn'];
export const AI_FIELDS = ['goal', 'content', 'deliverables', 'deadlines', 'members', 'steps', 'results', 'materials'];
function member(group, actor) { const row = group.members.find(m => m.userId === actor.id && m.active); requireValue(row, 'FORBIDDEN', 403); return row; }
function owner(group, actor) { requireValue(member(group, actor).role === 'owner', 'FORBIDDEN', 403); }
function writer(group, actor) { requireValue(member(group, actor).role !== 'viewer', 'FORBIDDEN', 403); }
function active(group, id) { return group.members.some(m => m.userId === id && m.active); }
function validateGroup(group) {
 group.name = text(group.name, 120, true); group.goal = text(group.goal, 3000); group.content = text(group.content, 6000); group.deliverables = text(group.deliverables, 3000);
 group.startDate = date(group.startDate, true); group.endDate = date(group.endDate, true); group.deadline = date(group.deadline);
 requireValue(!group.startDate || !group.endDate || group.startDate <= group.endDate, 'INVALID_DATES');
 requireValue(Array.isArray(group.materials) && group.materials.length <= 15);
 group.materials = group.materials.map(m => ({ id: typeof m.id === 'string' && /^[\w-]{1,80}$/.test(m.id) ? m.id : randomUUID(), title: text(m.title, 160, true), content: text(m.content || '', 6000), shared: m.shared === true, aiAllowed: m.aiAllowed === true }));
 requireValue(group.sharing && typeof group.sharing === 'object' && Array.isArray(group.sharing.fields) && group.sharing.fields.every(f => AI_FIELDS.includes(f)));
 group.sharing = { aiAllowed: group.sharing.aiAllowed === true, fields: [...new Set(group.sharing.fields)] };
 requireValue(group.steps.length <= 80);
 for (const step of group.steps) {
  step.name = text(step.name, 160, true); step.description = text(step.description, 3000); step.criteria = text(step.criteria, 2000); step.result = text(step.result, 6000);
  step.startsAt = date(step.startsAt); step.dueAt = date(step.dueAt);
  requireValue(!step.methodId || group.methods.some(method => method.id === step.methodId), 'INVALID_METHOD');
  requireValue(!step.startsAt || !step.dueAt || Date.parse(step.startsAt) <= Date.parse(step.dueAt), 'INVALID_DATES');
  requireValue(statuses.includes(step.status)); step.participantIds = ids(step.participantIds); step.dependsOn = ids(step.dependsOn);
  requireValue(!step.ownerId || active(group, step.ownerId), 'MEMBER_UNAVAILABLE');
  requireValue(!step.reviewerId || active(group, step.reviewerId), 'MEMBER_UNAVAILABLE');
  requireValue(step.participantIds.every(id => active(group, id)), 'MEMBER_UNAVAILABLE');
  requireValue(!step.ownerId || group.members.find(m => m.userId === step.ownerId).role !== 'viewer', 'FORBIDDEN', 403);
  requireValue(step.dependsOn.every(id => id !== step.id && group.steps.some(s => s.id === id)), 'INVALID_DEPENDENCY');
 }
 function visit(id, path = new Set()) { requireValue(!path.has(id), 'DEPENDENCY_CYCLE'); const next = new Set([...path, id]); group.steps.find(s => s.id === id).dependsOn.forEach(dep => visit(dep, next)); }
 group.steps.forEach(step => visit(step.id));
}
function newStep(data, actor) { return { id: randomUUID(), revision: 1, termsVersion: 1, name: '', description: '', ownerId: null, reviewerId: null, participantIds: [], startsAt: '', dueAt: '', dependsOn: [], criteria: '', result: '', status: 'todo', archived: false, createdBy: actor.id, ...Object.fromEntries(Object.entries(data).filter(([key]) => stepFields.includes(key))) }; }
function addConfirmation(group, target, actor, reason, now) {
 const step = target && group.steps.find(s => s.id === target);
 const required = step ? [...new Set([step.ownerId, step.reviewerId, ...step.participantIds].filter(id => id && active(group, id)))] : group.members.filter(m => m.active && m.role !== 'viewer').map(m => m.userId);
 group.confirmations.push({ id: randomUUID(), objectId: target || null, version: step ? step.termsVersion : group.termsVersion, required, confirmed: [], createdAt: now, actorId: actor.id, reason });
}
export function createCollaborationStore({ databaseFile, now = () => new Date().toISOString(), userById }) {
 if (databaseFile !== ':memory:') mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
 const db = new DatabaseSync(databaseFile); if (databaseFile !== ':memory:') chmodSync(databaseFile, 0o600);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS collab_groups(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS collab_audit(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, at TEXT NOT NULL, operation TEXT NOT NULL, target TEXT, reason TEXT NOT NULL, version INTEGER NOT NULL, before_json TEXT, after_json TEXT);
 CREATE TABLE IF NOT EXISTS collab_invites(token_hash TEXT PRIMARY KEY, group_id TEXT NOT NULL, role TEXT NOT NULL, expires_at TEXT NOT NULL, used_by TEXT, revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS collab_links(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, step_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(group_id,step_id,user_id));
 CREATE TABLE IF NOT EXISTS collab_proposals(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL, policy_version INTEGER NOT NULL, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS collab_meta(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO collab_meta(version) VALUES (1);`);
 const load = id => { const row = db.prepare('SELECT body FROM collab_groups WHERE id=?').get(id); requireValue(row, 'NOT_FOUND', 404); return JSON.parse(row.body); };
 const persist = group => db.prepare('INSERT OR REPLACE INTO collab_groups(id,body) VALUES (?,?)').run(group.id, JSON.stringify(group));
 if(!db.prepare('PRAGMA table_info(collab_invites)').all().some(column=>column.name==='reusable'))db.exec('ALTER TABLE collab_invites ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0');
 function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
 function log(actor, group, op, target, reason, before, after) { db.prepare('INSERT INTO collab_audit VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), group.id, actor.id, actor.displayName, now(), op, target || null, reason || '', group.revision, JSON.stringify(before), JSON.stringify(after)); }
 function project(group, actor) { const role = member(group, actor).role; const out = clone(group); out.myRole = role; out.materials = out.materials.filter(m => m.shared || role === 'owner'); out.members.forEach(m => { const user = userById && userById(m.userId); if (user) m.name = user.displayName; }); return out; }
 function changeState(actor, group, input) {
  const before = clone(group), data = input.data || {}, op = input.op, stamp = now(), role = member(group, actor).role;
  requireValue(Number.isInteger(input.revision) && group.revision === input.revision, 'CONFLICT', 409);
  requireValue(typeof op === 'string'); const reason = text(input.reason || '', 500);
  requireValue(!group.archived || ['reopen', 'leave'].includes(op), 'ARCHIVED', 409);
  const step = input.stepId && group.steps.find(s => s.id === input.stepId);
  if (op === 'group-edit') {
   owner(group, actor); for (const key of Object.keys(data)) requireValue(groupFields.includes(key)); Object.assign(group, clone(data));
   const critical = ['deliverables', 'deadline', 'startDate', 'endDate'].some(key => JSON.stringify(before[key]) !== JSON.stringify(group[key]));
   if (JSON.stringify(before.sharing) !== JSON.stringify(group.sharing) || JSON.stringify(before.materials) !== JSON.stringify(group.materials)) group.policyVersion++;
   if (critical) { requireValue(reason, 'REASON_REQUIRED'); group.termsVersion++; addConfirmation(group, null, actor, reason, stamp); }
  } else if (op === 'step-add') {
   writer(group, actor); const added = newStep(data, actor); if (role !== 'owner') requireValue(!added.ownerId || added.ownerId === actor.id, 'FORBIDDEN', 403); group.steps.push(added); addConfirmation(group, added.id, actor, reason, stamp);
  } else if (['step-edit', 'step-archive', 'step-order', 'step-status'].includes(op)) {
   requireValue(step, 'NOT_FOUND', 404); writer(group, actor); requireValue(role === 'owner' || step.ownerId === actor.id || step.participantIds.includes(actor.id) || step.reviewerId === actor.id, 'FORBIDDEN', 403);
   if (op === 'step-edit') {
    for (const key of Object.keys(data)) requireValue(stepFields.includes(key));
    const previous = clone(step); Object.assign(step, clone(data));
    if (criticalStep.some(key => JSON.stringify(previous[key]) !== JSON.stringify(step[key]))) { owner(group, actor); requireValue(reason, 'REASON_REQUIRED'); step.termsVersion++; addConfirmation(group, step.id, actor, reason, stamp); const check=group.confirmations.at(-1); check.required=[...new Set([...check.required,previous.ownerId,previous.reviewerId,...previous.participantIds].filter(id=>id&&active(group,id)))]; }
    if (previous.status === 'done' && (previous.result !== step.result || previous.criteria !== step.criteria)) { step.status='review'; delete step.reviewedBy; delete step.reviewedAt; }
   } else if (op === 'step-archive') { owner(group, actor); step.archived = !step.archived; }
   else if (op === 'step-order') { owner(group, actor); requireValue([-1, 1].includes(data.direction)); const i = group.steps.indexOf(step), j = i + data.direction; requireValue(j >= 0 && j < group.steps.length); group.steps.splice(i, 1); group.steps.splice(j, 0, step); }
   else {
    requireValue(statuses.includes(data.status)); requireValue(!step.archived, 'ARCHIVED', 409);
    if (data.status === 'done') { requireValue(role === 'owner' || step.reviewerId === actor.id, 'FORBIDDEN', 403); requireValue(step.status === 'review', 'REVIEW_REQUIRED', 409); requireValue(step.result.trim(), 'RESULT_REQUIRED');
      requireValue(!group.confirmations.some(c => ((!c.objectId && c.version === group.termsVersion) || (c.objectId === step.id && c.version === step.termsVersion)) && c.required.some(id => active(group,id) && !c.confirmed.includes(id))), 'CONFIRMATION_REQUIRED', 409);
      step.reviewedBy = actor.id; step.reviewedAt = stamp;
    } else requireValue(role === 'owner' || step.ownerId === actor.id || step.participantIds.includes(actor.id), 'FORBIDDEN', 403);
    if (data.status === 'active' || data.status === 'review') requireValue(step.dependsOn.every(id => group.steps.find(s => s.id === id)?.status === 'done'), 'DEPENDENCY_BLOCKED', 409);
    if (data.result !== undefined) step.result = text(data.result, 6000);
    if (data.status === 'review') requireValue(step.result.trim(), 'RESULT_REQUIRED');
    step.status = data.status;
    if (data.status === 'blocked') step.blockReason = reason;
    else delete step.blockReason;
   }
   step.revision++;
  } else if (op === 'confirm') {
   const confirmation = group.confirmations.find(c => c.id === input.confirmationId); requireValue(confirmation && confirmation.required.includes(actor.id), 'FORBIDDEN', 403);
   requireValue(confirmation.version === (confirmation.objectId ? group.steps.find(s => s.id === confirmation.objectId)?.termsVersion : group.termsVersion), 'STALE_CONFIRMATION', 409);
   if (!confirmation.confirmed.includes(actor.id)) confirmation.confirmed.push(actor.id);
  } else if (['archive', 'reopen'].includes(op)) { owner(group, actor); group.archived = op === 'archive'; }
  else if (op === 'leave' || op === 'member-remove' || op === 'member-role') {
   const who = op === 'leave' ? actor.id : input.userId, target = group.members.find(m => m.active && m.userId === who); requireValue(target, 'NOT_FOUND', 404);
   if (op !== 'leave') owner(group, actor);
   requireValue(!(target.role === 'owner' && group.members.filter(m => m.active && m.role === 'owner').length === 1 && (op !== 'member-role' || data.role !== 'owner')), 'LAST_OWNER', 409);
   if (op === 'member-role') { requireValue(roles.includes(data.role)); target.role = data.role; } else { target.active = false; target.leftAt = stamp; }
   group.policyVersion++;
   db.prepare('UPDATE collab_invites SET revoked=1 WHERE group_id=? AND used_by IS NULL').run(group.id);
   for (const item of group.steps) { if (item.ownerId === who && (!target.active || target.role === 'viewer')) item.ownerId = null; if (!target.active) { item.participantIds = item.participantIds.filter(id => id !== who); if (item.reviewerId === who) item.reviewerId = null; } }
  } else if (op === 'method-save') {
   writer(group, actor); requireValue(group.methods.length < 80);
   group.methods.push({ id: randomUUID(), name: text(data.name, 120, true), conditions: text(data.conditions || '', 1500), prompt: text(data.prompt || '', 4000), model: text(data.model || '', 100), verify: text(data.verify || '', 2000), result: text(data.result || '', 2000), stepId: step?.id || null, createdBy: actor.id, createdAt: stamp, version: 1 });
  } else if (op === 'restore') {
   owner(group, actor); requireValue(reason, 'REASON_REQUIRED'); const row = db.prepare('SELECT after_json FROM collab_audit WHERE id=? AND group_id=?').get(input.historyId, group.id); requireValue(row, 'NOT_FOUND', 404); const snapshot = JSON.parse(row.after_json); requireValue(snapshot && Array.isArray(snapshot.steps));
   for (const key of ['name', 'goal', 'content', 'deliverables', 'startDate', 'endDate', 'deadline', 'steps']) group[key] = clone(snapshot[key]);
   group.termsVersion++; addConfirmation(group, null, actor, reason, stamp);
   for (const item of group.steps) {
    const current = before.steps.find(step => step.id === item.id);
    if (!active(group,item.ownerId)) item.ownerId = null;
    if (!active(group,item.reviewerId)) item.reviewerId = null;
    item.participantIds = item.participantIds.filter(id => active(group,id));
    item.termsVersion = Math.max(item.termsVersion, current?.termsVersion || 0) + 1;
    item.revision = Math.max(item.revision, current?.revision || 0) + 1;
    if (item.status === 'done') item.status = 'review';
    delete item.reviewedBy; delete item.reviewedAt;
    addConfirmation(group,item.id,actor,reason,stamp);
   }
  } else throw collabError('INVALID_OPERATION');
  validateGroup(group); group.revision++; group.updatedAt = stamp;
  log(actor, group, op, input.stepId, reason, before, group); persist(group); return group;
 }
  const api = {
  close: () => db.close(),
  countUserResources(userId){const groups=db.prepare('SELECT body FROM collab_groups').all().map(row=>JSON.parse(row.body));return groups.filter(group=>active(group,userId)).length+Number(db.prepare('SELECT COUNT(*) AS count FROM collab_links WHERE user_id=?').get(userId).count)+Number(db.prepare('SELECT COUNT(*) AS count FROM collab_proposals WHERE user_id=?').get(userId).count);},
  removeUserResources(actor,userId){return transaction(()=>{
   const groups=db.prepare('SELECT body FROM collab_groups').all().map(row=>JSON.parse(row.body)).filter(group=>active(group,userId));
   for(const group of groups){const membership=group.members.find(m=>m.active&&m.userId===userId);requireValue(!(membership.role==='owner'&&group.members.filter(m=>m.active&&m.role==='owner').length===1&&group.members.some(m=>m.active&&m.userId!==userId)),'ACCOUNT_OWNS_GROUPS',409);}
   for(const group of groups){const before=clone(group),stamp=now();const membership=group.members.find(m=>m.userId===userId);membership.active=false;membership.leftAt=stamp;
    for(const step of group.steps){if(step.ownerId===userId||step.reviewerId===userId||step.participantIds.includes(userId)){if(step.ownerId===userId)step.ownerId=null;if(step.reviewerId===userId)step.reviewerId=null;step.participantIds=step.participantIds.filter(id=>id!==userId);step.revision++;step.termsVersion++;addConfirmation(group,step.id,actor,'账号已由管理员删除',stamp);}}
    if(!group.members.some(m=>m.active))group.archived=true;group.policyVersion++;group.revision++;group.updatedAt=stamp;db.prepare('UPDATE collab_invites SET revoked=1 WHERE group_id=?').run(group.id);log(actor,group,'account-delete',userId,'账号已由管理员删除',before,group);persist(group);
   }
   db.prepare('DELETE FROM collab_links WHERE user_id=?').run(userId);db.prepare('DELETE FROM collab_proposals WHERE user_id=?').run(userId);
  });},
  create(actor, data) { return transaction(() => {
   requireValue(actor && typeof actor.id === 'string', 'AUTH_REQUIRED', 401); const stamp = now();
   const group = { id: randomUUID(), revision: 1, termsVersion: 1, policyVersion: 1, name: data.name, goal: data.goal || '', content: data.content || '', deliverables: data.deliverables || '', startDate: data.startDate || '', endDate: data.endDate || '', deadline: data.deadline || '', materials: data.materials || [], sharing: data.sharing || { aiAllowed: false, fields: ['goal', 'steps'] }, members: [{ userId: actor.id, name: actor.displayName, role: 'owner', active: true, joinedAt: stamp }], steps: [], methods: [], confirmations: [], archived: false, createdAt: stamp, updatedAt: stamp };
   validateGroup(group); persist(group); log(actor,group,'create',null,'',null,group); return project(group,actor);
  }); },
  list(actor) { return db.prepare('SELECT body FROM collab_groups ORDER BY rowid DESC').all().map(row => JSON.parse(row.body)).filter(group => group.members.some(m => m.active && m.userId === actor.id)).map(group => ({ id: group.id, name: group.name, goal: group.goal, revision: group.revision, archived: group.archived, members: group.members.filter(m => m.active).length, completed: group.steps.filter(s => !s.archived && s.status === 'done').length, steps: group.steps.filter(s => !s.archived).length })); },
  get(actor, id) { return project(load(id), actor); },
  change(actor, id, input) { return transaction(() => { const group = changeState(actor,load(id),input); return group.members.some(m => m.active && m.userId === actor.id) ? project(group,actor) : { id, left: true, revision: group.revision }; }); },
  invite(actor,id,input){return transaction(()=>{const group=load(id);owner(group,actor);requireValue(!group.archived,'ARCHIVED',409);requireValue(input.revision===group.revision,'CONFLICT',409);requireValue(['member','viewer'].includes(input.role));const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';const token=Array.from(randomBytes(20),byte=>alphabet[byte&31]).join('');const passphrase=token.match(/.{5}/g).join('-');const expiresAt=new Date(Date.parse(now())+7*86400000).toISOString();db.prepare('UPDATE collab_invites SET revoked=1 WHERE group_id=? AND role=? AND reusable=1').run(id,input.role);db.prepare('INSERT INTO collab_invites(token_hash,group_id,role,expires_at,reusable) VALUES (?,?,?,?,1)').run(digest(token),id,input.role,expiresAt);log(actor,group,'invite',null,'',null,{role:input.role,expiresAt});return {token,passphrase,expiresAt};});},
  join(actor, token) { return transaction(() => { requireValue(typeof token === 'string' && token.length >= 20 && token.length <= 100,'INVITE_INVALID'); const normalized=token.toUpperCase().replace(/[\s-]/g,'');if(/^[A-HJ-NP-Z2-9]{20}$/.test(normalized))token=normalized; const row = db.prepare('SELECT * FROM collab_invites WHERE token_hash=?').get(digest(token)); requireValue(row && !row.revoked && row.expires_at > now(),'INVITE_INVALID'); const group = load(row.group_id); requireValue(!group.archived,'ARCHIVED',409); if (active(group,actor.id)) return project(group,actor); requireValue(row.reusable||!row.used_by,'INVITE_INVALID'); requireValue(group.members.filter(m=>m.active).length<100,'GROUP_FULL'); const before=clone(group); const old=group.members.find(m=>m.userId===actor.id); const membership={userId:actor.id,name:actor.displayName,role:row.role,active:true,joinedAt:now()}; if(old)Object.assign(old,membership);else group.members.push(membership); group.revision++;group.policyVersion++;group.updatedAt=now();if(!row.reusable)db.prepare('UPDATE collab_invites SET used_by=? WHERE token_hash=?').run(actor.id,digest(token));persist(group);log(actor,group,'join',null,'',before,group);return project(group,actor); }); },
  history(actor,id) { const group=load(id);member(group,actor);return db.prepare('SELECT * FROM collab_audit WHERE group_id=? ORDER BY rowid DESC LIMIT 100').all(id).map(row=>{const filter=raw=>{const value=JSON.parse(raw);if(value&&Array.isArray(value.materials)&&member(group,actor).role!=='owner')value.materials=value.materials.filter(m=>m.shared&&group.materials.some(current=>current.id===m.id&&current.shared));return value;};return {id:row.id,actorId:row.actor_id,actorName:row.actor_name,at:row.at,operation:row.operation,target:row.target,reason:row.reason,version:row.version,before:filter(row.before_json),after:filter(row.after_json)};}); },
  personal(actor,id,stepId) { return transaction(()=>{const group=load(id);writer(group,actor);requireValue(!group.archived,'ARCHIVED',409);const step=group.steps.find(s=>s.id===stepId&&!s.archived);requireValue(step&&step.ownerId===actor.id,'FORBIDDEN',403);requireValue(!group.confirmations.some(c=>(!c.objectId&&c.version===group.termsVersion||c.objectId===step.id&&c.version===step.termsVersion)&&c.required.includes(actor.id)&&!c.confirmed.includes(actor.id)),'CONFIRMATION_REQUIRED',409);const old=db.prepare('SELECT body FROM collab_links WHERE group_id=? AND step_id=? AND user_id=?').get(id,stepId,actor.id);if(old)return {...JSON.parse(old.body),currentStep:clone(step),groupRevision:group.revision};const link={id:randomUUID(),groupId:id,stepId,userId:actor.id,groupName:group.name,stepRevision:step.revision,eventId:'co_'+digest(actor.id+':'+id+':'+stepId).slice(0,40),snapshot:clone(step),createdAt:now()};db.prepare('INSERT INTO collab_links VALUES (?,?,?,?,?)').run(link.id,id,stepId,actor.id,JSON.stringify(link));return {...link,currentStep:clone(step),groupRevision:group.revision};}); },
  source(actor,linkId) { const row=db.prepare('SELECT body FROM collab_links WHERE id=? AND user_id=?').get(linkId,actor.id);requireValue(row,'NOT_FOUND',404);const link=JSON.parse(row.body);const group=load(link.groupId);if(!active(group,actor.id))return {availability:'unavailable',groupName:link.groupName};const step=group.steps.find(s=>s.id===link.stepId);return {availability:!step?'missing':group.archived||step.archived?'archived':'active',groupId:group.id,stepId:link.stepId,groupName:group.name,step:clone(step),changed:step?.revision!==link.stepRevision}; },
  aiContext(actor,id,fields,stepId) { const group=load(id);member(group,actor);requireValue(!group.archived,'ARCHIVED',409);requireValue(group.sharing.aiAllowed,'AI_SHARING_DISABLED',403);requireValue(Array.isArray(fields)&&fields.length<=AI_FIELDS.length&&fields.every(f=>AI_FIELDS.includes(f)&&group.sharing.fields.includes(f)),'SHARING_REJECTED',403);const context={};for(const field of fields){if(field==='members')context.members=group.members.filter(m=>m.active).map(m=>({id:m.userId,name:m.name,role:m.role}));else if(field==='steps')context.steps=group.steps.filter(s=>!s.archived&&(!stepId||s.id===stepId||group.steps.find(x=>x.id===stepId)?.dependsOn.includes(s.id))).map(s=>({id:s.id,name:s.name,description:s.description,ownerId:fields.includes('members')?s.ownerId:null,participantIds:fields.includes('members')?s.participantIds:[],criteria:s.criteria,status:s.status,...(fields.includes('deadlines')?{startsAt:s.startsAt,dueAt:s.dueAt,dependsOn:s.dependsOn}:{})}));else if(field==='results')context.results=group.steps.filter(s=>!s.archived&&(!stepId||s.id===stepId)).map(s=>({id:s.id,result:s.result,status:s.status}));else if(field==='materials')context.materials=group.materials.filter(m=>m.shared&&m.aiAllowed).map(m=>({id:m.id,title:m.title,content:m.content}));else if(field==='deadlines')context.deadlines={startDate:group.startDate,endDate:group.endDate,deadline:group.deadline};else context[field]=group[field];}return {context,revision:group.revision,policyVersion:group.policyVersion}; },
  saveProposal(actor,id,proposal) { const group=load(id);member(group,actor);requireValue(group.policyVersion===proposal.policyVersion,'SHARING_CHANGED',409);db.prepare('INSERT INTO collab_proposals VALUES (?,?,?,?,?)').run(proposal.id,id,actor.id,proposal.policyVersion,JSON.stringify(proposal));return proposal; },
  proposals(actor,id) { const group=load(id);member(group,actor);return db.prepare('SELECT body FROM collab_proposals WHERE group_id=? AND user_id=? AND policy_version=? ORDER BY rowid DESC LIMIT 30').all(id,actor.id,group.policyVersion).map(row=>JSON.parse(row.body)).filter(p=>!p.dismissed&&!p.applied).map(p=>({...p,stale:p.revision!==group.revision})); },
  thread(actor,id,threadId,fields) { const group=load(id);member(group,actor);const signature=JSON.stringify(fields.slice().sort());return db.prepare('SELECT body FROM collab_proposals WHERE group_id=? AND user_id=? AND policy_version=? ORDER BY rowid DESC LIMIT 40').all(id,actor.id,group.policyVersion).map(row=>JSON.parse(row.body)).filter(p=>p.threadId===threadId&&JSON.stringify(p.fields.slice().sort())===signature).slice(0,6).reverse().map(p=>({question:p.question,answer:p.reply})); },
  dismissProposal(actor,id,proposalId) { const p=api.proposal(actor,id,proposalId);p.dismissed=true;db.prepare('UPDATE collab_proposals SET body=? WHERE id=?').run(JSON.stringify(p),proposalId);return {dismissed:true}; },
  proposal(actor,id,proposalId) { const group=load(id);member(group,actor);const row=db.prepare('SELECT body FROM collab_proposals WHERE id=? AND group_id=? AND user_id=?').get(proposalId,id,actor.id);requireValue(row,'NOT_FOUND',404);const proposal=JSON.parse(row.body);requireValue(group.policyVersion===proposal.policyVersion&&group.sharing.aiAllowed,'SHARING_CHANGED',409);return {...proposal,stale:group.revision!==proposal.revision}; },
  applyProposal(actor,id,proposalId,selected) { return transaction(()=>{const proposal=api.proposal(actor,id,proposalId);if(proposal.applied)return project(load(id),actor);requireValue(!proposal.stale,'PROPOSAL_STALE',409);requireValue(Array.isArray(selected)&&selected.length>0&&selected.length<=20);let group=load(id);writer(group,actor);const seen=new Set(),mapping=new Map();for(const choice of selected.slice().sort((a,b)=>a.index-b.index)){requireValue(Number.isInteger(choice.index)&&!seen.has(choice.index));seen.add(choice.index);const action=proposal.actions[choice.index];requireValue(action&&['step-add','step-edit','group-edit','method-save'].includes(action.op),'INVALID_ACTION');const data=clone(choice.data===undefined?action.data:choice.data);requireValue(data&&typeof data==='object'&&!Array.isArray(data));const allowed=action.op==='group-edit'?['name','goal','content','deliverables','startDate','endDate','deadline']:action.op==='method-save'?['name','conditions','prompt','model','verify','result']:stepFields;requireValue(Object.keys(data).every(key=>allowed.includes(key)),'INVALID_ACTION');if(data.dependsOn)data.dependsOn=data.dependsOn.map(ref=>mapping.get(ref)||ref);group=changeState(actor,group,{revision:group.revision,op:action.op,stepId:action.stepId,data,reason:choice.reason||'AI 建议，经本人选择应用'});if(action.op==='step-add')mapping.set(action.key,group.steps.at(-1).id);}proposal.applied=true;db.prepare('UPDATE collab_proposals SET body=? WHERE id=?').run(JSON.stringify(proposal),proposalId);return project(group,actor);}); },
 };return api;
}
