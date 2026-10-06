import test from 'node:test';
import assert from 'node:assert/strict';
import { PlannerStorage, STORAGE_KEY, BACKUP_KEY, RECOVERY_KEY, emptyState, parseState, validDay, localDay, shiftMonth, makeId, quoteIndex, sortTasks, monthStats, isOverdue } from '../core.js';
import { QUOTES } from '../quotes.js';

class MemoryStorage {
  data = new Map();
  failRead = false;
  failWrite = false;
  failBackup = false;
  getItem(key) { if (this.failRead) throw new Error('Denied'); return this.data.get(key) ?? null; }
  setItem(key, value) { if (this.failWrite || (key === BACKUP_KEY && this.failBackup)) throw new Error('QuotaExceeded'); this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

function task(id = 'task-1', details = {}) {
  return { id, title: 'Проверить план', description: '', month: 10, year: 2026, priority: 'normal', status: 'active', createdAt: '2026-10-06T10:00:00.000Z', deadline: null, completedAt: null, ...details };
}
function saved(tasks = [], notes = []) { return { ...emptyState(), tasks, notes }; }
function storageWith(state) { const memory = new MemoryStorage(); memory.setItem(STORAGE_KEY, JSON.stringify(state)); return memory; }

test('календарные переходы декабрь - январь и январь - декабрь', () => {
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2027, 1, -1), { year: 2026, month: 12 });
  assert.deepEqual(shiftMonth(2034, 6, 1), { year: 2034, month: 7 });
});
test('границы календаря не создают нулевой или пятизначный год', () => {
  assert.deepEqual(shiftMonth(1, 1, -1), { year: 1, month: 1 });
  assert.deepEqual(shiftMonth(9999, 12, 1), { year: 9999, month: 12 });
});
test('даты проверяются с учетом високосных столетий', () => {
  for (const day of ['2024-02-29', '2000-02-29', '2026-10-06', '0001-01-01', '9999-12-31']) assert.equal(validDay(day), true);
  for (const day of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-05', '0000-01-01', '2026-1-01', '', null, '2026-02-00']) assert.equal(validDay(day), false);
});
test('локальная дата не зависит от UTC-преобразования', () => {
  const date = new Date(2026, 9, 6, 0, 5);
  assert.equal(localDay(date), '2026-10-06');
});
test('пустое хранилище дает валидную новую структуру', () => {
  const storage = new PlannerStorage(new MemoryStorage());
  assert.equal(parseState(storage.load()).ok, true);
  assert.equal(storage.locked, false);
  assert.equal(storage.state.tasks.length, 0);
});
test('создание и перезагрузка сохраняют все поля задач и мысли', () => {
  const memory = new MemoryStorage();
  const storage = new PlannerStorage(memory);
  storage.load();
  const note = { id: 'note-1', text: 'Рабочая мысль\nВторая строка', createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:01:00.000Z' };
  const expected = task('task-1', { description: 'Описание\nСсылка', priority: 'high', deadline: '2026-10-07' });
  assert.equal(storage.commit(next => { next.tasks.push(expected); next.notes.push(note); }).ok, true);
  const reloaded = new PlannerStorage(memory).load();
  assert.deepEqual(reloaded.tasks[0], expected);
  assert.deepEqual(reloaded.notes[0], note);
});
test('выполнение и восстановление сохраняют completion date корректно', () => {
  const memory = storageWith(saved([task()]));
  const storage = new PlannerStorage(memory);
  storage.load();
  assert.equal(storage.commit(next => { next.tasks[0].status = 'done'; next.tasks[0].completedAt = '2026-10-06T12:00:00.000Z'; }).ok, true);
  assert.equal(new PlannerStorage(memory).load().tasks[0].completedAt, '2026-10-06T12:00:00.000Z');
  storage.commit(next => { next.tasks[0].status = 'active'; next.tasks[0].completedAt = null; });
  assert.equal(new PlannerStorage(memory).load().tasks[0].completedAt, null);
});
test('редактирование, перенос и удаление не повреждают соседние записи', () => {
  const memory = storageWith(saved([task('one'), task('two')]));
  const storage = new PlannerStorage(memory);
  storage.load();
  storage.commit(next => { Object.assign(next.tasks[0], { title: 'Новое название', description: 'Новые детали', priority: 'medium', deadline: '2027-01-15', month: 1, year: 2027 }); });
  const copy = new PlannerStorage(memory).load();
  assert.equal(copy.tasks[0].year, 2027);
  assert.equal(copy.tasks[0].month, 1);
  assert.equal(copy.tasks[0].title, 'Новое название');
  storage.commit(next => { next.tasks.splice(0, 1); });
  assert.deepEqual(storage.state.tasks.map(item => item.id), ['two']);
});
test('настройки темы и фильтра переживают перезагрузку', () => {
  const memory = new MemoryStorage();
  const storage = new PlannerStorage(memory);
  storage.load();
  storage.commit(next => { next.settings = { theme: 'dark', filter: 'high' }; });
  assert.deepEqual(new PlannerStorage(memory).load().settings, { theme: 'dark', filter: 'high' });
});
test('операция перечитывает актуальное состояние соседней вкладки', () => {
  const memory = new MemoryStorage();
  const first = new PlannerStorage(memory);
  const second = new PlannerStorage(memory);
  first.load(); second.load();
  first.commit(next => next.tasks.push(task('one')));
  second.commit(next => next.tasks.push(task('two')));
  assert.deepEqual(new PlannerStorage(memory).load().tasks.map(item => item.id), ['one', 'two']);
  assert.equal(second.state.revision, 2);
});
test('отклоненная конфликтующая операция не перезаписывает актуальные данные', () => {
  const memory = storageWith(saved([task()]));
  const storage = new PlannerStorage(memory);
  storage.load();
  const original = memory.getItem(STORAGE_KEY);
  assert.equal(storage.commit(() => false).ok, false);
  assert.equal(memory.getItem(STORAGE_KEY), original);
});
test('предыдущая валидная версия сохраняется как backup', () => {
  const memory = storageWith(saved([task('one')]));
  const storage = new PlannerStorage(memory);
  storage.load();
  storage.commit(next => next.tasks.push(task('two')));
  assert.deepEqual(parseState(memory.getItem(BACKUP_KEY)).state.tasks.map(item => item.id), ['one']);
});
test('ошибка записи не выдает ложный успех и сохраняет прошлую версию', () => {
  const memory = storageWith(saved([task()]));
  const storage = new PlannerStorage(memory);
  storage.load();
  const original = memory.getItem(STORAGE_KEY);
  memory.failWrite = true;
  assert.equal(storage.commit(next => next.tasks.push(task('new'))).ok, false);
  assert.equal(memory.getItem(STORAGE_KEY), original);
  assert.equal(storage.state.tasks.length, 1);
});
test('отказ резервной записи не отменяет успешное основное сохранение', () => {
  const memory = storageWith(saved());
  const storage = new PlannerStorage(memory);
  storage.load();
  memory.failBackup = true;
  assert.equal(storage.commit(next => next.tasks.push(task())).ok, true);
  assert.equal(new PlannerStorage(memory).load().tasks.length, 1);
  assert.ok(storage.notice);
});
test('запрет чтения блокирует изменение данных', () => {
  const memory = storageWith(saved([task()]));
  const original = memory.getItem(STORAGE_KEY);
  memory.failRead = true;
  const storage = new PlannerStorage(memory);
  storage.load();
  assert.equal(storage.locked, true);
  assert.equal(storage.commit(next => next.tasks.push(task('new'))).ok, false);
  memory.failRead = false;
  assert.equal(memory.getItem(STORAGE_KEY), original);
});
test('поврежденный JSON восстанавливается из backup и архивируется', () => {
  const memory = new MemoryStorage();
  memory.setItem(STORAGE_KEY, '{broken');
  memory.setItem(BACKUP_KEY, JSON.stringify(saved([task('backup')])));
  const storage = new PlannerStorage(memory);
  assert.equal(storage.load().tasks[0].id, 'backup');
  assert.equal(memory.getItem(RECOVERY_KEY), '{broken');
  assert.equal(storage.locked, false);
  assert.equal(storage.commit(next => next.tasks.push(task('new'))).ok, true);
  assert.equal(new PlannerStorage(memory).load().tasks.length, 2);
});
test('без backup поврежденный исходник сохраняется перед новым планом', () => {
  const memory = new MemoryStorage();
  memory.setItem(STORAGE_KEY, 'not-json');
  const storage = new PlannerStorage(memory);
  assert.equal(storage.load().tasks.length, 0);
  assert.equal(memory.getItem(RECOVERY_KEY), 'not-json');
  assert.equal(storage.commit(next => next.tasks.push(task())).ok, true);
});
test('если архивирование поврежденного файла невозможно, оригинал не перезаписывается', () => {
  const memory = new MemoryStorage();
  memory.setItem(STORAGE_KEY, 'broken');
  memory.failWrite = true;
  const storage = new PlannerStorage(memory);
  storage.load();
  assert.equal(storage.locked, true);
  assert.equal(storage.commit(next => next.tasks.push(task())).ok, false);
  assert.equal(memory.getItem(STORAGE_KEY), 'broken');
});
test('дубликаты ID исправляются один раз и остаются стабильными', () => {
  const memory = storageWith(saved([task('same'), task('same')]));
  const storage = new PlannerStorage(memory);
  const data = storage.load();
  assert.equal(new Set(data.tasks.map(item => item.id)).size, 2);
  const id = data.tasks[1].id;
  assert.equal(new PlannerStorage(memory).load().tasks[1].id, id);
  assert.equal(storage.commit(next => { next.tasks.find(item => item.id === id).title = 'Исправлена'; }).ok, true);
  assert.equal(new PlannerStorage(memory).load().tasks[1].title, 'Исправлена');
});
test('ошибочные записи отделяются от доступных без потери исходного файла', () => {
  const data = saved([task('valid'), task('spaces', { title: '   ' }), task('bad-month', { month: 13 }), task('bad-year', { year: 0 })]);
  const memory = storageWith(data);
  const storage = new PlannerStorage(memory);
  assert.deepEqual(storage.load().tasks.map(item => item.id), ['valid']);
  assert.deepEqual(JSON.parse(memory.getItem(RECOVERY_KEY)), data);
});
test('некорректный дедлайн не превращается в несуществующую дату', () => {
  const result = parseState(saved([task('one', { deadline: '2026-02-30' })]));
  assert.equal(result.ok, true);
  assert.equal(result.state.tasks[0].deadline, null);
  assert.ok(result.repaired);
});
test('неизвестная будущая версия защищена от перезаписи', () => {
  const data = { ...saved([task()]), schemaVersion: 2 };
  const memory = storageWith(data);
  const storage = new PlannerStorage(memory);
  storage.load();
  assert.equal(storage.locked, true);
  assert.equal(storage.commit(next => next.tasks.push(task('new'))).ok, false);
  assert.deepEqual(JSON.parse(memory.getItem(STORAGE_KEY)), data);
});
test('backup будущей версии защищен при отсутствии основного файла', () => {
  const memory = new MemoryStorage();
  memory.setItem(BACKUP_KEY, JSON.stringify({ ...saved(), schemaVersion: 2 }));
  const storage = new PlannerStorage(memory);
  storage.load();
  assert.equal(storage.locked, true);
  assert.equal(memory.getItem(STORAGE_KEY), null);
});
test('backup будущей версии защищен при поврежденном основном файле', () => {
  const memory = new MemoryStorage();
  memory.setItem(STORAGE_KEY, '{broken');
  const backup = JSON.stringify({ ...saved(), schemaVersion: 2 });
  memory.setItem(BACKUP_KEY, backup);
  const storage = new PlannerStorage(memory);
  storage.load();
  assert.equal(storage.locked, true);
  assert.equal(storage.commit(next => next.tasks.push(task())).ok, false);
  assert.equal(memory.getItem(BACKUP_KEY), backup);
});
test('восстановление при исчезновении основной записи', () => {
  const memory = new MemoryStorage();
  memory.setItem(BACKUP_KEY, JSON.stringify(saved([task('restored')])));
  assert.equal(new PlannerStorage(memory).load().tasks[0].id, 'restored');
  assert.equal(parseState(memory.getItem(STORAGE_KEY)).state.tasks[0].id, 'restored');
});
test('пользовательский текст сохраняется как текст, включая HTML и длинные записи', () => {
  const title = '<img src=x onerror=alert(1)>';
  const text = 'Наблюдение '.repeat(8000);
  const result = parseState(saved([task('one', { title, description: text })], [{ id: 'note', text, createdAt: '2026-10-06T10:00:00Z', updatedAt: '2026-10-06T10:00:00Z' }]));
  assert.equal(result.state.tasks[0].title, title);
  assert.equal(result.state.tasks[0].description, text);
  assert.equal(result.state.notes[0].text, text.trim());
});
test('безопасный парсер отвергает неверную структуру', () => {
  for (const value of ['{', 'null', '[]', '{"schemaVersion":1}', '{"schemaVersion":1,"tasks":{},"notes":[]}']) assert.equal(parseState(value).ok, false);
});
test('просрочка определяется по календарной дате, завершенные задачи исключены', () => {
  assert.equal(isOverdue(task('a', { deadline: '2026-10-05' }), '2026-10-06'), true);
  assert.equal(isOverdue(task('b', { deadline: '2026-10-06' }), '2026-10-06'), false);
  assert.equal(isOverdue(task('c', { deadline: '2026-10-05', status: 'done' }), '2026-10-06'), false);
});
test('сортировка: просрочка, высокий, срок, средний, обычный, выполненный', () => {
  const input = [task('done', { status: 'done' }), task('normal'), task('medium', { priority: 'medium' }), task('deadline', { deadline: '2026-10-07' }), task('high', { priority: 'high' }), task('overdue', { deadline: '2026-10-05' })];
  assert.deepEqual(sortTasks(input, '2026-10-06').map(item => item.id), ['overdue', 'high', 'deadline', 'medium', 'normal', 'done']);
  assert.equal(input[0].id, 'done');
});
test('равные приоритеты сохраняют порядок по времени создания и ID', () => {
  const tasks = [task('b'), task('a'), task('old', { createdAt: '2026-10-05T10:00:00Z' })];
  assert.deepEqual(sortTasks(tasks).map(item => item.id), ['old', 'a', 'b']);
});
test('статистика корректна для пустого и полностью выполненного месяца', () => {
  assert.deepEqual(monthStats([]), { total: 0, done: 0, active: 0, percent: 0 });
  assert.deepEqual(monthStats([task('a', { status: 'done' }), task('b', { status: 'done' })]), { total: 2, done: 2, active: 0, percent: 100 });
  assert.deepEqual(monthStats([task('a', { status: 'done' }), task('b'), task('c')]), { total: 3, done: 1, active: 2, percent: 33 });
});
test('цитата детерминирована в пределах дня и меняется в следующий день', () => {
  const morning = new Date(2026, 9, 6, 0, 1);
  const evening = new Date(2026, 9, 6, 23, 59);
  assert.equal(quoteIndex(morning, QUOTES.length), quoteIndex(evening, QUOTES.length));
  assert.notEqual(quoteIndex(morning, QUOTES.length), quoteIndex(new Date(2026, 9, 7), QUOTES.length));
  assert.equal(new Set(QUOTES.map(quote => quote.text)).size, QUOTES.length);
  QUOTES.forEach(quote => { assert.ok(quote.author); assert.ok(quote.work); assert.ok(quote.url.startsWith('https://')); });
});
test('ID остаются уникальными при массовом создании', () => {
  assert.equal(new Set(Array.from({ length: 2000 }, makeId)).size, 2000);
});
test('большой реестр сохраняется, сортируется и не меняет исходный массив', () => {
  const tasks = Array.from({ length: 600 }, (_, index) => task(`task-${index}`, { priority: index % 3 === 0 ? 'high' : 'normal' }));
  const memory = storageWith(saved(tasks));
  const loaded = new PlannerStorage(memory).load();
  assert.equal(loaded.tasks.length, 600);
  assert.equal(sortTasks(loaded.tasks).length, 600);
  assert.equal(loaded.tasks[0].id, 'task-0');
});
test('импорт сохраняет исходный план и архив доступен после перезагрузки', () => {
  const memory = storageWith(saved([task('original')]));
  const storage = new PlannerStorage(memory);
  storage.load();
  assert.equal(storage.replace(saved([task('imported')])).ok, true);
  assert.equal(new PlannerStorage(memory).load().tasks[0].id, 'imported');
  const reloaded = new PlannerStorage(memory);
  reloaded.load();
  assert.equal(JSON.parse(reloaded.recoveryRaw).tasks[0].id, 'original');
});
test('импорт при отказе архивирования оставляет оригинальное сохранение', () => {
  const memory = storageWith(saved([task('original')]));
  const storage = new PlannerStorage(memory);
  storage.load();
  const original = memory.getItem(STORAGE_KEY);
  memory.failWrite = true;
  assert.equal(storage.replace(saved([task('imported')])).ok, false);
  assert.equal(memory.getItem(STORAGE_KEY), original);
});
