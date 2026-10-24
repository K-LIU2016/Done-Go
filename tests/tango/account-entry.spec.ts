import {test,expect,type Page} from '@playwright/test';
const password='SyncPass123';
const accountInput=(page:Page)=>page.locator('#app-auth-form input').first();
const registerLink=(page:Page)=>page.locator('.auth-alt .auth-link');

async function expectNoContactToggle(page:Page){
 await expect(page.locator('.auth-tabs')).toHaveCount(0);
 await expect(page.locator('[data-auth="contact-email"],[data-auth="contact-phone"]')).toHaveCount(0);
}

test('administrators list, disable, enable and confirm-delete users; ordinary members are denied',async({page,browser,baseURL},info)=>{
 await prepare(page);const registered=await page.context().request.post('/__test/register',{data:{username:'admin',password,displayName:'Fixture administrator'}});expect(registered.status()).toBe(200);
 const memberContext=await browser.newContext({baseURL});try{
  const name='managed'+Math.random().toString(36).slice(2,10),email=name+'@fixture.test';const memberResponse=await memberContext.request.post('/__test/register',{data:{username:name,password,displayName:'Managed member'}});expect(memberResponse.status()).toBe(200);const memberUser=(await memberResponse.json()).user;
  await page.goto('/#users');await expect(page.locator('#app-users-link')).toBeVisible();const row=page.locator('[data-admin-user="'+memberUser.id+'"]');await expect(row).toContainText(email);
  await row.locator('[data-users-action="toggle"]').click();await expect(row).toContainText('已停用');expect((await memberContext.request.get('/api/auth/me',{headers:{'x-tango-client':'tango-settings/1'}})).status()).toBe(401);
  await row.locator('[data-users-action="toggle"]').click();await expect(row).toContainText('已启用');const logged=await memberContext.request.post('/api/auth/login',{headers:{origin:baseURL!,'x-tango-client':'tango-settings/1'},data:{email,password}});expect(logged.status()).toBe(200);
  const ordinary=await memberContext.newPage();await prepare(ordinary);await ordinary.goto('/#users');await expect(ordinary.locator('#app-users-link')).toHaveCount(0);await expect(ordinary.locator('#view')).toContainText('权限不足');expect((await memberContext.request.get('/api/admin/users',{headers:{'x-tango-client':'tango-settings/1'}})).status()).toBe(403);
  for(const theme of ['standard','designer']){await page.locator('#appearance-select').selectOption(theme);await page.screenshot({path:info.outputPath(theme+'-users-management.png'),fullPage:true});}
  await row.locator('[data-users-action="delete"]').click();await expect(row.locator('.admin-delete-confirm')).toContainText(email);await row.locator('[data-users-action="cancel"]').click();await expect(row).toBeVisible();
  await row.locator('[data-users-action="delete"]').click();await row.locator('[data-users-action="confirm"]').click();await expect(row).toHaveCount(0);expect((await memberContext.request.get('/api/auth/me',{headers:{'x-tango-client':'tango-settings/1'}})).status()).toBe(401);
  const self=page.locator('.admin-user');await expect(self).toHaveCount(1);await expect(self.locator('[data-users-action="delete"]')).toBeDisabled();
 }finally{await memberContext.close();}
});

async function prepare(page:Page){await page.route('https://**',route=>route.abort());await page.addInitScript(()=>{if(!localStorage.getItem('tango-donego.web.v1'))localStorage.setItem('tango-donego.web.v1',JSON.stringify({v:1,pv:5,mode:'real',entries:[{id:'unclaimed',title:'PRIVATE LEGACY RECORD',date:'2026-10-21',start:'09:00',end:'09:30',kind:'necessary'}],drafts:[],trials:[],methods:[],methodUses:[]}));});}

async function signUp(page:Page,account:string){
 await expectNoContactToggle(page);await registerLink(page).click();await accountInput(page).fill(account);await page.locator('#auth-password').fill(password);
 await expect(page.locator('#auth-password')).toHaveAttribute('minlength','8');
 await page.locator('#auth-passwordConfirm').fill(password);await page.locator('#auth-displayName').fill('Research member');
 await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.auth-notice')).toContainText('注册成功，请登录');await expect(page.locator('#auth-passwordConfirm')).toHaveCount(0);
 await page.locator('#auth-password').fill(password);await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.tabs')).toBeVisible();
}

