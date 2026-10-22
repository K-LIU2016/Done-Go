import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export default async function setup(config){
 const origin=config.projects[0].use.baseURL;
 const response=await fetch(origin+'/__test/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'existing_ui_fixture',displayName:'UI fixture',password:'Synthetic UI fixture password 123'})});
 const value=await response.json();if(!response.ok)throw Error('Verified fixture registration failed: '+JSON.stringify(value));
 const pair=response.headers.get('set-cookie').split(';')[0],index=pair.indexOf('=');
 const state={cookies:[{name:pair.slice(0,index),value:pair.slice(index+1),domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'}],origins:[{origin,localStorage:[{name:'__testAccountId',value:value.user.id}]}]};
 await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/tango-ui-auth.json'),JSON.stringify(state));
}
