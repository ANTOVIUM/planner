import { PlannerStorage, STORAGE_KEY, BACKUP_KEY, SCHEMA_VERSION, makeId, localDay, validDay, shiftMonth, parseState, sortTasks, isOverdue, monthStats, quoteIndex } from './core.js';
import { QUOTES } from './quotes.js';
import { initializeOffline } from './offline.js';
import { initializeCloud } from './cloud.js';

const $ = id => document.getElementById(id);
const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const priorityNames = { normal: 'Обычный', medium: 'Средний', high: 'Высокий' };
let browserStorage;
try { browserStorage = window.localStorage; }
catch { browserStorage = { getItem() { throw new Error('Storage unavailable'); }, setItem() { throw new Error('Storage unavailable'); } }; }
const storage = new PlannerStorage(browserStorage);
let state = storage.load();
let now = new Date();
let selected = { month: now.getMonth() + 1, year: now.getFullYear() };
let currentView = 'plan';
let filter = state.settings.filter;
let taskQuery = '';
let noteQuery = '';
let toastTimer;
let dayTimer;
let confirmCallback;
let lastSaveError = '';
let taskSnapshot;
let noteSnapshot;
let conversionNoteId;
let cloud = { schedule() {} };
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const openers = new WeakMap();
const snapshot = item => JSON.stringify(item, Object.keys(item).sort());

