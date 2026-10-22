import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCollaborationService} from '../../scripts/collaboration-service.mjs';
import {createTangoServer} from '../../scripts/serve-tango.mjs';
import {createDemoAuthService} from '../../server/auth/demo.mjs';
test('direct entry is opt-in and does not enable credential registration',async()=>{
 for(const autoStart of [false,true]){
  const auth=createDemoAuthService({autoStart});let result;
  const res={writeHead(status){assert.equal(status,200);return this;},end(raw){result=JSON.parse(raw);}};
  await auth.handle({url:'/api/auth/status',method:'GET'},res);
  assert.equal(result.autoStart,autoStart?true:undefined);
  assert.equal(result.registrationEnabled,false);auth.close();
 }
});
test('demo uses temporary guest sessions and never accepts or persists email/password credentials',async t=>{
 const file=join(mkdtempSync(join(tmpdir(),'donego-demo-')),'must-not-exist.sqlite');
 const collaboration=await createCollaborationService({databaseFile:file,demoMode:true});const server=createTangoServer({collaboration});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeIdleConnections();await new Promise(r=>server.close(r));collaboration.close();});
 async function request(path,body,cookie){const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,'x-tango-client':'tango-settings/1','Content-Type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 const status=await request('/api/auth/status');assert.equal(status.body.demoMode,true);assert.equal(status.body.registrationEnabled,false);
 for(const path of ['/api/auth/register','/api/auth/login','/api/auth/send-code'])assert.equal((await request(path,{email:'must-not-store@example.test',password:'must-not-store-password'})).status,403);
 assert.equal((await request('/api/auth/demo-start',{email:'must-not-store@example.test',password:'must-not-store-password'})).status,400);
 const started=await request('/api/auth/demo-start',{displayName:'Demo researcher'});assert.equal(started.status,200);assert.equal(started.body.user.demo,true);assert.equal(started.body.user.email,null);assert.equal(started.body.user.emailVerified,false);assert.ok(started.cookie);
 assert.equal((await request('/api/auth/me',undefined,started.cookie)).body.user.id,started.body.user.id);
 assert.equal((await request('/api/collaboration/groups',{name:'Temporary group'},started.cookie)).status,200);
 assert.equal(existsSync(file),false);
 await request('/api/auth/logout',{},started.cookie);assert.equal((await request('/api/collaboration/groups',undefined,started.cookie)).status,401);
});
