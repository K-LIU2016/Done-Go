import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationStore} from '../../scripts/collaboration-store.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const owner={id:'owner',displayName:'Owner'},alice={id:'alice',displayName:'Alice'},bob={id:'bob',displayName:'Bob'};
test('one random passphrase admits multiple verified members, rotation and removal revoke it',()=>{
 const store=createCollaborationStore({databaseFile:':memory:'});try{
  let group=store.create(owner,{name:'Shared phrase group'});const invite=store.invite(owner,group.id,{revision:group.revision,role:'member'});
  assert.match(invite.passphrase,/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/);
  group=store.join(alice,invite.passphrase.toLowerCase().replaceAll('-',' '));group=store.join(bob,invite.passphrase);
  assert.equal(group.members.filter(member=>member.active).length,3);assert.equal(store.join(alice,invite.passphrase).members.length,3);
  assert.ok(!JSON.stringify(store.get(alice,group.id)).includes(invite.passphrase));
  const next=store.invite(owner,group.id,{revision:group.revision,role:'member'});assert.notEqual(next.passphrase,invite.passphrase);
  assert.throws(()=>store.join({id:'fourth'},invite.passphrase),/INVITE_INVALID/);
  group=store.change(owner,group.id,{revision:group.revision,op:'member-remove',userId:alice.id,reason:'Access withdrawn'});
  assert.throws(()=>store.join(alice,next.passphrase),/INVITE_INVALID/);
 }finally{store.close();}
});
test('adding reusable phrases preserves legacy single-use invitations and stored records',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'donego-phrase-legacy-')),'shared.sqlite');const before=new DatabaseSync(file);
 before.exec('CREATE TABLE collab_invites(token_hash TEXT PRIMARY KEY,group_id TEXT NOT NULL,role TEXT NOT NULL,expires_at TEXT NOT NULL,used_by TEXT,revoked INTEGER NOT NULL DEFAULT 0)');before.close();
 const store=createCollaborationStore({databaseFile:file});try{const group=store.create(owner,{name:'Existing agreement'}),token='legacy_single_use_invitation_123456';const db=new DatabaseSync(file);db.prepare('INSERT INTO collab_invites(token_hash,group_id,role,expires_at) VALUES (?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),group.id,'member','2099-01-01T00:00:00.000Z');db.close();assert.equal(store.join(alice,token).name,'Existing agreement');assert.throws(()=>store.join(bob,token),/INVITE_INVALID/);}finally{store.close();}
});
test('removal revokes a reusable phrase that the removed member had joined with',()=>{
 const store=createCollaborationStore({databaseFile:':memory:'});try{
  let group=store.create(owner,{name:'Reusable access'});const invite=store.invite(owner,group.id,{revision:group.revision,role:'member'});
  group=store.join(alice,invite.passphrase);
  group=store.change(owner,group.id,{revision:group.revision,op:'member-remove',userId:alice.id,reason:'Access withdrawn'});
  assert.throws(()=>store.join(alice,invite.passphrase),/INVITE_INVALID/);
 }finally{store.close();}
});
