import { validDay, parseState, SCHEMA_VERSION } from './core.js';

export const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export class CloudError extends Error {
  constructor(kind, message, status = 0) { super(message); this.name = 'CloudError'; this.kind = kind; this.status = status; }
}

export function validateCloudConfig(value) {
  if (!value || typeof value !== 'object') throw new CloudError('config', 'Подключение к аккаунту пока не настроено.');
  let url;
  try { url = new URL(value.url); } catch { throw new CloudError('config', 'Адрес существующего проекта не подтвержден.'); }
  if (url.protocol !== 'https:' || !/^[a-z\d-]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new CloudError('config', 'Нужен HTTPS-адрес существующего проекта Supabase.');
  const key = String(value.publishableKey || '').trim();
  let publicKey = /^sb_publishable_[A-Za-z\d_-]{16,}$/.test(key);
  if (!publicKey && key.split('.').length === 3) {
    try { const payload = JSON.parse(atob(key.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))); publicKey = payload.role === 'anon'; } catch { /* Reject unreadable or privileged credentials. */ }
  }
  if (!publicKey) throw new CloudError('config', 'Допускается только публичный publishable или anon ключ.');
  const statusValues = value.statusValues || { active:'active', done:'done' };
  const priorityValues = value.priorityValues || { normal:'normal', medium:'medium', high:'high' };
  if (!['active','done'].every(k => /^[a-z_]{2,30}$/.test(statusValues[k])) || statusValues.active === statusValues.done || !['normal','medium','high'].every(k => /^[a-z_]{2,30}$/.test(priorityValues[k])) || new Set(Object.values(priorityValues)).size !== 3) throw new CloudError('config', 'Значения полей базы не подтверждены.');
  const deadlineTimeZone = value.deadlineTimeZone || 'Europe/Saratov';
  try { new Intl.DateTimeFormat('en-CA', { timeZone:deadlineTimeZone }).format(); } catch { throw new CloudError('config', 'Часовой пояс сроков не подтвержден.'); }
  const statusReadValues = value.statusReadValues || Object.fromEntries(Object.entries(statusValues).map(([local,remote])=>[remote,local]));
  const priorityReadValues = value.priorityReadValues || Object.fromEntries(Object.entries(priorityValues).map(([local,remote])=>[remote,local]));
  if (Object.entries(statusReadValues).some(([key,local])=>!/^[a-z_]{2,30}$/.test(key) || !['active','done'].includes(local)) || Object.entries(priorityReadValues).some(([key,local])=>!/^[a-z_]{2,30}$/.test(key) || !['normal','medium','high'].includes(local))) throw new CloudError('config','Сопоставление полей базы не подтверждено.');
  return { url:url.origin, publishableKey:key, statusValues, priorityValues, statusReadValues, priorityReadValues, deadlineTimeZone, schemaVerified:value.schemaVerified === true };
}

export function taskFromRow(row, config, userId) {
  if (!row || !UUID.test(row.id) || row.user_id !== userId) throw new CloudError('permission', 'Ответ базы не соответствует аккаунту. Синхронизация остановлена.');
  if (typeof row.archived !== 'boolean' || !Number.isFinite(Date.parse(row.updated_at)) || !Number.isFinite(Date.parse(row.created_at))) throw new CloudError('schema', 'Структура таблицы задач отличается от ожидаемой. Локальные записи сохранены.');
  const monthDay = typeof row.task_month === 'string' ? row.task_month.slice(0,10) : '';
  const priority = config.priorityReadValues[row.priority];
  const status = config.statusReadValues[row.status];
  let deadline = null;
  if (row.deadline !== null && row.deadline !== undefined) {
    if (!Number.isFinite(Date.parse(row.deadline))) throw new CloudError('schema', 'База вернула некорректный срок задачи.');
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone:config.deadlineTimeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(row.deadline));
    const part = type => parts.find(item => item.type === type)?.value;
    deadline = `${part('year')}-${part('month')}-${part('day')}`;
  }
  if (!validDay(monthDay) || !priority || !status || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 2000 || typeof (row.description ?? '') !== 'string' || (row.description?.length || 0) > 100000 || (status === 'done' && !Number.isFinite(Date.parse(row.completed_at)))) throw new CloudError('schema', 'Поля существующей таблицы задач требуют проверки. Локальные записи сохранены.');
  const [year, month] = monthDay.split('-').map(Number);
  const task = { id:row.id, title:row.title.trim(), description:row.description ?? '', year, month, deadline, priority, status, createdAt:row.created_at, completedAt:status === 'done' ? row.completed_at : null };
  const parsed = parseState({ schemaVersion:SCHEMA_VERSION, tasks:[task], notes:[], settings:{} });
  if (!parsed.ok || parsed.repaired || parsed.state.tasks.length !== 1) throw new CloudError('schema', 'Некорректная запись из базы не заменит локальный план.');
  return task;
}

