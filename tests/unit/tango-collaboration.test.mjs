import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollaborationStore } from '../../scripts/collaboration-store.mjs';
import { createCollaborationService } from '../../scripts/collaboration-service.mjs';
const alice = { id: 'alice', displayName: 'Alice' }, bob = { id: 'bob', displayName: 'Bob' }, viewer = { id: 'viewer', displayName: 'Viewer' };
test('real membership, permissions, conflict detection, confirmation and revocation', () => {
 const store = createCollaborationStore({ databaseFile: ':memory:' });
 try {
  let group = store.create(alice, { name: 'Research', goal: 'Check sources' });
  const invite = store.invite(alice, group.id, { revision: group.revision, role: 'member' });
  group = store.join(bob, invite.token);
  const readInvite = store.invite(alice, group.id, { revision: group.revision, role: 'viewer' });
  store.join(viewer, readInvite.token); group = store.get(alice, group.id);
  assert.throws(() => store.change(viewer, group.id, { revision: group.revision, op: 'step-add', data: { name: 'No' } }), /FORBIDDEN/);
  group = store.change(alice, group.id, { revision: group.revision, op: 'step-add', data: { name: 'Review', ownerId: bob.id, criteria: 'Check citations' } });
  assert.ok(group.confirmations.some(c => c.required.includes(bob.id)));
  assert.throws(() => store.change(bob, group.id, { revision: 1, op: 'step-status', stepId: group.steps[0].id, data: { status: 'active' } }), /CONFLICT/);
  group = store.change(bob, group.id, { revision: group.revision, op: 'confirm', confirmationId: group.confirmations.at(-1).id });
  group = store.change(bob, group.id, { revision: group.revision, op: 'step-status', stepId: group.steps[0].id, data: { status: 'review', result: 'Citations checked' } });
  assert.equal(group.steps[0].status, 'review');
  assert.throws(() => store.change(bob, group.id, { revision: group.revision, op: 'step-status', stepId: group.steps[0].id, data: { status: 'done' } }), /FORBIDDEN/);
  group = store.change(alice, group.id, { revision: group.revision, op: 'step-status', stepId: group.steps[0].id, data: { status: 'done' } });
  const count = store.history(alice, group.id).length; assert.ok(count >= 4);
  group = store.change(alice, group.id, { revision: group.revision, op: 'member-remove', userId: bob.id, reason: 'Left the project' });
  assert.throws(() => store.get(bob, group.id), /FORBIDDEN/);
  assert.equal(group.members.filter(m => m.active).length, 2);
 } finally { store.close(); }
});
test('AI step links are accepted only from the shared step context', async () => {
 const actor={id:'alice',displayName:'Alice',emailVerified:true};
 let answer;
 const assistant={configuration:()=>({available:true,models:{heavy:'heavy',standard:'standard'}}),chat:async()=>({content:[{type:'text',text:JSON.stringify(answer)}]})};
 const auth={authenticate:()=>actor,userById:id=>actor.id===id?actor:null,close(){}};
 const service=await createCollaborationService({databaseFile:':memory:',assistant,auth});
 async function call(pathname,method='POST',body){let result;const request={method,headers:{host:'127.0.0.1:5207',origin:'http://127.0.0.1:5207','content-type':'application/json','x-tango-client':'tango-settings/1'},async *[Symbol.asyncIterator](){if(body!==undefined)yield Buffer.from(JSON.stringify(body));}};await service.handle(request,{destroyed:false,writableEnded:false,once(){},writeHead(){return {end:value=>{result={value:JSON.parse(value)};}};}},pathname);return result.value;}
 try {
  let group=(await call('/api/collaboration/groups','POST',{name:'Research',goal:'Check sources',sharing:{aiAllowed:true,fields:['goal','steps']}}));
  group=service.store.change(actor,group.id,{revision:group.revision,op:'step-add',data:{name:'Check evidence',criteria:'Original sources'}});
  const stepId=group.steps[0].id,input={question:'Save a method',intent:'method',fields:['steps','goal'],stepId};
  answer={reply:'Use this checking method',actions:[{op:'method-save',key:'method-1',stepId,data:{name:'Source check',prompt:'Compare claims with originals'}}]};
  const valid=await call('/api/collaboration/groups/'+group.id+'/ai','POST',input);
  assert.ok(valid.reply, JSON.stringify(valid));
  assert.equal(valid.reply,'Use this checking method');
  answer={reply:'Bad link',actions:[{op:'method-save',key:'method-1',stepId:'hidden-step',data:{name:'Source check'}}]};
  const rejected=await call('/api/collaboration/groups/'+group.id+'/ai','POST',input);
  assert.equal(rejected.error,'AI_RESPONSE_INVALID');
 } finally { service.close(); }
});
