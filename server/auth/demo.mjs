import {randomBytes,randomUUID} from 'node:crypto';
const COOKIE='tango_demo_session';
export function createDemoAuthService({secureCookie=false,now=Date.now,autoStart=false}={}){
 const sessions=new Map(),rates=new Map(),ttl=8*3600000;
 function fail(code,status=401){throw Object.assign(new Error(code),{code,status});}
 function throttle(key,limit,windowMs=60000){const time=now();for(const [id,value]of rates)if(time-value.at>86400000)rates.delete(id);const rate=rates.get(key);if(!rate||time-rate.at>=windowMs)rates.set(key,{at:time,count:1});else{if(rate.count>=limit)fail('RATE_LIMITED',429);rate.count++;}}
 function token(req){return String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);}
 function authenticate(req){const key=token(req),session=sessions.get(key);if(!session||session.expires<=now()){if(key)sessions.delete(key);fail('AUTH_REQUIRED');}return {...session.user};}
 function cookie(res,value,maxAge){res.setHeader('Set-Cookie',COOKIE+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(secureCookie?'; Secure':''));}
 function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(value));}
 return {authenticate,throttle,requireAdmin(){fail('ADMIN_REQUIRED',403);},userById(id){for(const value of sessions.values())if(value.user.id===id&&value.expires>now())return {...value.user};return null;},close(){sessions.clear();rates.clear();},async handle(req,res,body={}){
  try{const path=req.url.split('?')[0];
   if(path==='/api/auth/status'&&req.method==='GET'){send(res,200,{enabled:true,demoMode:true,registrationEnabled:false,emailDelivery:'disabled',...(autoStart?{autoStart:true}:{})});return true;}
   if(path==='/api/auth/demo-start'&&req.method==='POST'){
    if(Object.keys(body).some(key=>key!=='displayName')||body.displayName!==undefined&&(typeof body.displayName!=='string'||body.displayName.length>80))fail('INVALID_INPUT',400);
    throttle('start:'+req.socket?.remoteAddress,20);for(const [id,value]of sessions)if(value.expires<=now())sessions.delete(id);if(sessions.size>=1000)fail('DEMO_BUSY',503);
    const key=randomBytes(32).toString('base64url'),user={id:randomUUID(),displayName:body.displayName?.trim()||'Demo',role:'user',email:null,emailVerified:false,demo:true,isActive:true};
    sessions.set(key,{user,expires:now()+ttl});cookie(res,key,ttl/1000);send(res,200,{user});return true;
   }
   if(path==='/api/auth/me'&&req.method==='GET'){send(res,200,{user:authenticate(req)});return true;}
   if(path==='/api/auth/logout'&&req.method==='POST'){sessions.delete(token(req));cookie(res,'',0);send(res,200,{status:'ok'});return true;}
   if(path==='/api/auth/me'&&req.method==='PUT'){const user=authenticate(req);if(typeof body.displayName!=='string'||!body.displayName.trim()||body.displayName.length>80)fail('INVALID_INPUT',400);sessions.get(token(req)).user.displayName=body.displayName.trim();send(res,200,{user:{...user,displayName:body.displayName.trim()}});return true;}
   fail('DEMO_CREDENTIALS_DISABLED',403);
  }catch(error){send(res,error.status||500,{error:error.code||'DEMO_UNAVAILABLE'});}return true;
 }};
}
