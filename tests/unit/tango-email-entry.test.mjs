import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationService} from '../../scripts/collaboration-service.mjs';
import {createTangoServer} from '../../scripts/serve-tango.mjs';
import {readAuthConfig} from '../../server/auth/config.mjs';
import {request as httpRequest} from 'node:http';
async function fixture(t,extra={}){
 const sent=[];const authConfig=readAuthConfig({TANGO_AUTH_SECRET:'synthetic-email-entry-secret-32-bytes-minimum',EMAIL_TRANSPORT:'resend',RESEND_API_KEY:'synthetic',MAIL_FROM:'test@example.test',...extra});
 const assistant={configuration:()=>({available:false}),chat:async()=>{throw Error('No model calls in auth tests');}};
 const service=await createCollaborationService({databaseFile:':memory:',assistant,authConfig,sendEmail:async message=>sent.push(message)});
 const server=createTangoServer({collaboration:service,assistant});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeIdleConnections();await new Promise(r=>server.close(r));service.close();});
 async function request(path,body,cookie,method){const r=await fetch(origin+path,{method:method||(body===undefined?'GET':'POST'),headers:{origin,'x-tango-client':'tango-settings/1','Content-Type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function register(email){const result=await request('/api/auth/register',{email,password:'EmailPass123',confirmPassword:'EmailPass123'});assert.equal(result.status,200);return result;}
 return {request,register,sent,service,origin};
}
test('direct registration then explicit login unlocks all app APIs; anonymous users cannot use paid or shared features',async t=>{
 const f=await fixture(t);
assert.equal((await f.request('/api/auth/local-register',{username:'legacy',password:'EmailPass123'})).status,403);
 for(const path of ['/api/assistant/config','/api/speech','/api/discovery','/api/collaboration/groups']) assert.equal((await f.request(path)).status,401,path);
const registered=await f.request('/api/auth/register',{email:'one@example.test',password:'EmailPass123',confirmPassword:'EmailPass123'});
 assert.equal(registered.status,200);assert.equal(registered.body.user.emailVerified,true);assert.equal(registered.cookie,undefined);
 assert.equal((await f.request('/api/assistant/config')).status,401);
const login=await f.request('/api/auth/login',{email:'one@example.test',password:'EmailPass123'});assert.equal(login.status,200);assert.ok(login.cookie);
 assert.equal((await f.request('/api/assistant/config',undefined,login.cookie)).status,200);
 assert.equal((await f.request('/api/assistant/config',{model:'other'},login.cookie,'PUT')).status,403);
 assert.equal((await f.request('/api/collaboration/groups',{name:'Verified group'},login.cookie)).status,200);
 await f.request('/api/auth/logout',{},login.cookie);assert.equal((await f.request('/api/assistant/config',undefined,login.cookie)).status,401);
});
test('public HTTPS sessions set secure cookies and reject foreign, missing and wrong-port origins',async t=>{
 const publicOrigin='https://donego.example.test';const f=await fixture(t,{TANGO_PUBLIC_ORIGIN:publicOrigin,NODE_ENV:'production'});
 async function request(path,body,cookie,headers={}){return new Promise((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:new URL(f.origin).port,path,method:body===undefined?'GET':'POST',headers:{host:'donego.example.test',origin:publicOrigin,'x-tango-client':'tango-settings/1','Content-Type':'application/json',...(cookie?{cookie}:{}),...headers}},response=>{let raw='';response.on('data',chunk=>raw+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(raw),cookie:response.headers['set-cookie']?.[0]||null}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
const registered=await request('/api/auth/register',{email:'public@example.test',password:'EmailPass123',confirmPassword:'EmailPass123'});assert.equal(registered.status,200);assert.equal(registered.cookie,null);
const login=await request('/api/auth/login',{email:'public@example.test',password:'EmailPass123'});assert.equal(login.status,200);assert.match(login.cookie,/; Secure/);assert.match(login.cookie,/HttpOnly/);
 const cookie=login.cookie.split(';')[0];assert.equal((await request('/api/assistant/config',undefined,cookie)).status,200);
 for(const headers of [{origin:'https://attacker.example.test'},{origin:''},{host:'donego.example.test:8443',origin:publicOrigin}])assert.equal((await request('/api/collaboration/groups',{name:'Denied'},cookie,headers)).status,403);
});
test('mail2profile admin routes manage users, preserve disabled state on password reset and protect shared ownership',async t=>{
 const f=await fixture(t,{ADMIN_EMAILS:'admin@example.test'});
 const admin=await f.register('admin@example.test'),user=await f.register('member@example.test');
const ac=(await f.request('/api/auth/login',{email:'admin@example.test',password:'EmailPass123'})).cookie;
let uc=(await f.request('/api/auth/login',{email:'member@example.test',password:'EmailPass123'})).cookie;
 assert.equal((await f.request('/api/admin/users',undefined,uc)).status,403);
 let group=(await f.request('/api/collaboration/groups',{name:'Owned shared group'},uc)).body;const base='/api/collaboration/groups/'+group.id;
 const invitation=(await f.request(base+'/invite',{revision:group.revision,role:'member'},uc)).body;
 group=(await f.request('/api/collaboration/join',{passphrase:invitation.passphrase},ac)).body;
 const listed=await f.request('/api/admin/users',undefined,ac);assert.equal(listed.status,200);assert.ok(listed.body.users.find(row=>row.id===user.body.user.id).resourceCount>=1);
 const userPath='/api/admin/users/'+user.body.user.id;
 assert.equal((await f.request(userPath,{isActive:false},ac,'PATCH')).status,200);
 assert.equal((await f.request('/api/collaboration/groups',undefined,uc)).status,401);
 await f.request('/api/auth/send-code',{email:'member@example.test',purpose:'reset'});
const reset=await f.request('/api/auth/reset-password',{email:'member@example.test',code:f.sent.at(-1).code,newPassword:'MemberPass456'});assert.equal(reset.status,200);
const inactive=await f.request('/api/auth/login',{email:'member@example.test',password:'MemberPass456'});assert.equal(inactive.status,401);assert.equal(inactive.body.error,'ACCOUNT_INACTIVE');
 assert.equal((await f.request(userPath,{isActive:true},ac,'PATCH')).status,200);
uc=(await f.request('/api/auth/login',{email:'member@example.test',password:'MemberPass456'})).cookie;
 const owns=await f.request(userPath,undefined,ac,'DELETE');assert.equal(owns.status,409);assert.equal(owns.body.error,'ACCOUNT_OWNS_GROUPS');
 group=(await f.request(base+'/change',{revision:group.revision,op:'member-role',userId:admin.body.user.id,data:{role:'owner'}},uc)).body;
 assert.equal((await f.request('/api/admin/users/'+admin.body.user.id,undefined,ac,'DELETE')).status,400);
 assert.equal((await f.request(userPath,undefined,ac,'DELETE')).status,200);
 assert.equal((await f.request('/api/auth/me',undefined,uc)).status,401);
 const remaining=(await f.request(base,undefined,ac)).body;assert.equal(remaining.members.find(row=>row.userId===user.body.user.id).active,false);
 assert.equal((await f.request('/api/admin/users',undefined,ac)).body.users.length,1);
});
