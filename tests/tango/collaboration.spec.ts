import { test, expect, type Page } from '@playwright/test';
test('roles, important edits, history, conflicts and six-language responsive forms use real sessions',async({page,browser,baseURL},info)=>{
 await prepare(page);const request=page.context().request;const headers={origin:baseURL!,'x-tango-client':'tango-settings/1'};
 async function post(path:string,data:any,client=request){const response=await client.post(baseURL+path,{headers,data});return {status:response.status(),body:await response.json()};}
 const a=await post('/__test/register',{username:'owner'+Math.random().toString(36).slice(2,10),password,displayName:'Owner'});expect(a.status).toBe(200);
 let group=(await post('/api/collaboration/groups',{name:'Research agreement with a very long descriptive name for responsive review',goal:'Check the methods and original evidence',sharing:{aiAllowed:true,fields:['goal','steps','members','deadlines']}})).body;const base='/api/collaboration/groups/'+group.id;
 const viewerContext=await browser.newContext({baseURL,viewport:{width:390,height:844},reducedMotion:'reduce'});try{
 const v=await post('/__test/register',{username:'viewer'+Math.random().toString(36).slice(2,10),password,displayName:'Viewer'},viewerContext.request);expect(v.status).toBe(200);
 const invitation=await post(base+'/invite',{revision:group.revision,role:'viewer'});group=(await post('/api/collaboration/join',{token:invitation.body.token},viewerContext.request)).body;
 group=(await post(base+'/change',{revision:group.revision,op:'step-add',data:{name:'Review evidence with a long step title that should wrap without hiding controls',ownerId:a.body.user.id,criteria:'Check every citation against the original'}})).body;
 const stale=await post(base+'/change',{revision:group.revision-1,op:'step-edit',stepId:group.steps[0].id,data:{name:'Old edit'}});expect(stale.status).toBe(409);
 const forbidden=await post(base+'/change',{revision:group.revision,op:'step-edit',stepId:group.steps[0].id,data:{name:'Viewer edit'}},viewerContext.request);expect(forbidden.status).toBe(403);
 await page.goto('/#agreements');await expect(page.locator('.co-group-heading')).toContainText('Research agreement');const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));let aiCalls=0;page.on('request',r=>{if(r.url().endsWith('/ai'))aiCalls++;});
 const widths=info.project.name==='mobile'?[360,390]:[1440,768];
 for(const width of widths){await page.setViewportSize({width,height:900});for(const theme of ['standard','designer']){await page.locator('#appearance-select').selectOption(theme);for(const language of ['zh','en','ru','th','ar','ko']){await page.locator('#lang').selectOption(language);await page.locator('.co-page details').evaluateAll(nodes=>nodes.forEach(node=>(node as HTMLDetailsElement).open=true));if(language!=='zh'){const copy=await page.locator('.co-page').evaluate(el=>{const clone=el.cloneNode(true)as HTMLElement;clone.querySelectorAll('[data-user-content],option').forEach(n=>n.remove());return clone.textContent;});expect(copy,theme+'/'+language).not.toMatch(/[一-鿿]/);}expect(await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,innerWidth))).toBeLessThanOrEqual(width+1);if(['zh','ar'].includes(language))await page.screenshot({path:info.outputPath(theme+'-'+language+'-'+width+'-responsive.png'),fullPage:true});}}}
 expect(aiCalls).toBe(0);await page.locator('#lang').selectOption('zh');await page.locator('[data-co="add-step"]').focus();await page.keyboard.press('Enter');await expect(page.locator('#co-name')).toBeFocused();await page.locator('#co-name').fill('Draft preserved');await page.locator('#co-description').fill('Unsaved description');await page.locator('#lang').selectOption('ar');await expect(page.locator('#co-name')).toHaveValue('Draft preserved');await expect(page.locator('#co-description')).toHaveValue('Unsaved description');await page.keyboard.press('Escape');await expect(page.locator('#co-form')).toHaveCount(0);await page.locator('#lang').selectOption('zh');await expect(page.locator('#co-form')).toHaveCount(0);
 const viewer=await viewerContext.newPage();await prepare(viewer);await viewer.goto('/#agreements');await expect(viewer.locator('.co-group-heading')).toBeVisible();await expect(viewer.locator('[data-co="add-step"],[data-co="edit-group"],[data-co="apply"]')).toHaveCount(0);
 group=(await post(base+'/change',{revision:group.revision,op:'step-edit',stepId:group.steps[0].id,data:{dueAt:'2026-12-01T17:00:00.000Z'},reason:'Waiting for additional evidence'})).body;
 expect(await page.evaluate(() => innerWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
 await page.locator('[data-co="refresh"]').click();await page.locator('[data-co-history] summary').click();await expect(page.locator('#co-history')).toContainText('Waiting for additional evidence');await page.locator('[data-co="confirm"]').first().click();
 const current=(await request.get(baseURL+base,{headers}));group=await current.json();await post(base+'/change',{revision:group.revision,op:'member-remove',userId:v.body.user.id,reason:'Finished observing'});expect((await viewerContext.request.get(baseURL+base,{headers})).status()).toBe(403);await viewer.locator('[data-co="refresh"]').click();await expect(viewer.locator('.co-group-heading')).toHaveCount(0);expect(errors).toEqual([]);
 }finally{await viewerContext.close();}
});
const password='Synthetic collaboration password 123';
test('personal update previews the latest step even if it changed while the source sheet was open', async({page,baseURL})=>{
 await prepare(page);const headers={origin:baseURL!,'x-tango-client':'tango-settings/1'},client=page.context().request;
 const account=await(await client.post('/__test/register',{headers,data:{username:'sync'+Math.random().toString(36).slice(2,10),password,displayName:'Owner'}})).json();
 let group=await(await client.post('/api/collaboration/groups',{headers,data:{name:'Schedule changes'}})).json();const base='/api/collaboration/groups/'+group.id;
 async function change(op:string,data:any,args:any={}){const response=await client.post(base+'/change',{headers,data:{revision:group.revision,op,data,...args}});expect(response.status()).toBe(200);group=await response.json();}
 await change('step-add',{name:'Read originals',ownerId:account.user.id,startsAt:'2026-10-21T11:00:00.000Z'});
 const stepId=group.steps[0].id;await change('confirm',{}, {confirmationId:group.confirmations.at(-1).id});
 await page.goto('/#agreements');await page.locator('.co-next [data-co="personal"]').click();await page.locator('#co-form button[type=submit]').click();
 await page.locator('.tabs a[href="#today"]').click();await expect(page.locator('.co-source-link')).toHaveCount(1);
 await change('step-edit',{startsAt:'2026-10-21T12:00:00.000Z'},{stepId,reason:'Move to evening'});
 await page.locator('.co-source-link').click();await expect(page.locator('[data-co="source-update"]')).toBeVisible();
 await change('step-edit',{startsAt:'2026-10-21T13:00:00.000Z'},{stepId,reason:'Latest agreed time'});
 await change('confirm',{}, {confirmationId:group.confirmations.at(-1).id});
 await page.locator('[data-co="source-update"]').click();await expect(page.locator('#co-start')).toHaveValue('21:00');
 await page.locator('#co-form button[type=submit]').click();await expect(page.locator('.bubble[data-id^="co_"]')).toHaveCount(1);
});
test('owners edit existing materials and immediately revoke member and AI access', async ({page,browser,baseURL}) => {
 await prepare(page); const headers={origin:baseURL!,'x-tango-client':'tango-settings/1'};
 const owner=page.context().request;
 await owner.post('/__test/register',{headers,data:{username:'materials'+Math.random().toString(36).slice(2,10),password,displayName:'Owner'}});
 let group=await (await owner.post('/api/collaboration/groups',{headers,data:{name:'Material access',startDate:'2026-10-21',endDate:'2026-12-01',materials:[{id:'public-source',title:'Original source',content:'Synthetic public source',shared:true,aiAllowed:true}],sharing:{aiAllowed:true,fields:['goal','steps','materials']}}})).json();
 const base='/api/collaboration/groups/'+group.id; const member=await browser.newContext({baseURL});
 try {
  await member.request.post('/__test/register',{headers,data:{username:'reader'+Math.random().toString(36).slice(2,10),password,displayName:'Reader'}});
  const invitation=await (await owner.post(base+'/invite',{headers,data:{revision:group.revision,role:'member'}})).json();
  group=await (await member.request.post('/api/collaboration/join',{headers,data:{token:invitation.token}})).json();
  await page.goto('/#agreements');
  await page.locator('.co-page > details').filter({has:page.locator('[data-co="edit-group"]')}).locator('summary').first().click();
  await page.locator('[data-co="edit-group"]').click();
  await page.locator('#co-form details').filter({has:page.locator('[data-co-material]')}).locator('summary').first().click();
  await page.locator('[data-co-material] textarea').fill('Updated synthetic source');
  await page.locator('[data-co-material] input[name$="-shared"]').uncheck();
  await page.locator('[data-co-material] input[name$="-aiAllowed"]').uncheck();
  await page.locator('#co-form button[type=submit]').click();
  await expect(page.locator('#co-form')).toHaveCount(0);
  const current=await (await owner.get(base,{headers})).json();
  expect(current.materials[0]).toMatchObject({id:'public-source',content:'Updated synthetic source',shared:false,aiAllowed:false});
  expect((await (await member.request.get(base,{headers})).json()).materials).toEqual([]);
 } finally {await member.close();}
});
test('AI failure retains input, retry yields editable drafts, and changed versions block adoption',async({page,baseURL})=>{
 await prepare(page); const headers={origin:baseURL!,'x-tango-client':'tango-settings/1'},client=page.context().request;
 await client.post('/__test/register',{headers,data:{username:'retry'+Math.random().toString(36).slice(2,10),password,displayName:'Owner'}});
 let group=await(await client.post('/api/collaboration/groups',{headers,data:{name:'AI recovery',goal:'Check sources',sharing:{aiAllowed:true,fields:['goal','steps']}}})).json();
 await page.goto('/#agreements');await page.locator('.co-ai-disclosure > summary').click();
 await page.locator('#co-question').fill('FAIL_ONCE synthetic request');await page.locator('#co-ai-form button[type=submit]').click();
 await expect(page.locator('#co-question')).toHaveValue('FAIL_ONCE synthetic request');
 await expect(page.locator('.co-notice')).toBeVisible();await expect(page.locator('#co-ai-form button[type=submit]')).toBeEnabled();
 await page.locator('#co-question').fill('plan the source review');await page.locator('#co-ai-form button[type=submit]').click();
 await expect(page.locator('.co-proposal-item')).toHaveCount(2);
 await page.locator('#appearance-select').selectOption('designer');await page.locator('#lang').selectOption('ar');
 await expect(page.locator('#co-question')).toHaveValue('plan the source review');await expect(page.locator('.co-proposal-item')).toHaveCount(2);
 const base='/api/collaboration/groups/'+group.id;group=await(await client.post(base+'/change',{headers,data:{revision:group.revision,op:'group-edit',data:{goal:'Check newly supplied sources'}}})).json();
 await page.locator('[data-co="apply"]').click();await expect(page.locator('.co-notice')).toBeVisible();
 expect((await(await client.get(base,{headers})).json()).steps).toHaveLength(0);
 await page.locator('[data-co="refresh"]').click();await expect(page.locator('[data-co="apply"]')).toHaveCount(0);
 await page.locator('[data-co="dismiss"]').click();await expect(page.locator('.co-proposal')).toHaveCount(0);
});
async function prepare(page:Page){await page.clock.install({time:new Date('2026-10-21T17:00:00+08:00')});await page.route('https://**',route=>route.abort());await page.addInitScript(()=>{localStorage.setItem('tango-donego.web.v1',JSON.stringify({v:1,pv:5,mode:'real',name:'Unclaimed legacy data',wake:960,entries:[{id:'legacy-private',title:'PRIVATE PERSONAL SENTINEL',date:'2026-10-21',start:'07:00',end:'08:00',kind:'necessary',prio:3}],drafts:[],trials:[],methods:[],methodUses:[],fw:{},pal:0,sound:false}));localStorage.setItem('tango-donego.lang','zh');});}
async function register(page:Page,intent='create'){const origin=new URL(page.url()).origin;const response=await page.context().request.post(origin+'/__test/register',{data:{username:'user'+Math.random().toString(36).slice(2,12),password,displayName:intent==='create'?'Research owner':'Research member'}});expect(response.status()).toBe(200);await page.reload();await page.locator('[data-co="'+intent+'"]').first().click();await expect(page.locator('#co-name,#co-token')).toBeVisible();}
test('two independent accounts create, join, adopt editable AI drafts, plan personally, review and follow sources',async({page,browser,baseURL},info)=>{
 await prepare(page);await page.goto('/#agreements');await register(page);
 await page.locator('#co-name').fill('Evidence review group');await page.locator('#co-goal').fill('Verify the paper sources');await page.locator('#co-form details').filter({has:page.locator('input[name="allowAI"]')}).locator('summary').click();await page.locator('input[name="allowAI"]').check();await page.locator('input[name="field-members"]').check();await page.locator('#co-form button[type="submit"]').click();await expect(page.locator('.co-group-heading')).toContainText('Evidence review group');
 await page.locator('.co-members summary').click();await page.locator('[data-co="invite"]').click();await page.locator('#co-form button[type="submit"]').click();const invite=await page.locator('#co-invite-link').inputValue();await page.locator('[data-co="close"]').first().click();
 const memberContext=await browser.newContext({baseURL,viewport:info.project.name==='mobile'?{width:390,height:844}:{width:1440,height:1000},timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});const member=await memberContext.newPage();try{
 await prepare(member);await member.goto('/#agreements');await register(member,'join');await member.locator('#co-token').fill(invite);await member.locator('#co-form button[type="submit"]').click();await expect(member.locator('.co-group-heading')).toContainText('Evidence review group');
 await page.locator('[data-co="refresh"]').click();await expect(page.locator('.co-group-heading')).toContainText('2');
 const accounts=await Promise.all([page.context().request.get(baseURL+'/api/auth/me',{headers:{'x-tango-client':'tango-settings/1'}}).then(r=>r.json()),memberContext.request.get(baseURL+'/api/auth/me',{headers:{'x-tango-client':'tango-settings/1'}}).then(r=>r.json())]);expect(accounts[0].user.id).not.toBe(accounts[1].user.id);expect(accounts[0].user.emailVerified).toBe(true);
 await page.locator('.co-ai-disclosure > summary').click();await page.locator('[data-co="intent-plan"]').click();await page.locator('.co-ai-sharing summary').click();await page.locator('[data-co-share="members"]').check();await page.locator('#co-ai-form button[type="submit"]').click();await expect(page.locator('.co-proposal-item')).toHaveCount(2);await expect(page.locator('.co-ai-answer')).toContainText('Verify the paper sources');
 await page.locator('[data-co="edit-action"][data-index="0"]').click();await page.locator('#co-name').fill('Check evidence');await page.locator('#co-ownerId').selectOption(accounts[1].user.id);await page.locator('#co-form button[type="submit"]').click();await page.locator('[data-co="apply"]').click();await expect(page.locator('.co-step')).toHaveCount(2);
 await member.locator('[data-co="refresh"]').click();await member.locator('[data-co="confirm"]').click();await member.locator('[data-co="personal"]').first().click();await member.locator('#co-date').fill('2026-10-21');await member.locator('#co-start').fill('19:00');await member.locator('#co-minutes').fill('30');await member.locator('#co-form button[type="submit"]').click();
 await member.locator('[data-co="personal"]').first().click();await member.locator('#co-form button[type="submit"]').click();
 await member.locator('.tabs a[href="#today"]').click();await expect(member.locator('.bubble[data-id^="co_"]')).toHaveCount(1);await expect(member.locator('.co-source-link').first()).toContainText('Evidence review group');
 const baseBefore=await member.evaluate(()=>localStorage.getItem('tango-donego.web.v1'));await member.locator('.bubble[data-id^="co_"]').dblclick();await member.locator('#finish-min').fill('25');await member.locator('[data-act="finish-save"]').click();expect(await member.evaluate(()=>localStorage.getItem('tango-donego.web.v1'))).toBe(baseBefore);
 await member.reload();expect(await member.evaluate(()=>localStorage.getItem('tango-donego.web.v1'))).toBe(baseBefore);
 const persisted=await member.evaluate((accountId)=>{const scope=JSON.parse(localStorage.getItem('tango-donego.collaboration.personal.v1:'+accountId)!);return {entries:scope.entries.length,actual:scope.entries[0].completion.actual,trials:scope.trials.length};},accounts[1].user.id);
 expect(persisted).toEqual({entries:1,actual:25,trials:1});
 await member.locator('.tabs a[href="#review"]').click();await expect(member.locator('[data-metric="recorded-minutes"]')).toContainText('25');await expect(member.locator('.co-source-link')).toHaveCount(1);
 await member.locator('.co-source-link').click();await member.locator('[data-co="source-go"]').click();await expect(member.locator('.co-step').first()).toContainText('待开始');await member.locator('.co-step [data-co="start"]').first().click();await member.locator('.co-step [data-co="submit"]').first().click();await member.locator('#co-result').fill('All cited sources checked against the originals.');await member.locator('#co-form button[type="submit"]').click();
 await page.locator('[data-co="refresh"]').click();await page.locator('.co-step [data-co="accept"]').first().click();await expect(page.locator('.co-step').first()).toContainText('已完成');
 for(const theme of ['standard','designer']){await page.locator('#appearance-select').selectOption(theme);await page.screenshot({path:info.outputPath(theme+'-collaboration.png'),fullPage:true});}
 await member.locator('.co-step details summary').first().click();await member.locator('.co-step [data-co="chat"]').first().click();
 await expect(member.locator('.co-chat-page')).toBeVisible();await member.locator('#co-question').fill('Explain the verification method');
 await member.locator('#co-ai-form button[type=submit]').click();await expect(member.locator('.co-chat-page [role=log]')).toContainText('Verify the paper sources');
 await member.locator('#appearance-select').selectOption('designer');await member.locator('#lang').selectOption('ar');
 await expect(member.locator('.co-chat-page [role=log]')).toContainText('Explain the verification method');
 await member.locator('[data-co="back-group"]').click();await member.locator('#lang').selectOption('zh');
 await member.locator('.tabs a[href="#line"]').click();await member.locator('.tree .leaf[data-id^="co_"]').click();await expect(member.locator('.sheet .co-source-link')).toBeVisible();
 }finally{await memberContext.close();}
});

