export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'poryadok.planner.v1';
export const BACKUP_KEY = `${STORAGE_KEY}.backup`;
export const RECOVERY_KEY = `${STORAGE_KEY}.recovery`;
export const PRIORITIES = ['normal', 'medium', 'high'];
export const FILTERS = ['all', 'active', 'done', 'high'];

export function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function localDay(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function shiftMonth(year, month, offset) {
  const index = year * 12 + month - 1 + offset;
  const next = { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 + 1 };
  return next.year >= 1 && next.year <= 9999 ? next : { year, month };
}

export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: new Date().toISOString(), tasks: [], notes: [], settings: { theme: 'system', filter: 'all' } };
}

const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function parseState(raw) {
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return { ok: false, reason: 'invalid' }; }
  if (!object(value)) return { ok: false, reason: 'invalid' };
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > SCHEMA_VERSION) return { ok: false, reason: 'future' };
  if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.tasks) || !Array.isArray(value.notes)) return { ok: false, reason: 'invalid' };
  const state = emptyState();
  state.revision = Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0;
  state.updatedAt = validTime(value.updatedAt) ? value.updatedAt : state.updatedAt;
  let repaired = 0;
  const seen = new Set();
  function idFor(id) {
    if (typeof id === 'string' && id.trim() && id.length < 160 && !seen.has(id)) { seen.add(id); return id; }
    let newId;
    do { newId = makeId(); } while (seen.has(newId));
    seen.add(newId);
    repaired++;
    return newId;
  }
  for (const task of value.tasks) {
    if (!object(task) || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 2000 || !Number.isInteger(task.month) || task.month < 1 || task.month > 12 || !Number.isInteger(task.year) || task.year < 1 || task.year > 9999) { repaired++; continue; }
    const createdAt = validTime(task.createdAt) ? task.createdAt : state.updatedAt;
    const status = task.status === 'done' ? 'done' : 'active';
    const priority = PRIORITIES.includes(task.priority) ? task.priority : 'normal';
    const deadline = validDay(task.deadline) ? task.deadline : null;
    const description = typeof task.description === 'string' && task.description.length <= 100000 ? task.description : '';
    const completedAt = status === 'done' ? (validTime(task.completedAt) ? task.completedAt : createdAt) : null;
    if (task.status !== status || task.priority !== priority || (task.deadline ?? null) !== deadline || task.description !== description || task.createdAt !== createdAt || (task.completedAt ?? null) !== completedAt || task.title !== task.title.trim()) repaired++;
    state.tasks.push({ id: idFor(task.id), title: task.title.trim(), description, year: task.year, month: task.month, priority, status, createdAt, completedAt });
    state.tasks[state.tasks.length - 1].deadline = deadline;
  }
  for (const note of value.notes) {
    if (!object(note) || typeof note.text !== 'string' || !note.text.trim() || note.text.length > 100000) { repaired++; continue; }
    const createdAt = validTime(note.createdAt) ? note.createdAt : state.updatedAt;
    const updatedAt = validTime(note.updatedAt) ? note.updatedAt : createdAt;
    if (createdAt !== note.createdAt || updatedAt !== note.updatedAt || note.text !== note.text.trim()) repaired++;
    state.notes.push({ id: idFor(note.id), text: note.text.trim(), createdAt, updatedAt });
  }
  state.settings.theme = ['system', 'light', 'dark'].includes(value.settings?.theme) ? value.settings.theme : 'system';
  state.settings.filter = FILTERS.includes(value.settings?.filter) ? value.settings.filter : 'all';
  return { ok: true, state, repaired };
}

export class PlannerStorage {
  constructor(storage) { this.storage = storage; this.state = emptyState(); this.notice = ''; this.locked = false; this.recoveryRaw = null; }

