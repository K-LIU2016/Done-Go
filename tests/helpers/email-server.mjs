// Isolated test host. Mailbox and shortcuts are NEVER packaged with the app.
import {readFile} from 'node:fs/promises';
import {createTangoServer} from '../../scripts/serve-tango.mjs';
import {createCollaborationService} from '../../scripts/collaboration-service.mjs';
import {readAuthConfig} from '../../server/auth/config.mjs';
import {fixtureAssistant} from './collaboration-server.mjs';
const mailbox=new Map();let currentTime=Date.now();
const authConfig=readAuthConfig({TANGO_AUTH_SECRET:'email-fixture-only-secret-at-least-32-bytes',EMAIL_TRANSPORT:'resend',RESEND_API_KEY:'fixture-only',MAIL_FROM:'fixture@example.test',ADMIN_EMAILS:'admin@fixture.test'});
const assistant=process.env.TANGO_FIXTURE_AI==='1'?fixtureAssistant:undefined;
const demoMode=process.env.TANGO_DEMO_FIXTURE==='1';
const collaboration=await createCollaborationService({databaseFile:':memory:',assistant,authConfig,demoMode,authOptions:{now:()=>currentTime},sendEmail:async message=>mailbox.set(message.email,message)});
const server=createTangoServer({collaboration,...(assistant?{assistant}:{})});const app=server.listeners('request')[0];server.removeAllListeners('request');
const html=await readFile(new URL('../../web/index.html',import.meta.url),'utf8');
function legacyStorageShim(){try{var raw=window.localStorage,id=raw.getItem('__testAccountId');if(!id)return;function key(name){return /^tango-donego\.(web\.v1|assistant(?:-privacy)?\.v1|llm\.v1|agreements\.v1)(?:\.|$)/.test(name)?'tango-donego.user.'+id+'.'+name:name;}['tango-donego.web.v1','tango-donego.assistant.v1','tango-donego.assistant-privacy.v1','tango-donego.llm.v1','tango-donego.agreements.v1'].forEach(function(name){var value=raw.getItem(name);if(value!==null&&raw.getItem('__migrated:'+name)!==value){raw.setItem(key(name),value);raw.setItem('__migrated:'+name,value);}});Object.defineProperty(window,'localStorage',{value:{getItem:function(name){return raw.getItem(key(name));},setItem:function(name,value){raw.setItem(key(name),value);},removeItem:function(name){raw.removeItem(key(name));}}});}catch{}}
const shim='('+legacyStorageShim.toString()+')();';
server.on('request',async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.url.startsWith('/api/auth/send-code')||req.url.startsWith('/api/auth/register'))currentTime+=61000; // Advance fixture time between independent auth flows, preserve real rate enforcement.
 if(url.pathname==='/__test/mailbox'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(mailbox.get(url.searchParams.get('email'))||{}));return;}
 if(url.pathname==='/__test/register'){
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),email=body.username+'@fixture.test',origin='http://'+req.headers.host;
 async function call(path,data){if(path==='register')currentTime+=61000;const response=await fetch(origin+'/api/auth/'+path,{method:'POST',headers:{origin,'x-tango-client':'tango-settings/1','Content-Type':'application/json'},body:JSON.stringify(data)});return {response,value:await response.json()};}
  if(demoMode){const started=await call('demo-start',{displayName:body.displayName||'Fixture guest'});res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie',started.response.headers.get('set-cookie'));res.end(JSON.stringify(started.value));return;}
  await call('send-code',{email});const registered=await call('register',{email,code:mailbox.get(email)?.code,password:body.password,confirmPassword:body.confirmPassword??body.password,displayName:body.displayName});
  if(!registered.response.ok){res.writeHead(registered.response.status,{'Content-Type':'application/json'}).end(JSON.stringify(registered.value));return;}
  const logged=await call('login',{email,password:body.password});res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie',logged.response.headers.get('set-cookie'));res.end(JSON.stringify(logged.value));return;
 }
 if(process.env.TANGO_LEGACY_UI_FIXTURES==='1'&&['/','/index.html'].includes(url.pathname)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html.replace('<head>','<head><script>'+shim+'</script>'));return;}
 app(req,res);
 }catch{res.writeHead(500).end();}});
server.listen(Number(process.env.TANGO_PORT)||5276,'127.0.0.1',()=>process.stdout.write('Isolated verified-email test host ready\n'));
