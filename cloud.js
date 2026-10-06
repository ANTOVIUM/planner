import { SUPABASE_CONFIG } from './supabase-config.js';
import { SupabaseAPI } from './supabase-api.js';
import { TaskSynchronizer } from './task-sync.js';
const $ = id => document.getElementById(id);
const localLocks = new Map();
async function withLock(name,fn) {
  if (navigator.locks?.request) return navigator.locks.request(name,{ mode:'exclusive',signal:AbortSignal.timeout?.(30000) },fn);
  const previous = localLocks.get(name) || Promise.resolve();
  const next = previous.catch(()=>{}).then(fn); localLocks.set(name,next);
  try { return await next; } finally { if (localLocks.get(name) === next) localLocks.delete(name); }
}
export function initializeCloud({ storage,planner,onChange,notify,openDialog }) {
  let api,engine,busy = false,timer,retry = 0,errorText = '';
  const dialog = $('accountDialog');
  try { api = new SupabaseAPI({ config:SUPABASE_CONFIG,storage,withLock }); engine = new TaskSynchronizer({ api,planner,storage,onChange,notify,withLock }); }
  catch (error) { errorText = error.message; }
  function renderAccount() {
    const session = api?.session();
    $('accountForm').hidden = Boolean(session) || !api; $('accountSignedIn').hidden = !session; $('accountUnavailable').hidden = Boolean(api);
    $('accountEmailLabel').textContent = session?.user.email || 'Твой аккаунт';
    $('cloudLabel').textContent = session ? busy ? 'Сверяем' : !navigator.onLine ? 'Без сети' : engine.lastResult.pending ? 'Есть изменения' : errorText || !engine.lastResult.lastSync ? 'Синхронизация' : 'Все сохранено' : 'Войти';
    $('openAccount').classList.toggle('is-connected',Boolean(session) && !errorText && Boolean(engine.lastResult.lastSync) && !engine.lastResult.pending);
    $('openAccount').setAttribute('aria-label',session ? 'Открыть аккаунт и синхронизацию' : 'Войти для синхронизации задач');
    $('syncNow').disabled = busy; $('signOut').disabled = busy;
    const pending = engine?.lastResult.pending || 0;
    const status = !session ? 'Войди, чтобы открыть свои задачи на других устройствах.' : busy ? 'Сверяем задачи с твоим аккаунтом...' : !navigator.onLine ? 'Без интернета. Изменения останутся на устройстве и отправятся при возвращении сети.' : pending ? `Ожидают отправки: ${pending}. Локальный план сохранен.` : engine.lastResult.lastSync ? `Задачи синхронизированы в ${new Intl.DateTimeFormat('ru-RU',{ hour:'2-digit',minute:'2-digit' }).format(new Date(engine.lastResult.lastSync))}.` : 'Подготавливаем синхронизацию. Локальные записи сохранены.';
    $('cloudDetail').textContent = errorText || status; $('cloudDetail').classList.toggle('is-error',Boolean(errorText));
    $('accountUnavailable').textContent = errorText || 'Подключение к существующему проекту пока готовится. Локальный план и офлайн-режим доступны.';
  }
  function schedule(delay = 300) {
    clearTimeout(timer); if (!api?.session()) { renderAccount(); return; }
    timer = setTimeout(()=>runSync(),delay);
  }
  async function runSync() {
    if (!api?.session() || busy) return;
    busy = true; errorText = ''; renderAccount();
    try { await engine.sync({ online:navigator.onLine }); retry = 0; }
    catch (error) { errorText = error.name === 'CloudError' ? error.message : 'Синхронизация прервалась. Локальный план сохранен.'; retry = Math.min(retry + 1,5); }
    finally { busy = false; renderAccount(); if (api?.session() && !document.hidden) schedule(engine.lastResult.pending && !errorText && navigator.onLine ? 1200 : Math.min(60000,15000 * Math.max(1,retry))); }
  }
  $('openAccount').addEventListener('click',()=>{ renderAccount(); openDialog(dialog); });
  $('accountForm').addEventListener('submit',async event=>{
    event.preventDefault(); if (!api || busy) return;
    const email = $('accountEmail').value.trim(), password = $('accountPassword').value;
    if (!email || !password) return;
    busy = true; $('accountSubmit').disabled = true; $('accountError').hidden = true;
    try {
      await api.signIn(email,password);
      try { engine.owner(); } catch (error) { await api.signOut(); throw error; }
      errorText = ''; notify('Вход выполнен. Локальные задачи будут объединены с задачами аккаунта.');
    } catch (error) { $('accountError').textContent = error.name === 'CloudError' ? error.message : 'Вход не выполнен. Попробуй еще раз.'; $('accountError').hidden = false; }
    finally { $('accountPassword').value = ''; busy = false; $('accountSubmit').disabled = false; renderAccount(); if (api.session()) schedule(0); }
  });
  $('syncNow').addEventListener('click',()=>runSync());
  $('signOut').addEventListener('click',async()=>{
    if (!api || busy) return;
    clearTimeout(timer); busy = true; renderAccount();
    try { await api.signOut(); errorText = ''; notify('Ты вышел из аккаунта. Локальный план и неотправленные изменения сохранены.'); }
    catch (error) { errorText = error.message; }
    finally { busy = false; renderAccount(); }
  });
  dialog.addEventListener('close',()=>{ $('accountPassword').value = ''; $('accountError').hidden = true; });
  window.addEventListener('online',()=>schedule(0)); window.addEventListener('offline',()=>schedule(0));
  window.addEventListener('storage',event=>{ if (event.key === api?.sessionKey) { renderAccount(); schedule(0); } });
  document.addEventListener('visibilitychange',()=>{ if (document.hidden) clearTimeout(timer); else schedule(0); });
  window.addEventListener('focus',()=>schedule(0)); renderAccount(); schedule(0);
  return { schedule,signedIn:()=>Boolean(api?.session()) };
}
