const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const server=require('node:child_process').spawn('python3',['-m','http.server','8765','--bind','127.0.0.1'],{cwd:path.resolve(__dirname,'../..'),stdio:'ignore'});
process.on('exit',()=>server.kill());
const owner='655f0f86-2143-461b-8d02-ed412135d4e0';
const user={id:owner,email:'qa@example.test',aud:'authenticated',role:'authenticated',is_anonymous:false};
const token=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:owner,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'qa'].join('.');
const session={access_token:token,refresh_token:'qa-refresh',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user};
let model=[],fail=false,lastPage;
async function setup(browser,width=1440,logged=true){
 const ctx=await browser.newContext({viewport:{width,height:1000}});
 if(logged)await ctx.addInitScript(s=>localStorage.setItem('workdesk.auth.v1',JSON.stringify(s)),session);
 await ctx.route('https://hmdjcxpogdrveddznedx.supabase.co/**',async route=>{
  const req=route.request(),url=new URL(req.url()),method=req.method(),headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
  const send=(body,status=200)=>route.fulfill({status,headers,body:JSON.stringify(body)});
  if(method==='OPTIONS')return send({});
  if(url.pathname.startsWith('/auth/')){if(url.pathname.endsWith('/logout'))return send({});if(url.pathname.endsWith('/user'))return send(user);return send(session);}
  if(fail)return route.abort('internetdisconnected');
  if(url.pathname.endsWith('/workdesk_records')){
   if(method==='GET')return send(model.slice());
   const id=(url.searchParams.get('id')||'').replace('eq.',''),rev=+(url.searchParams.get('revision')||'').replace('eq.','');
   if(method==='POST'){const d=req.postDataJSON();const out={...d,id:d.id||crypto.randomUUID(),created_at:new Date().toISOString()};model.push(out);return send([out],201);}
   if(method==='PATCH'){const old=model.find(r=>r.id===id&&r.revision===rev);if(!old)return send([]);Object.assign(old,req.postDataJSON());return send([old]);}
   if(method==='DELETE'){const old=model.find(r=>r.id===id&&r.revision===rev);model=model.filter(r=>r!==old);return send(old?[{id}]:[]);}
  }
  return send({message:'Unexpected mock endpoint'},404);
 });
 const page=await ctx.newPage();lastPage=page;page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:8765/workdesk/');await page.waitForFunction(()=>window.supabase);
 if(logged)await page.locator('#app:not([hidden])').waitFor();
 return {ctx,page,errors};
}
const waitSaved=p=>p.locator('#editor').waitFor({state:'hidden'});
(async()=>{
 for(let i=0;i<20;i++){try{await fetch('http://127.0.0.1:8765/workdesk/');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/tmp/desk-chrome/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
 const a=await setup(browser),p=a.page;
 await p.locator('#new-order').click();await p.getByLabel('Название заказа',{exact:true}).fill('Курсовая - тест');await p.getByLabel('Клиент',{exact:true}).fill('Клиент <script>alert(1)</script>');await p.getByLabel('Стоимость до комиссии, руб.').fill('5000');await p.getByLabel('Комиссия площадки, руб.').fill('500');await p.getByLabel('Плановое время, ч').fill('5');await p.locator('#editor-save').click();await waitSaved(p);assert.equal(model.filter(x=>x.kind==='order').length,1);
 await p.getByRole('button',{name:'Заказы',exact:true}).click();assert.match(await p.locator('#content').textContent(),/Клиент <script>alert\(1\)<\/script>/);assert.equal(await p.locator('#content script').count(),0);
 await p.getByRole('button',{name:'Финансы',exact:true}).click();await p.getByRole('button',{name:'+ Платеж',exact:true}).click();await p.getByLabel('Заказ',{exact:true}).selectOption(model.find(r=>r.kind==='order').id);await p.getByLabel('Фактическая сумма, руб.').fill('1000');await p.locator('#editor-save').click();await waitSaved(p);assert.equal(model.filter(x=>x.kind==='payment').length,1);
 await p.getByRole('button',{name:'+ Платеж',exact:true}).click();await p.getByLabel('Заказ',{exact:true}).selectOption(model.find(r=>r.kind==='order').id);await p.getByLabel('Вид платежа').selectOption('refund');await p.getByLabel('Фактическая сумма, руб.').fill('1001');await p.locator('#editor-save').click();await p.locator('#editor-error').filter({hasText:'Возврат превышает'}).waitFor();assert.equal(model.filter(x=>x.kind==='payment').length,1);await p.getByLabel('Фактическая сумма, руб.').fill('500');await p.locator('#editor-save').click();await waitSaved(p);
 await p.getByRole('button',{name:'Аналитика',exact:true}).click();await p.getByRole('button',{name:'+ Записать время',exact:true}).click();await p.getByLabel('Заказ',{exact:true}).selectOption(model.find(r=>r.kind==='order').id);await p.getByLabel('Длительность, минут').fill('120');await p.locator('#editor-save').click();await waitSaved(p);assert.equal(model.filter(x=>x.kind==='time').length,1);
 await p.getByRole('button',{name:'Задачи',exact:true}).click();await p.getByRole('button',{name:'+ Задача',exact:true}).click();await p.getByLabel('Что нужно сделать').fill('Проверить сноски');await p.locator('#editor-save').click();await waitSaved(p);await p.getByRole('button',{name:'Выполнить: Проверить сноски'}).click();await p.getByRole('button',{name:'Выполненные',exact:true}).click();await p.locator('.task-card.done').waitFor();assert.equal(model.find(r=>r.kind==='task').data.done,true);
 await p.getByRole('button',{name:'Настройки',exact:true}).click();await p.getByLabel('Название кабинета').fill('Мой тестовый кабинет');await p.getByLabel('Минимальный доход за час, руб.').fill('1500');await p.getByRole('button',{name:'Сохранить настройки'}).click();await p.waitForFunction(()=>document.querySelector('#account-name').textContent==='Мой тестовый кабинет');assert.equal(model.find(r=>r.kind==='settings').data.hourly,1500);
 const b=await setup(browser,390);await b.page.getByRole('button',{name:'Заказы',exact:true}).click();assert.match(await b.page.locator('#content').textContent(),/Курсовая - тест/);
 await p.getByRole('button',{name:'Заказы',exact:true}).click();await p.getByRole('button',{name:'Открыть',exact:true}).first().click();const old=model.find(r=>r.kind==='order');old.revision++;old.data.client='Изменение на телефоне';await p.getByLabel('Название заказа',{exact:true}).fill('Старое изменение');await p.locator('#editor-save').click();await p.locator('#editor-error').filter({hasText:'другом устройстве'}).waitFor();assert.equal(await p.getByLabel('Название заказа',{exact:true}).inputValue(),'Старое изменение');await p.getByRole('button',{name:'Отмена',exact:true}).click();
 await p.locator('#refresh').click();await p.getByRole('button',{name:'Открыть',exact:true}).first().click();fail=true;await p.getByLabel('Название заказа',{exact:true}).fill('Не терять ввод');await p.locator('#editor-save').click();await p.locator('#editor-error').filter({hasText:'связи'}).waitFor();assert.equal(await p.getByLabel('Название заказа',{exact:true}).inputValue(),'Не терять ввод');fail=false;await p.getByRole('button',{name:'Отмена',exact:true}).click();
 const sizes=[1440,1024,768,390,360];for(const width of sizes){await p.setViewportSize({width,height:1000});for(const v of ['Обзор','Заказы','Финансы','Задачи','Аналитика','Настройки']){await p.getByRole('button',{name:v,exact:true}).first().click();assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${width} ${v}`);}}
 const c=await setup(browser,1440,false);await c.page.getByRole('button',{name:'Открыть пример кабинета'}).click();await c.page.screenshot({path:'/tmp/workdesk-desktop.png',fullPage:true});await c.page.setViewportSize({width:390,height:1000});await c.page.screenshot({path:'/tmp/workdesk-mobile.png',fullPage:true});await c.page.getByRole('button',{name:'Новый заказ',exact:false}).click();assert.equal(await c.page.locator('#editor').isVisible(),false);
 const mc=await setup(browser,1440);await mc.ctx.addInitScript(()=>{const list=[];Object.defineProperty(document,'modelContext',{value:{registerTool(t){list.push(t);}}});window.__tools=list;});await mc.page.reload();await mc.page.waitForFunction(()=>window.__tools?.length===2);const result=await mc.page.evaluate(()=>window.__tools[0].execute({month:'2026-10'}));assert.equal(result.month,'2026-10');assert.equal(await mc.page.evaluate(async()=>{try{await window.__tools[0].execute({month:'broken'});return false;}catch{return true;}}),true);await mc.page.evaluate(()=>window.__tools[1].execute({}));assert.equal(await mc.page.locator('#editor').isVisible(),true);
 assert.deepEqual([...a.errors,...b.errors,...c.errors,...mc.errors],[]);console.log(JSON.stringify({result:'passed',checks:['order creation','escaped user input','partial payment','refund validation','time entry','task completion','settings persistence','second device read','stale revision input preserved','network error input preserved','30 responsive views','isolated demo','WebMCP read and start valid/invalid'],screenshots:['/tmp/workdesk-desktop.png','/tmp/workdesk-mobile.png']}));await browser.close();server.kill();
})().catch(async e=>{console.error(e);if(lastPage){await lastPage.screenshot({path:'/tmp/workdesk-fail.png'}).catch(()=>{});console.error((await lastPage.locator('body').innerText()).slice(-1800));}process.exit(1);});
