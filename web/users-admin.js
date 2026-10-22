(function(root){
'use strict';
var rows=[
['用户管理','User management','Управление пользователями','จัดการผู้ใช้','إدارة المستخدمين','사용자 관리'],
['用户','User','Пользователь','ผู้ใช้','المستخدم','사용자'],
['管理员','Administrator','Администратор','ผู้ดูแล','مسؤول','관리자'],
['普通用户','Member','Участник','ผู้ใช้ทั่วไป','عضو','일반 사용자'],
['已启用','Active','Активен','เปิดใช้งาน','مفعّل','활성'],
['已停用','Disabled','Отключён','ปิดใช้งาน','معطّل','비활성'],
['停用','Disable','Отключить','ปิดใช้งาน','تعطيل','비활성화'],
['启用','Enable','Включить','เปิดใช้งาน','تفعيل','활성화'],
['删除账号','Delete account','Удалить аккаунт','ลบบัญชี','حذف الحساب','계정 삭제'],
['确认删除','Confirm deletion','Подтвердить удаление','ยืนยันการลบ','تأكيد الحذف','삭제 확인'],
['取消','Cancel','Отмена','ยกเลิก','إلغاء','취소'],
['刷新','Refresh','Обновить','รีเฟรช','تحديث','새로 고침'],
['加载中','Loading','Загрузка','กำลังโหลด','جارٍ التحميل','불러오는 중'],
['权限不足','Permission denied','Недостаточно прав','ไม่มีสิทธิ์','لا توجد صلاحية','권한 부족'],
['操作失败，请重试','Action failed. Try again.','Ошибка. Повторите.','ดำเนินการไม่สำเร็จ โปรดลองใหม่','تعذّر الإجراء. حاول مجددًا.','처리하지 못했습니다. 다시 시도하세요.'],
['请先转交小组负责人，再删除账号。','Transfer group ownership before deleting this account.','Сначала передайте владение группой.','โอนสิทธิ์เจ้าของกลุ่มก่อนลบบัญชี','انقل مسؤولية المجموعة قبل حذف الحساب.','그룹 책임자를 넘긴 뒤 계정을 삭제하세요.'],
['不能在这里停用或删除自己的账号。','You cannot disable or delete your own account here.','Здесь нельзя отключить или удалить себя.','ไม่สามารถปิดหรือลบบัญชีตนเองที่นี่','لا يمكنك تعطيل حسابك أو حذفه هنا.','여기서 본인 계정을 비활성화하거나 삭제할 수 없습니다.'],
['删除后会话失效，服务端私人关联会移除；共享历史保留。','Deletion revokes sessions and removes private server links. Shared history is kept.','Сессии и личные связи удалятся. Общая история сохранится.','การลบจะยกเลิกเซสชันและข้อมูลเชื่อมโยงส่วนตัว โดยเก็บประวัติร่วม','يلغي الحذف الجلسات والروابط الخاصة، مع إبقاء السجل المشترك.','삭제 시 세션과 서버 개인 연결이 제거됩니다. 공유 기록은 유지됩니다.'],
['服务端关联','Server links','Связи на сервере','ข้อมูลเชื่อมโยงบนเซิร์ฟเวอร์','روابط الخادم','서버 연결'],
['此处仅统计服务端关联，不读取用户浏览器里的私人记录。','Counts cover server links only. Private browser records are not read.','Здесь только серверные связи, без личных записей браузера.','นับเฉพาะข้อมูลเชื่อมโยงบนเซิร์ฟเวอร์ ไม่อ่านบันทึกส่วนตัวในเบราว์เซอร์','الإحصاء لروابط الخادم فقط، دون قراءة السجلات الخاصة في المتصفح.','서버 연결만 집계하며 브라우저의 개인 기록은 읽지 않습니다.']
];
function t(key){var language=root.TangoI18n?.language()||'zh',index=Math.max(0,['zh','en','ru','th','ar','ko'].indexOf(language)),row=rows.find(function(row){return row[0]===key;});return row?row[index]:key;}
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function create(bridge){var s={loaded:false,busy:false,users:[],confirm:null,error:''};
 function active(){return bridge.route()==='users';}
 function refresh(){if(active())bridge.refresh();}
 async function api(path,method,body){var response=await fetch('/api/admin/users'+(path||''),{method:method||'GET',credentials:'same-origin',headers:{'x-tango-client':'tango-settings/1',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});var value=await response.json();if(!response.ok)throw {code:value.error};return value;}
 function message(error){return ({ADMIN_REQUIRED:'权限不足',AUTH_REQUIRED:'权限不足',ACCOUNT_OWNS_GROUPS:'请先转交小组负责人，再删除账号。',SELF_MODIFICATION:'不能在这里停用或删除自己的账号。'})[error?.code]||'操作失败，请重试';}
 async function load(){if(s.busy)return;s.busy=true;s.error='';refresh();try{s.users=(await api()).users;s.loaded=true;}catch(error){s.error=message(error);s.loaded=true;}finally{s.busy=false;refresh();}}
 function button(action,label,id,disabled){return '<button type="button" class="btn sm" data-users-action="'+action+'"'+(id?' data-user-id="'+esc(id)+'"':'')+(disabled?' disabled':'')+'>'+esc(t(label))+'</button>';}
 document.addEventListener('click',async function(event){var el=event.target.closest('[data-users-action]');if(!el||!active()||bridge.user.role!=='admin')return;var action=el.dataset.usersAction,id=el.dataset.userId,user=s.users.find(function(user){return user.id===id;});if(action==='refresh'){await load();return;}if(action==='cancel'){s.confirm=null;refresh();return;}if(!user||user.id===bridge.user.id||s.busy)return;if(action==='delete'){s.confirm=id;refresh();document.querySelector('[data-users-action="confirm"]')?.focus();return;}s.busy=true;s.error='';refresh();try{if(action==='toggle')await api('/'+id,'PATCH',{isActive:!user.isActive});else if(action==='confirm'&&s.confirm===id){await api('/'+id,'DELETE');s.confirm=null;}s.loaded=false;}catch(error){s.error=message(error);}finally{s.busy=false;if(!s.loaded)await load();else refresh();}});
 function render(){if(bridge.user.role!=='admin')return '<p role="status">'+esc(t('权限不足'))+'</p>';if(!s.loaded&&!s.busy)queueMicrotask(load);return '<section class="users-admin"><div class="co-step-head"><h1>'+esc(t('用户管理'))+'</h1>'+button('refresh','刷新',null,s.busy)+'</div><p class="small muted">'+esc(t('此处仅统计服务端关联，不读取用户浏览器里的私人记录。'))+'</p>'+(s.error?'<p role="alert" class="co-notice">'+esc(t(s.error))+'</p>':'')+(!s.loaded?'<p role="status">'+esc(t('加载中'))+'</p>':'')+s.users.map(function(user){var self=user.id===bridge.user.id;return '<article class="admin-user" data-admin-user="'+esc(user.id)+'"><div><h2 data-user-content>'+esc(user.displayName)+'</h2><p data-user-content>'+esc(user.email||'')+'</p><p class="small muted">'+esc(t(user.role==='admin'?'管理员':'普通用户'))+' · '+esc(t(user.isActive?'已启用':'已停用'))+' · '+esc(t('服务端关联'))+' '+Number(user.resourceCount||0)+'</p></div><div class="btns">'+button('toggle',user.isActive?'停用':'启用',user.id,self||s.busy)+button('delete','删除账号',user.id,self||s.busy)+'</div>'+(s.confirm===user.id?'<div class="admin-delete-confirm"><p>'+esc(user.email)+' · '+esc(t('删除后会话失效，服务端私人关联会移除；共享历史保留。'))+'</p><div class="btns">'+button('confirm','确认删除',user.id,s.busy)+button('cancel','取消')+'</div></div>':'')+'</article>';}).join('')+'</section>';}
 return {render:render};
}
root.TangoUsersAdmin={create:create};
})(window);
