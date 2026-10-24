import {test,expect,type Page} from '@playwright/test';
const password='Synthetic account password 123';
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
test('password recovery uses the emailed reset code and rejects the previous password',async({page})=>{
 await prepare(page);const username='reset'+Math.random().toString(36).slice(2,10),email=username+'@fixture.test';
 const created=await page.context().request.post('/__test/register',{data:{username,password,displayName:'Recovery account'}});expect(created.status()).toBe(200);
 await page.goto('/#today');await page.locator('#app-auth-logout').click();await page.locator('[data-auth="reset"]').click();
 await page.locator('#auth-email').fill(email);await page.locator('#auth-password').fill('New synthetic password 456');await page.locator('[data-auth="send-code"]').click();await expect(page.locator('.auth-notice')).toContainText('验证码已发送');
 const mail=await(await page.context().request.get('/__test/mailbox?email='+encodeURIComponent(email))).json();expect(mail.purpose).toBe('reset');await page.locator('#auth-code').fill(mail.code);await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.auth-notice')).toContainText('密码已重设');
 await page.locator('#auth-password').fill(password);await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.auth-notice')).toContainText('邮箱或密码不正确');
 await page.locator('#auth-password').fill('New synthetic password 456');await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.tabs')).toBeVisible();
});
async function prepare(page:Page){await page.route('https://**',route=>route.abort());await page.addInitScript(()=>{if(!localStorage.getItem('tango-donego.web.v1'))localStorage.setItem('tango-donego.web.v1',JSON.stringify({v:1,pv:5,mode:'real',entries:[{id:'unclaimed',title:'PRIVATE LEGACY RECORD',date:'2026-10-21',start:'09:00',end:'09:30',kind:'necessary'}],drafts:[],trials:[],methods:[],methodUses:[]}));});}
async function signUp(page:Page,email:string){
 await expect(page.locator('[data-auth="register"]')).toBeVisible();await page.locator('[data-auth="register"]').click();await page.locator('#auth-email').fill(email);await page.locator('#auth-password').fill(password);await page.locator('#auth-displayName').fill('Research member');
 await page.locator('[data-auth="send-code"]').click();await expect(page.locator('.auth-notice')).toContainText('验证码已发送');
 const mail=await(await page.context().request.get('/__test/mailbox?email='+encodeURIComponent(email))).json();expect(mail.email).toBe(email);
 await page.locator('#auth-code').fill(mail.code==='000000'?'000001':'000000');await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.auth-notice')).toContainText('验证码无效');
 await expect(page.locator('#auth-email')).toHaveValue(email);await page.locator('#auth-code').fill(mail.code);await page.locator('#app-auth-form button[type=submit]').click();
 await expect(page.locator('#auth-code')).toHaveCount(0);await expect(page.locator('.auth-notice')).toContainText('邮箱验证成功');
 expect((await page.context().request.get('/api/auth/me',{headers:{'x-tango-client':'tango-settings/1'}})).status()).toBe(401);
 await page.locator('#auth-password').fill(password);await page.locator('#app-auth-form button[type=submit]').click();await expect(page.locator('.tabs')).toBeVisible();
}
test('entry verifies email then signs in; agreements accept one phrase for independent members',async({page,browser,baseURL},info)=>{
 await prepare(page);await page.goto('/#agreements');await expect(page.locator('#auth-email')).toBeVisible();await expect(page.locator('.tabs')).toBeHidden();await expect(page.locator('[data-co="create"]')).toHaveCount(0);
 const original=await page.evaluate(()=>localStorage.getItem('tango-donego.web.v1'));
 await signUp(page,'owner'+Math.random().toString(36).slice(2,10)+'@fixture.test');await expect(page.locator('[data-co="auth-toggle"]')).toHaveCount(0);
 await page.locator('[data-co="create"]').click();await page.locator('#co-name').fill('Shared phrase research');await page.locator('#co-goal').fill('Review evidence together');await page.locator('#co-form button[type=submit]').click();
 await page.locator('.co-members summary').click();await page.locator('[data-co="invite"]').click();await page.locator('#co-form button[type=submit]').click();const phrase=await page.locator('#co-invite-link').inputValue();expect(phrase).toMatch(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/);await page.keyboard.press('Escape');
 for(let i=0;i<2;i++){const context=await browser.newContext({baseURL});try{const member=await context.newPage();await prepare(member);await member.goto('/#agreements');await signUp(member,'member'+Math.random().toString(36).slice(2,10)+'@fixture.test');await member.locator('[data-co="join"]').click();await member.locator('#co-token').fill(phrase.toLowerCase().replaceAll('-',' '));await member.locator('#co-form button[type=submit]').click();await expect(member.locator('.co-group-heading')).toContainText('Shared phrase research');}finally{await context.close();}}
 await page.locator('[data-co="refresh"]').click();await expect(page.locator('.co-group-heading')).toContainText('3');expect(await page.evaluate(()=>localStorage.getItem('tango-donego.web.v1'))).toBe(original);
 await page.locator('.tabs a[href="#today"]').click();await expect(page.locator('#view')).not.toContainText('PRIVATE LEGACY RECORD');
 await page.locator('.picker .tile-av:not([disabled])').last().click();await page.locator('[data-act="pick-save"]').click();await expect(page.locator('.bubble.pb')).toHaveCount(1);
 await page.locator('#app-auth-logout').click();await expect(page.locator('#app-auth-form')).toBeVisible();await expect(page.locator('.tabs')).toBeHidden();
 await page.screenshot({path:info.outputPath('email-entry.png'),fullPage:true});
 await signUp(page,'second'+Math.random().toString(36).slice(2,10)+'@fixture.test');await expect(page.locator('.bubble.pb')).toHaveCount(0);expect(await page.evaluate(()=>localStorage.getItem('tango-donego.web.v1'))).toBe(original);
});
test('signed-in settings connect account identity, app data and logout',async({page})=>{
 await prepare(page);await page.goto('/#today');await signUp(page,'settings'+Math.random().toString(36).slice(2,10)+'@fixture.test');await page.goto('/#settings');
 await expect(page.locator('#app-account-link')).toHaveText('账户设置');await expect(page.locator('#account-settings')).toContainText('真实账号已登录');await expect(page.locator('#account-email')).toHaveValue(/@fixture\.test$/);await expect(page.locator('#account-settings')).toContainText('已验证邮箱');
 await page.locator('#account-display-name').fill('Updated settings member');await page.locator('#account-profile-form button[type=submit]').click();await expect(page.locator('.toast')).toContainText('账号设置已保存');await expect(page.locator('#account-display-name')).toHaveValue('Updated settings member');
 await page.locator('#account-old-password').fill(password);await page.locator('#account-new-password').fill('Updated account password 456');await page.locator('#account-password-form button[type=submit]').click();await expect(page.locator('.toast')).toContainText('密码已更新');
 await page.locator('#account-settings [data-auth="logout"]').click();await expect(page.locator('#app-auth-form')).toBeVisible();await expect(page.locator('.tabs')).toBeHidden();expect((await page.context().request.get('/api/auth/me',{headers:{'x-tango-client':'tango-settings/1'}})).status()).toBe(401);
});
test('auth forms keep drafts across both themes and every language without calling AI',async({page},info)=>{
 await prepare(page);let calls=0;page.on('request',request=>{if(request.url().includes('/api/assistant/chat'))calls++;});await page.goto('/#today');await page.locator('#auth-email').fill('draft@example.test');
 for(const theme of ['standard','designer']){await page.locator('#appearance-select').selectOption(theme);for(const language of ['zh','en','ru','th','ar','ko']){await page.locator('#lang').selectOption(language);await expect(page.locator('#auth-email')).toHaveValue('draft@example.test');expect(await page.evaluate(()=>Math.max(innerWidth,document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width+1);if(language==='zh'||language==='ar')await page.screenshot({path:info.outputPath(theme+'-'+language+'-registration.png'),fullPage:true});}}
 expect(calls).toBe(0);
});