export function taskToRow(task, remoteId, userId, config, baseRow = null) {
  if (!UUID.test(remoteId) || !UUID.test(userId)) throw new CloudError('schema', 'Неверный идентификатор задачи или аккаунта.');
  const baseTask = baseRow ? taskFromRow(baseRow, config, userId) : null;
  const sameDeadline = baseTask?.deadline === task.deadline;
  return { id:remoteId, user_id:userId, title:task.title, description:task.description, task_month:`${String(task.year).padStart(4,'0')}-${String(task.month).padStart(2,'0')}-01`, deadline:task.deadline ? sameDeadline ? baseRow.deadline : `${task.deadline}T12:00:00.000Z` : null, priority:baseTask?.priority === task.priority ? baseRow.priority : config.priorityValues[task.priority], status:baseTask?.status === task.status ? baseRow.status : config.statusValues[task.status], archived:false, completed_at:task.status === 'done' ? task.completedAt : null, created_at:task.createdAt };
}

export class SupabaseAPI {
  constructor({ config, storage, fetcher = fetch, now = () => Date.now(), withLock = (_name, fn) => fn() }) {
    this.config = validateCloudConfig(config); this.storage = storage; this.fetcher = fetcher; this.now = now; this.withLock = withLock;
    this.sessionKey = `poryadok.auth.v1:${new URL(this.config.url).hostname}`;
  }
  session() {
    try {
      const data = JSON.parse(this.storage.getItem(this.sessionKey));
      if (!data || !UUID.test(data.user?.id) || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !data.access_token || !data.refresh_token || !Number.isFinite(data.expires_at)) return null;
      return data;
    } catch { return null; }
  }
  saveSession(data, previous = null) {
    const user = data.user || previous?.user;
    if (!UUID.test(user?.id) || !data.access_token || !data.refresh_token || (previous && previous.user.id !== user.id)) throw new CloudError('auth', 'Не удалось подтвердить аккаунт. Войди еще раз.');
    const session = { access_token:data.access_token, refresh_token:data.refresh_token, expires_at:data.expires_at || Math.floor(this.now()/1000) + Number(data.expires_in || 3600), user:{ id:user.id, email:typeof user.email === 'string' ? user.email : '' } };
    const raw = JSON.stringify(session);
    try { this.storage.setItem(this.sessionKey, raw); if (this.storage.getItem(this.sessionKey) !== raw) throw new Error(); }
    catch { throw new CloudError('storage', 'Браузер не сохранил вход. Локальные задачи остаются доступны.'); }
    return session;
  }
  async transport(path, options = {}) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await this.fetcher(`${this.config.url}${path}`, { ...options, signal:controller.signal, cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer', headers:{ apikey:this.config.publishableKey, 'Content-Type':'application/json', ...options.headers } });
      let data = null;
      const raw = await response.text();
      if (raw) { try { data = JSON.parse(raw); } catch { throw new CloudError('schema', 'База вернула ответ в неизвестном формате.'); } }
      if (!response.ok) {
        const status = response.status;
        const code = String(data?.code || data?.error_code || '');
        if (status === 409 || code === '23505') throw new CloudError('conflict', 'Запись уже появилась в базе. Будет повторная сверка.', status);
        if (status === 401) throw new CloudError('auth', 'Сессия закончилась. Войди еще раз для синхронизации.', status);
        if (status === 403 || code === '42501') throw new CloudError('permission', 'Нет доступа к собственным задачам. Нужна проверка политик существующей базы.', status);
        if (status === 429 || status >= 500) throw new CloudError('network', 'Сервис временно недоступен. Изменения остаются на устройстве.', status);
        if (path.startsWith('/auth/')) throw new CloudError('auth', 'Вход не выполнен. Проверь почту и пароль существующего аккаунта.', status);
        throw new CloudError('schema', 'Запись не принята существующей базой. Локальные изменения сохранены.', status);
      }
      return { data, headers:response.headers };
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError('network', 'Нет связи с базой. Изменения сохранены на устройстве.');
    } finally { clearTimeout(timeout); }
  }
  async signIn(email, password) {
    return this.withLock(`${this.sessionKey}:refresh`, async () => {
      const { data } = await this.transport('/auth/v1/token?grant_type=password', { method:'POST', body:JSON.stringify({ email, password }) });
      return this.saveSession(data);
    });
  }
  async token(force = false) {
    return this.withLock(`${this.sessionKey}:refresh`, async () => {
      const previous = this.session();
      if (!previous) throw new CloudError('auth', 'Войди в аккаунт для синхронизации.');
      if (!force && previous.expires_at > this.now()/1000 + 60) return previous.access_token;
      try {
        const { data } = await this.transport('/auth/v1/token?grant_type=refresh_token', { method:'POST', body:JSON.stringify({ refresh_token:previous.refresh_token }) });
        return this.saveSession(data, previous).access_token;
      } catch (error) {
        if (error.kind === 'auth') { try { this.storage.removeItem(this.sessionKey); } catch { /* Keep local tasks regardless of session storage. */ } }
        throw error;
      }
    });
  }
  async signOut() {
    return this.withLock(`${this.sessionKey}:refresh`, async () => {
      const previous = this.session();
      try { this.storage.removeItem(this.sessionKey); if (this.storage.getItem(this.sessionKey)) throw new Error(); }
      catch { throw new CloudError('storage', 'Браузер не завершил выход. Попробуй еще раз.'); }
      if (previous) { try { await this.transport('/auth/v1/logout?scope=local', { method:'POST', headers:{ Authorization:`Bearer ${previous.access_token}` } }); } catch { /* Local sign-out also works offline. */ } }
    });
  }
  async request(path, options = {}) {
    const session = this.session();
    if (!session) throw new CloudError('auth', 'Войди в аккаунт для синхронизации.');
    const accessToken = await this.token();
    if (this.session()?.user.id !== session.user.id) throw new CloudError('auth', 'Аккаунт изменился. Синхронизация остановлена.');
    try { return await this.transport(path, { ...options, headers:{ ...options.headers, Authorization:`Bearer ${accessToken}` } }); }
    catch (error) {
      if (error.status !== 401) throw error;
      const renewed = await this.token(true);
      if (this.session()?.user.id !== session.user.id) throw new CloudError('auth', 'Аккаунт изменился. Синхронизация остановлена.');
      return this.transport(path, { ...options, headers:{ ...options.headers, Authorization:`Bearer ${renewed}` } });
    }
  }
  async listTasks(userId) {
    if (this.session()?.user.id !== userId) throw new CloudError('auth', 'Аккаунт изменился.');
    const rows = []; let total = Infinity; let offset = 0;
    for (let page = 0; page < 1000 && offset < total; page++) {
      const query = new URLSearchParams({ user_id:`eq.${userId}`, select:'id,user_id,title,description,task_month,deadline,priority,status,archived,completed_at,created_at,updated_at', order:'id.asc', limit:'500', offset:String(offset) });
      const result = await this.request(`/rest/v1/tasks?${query}`, { headers:{ Prefer:'count=exact' } });
      if (!Array.isArray(result.data)) throw new CloudError('schema', 'Не удалось прочитать список задач.');
      const count = result.headers.get('content-range')?.split('/')[1];
      if (!count || !/^\d+$/.test(count)) throw new CloudError('schema', 'База не подтвердила полноту списка. Локальные данные сохранены.');
      total = Number(count);
      for (const row of result.data) taskFromRow(row, this.config, userId);
      if (!result.data.length && offset < total) throw new CloudError('schema', 'Список задач загружен не полностью.');
      rows.push(...result.data); offset += result.data.length;
    }
    if (offset < total || new Set(rows.map(row => row.id)).size !== rows.length) throw new CloudError('schema', 'Список задач изменился во время загрузки. Будет повторная сверка.');
    return rows;
  }
  async insertTask(task, remoteId, userId) {
    if (!this.config.schemaVerified) throw new CloudError('config', 'Запись в существующую базу ожидает проверки схемы и доступа.');
    const { data } = await this.request('/rest/v1/tasks', { method:'POST', headers:{ Prefer:'return=representation' }, body:JSON.stringify(taskToRow(task, remoteId, userId, this.config)) });
    if (!Array.isArray(data) || data.length !== 1 || data[0].id !== remoteId) throw new CloudError('permission', 'База не подтвердила запись. Изменение остается в очереди.');
    taskFromRow(data[0], this.config, userId); return data[0];
  }
  async patchTask(task, row, userId, archived = false) {
    if (!this.config.schemaVerified) throw new CloudError('config', 'Запись в существующую базу ожидает проверки схемы и доступа.');
    const body = archived ? { archived:true } : taskToRow(task, row.id, userId, this.config, row);
    if (!archived) { delete body.id; delete body.user_id; delete body.created_at; }
    const query = new URLSearchParams({ id:`eq.${row.id}`, user_id:`eq.${userId}`, updated_at:`eq.${row.updated_at}` });
    const { data } = await this.request(`/rest/v1/tasks?${query}`, { method:'PATCH', headers:{ Prefer:'return=representation' }, body:JSON.stringify(body) });
    if (!Array.isArray(data) || data.length > 1) throw new CloudError('permission', 'База вернула некорректное подтверждение записи.');
    if (!data.length) throw new CloudError('conflict', 'Задача изменилась на другом устройстве. Будет повторная сверка.');
    if (data[0].id !== row.id) throw new CloudError('permission', 'База подтвердила другую задачу. Синхронизация остановлена.');
    taskFromRow(data[0], this.config, userId); return data[0];
  }
}
