import { fileURLToPath } from 'node:url';
import { createAssistant } from '../../scripts/ai-assistant.mjs';
import { loadAssistantConfig, applyDotEnv } from '../../scripts/assistant-config.mjs';
import { createCollaborationService } from '../../scripts/collaboration-service.mjs';
import { createTangoServer } from '../../scripts/serve-tango.mjs';
const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
await applyDotEnv({projectRoot});const config=await loadAssistantConfig({projectRoot});const assistant=createAssistant({config});
if(!assistant.configuration().available){console.log(JSON.stringify({verified:false,reason:'AI_NOT_CONFIGURED'}));process.exitCode=2;}
else{
 const service=await createCollaborationService({databaseFile:':memory:',assistant,allowLocalAccounts:true});const server=createTangoServer({collaboration:service,assistant});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let cookie;
 async function request(path,body){const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,'x-tango-client':'tango-settings/1','Content-Type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150000)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const value=await response.json();if(!response.ok)throw Object.assign(new Error('request failed'),{code:value.error,status:response.status});return value;}
 try{
  await request('/api/auth/local-register',{username:'live_check_'+Date.now().toString(36),displayName:'Synthetic verification account',password:'Temporary synthetic verification password 123'});
  const group=await request('/api/collaboration/groups',{name:'合成验证约定',goal:'对公开的虚构研究摘要做一次人工对照阅读。这里只是合成验证，没有真人资料。',sharing:{aiAllowed:true,fields:['goal','steps']}});
  const result=await request('/api/collaboration/groups/'+group.id+'/ai',{question:'请为这个合成约定生成且只生成一个可编辑步骤，op=step-add。名称用“核对公开摘要”，description和criteria各一句话，不分配成员，ownerId=null，participantIds=[]，dependsOn=[]，时间未知用空字符串。reply简短说明应怎样核验。请遵循服务端JSON协议。',intent:'plan',language:'zh',fields:['goal','steps'],modelMode:'chat'});
  const index=result.actions.findIndex(action=>action.op==='step-add');if(index<0)throw {code:'NO_EDITABLE_PLAN'};
  const applied=await request('/api/collaboration/groups/'+group.id+'/apply',{proposalId:result.id,selected:[{index}]});
  console.log(JSON.stringify({verified:true,actualModel:result.actualModel,replyCharacters:result.reply.length,editableActions:result.actions.length,appliedSteps:applied.steps.length,data:'synthetic-only',database:'memory-only'}));
 }catch(error){console.log(JSON.stringify({verified:false,reason:error.code||'LIVE_REQUEST_FAILED',status:error.status||null}));process.exitCode=1;}
 finally{await new Promise(r=>server.close(r));service.close();}
}

