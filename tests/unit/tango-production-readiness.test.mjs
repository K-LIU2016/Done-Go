import test from 'node:test';
import assert from 'node:assert/strict';
import {productionReadiness} from '../../scripts/production-readiness.mjs';
test('release configuration supports direct password accounts without requiring email delivery',()=>{
 const result=productionReadiness({});assert.equal(result.configurationReady,false);assert.ok(result.missing.includes('persistent-session-secret'));
 const configured={NODE_ENV:'production',TANGO_PUBLIC_ORIGIN:'https://donego.example.test',TANGO_AUTH_SECRET:'synthetic-test-persistent-secret-at-least-32-bytes',EMAIL_TRANSPORT:'disabled',TANGO_COLLAB_DB:'/persistent/collaboration.sqlite'};
 assert.deepEqual(productionReadiness(configured),{configurationReady:true,missing:[],liveEmailVerified:false,publicDeploymentVerified:false});
 for(const patch of [{EMAIL_TRANSPORT:'console'},{TANGO_COLLAB_DB:':memory:'},{TANGO_AUTH_SECRET:'short'},{TANGO_PUBLIC_ORIGIN:'http://donego.example.test'}])assert.equal(productionReadiness({...configured,...patch}).configurationReady,false);
 assert.ok(!JSON.stringify(productionReadiness({...configured,RESEND_API_KEY:''})).includes(configured.TANGO_AUTH_SECRET));
});
