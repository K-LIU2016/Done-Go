import { createTangoServer } from '../../scripts/serve-tango.mjs';
import { createCollaborationService } from '../../scripts/collaboration-service.mjs';
import { createAssistant } from '../../scripts/ai-assistant.mjs';
// Provider replacement only. Accounts, cookies, database, permissions and routes are real.
export const fixtureAssistant=createAssistant({config:{provider:'openai',url:'https://fixture.example.test/v1/chat/completions',model:'fixture-collaboration-model',key:'synthetic-test-credential'},fetch:async(_url,options)=>{
 const prompt=JSON.parse(options.body).messages.at(-1).content;
 const sections=prompt.split(/(?:\n|\\n)SHARED_CONTEXT(?:\n|\\n)/);const context=JSON.parse(sections[1].split(/(?:\n|\\n)QUESTION(?:\n|\\n)/)[0]);
 const question=sections[1].split(/(?:\n|\\n)QUESTION(?:\n|\\n)/)[1]||'';
 if(question.includes('FAIL_ONCE'))return new Response('',{status:503});
 const answer={reply:(context.goal||'Shared goal')+': check sources and review results before accepting.',actions:question.includes('拆解')||question.includes('plan')?[{op:'step-add',key:'new-1',data:{name:'Source review',description:'Check original sources',ownerId:null,participantIds:[],dependsOn:[],criteria:'Each claim has a checked source'}},{op:'step-add',key:'new-2',data:{name:'Team review',description:'Review the submitted evidence',ownerId:null,participantIds:[],dependsOn:['new-1'],criteria:'Review findings together'}}]:[]};
 return Response.json({choices:[{message:{content:JSON.stringify(answer)}}]});
}});

if(process.argv[1]&&process.argv[1].replaceAll('\\','/').endsWith('/collaboration-server.mjs')){
 const collaboration=await createCollaborationService({databaseFile:':memory:',assistant:fixtureAssistant,allowLocalAccounts:true});
 const port=Number(process.env.TANGO_PORT)||5276;
 createTangoServer({assistant:fixtureAssistant,collaboration}).listen(port,'127.0.0.1');
}