  load() {
    this.notice = '';
    this.locked = false;
    let raw;
    try { raw = this.storage.getItem(STORAGE_KEY); }
    catch {
      this.notice = 'Браузер запретил доступ к хранилищу. Разреши сохранение данных для этого сайта; введенный текст останется в форме.';
      this.locked = true;
      return this.state;
    }
    if (!this.recoveryRaw) {
      try { this.recoveryRaw = this.storage.getItem(RECOVERY_KEY); } catch { this.recoveryRaw = null; }
    }
    if (raw === null) {
      let backup;
      try { backup = this.storage.getItem(BACKUP_KEY); } catch { backup = null; }
      const parsed = backup ? parseState(backup) : null;
      this.state = parsed?.ok ? parsed.state : emptyState();
      if (parsed?.reason === 'future') {
        this.recoveryRaw = backup;
        this.locked = true;
        this.notice = 'Резервная копия создана более новой версией приложения. Скачай исходные данные и обнови приложение.';
      } else if (backup) {
        try {
          if (!parsed.ok || parsed.repaired) { this.storage.setItem(RECOVERY_KEY, backup); this.recoveryRaw = backup; }
          this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
          this.notice = parsed.ok ? 'Основное сохранение отсутствует. Загружена резервная копия.' : 'Резервная копия повреждена. Исходный файл сохранен; открыт чистый план.';
        } catch {
          this.locked = true;
          this.notice = 'Резервную копию не удалось восстановить в хранилище. Скачай исходные данные и освободи место.';
          this.recoveryRaw = backup;
        }
      }
      return this.state;
    }
    const parsed = parseState(raw);
    if (parsed.ok && !parsed.repaired) { this.state = parsed.state; return this.state; }
    this.recoveryRaw = raw;
    if (parsed.reason === 'future') {
      this.locked = true;
      this.notice = 'Данные созданы более новой версией приложения. Они сохранены без изменений. Обнови страницу или скачай исходный файл.';
      return this.state;
    }
    try { this.storage.setItem(RECOVERY_KEY, raw); }
    catch {
      this.locked = true;
      this.notice = 'Сохранение повреждено, а места для его резервной копии нет. Скачай исходные данные перед восстановлением.';
      return this.state;
    }
    if (parsed.ok) {
      this.state = parsed.state;
      this.notice = 'Обнаружены некорректные записи. Доступные данные восстановлены; исходное сохранение можно скачать.';
      try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
      catch { this.locked = true; this.notice = 'Доступные записи восстановлены, но сохранить исправленные данные не удалось. Скачай исходный файл и освободи место.'; }
      return this.state;
    }
    let backup;
    try { backup = parseState(this.storage.getItem(BACKUP_KEY)); } catch { backup = { ok: false }; }
    if (backup.reason === 'future') {
      this.locked = true;
      this.notice = 'Основной файл поврежден, а резервная копия создана новой версией приложения. Обнови приложение; перезапись данных заблокирована.';
      try { this.recoveryRaw = this.storage.getItem(BACKUP_KEY); } catch { this.recoveryRaw = raw; }
      return this.state;
    }
    this.state = backup.ok ? backup.state : emptyState();
    this.notice = backup.ok ? 'Сохранение повреждено. Загружена последняя резервная копия; исходные данные доступны для скачивания.' : 'Сохранение повреждено. Открыт чистый план; исходные данные сохранены и доступны для скачивания.';
    return this.state;
  }

  commit(mutator) {
    const latest = this.load();
    if (this.locked) return { ok: false, message: this.notice };
    const next = structuredClone(latest);
    if (mutator(next) === false) return { ok: false, message: 'Запись уже изменена в другой вкладке. Обновленный список загружен.' };
    next.schemaVersion = SCHEMA_VERSION;
    next.revision = latest.revision + 1;
    next.updatedAt = new Date().toISOString();
    const previous = JSON.stringify(latest);
    const serialized = JSON.stringify(next);
    try {
      this.storage.setItem(STORAGE_KEY, serialized);
      if (this.storage.getItem(STORAGE_KEY) !== serialized) throw new Error('Write verification failed');
    } catch {
      return { ok: false, message: 'Не удалось сохранить изменения. Возможно, хранилище заполнено или запрещено. Освободи место либо скачай резервную копию; текст оставлен в форме.' };
    }
    this.state = next;
    let backupSaved = true;
    try { this.storage.setItem(BACKUP_KEY, previous); } catch { backupSaved = false; }
    this.notice = backupSaved ? '' : 'Изменения сохранены, но резервная копия не обновилась: в хранилище недостаточно места. Скачай копию в настройках.';
    return { ok: true, state: next, message: this.notice };
  }

  replace(state) {
    let original;
    const serialized = JSON.stringify(state);
    try {
      original = this.storage.getItem(STORAGE_KEY);
      if (original) this.storage.setItem(RECOVERY_KEY, original);
      this.storage.setItem(STORAGE_KEY, serialized);
      if (this.storage.getItem(STORAGE_KEY) !== serialized) throw new Error('Write verification failed');
    } catch { return { ok: false, message: 'Не удалось завершить импорт. Проверь доступ к хранилищу и сохрани доступную резервную копию.' }; }
    this.notice = '';
    if (original && parseState(original).ok) {
      try { this.storage.setItem(BACKUP_KEY, original); } catch { this.notice = 'План импортирован. Скачай резервную копию: в браузере мало свободного места.'; }
    }
    this.locked = false;
    this.state = state;
    this.recoveryRaw = original;
    return { ok: true, state };
  }
}

export function isOverdue(task, today = localDay()) { return task.status !== 'done' && Boolean(task.deadline) && task.deadline < today; }

export function sortTasks(tasks, today = localDay()) {
  const bucket = task => task.status === 'done' ? 5 : isOverdue(task, today) ? 0 : task.priority === 'high' ? 1 : task.deadline ? 2 : task.priority === 'medium' ? 3 : 4;
  return [...tasks].sort((a, b) => bucket(a) - bucket(b) || (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function monthStats(tasks) {
  const total = tasks.length;
  const done = tasks.filter(task => task.status === 'done').length;
  return { total, done, active: total - done, percent: total ? Math.round(done / total * 100) : 0 };
}

export function quoteIndex(date, count) {
  const day = new Date(0);
  day.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  day.setUTCHours(0, 0, 0, 0);
  return ((Math.floor(day.getTime() / 86400000) % count) + count) % count;
}