function element(tag, className = '', text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function iconButton(name, label, handler, className = '') {
  const button = element('button', `icon-button ${className}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  button.addEventListener('click', handler);
  return button;
}

function plural(count, one = 'задача', few = 'задачи', many = 'задач') {
  return `${count} ${count % 100 >= 11 && count % 100 <= 14 ? many : count % 10 === 1 ? one : count % 10 >= 2 && count % 10 <= 4 ? few : many}`;
}

function dayDate(day) {
  const [year, month, date] = day.split('-').map(Number);
  const result = new Date(0);
  result.setFullYear(year, month - 1, date);
  result.setHours(12, 0, 0, 0);
  return result;
}

function formatDeadline(day) {
  const date = dayDate(day);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(date).replaceAll('ё', 'е');
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)).replaceAll('ё', 'е');
}

function monthValue(month = selected) { return `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}`; }

function readMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split('-').map(Number);
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 ? { year, month } : null;
}

function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
}

function renderStorage() {
  const message = lastSaveError || storage.notice;
  $('storageMessage').textContent = message;
  $('storageBanner').hidden = !message;
  $('downloadRecovery').hidden = !storage.recoveryRaw;
  $('exportPrevious').hidden = !storage.recoveryRaw;
  $('storageLabel').textContent = storage.locked || lastSaveError ? 'Проверь сохранение' : 'Данные в этом браузере';
}

function update(mutator, successMessage) {
  const active = document.activeElement;
  const focusTask = active?.closest('[data-task-id]')?.dataset.taskId;
  const focusAction = active?.dataset.action;
  const result = storage.commit(mutator);
  state = storage.state;
  lastSaveError = result.ok ? '' : result.message;
  render();
  if (focusTask && focusAction) {
    const target = document.querySelector(`[data-task-id="${CSS.escape(focusTask)}"] [data-action="${focusAction}"]`);
    if (target) target.focus({ preventScroll: true });
    else if (!$('taskDialog').open && !$('confirmDialog').open) $('quickTaskTitle').focus({ preventScroll: true });
  }
  if (result.ok && successMessage) showToast(successMessage);
  if (!result.ok) showToast('Изменения не сохранены. Подробности - в сообщении выше.');
  if (result.ok) cloud.schedule();
  return result;
}

function applyTheme() {
  const dark = state.settings.theme === 'dark' || (state.settings.theme === 'system' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#191c1a' : '#fafaf8';
  const button = $('themeToggle');
  button.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить темную тему');
  button.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  document.querySelectorAll('input[name="theme"]').forEach(input => { input.checked = input.value === state.settings.theme; });
}

function renderDaily() {
  $('todayDate').dateTime = localDay(now);
  $('todayDate').textContent = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now).replaceAll('ё', 'е');
  $('quoteDate').textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(now);
  const quote = QUOTES[quoteIndex(now, QUOTES.length)];
  $('quoteText').textContent = `«${quote.text}»`;
  $('quoteSource').textContent = `${quote.author} · ${quote.work}`;
  $('quoteSource').href = quote.url;
  $('quoteSource').setAttribute('aria-label', `${quote.author}, ${quote.work}. Открыть источник цитаты в новой вкладке`);
}

function renderCalendar() {
  $('calendarHeading').textContent = `${months[selected.month - 1]} ${selected.year}`;
  const current = selected.year === now.getFullYear() && selected.month === now.getMonth() + 1;
  document.querySelector('.calendar-today-label').hidden = !current;
  document.querySelector('.calendar-today-label').textContent = `Сегодня ${now.getDate()}`;
  const first = dayDate(`${monthValue()}-01`);
  const blankCount = (first.getDay() + 6) % 7;
  const dueDates = new Set(state.tasks.filter(task => task.status === 'active' && task.deadline?.startsWith(monthValue())).map(task => task.deadline));
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < blankCount; i++) fragment.append(element('span'));
  for (let day = 1; day <= 31; day++) {
    const key = `${monthValue()}-${String(day).padStart(2, '0')}`;
    if (!validDay(key)) break;
    const cell = element('span', 'calendar-day', day);
    if (key === localDay(now)) cell.classList.add('is-today');
    if (dueDates.has(key)) cell.classList.add('has-due');
    cell.setAttribute('aria-label', `${day} ${months[selected.month - 1]}${key === localDay(now) ? ', сегодня' : ''}${dueDates.has(key) ? ', срок задачи' : ''}`);
    fragment.append(cell);
  }
  $('calendarDays').replaceChildren(fragment);
  renderMonthShortcuts();
}

function renderMonthShortcuts() {
  const fragment = document.createDocumentFragment();
  const shown = new Set();
  for (const offset of [-2, -1, 0, 1, 2]) {
    const month = shiftMonth(selected.year, selected.month, offset);
    const key = monthValue(month);
    if (shown.has(key)) continue;
    shown.add(key);
    const button = element('button', 'month-shortcut');
    button.type = 'button';
    button.append(element('span', '', months[month.month - 1]));
    const isCurrent = month.year === now.getFullYear() && month.month === now.getMonth() + 1;
    const count = state.tasks.filter(task => task.year === month.year && task.month === month.month).length;
    button.append(element('span', '', month.year !== now.getFullYear() ? month.year : isCurrent ? 'сейчас' : count || ''));
    button.setAttribute('aria-pressed', String(month.year === selected.year && month.month === selected.month));
    button.setAttribute('aria-label', `Перейти к плану: ${months[month.month - 1]} ${month.year}`);
    button.addEventListener('click', () => { selected = month; showView('plan'); renderTasks(); renderCalendar(); });
    fragment.append(button);
  }
  $('monthShortcuts').replaceChildren(fragment);
}

function renderTasks() {
  const monthTasks = state.tasks.filter(task => task.month === selected.month && task.year === selected.year);
  const stats = monthStats(monthTasks);
  $('monthName').textContent = months[selected.month - 1];
  $('monthYear').textContent = selected.year;
  $('chooseMonth').setAttribute('aria-label', `${months[selected.month - 1]} ${selected.year}. Выбрать месяц и год`);
  $('previousMonth').disabled = selected.year === 1 && selected.month === 1;
  $('nextMonth').disabled = selected.year === 9999 && selected.month === 12;
  $('statTotal').textContent = stats.total;
  $('statDone').textContent = stats.done;
  $('statActive').textContent = stats.active;
  $('statPercent').replaceChildren(document.createTextNode(stats.percent), element('span', '', '%'));
  $('progressCircle').style.strokeDashoffset = 125.664 * (1 - stats.percent / 100);
  $('progressAccessible').setAttribute('aria-valuenow', stats.percent);
  $('navTaskCount').textContent = stats.active;
  const overdueCount = monthTasks.filter(task => isOverdue(task, localDay(now))).length;
  $('taskSummary').textContent = stats.total === 0 ? 'Начни с одного понятного действия' : stats.active === 0 ? 'Все задачи месяца выполнены' : `${plural(stats.active)} в работе${overdueCount ? ` · ${overdueCount} со сроком в прошлом` : ''}`;
  document.querySelectorAll('[data-filter-count]').forEach(counter => { counter.textContent = counter.dataset.filterCount === 'all' ? stats.total : counter.dataset.filterCount === 'active' ? stats.active : stats.done; });
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
  const tasks = sortTasks(monthTasks.filter(task => (filter === 'all' || (filter === 'active' && task.status === 'active') || (filter === 'done' && task.status === 'done') || (filter === 'high' && task.priority === 'high')) && (!taskQuery || `${task.title}\n${task.description}`.toLocaleLowerCase('ru').includes(taskQuery))), localDay(now));
  const fragment = document.createDocumentFragment();
  const groupFor = task => task.status === 'done' ? 'done' : isOverdue(task, localDay(now)) ? 'overdue' : task.priority === 'high' ? 'high' : 'active';
  const groupNames = { overdue: 'Срок прошел', high: 'Важное', active: 'В работе', done: 'Завершено' };
  const counts = tasks.reduce((groups, task) => { const key = groupFor(task); groups[key] = (groups[key] || 0) + 1; return groups; }, {});
  let previousGroup;
  for (const task of tasks) {
    const group = groupFor(task);
    if (previousGroup !== group) {
      const heading = element('li', `task-group group-${group}`);
      heading.setAttribute('role', 'presentation');
      heading.append(element('h3', '', groupNames[group]), element('span', '', counts[group]));
      fragment.append(heading);
      previousGroup = group;
    }
    fragment.append(taskRow(task));
  }
  $('taskList').replaceChildren(fragment);
  $('visibleTaskCount').textContent = `${plural(tasks.length)}${tasks.length !== monthTasks.length ? ` из ${monthTasks.length}` : ''}`;
  $('taskEmpty').hidden = tasks.length > 0;
  $('emptyAddTask').hidden = monthTasks.length > 0;
  $('taskEmptyTitle').textContent = monthTasks.length === 0 ? 'Твой месяц начинается здесь' : taskQuery ? 'Ничего не нашлось' : filter === 'done' ? 'Выполненные задачи появятся здесь' : filter === 'active' ? 'Все задачи месяца выполнены' : 'Задач с высоким приоритетом пока нет';
  $('taskEmptyText').textContent = monthTasks.length === 0 ? 'Запиши первое дело. Большие планы складываются из простых шагов.' : taskQuery ? 'Попробуй другое слово или сбрось поиск.' : filter === 'active' ? 'Можно выдохнуть или добавить новый план.' : 'Другие задачи доступны в фильтре «Все».';
}

function taskRow(task) {
  const done = task.status === 'done';
  const overdue = isOverdue(task, localDay(now));
  const row = element('li', `task-row${done ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}`);
  row.dataset.taskId = task.id;
  const checkbox = element('button', 'task-check');
  checkbox.type = 'button';
  checkbox.dataset.action = 'toggle';
  checkbox.setAttribute('aria-pressed', String(done));
  checkbox.setAttribute('aria-label', `${done ? 'Вернуть в работу' : 'Выполнить'}: ${task.title}`);
  checkbox.title = done ? 'Вернуть в работу' : 'Выполнить';
  checkbox.append(icon('check'));
  checkbox.addEventListener('click', () => update(next => {
    const item = next.tasks.find(candidate => candidate.id === task.id);
    if (!item || item.status !== task.status) return false;
    item.status = done ? 'active' : 'done';
    item.completedAt = done ? null : new Date().toISOString();
  }, done ? 'Задача снова в работе' : 'Задача выполнена'));
  const body = element('button', 'task-content');
  body.type = 'button';
  body.dataset.action = 'edit';
  body.setAttribute('aria-label', `Редактировать задачу: ${task.title}`);
  body.append(element('span', 'task-title', task.title));
  if (task.description) body.append(element('span', 'task-description', task.description));
  const meta = element('span', 'task-meta');
  if (task.priority !== 'normal') {
    const priority = element('span', `priority-label priority-${task.priority}`);
    priority.append(icon('flag'), document.createTextNode(`${priorityNames[task.priority]} приоритет`));
    meta.append(priority);
  }
  if (task.deadline) {
    const deadline = element('span', `deadline-label${overdue ? ' deadline-overdue' : ''}`);
    deadline.append(icon('calendar'), document.createTextNode(`${overdue ? 'Просрочено · ' : ''}${task.deadline === localDay(now) && !done ? 'Сегодня' : formatDeadline(task.deadline)}`));
    meta.append(deadline);
  }
  if (done) meta.append(element('span', '', `Выполнено ${formatDeadline(localDay(new Date(task.completedAt)))}`));
  if (meta.childNodes.length) body.append(meta);
  body.addEventListener('click', () => openTask(task.id));
  const actions = element('span', 'task-actions');
  const edit = iconButton('edit', `Изменить: ${task.title}`, () => openTask(task.id));
  edit.dataset.action = 'edit-icon';
  const remove = iconButton('trash', `Удалить задачу: ${task.title}`, () => askConfirmation('Удалить задачу?', `«${task.title.slice(0, 180)}${task.title.length > 180 ? '…' : ''}» будет удалена из плана.`, 'Удалить', () => update(next => {
    const index = next.tasks.findIndex(item => item.id === task.id);
    if (index < 0) return false;
    next.tasks.splice(index, 1);
  }, 'Задача удалена').ok), 'delete-button');
  remove.dataset.action = 'delete';
  actions.append(edit, remove);
  row.append(checkbox, body, actions);
  return row;
}

function orderedNotes() { return [...state.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)); }

function renderNotes() {
  const notes = orderedNotes();
  $('navNoteCount').textContent = notes.length;
  $('previewNoteCount').textContent = notes.length;
  $('notesTotal').textContent = notes.length;
  const preview = document.createDocumentFragment();
  for (const note of notes.slice(0, 2)) {
    const card = element('article', 'preview-note');
    const time = element('time', '', formatTimestamp(note.createdAt));
    time.dateTime = note.createdAt;
    const button = element('button', '', `${note.text.slice(0, 180)}${note.text.length > 180 ? '…' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-label', `Открыть мысль: ${note.text.slice(0, 90)}`);
    button.addEventListener('click', () => openNote(note.id));
    card.append(time, button);
    preview.append(card);
  }
  $('notesPreview').replaceChildren(preview);
  $('notesPreviewEmpty').hidden = notes.length > 0;
  const visible = notes.filter(note => !noteQuery || note.text.toLocaleLowerCase('ru').includes(noteQuery));
  const list = document.createDocumentFragment();
  for (const note of visible) {
    const article = element('article', 'note-entry');
    article.dataset.noteId = note.id;
    const header = element('div', 'note-entry-header');
    const dates = element('div', 'note-dates');
    const time = element('time', '', formatTimestamp(note.createdAt));
    time.dateTime = note.createdAt;
    dates.append(time);
    if (note.updatedAt !== note.createdAt) dates.append(document.createTextNode(` · изменено ${formatTimestamp(note.updatedAt)}`));
    const actions = element('div', 'task-actions');
    actions.append(iconButton('edit', `Редактировать мысль: ${note.text.slice(0, 80)}`, () => openNote(note.id)), iconButton('trash', `Удалить мысль: ${note.text.slice(0, 80)}`, () => askConfirmation('Удалить мысль?', 'Запись будет удалена из блокнота.', 'Удалить', () => update(next => {
      const index = next.notes.findIndex(item => item.id === note.id);
      if (index < 0) return false;
      next.notes.splice(index, 1);
    }, 'Мысль удалена').ok), 'delete-button'));
    header.append(dates, actions);
    const body = element('p', 'note-body', note.text);
    const footer = element('div', 'note-entry-footer');
    const convert = element('button', 'text-button', 'Превратить в задачу');
    convert.type = 'button';
    convert.append(icon('arrow'));
    convert.addEventListener('click', () => {
      openTask();
      conversionNoteId = note.id;
      const firstLine = note.text.split('\n').find(line => line.trim()) || note.text;
      $('taskTitle').value = firstLine.slice(0, 2000);
      $('taskDescription').value = note.text.length > firstLine.length || firstLine.length > 2000 ? note.text : '';
    });
    footer.append(convert);
    article.append(header, body, footer);
    list.append(article);
  }
  $('notesList').replaceChildren(list);
  $('notesEmpty').hidden = visible.length > 0;
  $('notesEmptyTitle').textContent = noteQuery ? 'Мысль не нашлась' : 'Здесь начинается твой блокнот';
  $('notesEmptyText').textContent = noteQuery ? 'Попробуй другое слово или очисти поиск.' : 'Сохрани первую мысль в поле выше.';
}

function render() { applyTheme(); renderDaily(); renderTasks(); renderCalendar(); renderNotes(); renderStorage(); }

function showView(view) {
  currentView = view;
  $('planView').hidden = view !== 'plan';
  $('notesView').hidden = view !== 'notes';
  $('viewLabel').textContent = view === 'notes' ? 'Мысли' : 'План на месяц';
  document.querySelectorAll('.nav-item').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.title = view === 'notes' ? 'Мысли - Порядок' : 'Порядок - личный планировщик';
}

function openDialog(dialog) {
  openers.set(dialog, document.activeElement);
  dialog.showModal();
}

function openTask(id) {
  const task = id ? state.tasks.find(item => item.id === id) : null;
  if (id && !task) return;
  $('taskForm').reset();
  $('taskFormError').hidden = true;
  $('taskId').value = task?.id || '';
  $('taskTitle').value = task?.title || '';
  $('taskDescription').value = task?.description || '';
  $('taskPriority').value = task?.priority || 'normal';
  $('taskMonth').value = task ? monthValue(task) : monthValue();
  $('taskDeadline').value = task?.deadline || '';
  $('taskDialogTitle').textContent = task ? 'Редактировать задачу' : 'Новая задача';
  $('saveTask').textContent = task ? 'Сохранить' : 'Добавить задачу';
  taskSnapshot = task ? snapshot(task) : null;
  conversionNoteId = null;
  openDialog($('taskDialog'));
}

function openNote(id) {
  const note = state.notes.find(item => item.id === id);
  if (!note) return;
  $('noteId').value = id;
  $('noteText').value = note.text;
  $('noteFormError').hidden = true;
  noteSnapshot = snapshot(note);
  openDialog($('noteDialog'));
}

function formError(id, message) { $(id).textContent = message; $(id).hidden = false; }

function askConfirmation(title, text, label, callback, destructive = true) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmAction').textContent = label;
  $('confirmAction').className = destructive ? 'danger-button' : 'primary-button';
  confirmCallback = callback;
  openDialog($('confirmDialog'));
}

