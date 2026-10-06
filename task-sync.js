import { makeId } from './core.js';
import { CloudError, UUID, taskFromRow } from './supabase-api.js';

export const SYNC_OWNER_KEY = 'poryadok.sync.owner.v1';
const clone = value => value === null ? null : structuredClone(value);
const fields = ['title','description','year','month','deadline','priority','status','createdAt','completedAt'];
function canonical(task) {
  if (!task) return null;
  return fields.map(key => ['createdAt','completedAt'].includes(key) && task[key] ? new Date(task[key]).toISOString() : task[key] ?? null);
}
export const sameTask = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Compare the edited fields, not device clocks. Both versions survive conflicts.
export function mergeTasks(base, local, remote) {
  const next = { ...remote, id:local.id };
  const groups = [['title'], ['description'], ['year','month'], ['deadline'], ['priority'], ['status']];
  const conflicts = [];
  for (const group of groups) {
    const value = task => JSON.stringify(group.map(key => task[key]));
    const l = value(local), b = value(base), r = value(remote);
    if (l === b) continue;
    if (r === b || r === l) for (const key of group) next[key] = local[key];
    else conflicts.push(...group);
  }
  if (next.status === 'done') {
    const localCompleted = local.status === 'done' ? local.completedAt : null;
    const remoteCompleted = remote.status === 'done' ? remote.completedAt : null;
    next.completedAt = [localCompleted,remoteCompleted].filter(Boolean).sort((a,b) => Date.parse(b)-Date.parse(a))[0] || local.createdAt;
  } else next.completedAt = null;
  return { task:next, conflicts };
}

