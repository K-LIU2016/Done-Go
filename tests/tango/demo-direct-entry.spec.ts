import {test,expect} from '@playwright/test';

test('visitors enter immediately, keep their session on refresh and cannot access administration',async({page})=>{
 await page.route('https://**',route=>route.abort());
 const authWrites:string[]=[];
 page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/auth/'))authWrites.push(request.url());});
 // Harness contract: this spec requires the direct-entry demo launcher (playwright.demo-direct.config.ts,
 // scripts/start-local-auth.mjs with TANGO_REQUIRE_ACCOUNT=0). Any other harness must fail here, not below.
 const harness=await(await page.request.get('/api/auth/status',{headers:{'x-tango-client':'tango-settings/1'}})).json();
 expect(harness.demoMode).toBe(true);
 expect(harness.autoStart).toBe(true);
 await page.goto('/#agreements');
 await expect(page.locator('.tabs')).toBeVisible();
 await expect(page.locator('#app-auth-form,#app-demo-form,input[type=email],input[type=password]')).toHaveCount(0);
 await expect(page.locator('#app-auth-logout')).toBeHidden();
 const headers={'x-tango-client':'tango-settings/1'};
 const before=await(await page.request.get('/api/auth/me',{headers})).json();
 expect(before.user.demo).toBe(true);
 expect(before.user.email).toBeNull();
 await page.reload();
 await expect(page.locator('[data-co="create"]')).toBeVisible();
 expect((await(await page.request.get('/api/auth/me',{headers})).json()).user.id).toBe(before.user.id);
 const admin=await page.request.get('/api/admin/users',{headers});
 expect(admin.status()).toBe(403);
 expect(authWrites.filter(url=>url.endsWith('/demo-start'))).toHaveLength(1);
 expect(authWrites.every(url=>url.endsWith('/demo-start'))).toBe(true);
 await page.context().clearCookies();
 await page.reload();
 await expect(page.locator('.tabs')).toBeVisible();
 await expect(page.locator('#app-auth-form,#app-demo-form')).toHaveCount(0);
 expect((await(await page.request.get('/api/auth/me',{headers})).json()).user.id).not.toBe(before.user.id);
});

test('all appearances and languages stay usable without exposing account screens',async({page},info)=>{
 await page.route('https://**',route=>route.abort());
 const harness=await(await page.request.get('/api/auth/status',{headers:{'x-tango-client':'tango-settings/1'}})).json();
 expect(harness.demoMode).toBe(true);
 expect(harness.autoStart).toBe(true);
 await page.goto('/#today');
 await expect(page.locator('.tabs')).toBeVisible();
 for(const theme of ['standard','swiss','archive','designer','workbench']){
  await page.locator('#appearance-select').selectOption(theme);
  for(const language of ['zh','en','ru','th','ar','ko']){
   await page.locator('#lang').selectOption(language);
   await expect(page.locator('.tabs')).toBeVisible();
   await expect(page.locator('#app-auth-form,#app-demo-form')).toHaveCount(0);
   await expect(page.locator('#app-auth-logout')).toBeHidden();
   await expect(page.locator('html')).toHaveAttribute('dir',language==='ar'?'rtl':'ltr');
  }
 }
 await page.locator('#lang').selectOption('zh');
 await page.locator('#appearance-select').selectOption('standard');
 await page.screenshot({path:info.outputPath('direct-entry.png'),fullPage:true});
});