function newTask(title, details = {}) {
  return { id: makeId(), title, description: details.description || '', ...selected, priority: details.priority || 'normal', status: 'active', createdAt: new Date().toISOString(), deadline: details.deadline || null, completedAt: null, ...(details.month ? { month: details.month, year: details.year } : {}) };
}

function addNoteFrom(input) {
  const text = input.value.trim();
  if (!text) { showToast('Запиши мысль перед сохранением'); input.focus(); return; }
  if (text.length > 100000) { showToast('Мысль слишком длинная. Максимум - 100000 символов.'); input.focus(); return; }
  const timestamp = new Date().toISOString();
  if (update(next => { next.notes.push({ id: makeId(), text, createdAt: timestamp, updatedAt: timestamp }); }, 'Мысль сохранена').ok) input.value = '';
}

function downloadFile(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const link = element('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  update(next => { next.settings.filter = filter; });
}));
$('previousMonth').addEventListener('click', () => { selected = shiftMonth(selected.year, selected.month, -1); renderTasks(); renderCalendar(); });
$('nextMonth').addEventListener('click', () => { selected = shiftMonth(selected.year, selected.month, 1); renderTasks(); renderCalendar(); });
$('currentMonth').addEventListener('click', () => { now = new Date(); selected = { month: now.getMonth() + 1, year: now.getFullYear() }; render(); });
$('chooseMonth').addEventListener('click', () => { $('monthInput').value = monthValue(); openDialog($('monthDialog')); });
$('monthForm').addEventListener('submit', event => {
  event.preventDefault();
  const month = readMonth($('monthInput').value);
  if (!month) return;
  selected = month;
  $('monthDialog').close();
  renderTasks(); renderCalendar();
});
['addTask', 'emptyAddTask', 'sidebarAddTask'].forEach(id => $(id).addEventListener('click', () => openTask()));
$('quickTaskDetails').addEventListener('click', () => { const title = $('quickTaskTitle').value; openTask(); $('taskTitle').value = title; });
$('quickTaskForm').addEventListener('submit', event => {
  event.preventDefault();
  const title = $('quickTaskTitle').value.trim();
  if (!title) { showToast('Введи название задачи'); $('quickTaskTitle').focus(); return; }
  if (title.length > 2000) { showToast('Название слишком длинное. Максимум - 2000 символов.'); $('quickTaskTitle').focus(); return; }
  const task = newTask(title);
  if (update(next => { next.tasks.push(task); }, 'Задача добавлена').ok) {
    $('quickTaskTitle').value = '';
    if (filter === 'done' || (filter === 'high' && task.priority !== 'high') || taskQuery) showToast('Задача сохранена. Она доступна в фильтре «Все».');
    $('quickTaskTitle').focus();
  }
});
$('taskForm').addEventListener('submit', event => {
  event.preventDefault();
  const title = $('taskTitle').value.trim();
  const description = $('taskDescription').value.trim();
  const month = readMonth($('taskMonth').value);
  const deadline = $('taskDeadline').value || null;
  if (!title) return formError('taskFormError', 'Название не может состоять из пробелов.');
  if (title.length > 2000) return formError('taskFormError', 'Название слишком длинное. Максимум - 2000 символов.');
  if (description.length > 100000) return formError('taskFormError', 'Описание слишком длинное. Максимум - 100000 символов.');
  if (!month) return formError('taskFormError', 'Выбери корректный месяц и год.');
  if (deadline && !validDay(deadline)) return formError('taskFormError', 'Укажи существующую дату дедлайна.');
  const changes = { title, description, priority: $('taskPriority').value, ...month, deadline };
  const id = $('taskId').value;
  const result = update(next => {
    if (id) {
      const task = next.tasks.find(item => item.id === id);
      if (!task || snapshot(task) !== taskSnapshot) return false;
      Object.assign(task, changes);
    } else next.tasks.push(newTask(title, changes));
  }, id ? 'Задача обновлена' : conversionNoteId ? 'Задача создана из мысли' : 'Задача добавлена');
  if (!result.ok) return formError('taskFormError', result.message);
  $('taskDialog').close();
  if (!id && $('quickTaskTitle').value.trim() === title) $('quickTaskTitle').value = '';
  if (month.year !== selected.year || month.month !== selected.month) showToast(`Задача сохранена: ${months[month.month - 1].toLowerCase()} ${month.year}`);
});
$('toggleTaskSearch').addEventListener('click', () => {
  const open = $('taskSearchBox').hidden;
  $('taskSearchBox').hidden = !open;
  $('toggleTaskSearch').setAttribute('aria-expanded', String(open));
  if (open) $('taskSearch').focus();
  else { taskQuery = ''; $('taskSearch').value = ''; renderTasks(); }
});
$('taskSearch').addEventListener('input', event => { taskQuery = event.target.value.trim().toLocaleLowerCase('ru'); renderTasks(); });
$('clearTaskSearch').addEventListener('click', () => { taskQuery = ''; $('taskSearch').value = ''; renderTasks(); $('taskSearch').focus(); });
function focusTaskSearch() {
  showView('plan');
  $('taskSearchBox').hidden = false;
  $('toggleTaskSearch').setAttribute('aria-expanded', 'true');
  $('taskSearch').focus();
}
$('globalSearch').addEventListener('click', focusTaskSearch);
$('taskSearch').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  taskQuery = ''; $('taskSearch').value = ''; $('taskSearchBox').hidden = true;
  $('toggleTaskSearch').setAttribute('aria-expanded', 'false');
  renderTasks(); $('toggleTaskSearch').focus();
});
$('noteSearch').addEventListener('input', event => { noteQuery = event.target.value.trim().toLocaleLowerCase('ru'); renderNotes(); });
$('quickNoteForm').addEventListener('submit', event => { event.preventDefault(); addNoteFrom($('quickNoteText')); });
$('newNoteForm').addEventListener('submit', event => { event.preventDefault(); addNoteFrom($('newNoteText')); });
['quickNoteText', 'newNoteText', 'noteText'].forEach(id => $(id).addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $(id).form.requestSubmit(); }
}));
$('noteForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('noteText').value.trim();
  if (!text) return formError('noteFormError', 'Запись не может состоять из пробелов.');
  if (text.length > 100000) return formError('noteFormError', 'Мысль слишком длинная. Максимум - 100000 символов.');
  const result = update(next => {
    const note = next.notes.find(item => item.id === $('noteId').value);
    if (!note || snapshot(note) !== noteSnapshot) return false;
    note.text = text;
    note.updatedAt = new Date().toISOString();
  }, 'Мысль обновлена');
  if (!result.ok) return formError('noteFormError', result.message);
  $('noteDialog').close();
});
$('confirmAction').addEventListener('click', () => { if (confirmCallback?.()) $('confirmDialog').close(); });
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => {
    if (dialog === $('confirmDialog')) confirmCallback = null;
    const opener = openers.get(dialog);
    if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
    else (currentView === 'plan' ? $('addTask') : $('newNoteText')).focus({ preventScroll: true });
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});
['openSettings', 'storageInfo'].forEach(id => $(id).addEventListener('click', () => { $('importError').hidden = true; openDialog($('settingsDialog')); }));
$('themeToggle').addEventListener('click', () => update(next => { next.settings.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; }));
document.querySelectorAll('input[name="theme"]').forEach(input => input.addEventListener('change', () => update(next => { next.settings.theme = input.value; })));
systemTheme.addEventListener('change', applyTheme);
$('exportData').addEventListener('click', () => {
  state = storage.load();
  const data = storage.locked && storage.recoveryRaw ? storage.recoveryRaw : JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
  downloadFile(data, `poryadok-${localDay()}.json`);
  renderStorage();
});
$('downloadRecovery').addEventListener('click', () => { if (storage.recoveryRaw) downloadFile(storage.recoveryRaw, `poryadok-recovery-${localDay()}.json`); });
$('exportPrevious').addEventListener('click', () => { if (storage.recoveryRaw) downloadFile(storage.recoveryRaw, `poryadok-recovery-${localDay()}.json`); });
$('importData').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  $('importError').hidden = true;
  if (file.size > 10 * 1024 * 1024) return formError('importError', 'Файл слишком большой. Максимальный размер - 10 МБ.');
  let parsed;
  try { parsed = parseState(await file.text()); }
  catch { return formError('importError', 'Не удалось прочитать файл. Попробуй выбрать его еще раз.'); }
  if (!parsed.ok || parsed.repaired) return formError('importError', parsed.reason === 'future' ? 'Файл создан более новой версией приложения.' : 'Файл содержит некорректные данные. Выбери сохраненную копию планировщика.');
  $('settingsDialog').close();
  askConfirmation('Восстановить план?', `В файле ${plural(parsed.state.tasks.length)} и ${plural(parsed.state.notes.length, 'мысль', 'мысли', 'мыслей')}. Текущий план будет заменен; его исходная копия сохранится в браузере.`, 'Восстановить', () => {
    parsed.state.schemaVersion = SCHEMA_VERSION;
    parsed.state.updatedAt = new Date().toISOString();
    const result = storage.replace(parsed.state);
    lastSaveError = result.ok ? '' : result.message;
    state = storage.state;
    filter = state.settings.filter;
    render();
    if (result.ok) { $('importData').value = ''; showToast('План восстановлен из файла'); cloud.schedule(); }
    else showToast(result.message);
    return result.ok;
  }, false);
});
document.addEventListener('keydown', event => {
  if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && ['k', 'л'].includes(event.key.toLowerCase()) && !document.querySelector('dialog[open]')) {
    event.preventDefault(); focusTaskSearch(); return;
  }
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key.toLowerCase() === 'n' || event.key.toLowerCase() === 'т') { event.preventDefault(); if (currentView === 'plan') openTask(); else $('newNoteText').focus(); }
});
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== BACKUP_KEY && event.key !== null) return;
  state = storage.load();
  filter = state.settings.filter;
  lastSaveError = '';
  render();
  cloud.schedule();
});

function refreshClock() {
  const next = new Date();
  if (localDay(next) !== localDay(now)) {
    const followingCurrent = selected.year === now.getFullYear() && selected.month === now.getMonth() + 1;
    now = next;
    if (followingCurrent) selected = { year: now.getFullYear(), month: now.getMonth() + 1 };
    render();
  }
  clearTimeout(dayTimer);
  const midnight = new Date(next);
  midnight.setHours(24, 0, 0, 100);
  dayTimer = setTimeout(refreshClock, Math.max(100, midnight.getTime() - next.getTime()));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshClock(); });
window.addEventListener('focus', refreshClock);
render();
refreshClock();
const searchShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
document.querySelectorAll('[data-search-shortcut]').forEach(kbd => { kbd.textContent = searchShortcut; });
initializeOffline({ notify: showToast });
cloud = initializeCloud({ storage:browserStorage,planner:storage,notify:showToast,openDialog,onChange:next=>{ state = next; filter = state.settings.filter; render(); } });
