import {readAuthConfig} from '../server/auth/config.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function productionReadiness(env){
 const missing=[];let config;
 if(env.TANGO_DEMO_MODE==='1')missing.push('demo-mode-not-production');
 try{config=readAuthConfig(env);}catch{missing.push('valid-email-and-session-configuration');}
 if(!env.TANGO_PUBLIC_ORIGIN)missing.push('https-public-origin');
 if(env.NODE_ENV!=='production')missing.push('production-mode');
 if(!env.TANGO_AUTH_SECRET||Buffer.byteLength(env.TANGO_AUTH_SECRET)<32)missing.push('persistent-session-secret');
 if(!env.TANGO_COLLAB_DB||env.TANGO_COLLAB_DB===':memory:')missing.push('persistent-database-path');
 if(config&&!config.secureCookie)missing.push('secure-session-cookie');
 return {configurationReady:missing.length===0,missing,liveEmailVerified:false,publicDeploymentVerified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=productionReadiness(process.env);process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.configurationReady)process.exitCode=1;
}