export class TaskSynchronizer {
  constructor({ api, planner, storage, notify = () => {}, onChange = () => {}, idFactory = makeId, withLock = (_name,fn) => fn(), now = () => new Date().toISOString() }) {
    this.api = api; this.planner = planner; this.storage = storage; this.notify = notify; this.onChange = onChange; this.idFactory = idFactory; this.withLock = withLock; this.now = now;
    this.running = null; this.lastResult = { pending:0, lastSync:null };
  }
  uuid() {
    const id = this.idFactory();
    if (UUID.test(id)) return id.toLowerCase();
    if (/^[\da-f]{32}$/i.test(id)) return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`.toLowerCase();
    throw new CloudError('storage','Браузер не создал идентификатор для синхронизации.');
  }
  owner() {
    const session = this.api.session();
    if (!session) throw new CloudError('auth','Войди в аккаунт для синхронизации.');
    const owner = { project:this.api.config.url, userId:session.user.id };
    let raw;
    try { raw = this.storage.getItem(SYNC_OWNER_KEY); }
    catch { throw new CloudError('storage','Нет доступа к локальной очереди синхронизации.'); }
    if (raw) {
      let bound;
      try { bound = JSON.parse(raw); } catch { throw new CloudError('storage','Привязка локального плана повреждена. Данные сохранены.'); }
      if (bound.project !== owner.project || bound.userId !== owner.userId) throw new CloudError('owner','Локальный план связан с другим аккаунтом. Войди в прежний аккаунт; записи остаются на этом устройстве.');
    } else this.write(SYNC_OWNER_KEY, owner);
    return owner;
  }
  write(key, value) {
    const raw = JSON.stringify(value);
    try { this.storage.setItem(key,raw); if (this.storage.getItem(key) !== raw) throw new Error(); }
    catch { throw new CloudError('storage','Очередь не сохранилась. Задачи остаются в локальном плане; отправка возобновится после освобождения места.'); }
  }
  journal(owner) {
    const key = `poryadok.sync.v1:${new URL(owner.project).hostname}:${owner.userId}`;
    let raw;
    try { raw = this.storage.getItem(key); } catch { throw new CloudError('storage','Не удалось прочитать очередь синхронизации.'); }
    if (!raw) return { key, records:[], lastSync:null };
    let journal;
    try { journal = JSON.parse(raw); } catch { throw new CloudError('storage','Очередь синхронизации повреждена. Локальный план сохранен.'); }
    if (journal.version !== 1 || !Array.isArray(journal.records) || journal.records.some(r => !r || typeof r.localId !== 'string' || !UUID.test(r.remoteId) || typeof r.pending !== 'boolean' || (!r.shadow && r.shadow !== null) || (r.base && r.base.user_id !== owner.userId)) || new Set(journal.records.map(r=>r.localId)).size !== journal.records.length || new Set(journal.records.map(r=>r.remoteId)).size !== journal.records.length) throw new CloudError('storage','Очередь не прошла проверку. Локальный план сохранен.');
    return { key, records:journal.records, lastSync:journal.lastSync || null };
  }
  save(journal) { this.write(journal.key,{ version:1,records:journal.records,lastSync:journal.lastSync }); }
  assertOwner(owner) {
    if (this.api.session()?.user.id !== owner.userId || this.api.config.url !== owner.project) throw new CloudError('auth','Аккаунт изменился. Синхронизация остановлена.');
  }
  localTasks() {
    const state = this.planner.load();
    if (this.planner.locked) throw new CloudError('storage',this.planner.notice || 'Локальный план защищен от перезаписи.');
    return state.tasks;
  }
  stage(journal) {
    const tasks = new Map(this.localTasks().map(task=>[task.id,task]));
    const records = new Map(journal.records.map(r=>[r.localId,r]));
    for (const task of tasks.values()) {
      const record = records.get(task.id);
      if (!record) journal.records.push({ localId:task.id,remoteId:UUID.test(task.id) ? task.id.toLowerCase() : this.uuid(),base:null,shadow:clone(task),pending:true });
      else if (!sameTask(task,record.shadow)) { record.shadow = clone(task); record.pending = true; }
    }
    for (const record of journal.records) if (!tasks.has(record.localId) && record.shadow !== null) { record.shadow = null; record.pending = true; }
    this.save(journal);
    this.lastResult = { pending:journal.records.filter(r=>r.pending).length,lastSync:journal.lastSync };
  }
  mutate(fn) {
    const result = this.planner.commit(fn);
    if (!result.ok) throw new CloudError('storage',result.message);
    this.onChange(result.state);
  }
  async acknowledge(journal,record,row,expectedTask,owner) {
    this.assertOwner(owner);
    const current = this.localTasks().find(task=>task.id === record.localId) || null;
    const remote = row.archived ? null : { ...taskFromRow(row,this.api.config,owner.userId), id:record.localId };
    record.base = clone(row);
    if (sameTask(current,expectedTask)) {
      if (!sameTask(current,remote)) this.mutate(next => {
        const task = next.tasks.find(item=>item.id === record.localId) || null;
        if (!sameTask(task,current)) return false;
        next.tasks = next.tasks.filter(item=>item.id !== record.localId);
        if (remote) next.tasks.push(remote);
      });
      record.shadow = clone(remote); record.pending = false;
    } else if (current && expectedTask && remote) {
      const merged = mergeTasks(expectedTask,current,remote);
      if (merged.conflicts.length) { this.fork(journal,record,current,row,owner); return; }
      if (!sameTask(current,merged.task)) this.mutate(next => {
        const task = next.tasks.find(item=>item.id === record.localId);
        if (!sameTask(task,current)) return false;
        Object.assign(task,merged.task);
      });
      record.shadow = clone(remote); record.pending = false;
    } else { record.shadow = clone(remote); record.pending = false; }
    this.stage(journal); // Recover any edit made while the network request was in flight.
  }
  fork(journal,record,local,row,owner) {
    this.assertOwner(owner);
    const copied = { ...clone(local), id:this.uuid() };
    const remote = row.archived ? null : { ...taskFromRow(row,this.api.config,owner.userId),id:record.localId };
    this.mutate(next => {
      const current = next.tasks.find(task=>task.id === record.localId) || null;
      if (!sameTask(current,local)) return false;
      next.tasks = next.tasks.filter(task=>task.id !== record.localId);
      if (remote) next.tasks.push(remote);
      next.tasks.push(copied);
    });
    record.base = clone(row); record.shadow = clone(remote); record.pending = false;
    this.stage(journal); // The preserved local copy is durable before sending anything.
    this.notify('Задача менялась на двух устройствах. Обе версии сохранены отдельными задачами.');
  }
  async push(journal,record,row,owner) {
    const expected = clone(record.shadow);
    if (!expected) {
      if (!row || row.archived) { record.base = clone(row || record.base); record.pending = false; this.save(journal); return; }
      if (!record.base || !sameTask(taskFromRow(record.base,this.api.config,owner.userId),taskFromRow(row,this.api.config,owner.userId))) {
        // Deleting an old version must not destroy someone else's newer edit.
        record.shadow = null;
        await this.acknowledge(journal,record,row,null,owner);
        this.notify('Измененная на другом устройстве задача восстановлена.'); return;
      }
      const saved = await this.api.patchTask(null,row,owner.userId,true);
      await this.acknowledge(journal,record,saved,null,owner); return;
    }
    let task = expected;
    if (row) {
      const remoteTask = { ...taskFromRow(row,this.api.config,owner.userId),id:record.localId };
      if (row.archived && !record.base?.archived) { this.fork(journal,record,expected,row,owner); return; }
      if (!record.base && !sameTask(task,remoteTask)) { this.fork(journal,record,expected,row,owner); return; }
      if (record.base && !row.archived) {
        const baseTask = { ...taskFromRow(record.base,this.api.config,owner.userId),id:record.localId };
        const merged = mergeTasks(baseTask,task,remoteTask);
        if (merged.conflicts.length) { this.fork(journal,record,expected,row,owner); return; }
        task = merged.task;
      }
      if (!row.archived && sameTask(task,remoteTask)) { await this.acknowledge(journal,record,row,expected,owner); return; }
    }
    this.assertOwner(owner);
    const saved = row ? await this.api.patchTask(task,row,owner.userId) : await this.api.insertTask(task,record.remoteId,owner.userId);
    await this.acknowledge(journal,record,saved,expected,owner);
  }
  async pull(journal,rows,owner) {
    this.stage(journal);
    const known = new Map(journal.records.map(r=>[r.remoteId,r]));
    for (const row of rows) {
      this.assertOwner(owner);
      const record = known.get(row.id);
      if (record) {
        if (record.pending) continue;
        if (record.base?.updated_at !== row.updated_at || record.base?.archived !== row.archived) await this.acknowledge(journal,record,row,clone(record.shadow),owner);
      } else if (!row.archived) {
        const task = taskFromRow(row,this.api.config,owner.userId);
        if (this.localTasks().some(item=>item.id === task.id)) throw new CloudError('conflict','Локальная задача изменилась во время загрузки. Будет повторная сверка.');
        this.mutate(next => { if (next.tasks.some(item=>item.id === task.id)) return false; next.tasks.push(task); });
        journal.records.push({ localId:task.id,remoteId:row.id,base:clone(row),shadow:clone(task),pending:false });
        this.save(journal);
      }
    }
    // Missing rows are never treated as deletions. Only an explicit archive is.
  }
  async sync({ online = true } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const owner = this.owner();
      return this.withLock(`poryadok-sync:${owner.project}:${owner.userId}`,async () => {
        this.assertOwner(owner);
        const journal = this.journal(owner);
        this.stage(journal);
        if (!online) return this.lastResult = { pending:journal.records.filter(r=>r.pending).length,lastSync:journal.lastSync,offline:true };
        const rows = await this.api.listTasks(owner.userId);
        this.assertOwner(owner);
        const remote = new Map(rows.map(row=>[row.id,row]));
        this.stage(journal);
        for (const record of [...journal.records]) {
          this.stage(journal);
          if (!record.pending) continue;
          await this.push(journal,record,remote.get(record.remoteId) || null,owner);
          if (record.base) remote.set(record.remoteId,record.base);
        }
        await this.pull(journal,[...remote.values()],owner);
        this.stage(journal); journal.lastSync = this.now(); this.save(journal);
        return this.lastResult = { pending:journal.records.filter(r=>r.pending).length,lastSync:journal.lastSync,offline:false };
      });
    })();
    try { return await this.running; } finally { this.running = null; }
  }
}
