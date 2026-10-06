import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const root = new URL('../', import.meta.url);
async function worker() {
  const listeners = new Map();
  const cacheData = new Map();
  const networkFiles = new Map();
  let networkAllowed = true;
  let networkCalls = 0;
  let claimed = 0;
  let skipped = 0;
  const self = { location: { href: 'https://example.test/planner/sw.js' }, addEventListener: (type, handler) => listeners.set(type, handler), clients: { claim: async () => { claimed++; } }, skipWaiting: async () => { skipped++; } };
  const network = async request => {
    networkCalls++;
    if (!networkAllowed) throw new TypeError('Network offline');
    const url = typeof request === 'string' ? request : request.url;
    const data = networkFiles.get(url);
    if (!data) return new Response('Not found', { status:404 });
    if (request.integrity && request.integrity !== `sha256-${createHash('sha256').update(data).digest('base64')}`) throw new TypeError('Integrity mismatch');
    return new Response(data);
  };
  const caches = {
    keys: async () => [...cacheData.keys()],
    delete: async key => cacheData.delete(key),
    open: async name => {
      if (!cacheData.has(name)) cacheData.set(name, new Map());
      const data = cacheData.get(name);
      return {
        match: async input => data.get(typeof input === 'string' ? input : input.url)?.clone(),
        addAll: async requests => {
          const pending = await Promise.all(requests.map(async request => {
            const response = await network(request);
            if (!response.ok) throw new TypeError('Bad response');
            return [request.url, response];
          }));
          for (const [url, response] of pending) data.set(url, response);
        }
      };
    }
  };
  const context = vm.createContext({ self, caches, fetch:network, URL, Request, Response, Promise, Set });
  vm.runInContext(source, context);
  const meta = vm.runInContext('({ VERSION, PRECACHE, CACHE_NAME, CACHE_PREFIX })', context);
  for (const [path] of meta.PRECACHE) networkFiles.set(new URL(path, self.location.href).href, await readFile(new URL(path === './' ? 'index.html' : path, root)));
  async function dispatch(type, properties = {}) {
    const waits = [];
    let response;
    listeners.get(type)?.({ ...properties, waitUntil: promise => waits.push(promise), respondWith: promise => { response = promise; } });
    await Promise.all(waits);
    return response ? await response : undefined;
  }
  return { meta, dispatch, cacheData, networkFiles, setOffline: () => { networkAllowed = false; }, get networkCalls(){ return networkCalls; }, get claimed(){ return claimed; }, get skipped(){ return skipped; } };
}
function getRequest(path, mode='navigate', method='GET') { return { url: new URL(path,'https://example.test/planner/').href, mode, method }; }
async function status(w, type='GET_STATUS') { let reply; await w.dispatch('message', { data:{type}, ports:[{postMessage:value => {reply=value;}}] }); return reply; }

