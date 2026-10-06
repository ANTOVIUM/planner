// The worker owns only the static app shell. Planner data stays in localStorage.
export async function initializeOffline({ notify = () => {} } = {}) {
  const indicator = document.getElementById('offlineIndicator');
  const label = document.getElementById('offlineLabel');
  const detail = document.getElementById('offlineDetail');
  const updateNotice = document.getElementById('updateNotice');
  const updateMessage = document.getElementById('updateMessage');
  const updateButton = document.getElementById('applyUpdate');
  const installButton = document.getElementById('installApp');
  let ready = false;
  let registration;
  let applyingUpdate = false;
  let checking = false;
  let installPrompt;

  const renderStatus = () => {
    indicator.classList.toggle('is-ready', ready);
    label.textContent = ready ? navigator.onLine ? 'Офлайн готов' : 'Без интернета' : indicator.classList.contains('is-error') ? 'Офлайн пока не готов' : 'Подготовка офлайн';
    if (ready) detail.textContent = 'Приложение сохранено на устройстве. Можно закрывать вкладку, открывать план и перезагружать страницу без интернета. Задачи и мысли сохраняются в этом браузере.';
  };
  const unavailable = message => {
    ready = false;
    indicator.classList.remove('is-ready');
    indicator.classList.add('is-error');
    label.textContent = 'Офлайн пока не готов';
    detail.textContent = message;
  };
  function messageWorker(worker, type) {
    return new Promise((resolve, reject) => {
      if (!worker) { reject(new Error('No active worker')); return; }
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Worker timed out')); }, type === 'REPAIR_CACHE' ? 20000 : 6000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
      worker.postMessage({ type }, [channel.port2]);
    });
  }
  const showUpdate = () => {
    if (registration?.waiting) { updateNotice.hidden = false; updateMessage.textContent = 'Новая версия готова'; }
  };
  async function verifyOffline() {
    if (checking || !registration?.active) return;
    checking = true;
    try {
      let result = await messageWorker(registration.active, 'GET_STATUS');
      // A cache may have been evicted. Repair only against this version's hashes.
      if (!result.ready && navigator.onLine && !registration.waiting) result = await messageWorker(registration.active, 'REPAIR_CACHE');
      ready = result.ready === true;
      if (ready) { indicator.classList.remove('is-error'); renderStatus(); }
      else unavailable('Полная офлайн-копия пока не сохранена. Открой приложение с интернетом и дождись статуса «Офлайн готов». Если доступно обновление, сначала примени его.');
    } catch {
      unavailable('Не удалось подготовить офлайн-запуск. Задачи продолжают сохраняться в браузере. Попробуй открыть приложение с интернетом еще раз.');
    } finally { checking = false; }
  }
  window.addEventListener('online', () => { renderStatus(); registration?.update().catch(() => {}); verifyOffline(); });
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verifyOffline(); });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); installPrompt = event; installButton.hidden = false;
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; installButton.hidden = true; });
  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    const prompt = installPrompt; installPrompt = null; installButton.hidden = true;
    await prompt.prompt(); await prompt.userChoice;
  });
  updateButton.addEventListener('click', () => {
    if (!registration?.waiting) { updateNotice.hidden = true; return; }
    const hasDraft = ['quickTaskTitle', 'quickNoteText', 'newNoteText'].some(id => document.getElementById(id).value.trim());
    if (hasDraft || document.querySelector('dialog[open]')) {
      updateMessage.textContent = 'Сохрани ввод и закрой форму перед обновлением';
      notify('Сохрани ввод и закрой форму. После этого можно обновить приложение.');
      return;
    }
    applyingUpdate = true; updateButton.disabled = true;
    updateMessage.textContent = 'Обновляем приложение...';
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  });
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    unavailable('Этот браузер не поддерживает офлайн-запуск на текущем адресе. Используй опубликованный сайт по HTTPS в обычном режиме браузера.');
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applyingUpdate) window.location.reload();
    else verifyOffline();
  });
  try {
    registration = await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: './', updateViaCache: 'none' });
    showUpdate();
    const watch = worker => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') showUpdate();
        if (worker.state === 'activated') verifyOffline();
        if (worker.state === 'redundant' && !registration.active) unavailable('Загрузка офлайн-копии прервалась. Открой приложение с интернетом еще раз.');
      });
    };
    watch(registration.installing);
    registration.addEventListener('updatefound', () => watch(registration.installing));
    await navigator.serviceWorker.ready;
    await verifyOffline();
  } catch {
    unavailable('Браузер не разрешил сохранить офлайн-копию. Задачи и мысли по-прежнему сохраняются локально. Открой сайт в обычном режиме и проверь доступ к хранилищу.');
  }
}
