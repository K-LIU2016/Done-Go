import {defineConfig} from '@playwright/test';
import account from './playwright.account.config';
const port=Number(process.env.TANGO_PORT)||5340;
export default defineConfig({...account,testMatch:'demo-entry.spec.ts',outputDir:'./artifacts/demo-entry',projects:account.projects?.map((project,index)=>({...project,use:{...project.use,baseURL:'http://127.0.0.1:'+(port+index)}})),webServer:(account.webServer as any[]).map((server,index)=>({...server,url:'http://127.0.0.1:'+(port+index),env:{...server.env,TANGO_PORT:String(port+index),TANGO_DEMO_FIXTURE:'1'}}))});
