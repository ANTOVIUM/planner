import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PlannerStorage,STORAGE_KEY,emptyState } from '../core.js';
import { TaskSynchronizer,mergeTasks,SYNC_OWNER_KEY } from '../task-sync.js';
import { SupabaseAPI,CloudError,validateCloudConfig,taskFromRow,taskToRow } from '../supabase-api.js';
import { SUPABASE_CONFIG } from '../supabase-config.js';
const userId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const config = validateCloudConfig(SUPABASE_CONFIG);
const task = (changes = {})=>({ id:randomUUID(),title:'Проверить план',description:'',year:2026,month:10,deadline:null,priority:'normal',status:'active',createdAt:'2026-10-06T08:00:00.000Z',completedAt:null,...changes });
class MemoryStorage {
  constructor(){ this.data = new Map(); this.blockSync = false; }
  getItem(key){ return this.data.get(key) ?? null; }
  setItem(key,value){ if (this.blockSync && key.startsWith('poryadok.sync.')) throw Error('Quota'); this.data.set(key,value); }
  removeItem(key){ this.data.delete(key); }
}
function server() {
  const rows = new Map(); let version = 0;
  return { rows,offline:false,afterInsert:null,beforePatch:null,
    row(t,id=t.id){ return { ...taskToRow(t,id,userId,config),updated_at:new Date(Date.UTC(2026,9,6,9,0,++version)).toISOString() }; },
    edit(id,changes){ const row = rows.get(id); Object.assign(row,changes,{ updated_at:new Date(Date.UTC(2026,9,6,9,0,++version)).toISOString() }); },
    async list(){ if (this.offline) throw new CloudError('network','Offline'); return structuredClone([...rows.values()]); },
    async insert(t,id){ if (this.offline) throw new CloudError('network','Offline'); if (rows.has(id)) throw new CloudError('conflict','Duplicate'); const row = this.row(t,id); rows.set(id,row); await this.afterInsert?.(row); return structuredClone(row); },
    async patch(t,row,archived){ if (this.offline) throw new CloudError('network','Offline'); await this.beforePatch?.(row); const current = rows.get(row.id); if (current?.updated_at !== row.updated_at) throw new CloudError('conflict','CAS failed'); const next = archived ? { ...current,archived:true } : { ...current,...taskToRow(t,row.id,userId,config,current) }; next.updated_at = new Date(Date.UTC(2026,9,6,9,0,++version)).toISOString(); rows.set(row.id,next); return structuredClone(next); }
  };
}
function device(db,tasks = [],memory = new MemoryStorage()) {
  const planner = new PlannerStorage(memory); if (!memory.getItem(STORAGE_KEY)) memory.setItem(STORAGE_KEY,JSON.stringify({...emptyState(),tasks})); planner.load();
  const notices = []; const session = { user:{ id:userId } };
  const api = { config,session:()=>session.user ? session : null,listTasks:()=>db.list(),insertTask:(t,id)=>db.insert(t,id),patchTask:(t,row,_uid,archived)=>db.patch(t,row,archived) };
  const engine = new TaskSynchronizer({ api,planner,storage:memory,idFactory:randomUUID,notify:message=>notices.push(message) });
  return { memory,planner,engine,session,notices,get tasks(){ return planner.load().tasks; },edit(id,changes){ assert.equal(planner.commit(next=>Object.assign(next.tasks.find(t=>t.id === id),changes)).ok,true); },remove(id){ assert.equal(planner.commit(next=>{next.tasks=next.tasks.filter(t=>t.id!==id);}).ok,true); } };
}
test('first login merges local and cloud plans without replacing notes or settings',async()=>{
  const db=server(),local=task(),remote=task({title:'С другого устройства'}); db.rows.set(remote.id,db.row(remote)); const a=device(db,[local]);
  a.planner.commit(next=>{next.notes.push({id:randomUUID(),text:'Локальная мысль',createdAt:local.createdAt,updatedAt:local.createdAt});next.settings.theme='dark';});
  await a.engine.sync(); assert.equal(a.tasks.length,2); assert.equal(db.rows.size,2); assert.equal(a.planner.state.notes.length,1); assert.equal(a.planner.state.settings.theme,'dark');
});
test('repeated sync never duplicates records',async()=>{
  const db=server(),t=task(),a=device(db,[t]); for(let i=0;i<4;i++) await a.engine.sync(); assert.equal(a.tasks.length,1); assert.equal(db.rows.size,1);
});
test('offline edits survive reload and arrive on a second device',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); const b=device(db); await b.engine.sync();
  a.edit(t.id,{title:'Изменено без сети',priority:'high'}); db.offline=true; const queue=await a.engine.sync({online:false}); assert.equal(queue.pending,1);
  const reloaded=device(db,[],a.memory); db.offline=false; await reloaded.engine.sync(); await b.engine.sync(); assert.equal(b.tasks[0].title,'Изменено без сети'); assert.equal(b.tasks[0].priority,'high');
});
test('local deletion becomes a cloud archive and disappears on another device',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); const b=device(db); await b.engine.sync(); a.remove(t.id); await a.engine.sync(); await b.engine.sync(); assert.equal(db.rows.get(t.id).archived,true); assert.equal(b.tasks.length,0);
});
test('independent field edits merge in both directions',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); const b=device(db); await b.engine.sync();
  a.edit(t.id,{title:'Новый заголовок'}); b.edit(t.id,{deadline:'2026-10-20'}); await a.engine.sync(); await b.engine.sync(); await a.engine.sync(); assert.equal(a.tasks[0].title,'Новый заголовок'); assert.equal(a.tasks[0].deadline,'2026-10-20'); assert.equal(b.tasks[0].title,'Новый заголовок');
});
test('conflicting titles preserve both versions and converge',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); const b=device(db); await b.engine.sync(); a.edit(t.id,{title:'Версия A'}); b.edit(t.id,{title:'Версия B'}); await a.engine.sync(); await b.engine.sync(); await b.engine.sync(); await a.engine.sync(); assert.deepEqual(a.tasks.map(t=>t.title).sort(),['Версия A','Версия B']); assert.equal(db.rows.size,2); assert.equal(b.notices.length,1);
});
test('a newer cloud edit survives an offline deletion',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); a.remove(t.id); db.edit(t.id,{title:'Важное новое уточнение'}); await a.engine.sync(); assert.equal(a.tasks[0].title,'Важное новое уточнение'); assert.equal(db.rows.get(t.id).archived,false);
});
test('an offline edit to a remotely archived task survives as a new task',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); a.edit(t.id,{title:'Сохранить мою правку'}); db.edit(t.id,{archived:true}); await a.engine.sync(); await a.engine.sync(); assert.equal(a.tasks.length,1); assert.notEqual(a.tasks[0].id,t.id); assert.equal([...db.rows.values()].filter(r=>!r.archived).length,1);
});
test('an insert whose response was lost is retried without duplication',async()=>{
  const db=server(),t=task(),a=device(db,[t]); db.afterInsert=()=>{db.afterInsert=null;throw new CloudError('network','Lost response');}; await assert.rejects(a.engine.sync()); await a.engine.sync(); assert.equal(db.rows.size,1); assert.equal(a.tasks.length,1);
});
test('a local edit made during upload is not lost',async()=>{
  const db=server(),t=task(),a=device(db,[t]); db.afterInsert=()=>{a.edit(t.id,{description:'Уточнение во время отправки'});db.afterInsert=null;}; await a.engine.sync(); await a.engine.sync(); assert.equal(db.rows.get(t.id).description,'Уточнение во время отправки');
});
test('deleting during an insert queues an archive instead of resurrecting the task',async()=>{
  const db=server(),t=task(),a=device(db,[t]); db.afterInsert=()=>{a.remove(t.id);db.afterInsert=null;}; await a.engine.sync(); await a.engine.sync(); assert.equal(a.tasks.length,0); assert.equal(db.rows.get(t.id).archived,true);
});
test('compare-and-swap prevents overwriting an edit made during PATCH',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); a.edit(t.id,{description:'Локально'}); db.beforePatch=()=>{db.edit(t.id,{title:'Одновременная правка'});db.beforePatch=null;}; await assert.rejects(a.engine.sync(),error=>error.kind==='conflict'); await a.engine.sync(); assert.equal(db.rows.get(t.id).title,'Одновременная правка'); assert.equal(db.rows.get(t.id).description,'Локально');
});
test('quota failure stops network writes but keeps the local task',async()=>{
  const db=server(),t=task(),a=device(db,[t]); a.memory.blockSync=true; await assert.rejects(a.engine.sync(),error=>error.kind==='storage'); assert.equal(db.rows.size,0); assert.equal(a.tasks.length,1); a.memory.blockSync=false; await a.engine.sync(); assert.equal(db.rows.size,1);
});
test('a different account cannot receive the bound local plan',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); a.session.user={id:otherId}; await assert.rejects(a.engine.sync(),error=>error.kind==='owner'); assert.equal(a.tasks.length,1); assert.equal(db.rows.size,1);
});
test('sign-out stops sync and keeps queued changes',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); a.edit(t.id,{title:'После выхода'}); a.session.user=null; await assert.rejects(a.engine.sync(),error=>error.kind==='auth'); assert.equal(a.tasks[0].title,'После выхода'); a.session.user={id:userId}; await a.engine.sync(); assert.equal(db.rows.get(t.id).title,'После выхода');
});
test('a non-UUID local task keeps its original ID and a durable cloud mapping',async()=>{
  const db=server(),t=task({id:'old-local-task'}),a=device(db,[t]); await a.engine.sync(); assert.equal(a.tasks[0].id,'old-local-task'); const reloaded=device(db,[],a.memory); await reloaded.engine.sync(); assert.equal(db.rows.size,1); assert.equal(reloaded.tasks[0].id,'old-local-task');
});
test('absence in a partial server snapshot never deletes local data',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); db.rows.clear(); await a.engine.sync(); assert.equal(a.tasks.length,1); assert.equal(db.rows.size,0);
});
test('task completion time and month move survive sync',async()=>{
  const db=server(),t=task(),a=device(db,[t]); await a.engine.sync(); a.edit(t.id,{year:2027,month:1,status:'done',completedAt:'2026-10-06T10:10:00.000Z'}); await a.engine.sync(); const b=device(db); await b.engine.sync(); assert.equal(b.tasks[0].month,1); assert.equal(b.tasks[0].year,2027); assert.equal(b.tasks[0].completedAt,'2026-10-06T10:10:00.000Z');
});
test('existing raw status, priority and deadline time survive a title-only edit',()=>{
  const row={...taskToRow(task(),randomUUID(),userId,config),priority:'low',status:'waiting',deadline:'2026-10-08T20:00:00.000Z',updated_at:'2026-10-06T09:00:00.000Z'};
  const local=taskFromRow(row,config,userId); assert.equal(local.deadline,'2026-10-09'); local.title='Уточнено'; const saved=taskToRow(local,row.id,userId,config,row); assert.equal(saved.priority,'low'); assert.equal(saved.status,'waiting'); assert.equal(saved.deadline,row.deadline);
});
test('same status completions merge without making duplicate tasks',()=>{
  const base=task(),a={...base,status:'done',completedAt:'2026-10-06T10:00:00Z'},b={...base,status:'done',completedAt:'2026-10-06T11:00:00Z'}; const merged=mergeTasks(base,a,b); assert.equal(merged.conflicts.length,0); assert.equal(merged.task.completedAt,b.completedAt);
});
test('client config rejects privileged keys and unrelated endpoints',()=>{
  for(const key of ['sb_secret_not_a_public_key',`e30.${btoa(JSON.stringify({role:'service_role'}))}.signature`]) assert.throws(()=>validateCloudConfig({...SUPABASE_CONFIG,publishableKey:key}),error=>error.kind==='config');
  for(const url of ['http://example.supabase.co','https://other.example','https://example.supabase.co/path','https://user:pass@example.supabase.co']) assert.throws(()=>validateCloudConfig({...SUPABASE_CONFIG,url}));
});
test('an unknown or foreign row cannot replace local data',()=>{
  const row={...taskToRow(task(),randomUUID(),userId,config),updated_at:'2026-10-06T09:00:00.000Z'}; assert.throws(()=>taskFromRow({...row,user_id:otherId},config,userId),error=>error.kind==='permission'); assert.throws(()=>taskFromRow({...row,priority:'unknown'},config,userId),error=>error.kind==='schema');
});
function apiHarness(handler) {
  const storage=new MemoryStorage(); const calls=[]; const api=new SupabaseAPI({config:SUPABASE_CONFIG,storage,fetcher:async(url,options)=>{calls.push({url,options});return handler(url,options);},now:()=>Date.parse('2026-10-06T09:00:00Z')});
  const saved={access_token:'access-token',refresh_token:'refresh-token',expires_at:1791280800,user:{id:userId,email:'qa@example.test'}}; api.saveSession(saved); return {api,storage,calls,saved};
}
const response=(value,status=200,headers={})=>new Response(value===null ? '' : JSON.stringify(value),{status,headers});
test('email/password login does not create an account or persist the password',async()=>{
  const h=apiHarness(()=>response({access_token:'signed-in',refresh_token:'renew',expires_in:3600,user:{id:userId,email:'qa@example.test'}})); await h.api.signIn('qa@example.test','temporary-test-password'); assert.match(h.calls[0].url,/token\?grant_type=password$/); assert.doesNotMatch(JSON.stringify([...h.storage.data]),/temporary-test-password/); assert.equal(h.calls[0].options.headers.apikey,config.publishableKey);
});
test('expired sessions refresh before requesting task data',async()=>{
  const h=apiHarness(url=>url.includes('refresh_token')?response({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,user:{id:userId}}):response([])); h.api.saveSession({...h.saved,expires_at:1}); await h.api.request('/rest/v1/tasks'); assert.equal(h.calls.length,2); assert.equal(h.calls[1].options.headers.Authorization,'Bearer new-access');
});
test('network refresh failures keep the session for later recovery',async()=>{
  const h=apiHarness(()=>{throw Error('Offline');}); h.api.saveSession({...h.saved,expires_at:1}); await assert.rejects(h.api.token(),error=>error.kind==='network'); assert.ok(h.api.session());
});
test('invalid refresh tokens stop cloud access without touching local tasks',async()=>{
  const h=apiHarness(()=>response({error:'invalid_grant'},400)); h.api.saveSession({...h.saved,expires_at:1}); h.storage.setItem(STORAGE_KEY,'local-plan-untouched'); await assert.rejects(h.api.token(),error=>error.kind==='auth'); assert.equal(h.api.session(),null); assert.equal(h.storage.getItem(STORAGE_KEY),'local-plan-untouched');
});
test('offline sign-out clears only this device session',async()=>{
  const h=apiHarness(()=>{throw Error('Offline');}); h.storage.setItem(SYNC_OWNER_KEY,'bound'); h.storage.setItem(STORAGE_KEY,'local-plan'); await h.api.signOut(); assert.equal(h.api.session(),null); assert.equal(h.storage.getItem(SYNC_OWNER_KEY),'bound'); assert.equal(h.storage.getItem(STORAGE_KEY),'local-plan');
});
test('a rejected write stays unacknowledged',async()=>{
  const h=apiHarness(()=>response({code:'42501'},403)); await assert.rejects(h.api.insertTask(task(),randomUUID(),userId),error=>error.kind==='permission'); assert.equal(h.calls[0].options.method,'POST');
});
test('client refuses writes before verification of the existing schema',async()=>{
  const h=apiHarness(()=>response([])); h.api.config.schemaVerified=false; await assert.rejects(h.api.insertTask(task(),randomUUID(),userId),error=>error.kind==='config'); assert.equal(h.calls.length,0);
});
test('zero-row CAS updates are conflicts, not successful writes',async()=>{
  const h=apiHarness(()=>response([])),t=task(),row={...taskToRow(t,t.id,userId,config),updated_at:'2026-10-06T08:00:00Z'}; await assert.rejects(h.api.patchTask(t,row,userId),error=>error.kind==='conflict'); assert.match(h.calls[0].url,/updated_at=/);
});
test('pagination reads all 600 tasks and includes explicit owner filters',async()=>{
  const rows=Array.from({length:600},()=>({...taskToRow(task(),randomUUID(),userId,config),updated_at:'2026-10-06T08:00:00Z'}));
  const h=apiHarness(url=>{const offset=Number(new URL(url).searchParams.get('offset'));const part=rows.slice(offset,offset+500);return response(part,200,{'content-range':`${offset}-${offset+part.length-1}/600`});});
  const got=await h.api.listTasks(userId); assert.equal(got.length,600); assert.equal(h.calls.length,2); assert.ok(h.calls.every(c=>new URL(c.url).searchParams.get('user_id')===`eq.${userId}`));
});
test('unconfirmed partial reads are errors, not deletions',async()=>{
  const h=apiHarness(()=>response([])); await assert.rejects(h.api.listTasks(userId),error=>error.kind==='schema');
});
