const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH || path.join(__dirname, '../workbench/agent-workbench.html'), 'utf8');
const helper = html.split('// BEGIN CLARITIDE_ACCOUNT_HISTORY_STORE')[1].split('// END CLARITIDE_ACCOUNT_HISTORY_STORE')[0];
const context = { setTimeout, clearTimeout, Set, Map, Promise };
vm.runInNewContext(helper + '\nthis.create = createAccountHistoryStore;', context);

// Small asynchronous IndexedDB test adapter: independent named databases,
// transaction commit/abort, request callbacks, and injected quota failures.
function indexedDBFixture() {
  const databases = new Map();
  const writes = [];
  let failWrite = false;
  let holdWrites = false;
  const pendingWrites = [];
  return {
    databases, writes, pendingWrites,
    failNextWrite() { failWrite = true; },
    holdWrites() { holdWrites = true; },
    releaseWrites() { holdWrites = false; pendingWrites.splice(0).forEach(fn => fn()); },
    open(name) {
      const request = {};
      setImmediate(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name);
        let closed = false;
        const db = {
          objectStoreNames: { contains(key) { return stores.has(key); } },
          createObjectStore(key) { stores.set(key, new Map()); },
          close() { closed = true; },
          transaction(names, mode) {
            if (closed) throw new Error('closed');
            let ended = false;
            const modifications = [];
            const reads = [];
            const tx = {
              abort() { if (ended) return; ended = true; setImmediate(() => tx.onabort?.()); },
              objectStore(key) {
                return {
                  getAll() { const req = {}; reads.push(() => { req.result = [...stores.get(key).values()].map(row => ({ ...row })); req.onsuccess?.(); }); return req; },
                  put(row) { modifications.push({ store: key, operation: 'put', row: { ...row } }); },
                  delete(id) { modifications.push({ store: key, operation: 'delete', key: id }); },
                };
              },
            };
            function finish() {
              if (ended) return;
              if (mode === 'readwrite' && failWrite) { failWrite = false; tx.error = new Error('QuotaExceededError'); tx.abort(); return; }
              reads.forEach(read => read());
              if (ended) return;
              modifications.forEach(change => {
                writes.push({ database: name, ...change });
                if (change.operation === 'put') stores.get(change.store).set(change.row.key, change.row);
                else stores.get(change.store).delete(change.key);
              });
              ended = true; tx.oncomplete?.();
            }
            setImmediate(() => { if (mode === 'readwrite' && holdWrites) pendingWrites.push(finish); else finish(); });
            return tx;
          },
        };
        request.result = db;
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}
function projects(text = 'A private conversation') {
  return [{ id: 'p', name: 'Project', path: 'C:/private', sessions: [
    { id: 'one', name: 'Chat one', messages: [{ role: 'user', text }] },
    { id: 'two', name: 'Chat two', messages: [{ role: 'agent', text: 'Unaffected' }] },
  ] }];
}
const composer = { activeProjectId: 'p', activeSessionId: 'one', drafts: { '["p","one"]': { text: 'unsent', attachments: [] } } };

test('two authenticated accounts never load each other’s chats or drafts', async () => {
  const idb = indexedDBFixture();
  const a = await context.create(idb, 'acct_alice'); await a.load();
  await a.save(projects(), composer); a.close();
  const b = await context.create(idb, 'acct_bob');
  assert.deepEqual(JSON.parse(JSON.stringify(await b.load())), { projects: [], composer: null });
  await b.save(projects('Bob only'), { drafts: {} }); b.close();
  const reopened = await context.create(idb, 'acct_alice');
  const saved = await reopened.load();
  assert.equal(saved.projects[0].sessions[0].messages[0].text, 'A private conversation');
  assert.equal(saved.composer.drafts['["p","one"]'].text, 'unsent');
  reopened.close();
});

test('incremental writes update only the changed conversation and delete only removed records', async () => {
  const idb = indexedDBFixture(); const store = await context.create(idb, 'acct_a'); await store.load();
  const data = projects(); await store.save(data, composer); idb.writes.length = 0;
  data[0].sessions[0].messages.push({ role: 'agent', text: 'Reply' });
  await store.save(data, composer);
  assert.equal(idb.writes.length, 1);
  assert.equal(idb.writes[0].store, 'sessions');
  assert.equal(idb.writes[0].row.key, '["p","one"]');
  idb.writes.length = 0; data[0].sessions.splice(0, 1); await store.save(data, composer);
  assert.deepEqual(idb.writes.map(item => [item.store, item.operation, item.key]), [['sessions', 'delete', '["p","one"]']]);
  store.close();
});

test('aborted transactions stay dirty and a retry persists the full failed change atomically', async () => {
  const idb = indexedDBFixture(); const store = await context.create(idb, 'acct_a'); await store.load();
  await store.save(projects(), composer);
  idb.failNextWrite();
  await assert.rejects(store.save(projects('Must survive retry'), composer), /QuotaExceededError/);
  await store.save(projects('Must survive retry'), composer); store.close();
  const reopened = await context.create(idb, 'acct_a');
  assert.equal((await reopened.load()).projects[0].sessions[0].messages[0].text, 'Must survive retry');
  reopened.close();
});

test('account switch aborts in-flight and queued writes without affecting the next account', async () => {
  const idb = indexedDBFixture(); const a = await context.create(idb, 'acct_a'); await a.load();
  idb.holdWrites();
  const first = a.save(projects('Before switch'), composer);
  const second = a.save(projects('Queued old account'), composer);
  const rejectedFirst = assert.rejects(first); const rejectedSecond = assert.rejects(second, /HISTORY_ACCOUNT_CHANGED/);
  await new Promise(resolve => setImmediate(resolve)); a.close(); idb.releaseWrites();
  await Promise.all([rejectedFirst, rejectedSecond]);
  const b = await context.create(idb, 'acct_b');
  assert.equal((await b.load()).projects.length, 0); b.close();
  assert.equal(idb.writes.length, 0);
});

test('corrupt saved records cannot be silently replaced with an empty chat list', async () => {
  const idb = indexedDBFixture(); const first = await context.create(idb, 'acct_a'); await first.load(); first.close();
  const db = idb.databases.get('claritide.agent.account.v1.acct_a');
  db.get('projects').set('p', { key: 'p', json: '{broken' });
  const store = await context.create(idb, 'acct_a');
  await assert.rejects(store.load());
  await assert.rejects(store.save([], { drafts: {} }), /HISTORY_NOT_LOADED/);
  assert.equal(db.get('projects').get('p').json, '{broken'); store.close();
});

test('missing or untrusted account scope never opens storage', async () => {
  const idb = indexedDBFixture();
  for (const scope of [null, '', '../alice', 'a'.repeat(129)]) await assert.rejects(context.create(idb, scope), /HISTORY_ACCOUNT_REQUIRED/);
  assert.equal(idb.databases.size, 0);
});

test('legacy history is detected without reading, parsing, assigning, or deleting its contents', () => {
  const begin = html.indexOf('      function showLegacyHistoryNotice()');
  const end = html.indexOf('      function resetAccountMemory()', begin);
  const nodes = new Map();
  const fixture = {
    STORAGE_KEY: 'claritide.agent.projects.v2', LEGACY_STORAGE_KEY: 'claritide.agent.projects.v1', DRAFT_STORAGE_KEY: 'claritide.agent.composer.v1', english: true,
    localStorage: { length: 1, key() { return 'claritide.agent.projects.v2'; }, getItem() { throw new Error('legacy body must not be read'); }, removeItem() { throw new Error('legacy must be preserved'); } },
    $(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
  };
  vm.runInNewContext(html.slice(begin, end) + '\nshowLegacyHistoryNotice();', fixture);
  assert.equal(nodes.get('#legacyHistoryNotice').hidden, false);
  assert.match(nodes.get('#legacyHistoryNotice').textContent, /preserved.*not been opened/);
});

function accountUIHarness(factory) {
  const source = html.slice(html.indexOf('      function verifiedScope('), html.indexOf('      function composerKey('));
  const nodes = new Map();
  const renders = [];
  const state = { accountScope: null, storageEpoch: 0, storageReady: false, storageLoading: false, storageClient: null, storageError: '', projects: [], composerDrafts: {}, accountSnapshots: {}, storageWriteSequence: 0, activeProjectId: '', activeSessionId: '' };
  const fixture = {
    state, english: true, recognition: null, ui: {}, clearTimeout, window: {},
    $(key) { if (!nodes.has(key)) nodes.set(key, { value: '', classList: { toggle() {} } }); return nodes.get(key); },
    createAccountHistoryStore: (_, scope) => factory(scope),
    renderProjects() { renders.push(state.projects.map(project => project.name)); },
    renderConversation() {}, renderAttachments() {}, renderActivity() {}, syncControls() {}, restoreDraft() {},
    resetRunningView() {}, closeMenus() {}, closeControlPopovers() {}, closeModal() {}, captureDraft() {},
    friendlyPath(value) { return value; }, normalizeSession(value) { return value; },
    loadComposerState(saved) { if (saved) { state.composerDrafts = saved.drafts || {}; state.activeProjectId = saved.activeProjectId || state.activeProjectId; state.activeSessionId = saved.activeSessionId || ''; } },
    composerSnapshot() { return { activeProjectId: state.activeProjectId, activeSessionId: state.activeSessionId, drafts: state.composerDrafts }; },
  };
  vm.runInNewContext(source + '\nthis.api = { synchronizeAccount, save };', fixture);
  return { ...fixture.api, state, nodes, renders };
}

test('late account A load cannot render over account B after a status change', async () => {
  let resolveA;
  let aClosed = false;
  const h = accountUIHarness(async scope => ({
    close() { if (scope === 'acct_a') aClosed = true; },
    async load() {
      if (scope === 'acct_a') return new Promise(resolve => { resolveA = resolve; });
      return { projects: [{ ...projects('Bob')[0], name: 'Bob' }], composer: null };
    },
    async save() {},
  }));
  const first = h.synchronizeAccount({ accountScope: 'acct_a' });
  for (let tick = 0; tick < 10 && !resolveA; tick += 1) await Promise.resolve();
  assert.equal(typeof resolveA, 'function');
  assert.equal(h.state.projects.length, 0);
  await h.synchronizeAccount({ accountScope: 'acct_b' });
  assert.equal(aClosed, true);
  resolveA({ projects: [{ ...projects('Alice')[0], name: 'Alice' }], composer: null }); await first;
  assert.equal(h.state.projects[0].name, 'Bob');
  assert.equal(h.renders.some(names => names.includes('Alice')), false);
});

test('logout clears every rendered record and restores unsaved data only after the same account returns', async () => {
  const h = accountUIHarness(async () => ({ close() {}, async load() { return { projects: [], composer: null }; }, async save() {} }));
  await h.synchronizeAccount({ accountScope: 'acct_a' });
  h.state.projects = projects('Unsaved Alice'); h.state.activeProjectId = 'p'; h.state.activeSessionId = 'one';
  h.state.composerDrafts = { '["p","one"]': { text: 'Secret draft', attachments: [] } };
  await h.synchronizeAccount({ accountScope: null });
  assert.equal(h.state.projects.length, 0); assert.equal(Object.keys(h.state.composerDrafts).length, 0);
  assert.equal(h.state.storageReady, false); assert.equal(h.nodes.get('#prompt').value, '');
  await h.synchronizeAccount({ accountScope: 'acct_b' });
  assert.equal(h.state.projects.length, 0);
  await h.synchronizeAccount({ accountScope: 'acct_a' });
  assert.equal(h.state.projects[0].sessions[0].messages[0].text, 'Unsaved Alice');
  assert.equal(h.state.composerDrafts['["p","one"]'].text, 'Secret draft');
});

test('failed history load exposes a persistent retry state and forbids creating replacement records', async () => {
  const h = accountUIHarness(async () => ({ close() {}, async load() { throw new Error('damaged database'); } }));
  await h.synchronizeAccount({ accountScope: 'acct_a' });
  assert.equal(h.state.storageReady, false);
  assert.match(h.state.storageError, /could not be loaded/);
  assert.equal(h.nodes.get('#retryHistory').hidden, false);
  assert.equal(h.nodes.get('#newProject').disabled, true);
  assert.equal(h.save(), false);
});

function uiFunction(name) {
  const start = html.search(new RegExp('      (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name + ' exists');
  const rest = html.slice(start + 1);
  const next = rest.search(/\n      (?:async )?function /);
  return next < 0 ? rest : html.slice(start, start + 1 + next);
}
function storageExitHarness(options = {}) {
  const nodes = new Map(); const calls = []; const toasts = [];
  const state = {
    storageReady: true, accountScope: 'acct_a', storageEpoch: 1, storageWriteSequence: 0,
    storageUnsaved: false, draftsUnsavedLimit: false, draftRevision: 0, statusRequestSequence: 0,
    projects: projects(), activeProjectId: 'p', activeSessionId: 'one', composerDrafts: {}, attachments: [], accountSnapshots: {},
    nativeSessionId: '', closingSessionId: '', closingPromise: Promise.resolve(), storageError: '', status: {},
    storageClient: { async save() { if (options.save) return options.save(); } },
  };
  const fixture = {
    state, english: true, TextEncoder, clearTimeout, setTimeout, Date, Promise,
    MAX_SAVED_DRAFTS: 20, MAX_DRAFT_BYTES: 256 * 1024, MAX_SAVED_DRAFT_BYTES: 1024 * 1024, TOTAL_FILE_LIMIT_BYTES: 64 * 1024,
    WORKSPACE_URL: '/my-day/',
    window: { confirm() { calls.push('confirm'); return options.confirm === true; }, location: { assign() { calls.push('navigate'); } }, setTimeout },
    bridge: {
      async close() { calls.push('close'); if (options.close) return options.close(); },
      async listSessions() { if (options.listSessions) return options.listSessions(); return []; },
      async getStatus() { return options.getStatus(); },
    },
    $(key) { if (!nodes.has(key)) nodes.set(key, { value: '', classList: { toggle() {}, remove() {} } }); return nodes.get(key); },
    friendlyPath(value) { return value; }, safeText(value) { return String(value || ''); }, tr(value) { return value; },
    showToast(value) { toasts.push(value); }, syncControls() {}, fillModels() { calls.push('models'); },
    async synchronizeAccount(status) { state.accountScope = status.accountScope; state.storageEpoch += 1; calls.push(status.accountScope); },
  };
  const names = ['verifiedScope', 'updateHistoryNotice', 'memoryAccountSnapshot', 'storageWarning', 'save', 'retryHistory', 'composerKey', 'copyAttachments', 'validStoredDraft', 'captureDraft', 'composerSnapshot', 'persistComposerState', 'rememberDraft', 'closeNativeSession', 'returnToWorkspace', 'refreshRuntimeStatus'];
  vm.runInNewContext(names.map(uiFunction).join('\n') + '\nthis.api = { save, rememberDraft, returnToWorkspace, closeNativeSession, refreshRuntimeStatus, retryHistory };', fixture);
  return { ...fixture.api, state, calls, nodes, toasts, prompt: fixture.$('#prompt') };
}

test('successful partial saves keep oversized draft warning, export action, and leave confirmation', async () => {
  const h = storageExitHarness(); h.prompt.value = '中'.repeat(100000);
  await h.rememberDraft(true);
  assert.equal(h.state.storageError, '');
  assert.equal(h.state.draftsUnsavedLimit, true);
  assert.equal(h.nodes.get('#storageNotice').hidden, false);
  assert.equal(h.nodes.get('#exportHistory').hidden, false);
  await h.returnToWorkspace();
  assert.deepEqual(h.calls, ['confirm']);
  assert.equal(h.prompt.value.length, 100000);
});

test('recovered unsaved account data remains protected when the database cannot be reopened', async () => {
  const h = storageExitHarness(); h.state.storageReady = false; h.state.storageUnsaved = true;
  h.state.storageError = 'Saved chats could not be loaded';
  await h.returnToWorkspace();
  assert.deepEqual(h.calls, ['confirm']);
  assert.equal(h.state.projects[0].sessions[0].messages[0].text, 'A private conversation');
});

test('a save finishing after a newer unsent edit cannot mark that edit as saved', async () => {
  let accept; const h = storageExitHarness({ save: () => new Promise(resolve => { accept = resolve; }) });
  h.prompt.value = 'First'; const saving = h.rememberDraft(true);
  h.prompt.value = 'Later unsaved edit'; h.rememberDraft(false);
  clearTimeout(h.state.draftSaveTimer);
  accept(); await saving;
  assert.equal(h.state.storageUnsaved, true);
});

test('a stale runtime status response cannot switch the active account back after a newer retry', async () => {
  let returnOld; let requests = 0;
  const h = storageExitHarness({ getStatus: () => ++requests === 1 ? new Promise(resolve => { returnOld = resolve; }) : { accountScope: 'acct_b', available: true } });
  const refresh = h.refreshRuntimeStatus();
  h.state.storageReady = false;
  await h.retryHistory();
  assert.equal(h.state.accountScope, 'acct_b');
  returnOld({ accountScope: 'acct_a', available: true }); await refresh;
  assert.equal(h.state.accountScope, 'acct_b');
  assert.equal(h.state.status.accountScope, 'acct_b');
  assert.equal(h.calls.includes('acct_a'), false);
});

test('old close completion cannot clear a new account cleanup target or show its errors there', async () => {
  let finish; const h = storageExitHarness({ listSessions: () => new Promise(resolve => { finish = resolve; }) });
  h.state.nativeSessionId = 'native-a'; const closing = h.closeNativeSession();
  for (let turn = 0; turn < 10 && !finish; turn += 1) await Promise.resolve();
  assert.equal(typeof finish, 'function');
  h.state.storageEpoch += 1; h.state.accountScope = 'acct_b'; h.state.closingSessionId = 'native-b';
  finish([]); await closing;
  assert.equal(h.state.closingSessionId, 'native-b');
  assert.equal(h.toasts.length, 0);
});