test('precache has current hashes for HTML, modules, fonts, manifest and icons', async () => {
  const w=await worker();
  assert.equal(w.meta.PRECACHE.length,20);
  for (const [path,integrity] of w.meta.PRECACHE) {
    const data=await readFile(new URL(path === './' ? 'index.html' : path,root));
    assert.equal(integrity,`sha256-${createHash('sha256').update(data).digest('base64')}`,path);
  }
  assert.match(w.meta.VERSION,/^[a-f0-9]{16}$/);
});
test('cold navigation and every asset work with a network that throws', async () => {
  const w=await worker(); await w.dispatch('install'); await w.dispatch('activate'); w.setOffline();
  const networkBefore=w.networkCalls;
  const home=await w.dispatch('fetch',{request:getRequest('./?from=home')});
  assert.match(await home.text(),/id="planView"/);
  const index=await w.dispatch('fetch',{request:getRequest('./index.html?fresh=1')});
  assert.match(await index.text(),/id="taskList"/);
  for (const [path] of w.meta.PRECACHE) {
    const response=await w.dispatch('fetch',{request:getRequest(path,'same-origin')});
    assert.equal(response.status,200,path);
    assert.ok((await response.arrayBuffer()).byteLength>0,path);
  }
  assert.equal(w.networkCalls,networkBefore);
  assert.equal((await status(w)).ready,true);
  assert.equal(w.claimed,1);
});
test('missing file rejects installation without a partially cached shell', async () => {
  const w=await worker(); w.networkFiles.delete('https://example.test/planner/fonts/inter-cyrillic.woff2');
  await assert.rejects(w.dispatch('install'));
  assert.equal(w.cacheData.get(w.meta.CACHE_NAME).size,0);
  assert.equal((await status(w)).ready,false);
});
test('mixed deployment with changed JS rejects install and preserves previous cache', async () => {
  const w=await worker();
  w.cacheData.set(`${w.meta.CACHE_PREFIX}previous`,new Map([['previous',new Response('old working shell')]]));
  w.networkFiles.set('https://example.test/planner/script.js',Buffer.from('new incompatible script'));
  await assert.rejects(w.dispatch('install'),/Integrity mismatch/);
  assert.equal(w.cacheData.get(w.meta.CACHE_NAME).size,0);
  assert.equal(w.cacheData.has(`${w.meta.CACHE_PREFIX}previous`),true);
  assert.equal(w.skipped,0);
});
test('network failure during install keeps previous working cache', async () => {
  const w=await worker(); w.cacheData.set(`${w.meta.CACHE_PREFIX}old`,new Map()); w.setOffline();
  await assert.rejects(w.dispatch('install'),/offline/);
  assert.equal(w.cacheData.has(`${w.meta.CACHE_PREFIX}old`),true);
  assert.equal(w.skipped,0);
});
test('activation deletes only stale caches belonging to this app scope', async () => {
  const w=await worker(); await w.dispatch('install');
  for (const key of [`${w.meta.CACHE_PREFIX}old`,'poryadok-shell:/other/:old','another-app']) w.cacheData.set(key,new Map());
  await w.dispatch('activate');
  assert.equal(w.cacheData.has(`${w.meta.CACHE_PREFIX}old`),false);
  assert.equal(w.cacheData.has('poryadok-shell:/other/:old'),true);
  assert.equal(w.cacheData.has('another-app'),true);
  assert.equal(w.cacheData.has(w.meta.CACHE_NAME),true);
});
test('status detects eviction; repair recovers all resources atomically', async () => {
  const w=await worker(); await w.dispatch('install');
  w.cacheData.get(w.meta.CACHE_NAME).delete('https://example.test/planner/styles.css');
  const before=await status(w); assert.equal(before.ready,false); assert.equal(before.count,19);
  const after=await status(w,'REPAIR_CACHE'); assert.equal(after.ready,true); assert.equal(after.count,20);
});
test('failed repair reports incomplete cache without replacing good files', async () => {
  const w=await worker(); await w.dispatch('install');
  const data=w.cacheData.get(w.meta.CACHE_NAME); const before=await data.get('https://example.test/planner/script.js').clone().text();
  data.delete('https://example.test/planner/styles.css');
  w.networkFiles.set('https://example.test/planner/script.js',Buffer.from('incorrect version'));
  assert.equal((await status(w,'REPAIR_CACHE')).ready,false);
  assert.equal(await data.get('https://example.test/planner/script.js').clone().text(),before);
  assert.equal(data.has('https://example.test/planner/styles.css'),false);
});
test('non-GET, foreign origin, unrelated navigation and QA pages are not intercepted', async () => {
  const w=await worker(); await w.dispatch('install');
  for (const request of [getRequest('./','navigate','POST'),getRequest('https://other.test/'),getRequest('/other/'),getRequest('./tests/responsive.html'),getRequest('./unknown.js','same-origin')]) {
    assert.equal(await w.dispatch('fetch',{request}),undefined);
  }
});
test('cached assets with query strings do not need the network', async () => {
  const w=await worker(); await w.dispatch('install'); w.setOffline();
  assert.match(await (await w.dispatch('fetch',{request:getRequest('./core.js?v=1','same-origin')})).text(),/PlannerStorage/);
});
test('missing asset falls back to network and fails honestly when offline', async () => {
  const w=await worker(); await w.dispatch('install'); w.cacheData.get(w.meta.CACHE_NAME).delete('https://example.test/planner/quotes.js'); w.setOffline();
  await assert.rejects(w.dispatch('fetch',{request:getRequest('./quotes.js','same-origin')}),/offline/);
  assert.equal((await status(w)).ready,false);
});
test('update waits for explicit activation message', async () => {
  const w=await worker(); await w.dispatch('install'); assert.equal(w.skipped,0);
  await w.dispatch('message',{data:{type:'SKIP_WAITING'}}); assert.equal(w.skipped,1);
});