test('entry registers with an email through the single account field and agreements accept one phrase',async({page,browser,baseURL},info)=>{
 await prepare(page);await page.goto('/#agreements');await expect(accountInput(page)).toBeVisible();await expectNoContactToggle(page);await expect(page.locator('.tabs')).toBeHidden();await expect(page.locator('[data-co="create"]')).toHaveCount(0);
 const original=await page.evaluate(()=>localStorage.getItem('tango-donego.web.v1'));
 await signUp(page,'owner'+Math.random().toString(36).slice(2,10)+'@fixture.test');await expect(page.locator('[data-co="auth-toggle"]')).toHaveCount(0);
 await page.locator('[data-co="create"]').click();await page.locator('#co-name').fill('Shared phrase research');await page.locator('#co-goal').fill('Review evidence together');await page.locator('#co-form button[type=submit]').click();
 await page.locator('.co-members summary').click();await page.locator('[data-co="invite"]').click();await page.locator('#co-form button[type=submit]').click();const phrase=await page.locator('#co-invite-link').inputValue();expect(phrase).toMatch(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/);await page.keyboard.press('Escape');
 for(let i=0;i<2;i++){const context=await browser.newContext({baseURL});try{const member=await context.newPage();await prepare(member);await member.goto('/#agreements');await signUp(member,'member'+Math.random().toString(36).slice(2,10)+'@fixture.test');await member.locator('[data-co="join"]').click();await member.locator('#co-token').fill(phrase.toLowerCase().replaceAll('-',' '));await member.locator('#co-form button[type=submit]').click();await expect(member.locator('.co-group-heading')).toContainText('Shared phrase research');}finally{await context.close();}}
 await page.locator('[data-co="refresh"]').click();await expect(page.locator('.co-group-heading')).toContainText('3');expect(await page.evaluate(()=>localStorage.getItem('tango-donego.web.v1'))).toBe(original);
 await page.locator('.tabs a[href="#today"]').click();await expect(page.locator('#view')).not.toContainText('PRIVATE LEGACY RECORD');
 await page.locator('.picker .tile-av:not([disabled])').last().click();await page.locator('[data-act="pick-save"]').click();await expect(page.locator('.bubble.pb')).toHaveCount(1);
 await page.locator('#app-auth-logout').click();await expect(page.locator('#app-auth-form')).toBeVisible();await expect(page.locator('.tabs')).toBeHidden();
 await page.screenshot({path:info.outputPath('account-entry.png'),fullPage:true});
});

test('entry registers and signs in with a phone number through the same single account field',async({page})=>{
 await prepare(page);await page.goto('/#today');await expect(accountInput(page)).toBeVisible();await expectNoContactToggle(page);await expect(page.locator('#app-auth-form input')).toHaveCount(2);
 const phone='138'+String(Math.floor(10000000+Math.random()*89999999));
 await registerLink(page).click();await accountInput(page).fill(phone);await page.locator('#auth-password').fill(password);await page.locator('#auth-passwordConfirm').fill(password);
 await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.auth-notice')).toContainText('注册成功，请登录');await expect(page.locator('#auth-passwordConfirm')).toHaveCount(0);
 await page.locator('#auth-password').fill(password);await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.tabs')).toBeVisible();
});

async function signIn(page:Page,account:string){
 await expectNoContactToggle(page);await accountInput(page).fill(account);await page.locator('#auth-password').fill(password);
 await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.tabs')).toBeVisible();
}

test('auth forms keep drafts across every language and unlock themes after sign-in',async({page,browser,baseURL},info)=>{
 await prepare(page);let calls=0;page.on('request',request=>{if(request.url().includes('/api/assistant/chat'))calls++;});await page.goto('/#today');await accountInput(page).fill('draft@example.test');
 await expect(page.locator('#appearance-control')).toBeHidden();await expect(page.locator('.lang-caption')).toHaveText('语言');await expect(page.locator('#lang')).toHaveValue('zh');
 expect(await page.locator('#auth-account').evaluate(el=>getComputedStyle(el).paddingInlineStart)).toBe('48px');
 for(const language of ['zh','en','ru','th','ar','ko']){await page.locator('#lang').selectOption(language);await expect(accountInput(page)).toHaveValue('draft@example.test');expect(await page.evaluate(()=>Math.max(innerWidth,document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width+1);if(language==='en'){await expect(page.locator('.logo')).not.toContainText('探戈');await expect(page.locator('.logo')).toContainText('Done&Go');await expect(page.locator('.slogan')).toHaveText('Embrace our changing world, one small thing at a time.');}if(language==='zh'){await expect(page.locator('.logo')).toContainText('探戈');await expect(page.locator('.slogan')).toHaveText('从一件件的小事里拥抱我们的大时代');}if(language==='ar')expect(await page.locator('#auth-account').evaluate(el=>getComputedStyle(el).paddingInlineStart)).toBe('48px');if(language==='zh'||language==='ar')await page.screenshot({path:info.outputPath(language+'-registration.png'),fullPage:true});}
 const username='theme'+Math.random().toString(36).slice(2,10),account=username+'@fixture.test',registrationContext=await browser.newContext({baseURL});
 try{const registered=await registrationContext.request.post('/__test/register',{data:{username,password,displayName:'Theme member'}});expect(registered.status()).toBe(200);}finally{await registrationContext.close();}
 await page.locator('#lang').selectOption('zh');await signIn(page,account);await expect(page.locator('#appearance-control')).toBeVisible();
 for(const theme of ['standard','designer']){await page.locator('#appearance-select').selectOption(theme);await expect(page.locator('html')).toHaveAttribute('data-appearance',theme);await page.screenshot({path:info.outputPath(theme+'-signed-in.png'),fullPage:true});}
 expect(calls).toBe(0);
});
