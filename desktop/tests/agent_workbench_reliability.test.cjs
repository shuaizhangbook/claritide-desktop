const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

function harness(overrides = {}) {
  const elements = new Map();
  function element() {
    return {
      value: '', textContent: '', children: [], style: {}, classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener() {}, setAttribute() {}, remove() {}, focus() {},
    };
  }
  const document = {
    documentElement: {},
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    querySelectorAll() { return []; }, createElement: element, getElementById() { return null; },
  };
  const calls = [];
  let sessions = [];
  const bridge = {
    async listSessions() { return sessions; },
    async startSession(request) {
      calls.push(['start', request]);
      sessions = [{ sessionId: request.clientSessionId, phase: 'running', reaped: false, workspaceId: request.workspace, model: request.model, effort: request.effort, permission: request.permission }];
      return { model: request.model };
    },
    async send(request) { calls.push(['send', request]); },
    async close(request) { calls.push(['close', request]); sessions = []; },
    ...overrides,
  };
  const toasts = [];
  const context = { document, console, TextEncoder, URLSearchParams, crypto: { randomUUID }, localStorage: { setItem() {} }, setTimeout() {}, clearTimeout() {},
    window: { __CLARITIDE_CCB__: bridge, location: { search: '?locale=en' }, setTimeout(callback) { callback(); } }, toasts };
  // Run the production handlers unchanged; replace rendering only. This avoids
  // mounting the app or adding test-only hooks to the shipped local document.
  const bootstrap = `
    renderProjects = renderConversation = renderAttachments = syncControls = removeRunIndicator = appendRunIndicator = scrollConversation = function () {};
    showToast = function (text) { toasts.push(text); };
    appendErrorCard = function () {};
    recordEvent = function () {};
    appendMessage = function (role, text, time, persist, attachments) { if (persist) activeSession().messages.push({role, text, time, attachments}); return {textContent:text}; };
    window.testApi = { state, fillModels, runtimeContentForSession, ensureNativeSession, closeNativeSession, send, handleEvent };
  `;
  assert.ok(script.includes('void init();'));
  vm.runInNewContext(script.replace('void init();', bootstrap), context);
  const api = context.window.testApi;
  const session = { id: 'chat', model: 'gpt-test', effort: 'high', permission: 'controlled', messages: [], events: [] };
  api.state.projects = [{ id: 'project', name: 'Project', path: '/project', nativeWorkspace: { id: 'workspace', path: '/project' }, sessions: [session] }];
  api.state.storageReady = true; api.state.accountScope = 'acct_test'; api.state.storageEpoch = 1;
  api.state.runningProjectId = 'project'; api.state.runningSessionId = 'chat'; api.state.runStorageEpoch = 1;
  api.state.activeProjectId = 'project'; api.state.activeSessionId = 'chat';
  api.state.status = { available: true, allowedModels: ['gpt-test'], defaultModel: 'gpt-test', maxMessageBytes: 65536 };
  return { ...api, session, calls, toasts, prompt: document.querySelector('#prompt'), modelSelect: document.querySelector('#modelSelect'), setSessions(value) { sessions = value; } };
}

test('the default choice is preserved until native startup resolves it', () => {
  const h = harness(); h.session.model = 'default';
  h.state.status.defaultModel = 'gpt-other';
  h.fillModels(['gpt-test', 'gpt-other']);
  assert.deepEqual(h.modelSelect.children.map(option => option.value), ['default', 'gpt-test', 'gpt-other']);
  assert.equal(h.session.model, 'default');
  assert.match(h.modelSelect.children[0].textContent, /gpt-other|GPT-other/i);
});

test('UTF-8 message, attachments and legacy history are checked before starting CCB', async () => {
  const h = harness(); h.prompt.value = '中'.repeat(23000);
  await h.send();
  assert.equal(h.calls.length, 0); assert.equal(h.prompt.value.length, 23000);
  assert.match(h.toasts[0], /exceed/);
  h.session.messages = [{ role: 'user', text: 'Previous requirement' }];
  const content = h.runtimeContentForSession(h.session, 'Next request', [{name:'notes.txt', content:'notes'}]);
  assert.match(content, /Previous requirement/); assert.match(content, /Next request/); assert.match(content, /notes.txt/);
  h.session.nativeHistoryInitialized = true;
  assert.equal(h.runtimeContentForSession(h.session, 'Next request', []), 'Next request');
});

test('rejected send preserves draft, attachments and process; retry reuses the same process', async () => {
  let attempts = 0;
  const h = harness({ async send() { attempts += 1; if (attempts === 1) throw new Error('queue full'); } });
  h.prompt.value = 'Keep this draft'; h.state.attachments = [{ name: 'notes.txt', content: 'keep notes' }];
  await h.send();
  assert.equal(h.prompt.value, 'Keep this draft'); assert.equal(h.state.attachments.length, 1);
  assert.equal(h.session.messages.length, 0); assert.ok(h.state.nativeSessionId);
  await h.send();
  assert.equal(h.calls.filter(([kind]) => kind === 'start').length, 1);
  assert.equal(h.prompt.value, ''); assert.equal(h.state.attachments.length, 0);
  assert.equal(h.session.messages.length, 1); assert.equal(h.state.turnActive, true);
});

test('saved chats resume their exact native UUID; reaped entries are not reused', async () => {
  const h = harness(); h.session.runtimeSessionId = randomUUID();
  h.setSessions([{ sessionId: h.session.runtimeSessionId, phase: 'stopped', reaped: true }]);
  const id = await h.ensureNativeSession();
  assert.equal(id, h.session.runtimeSessionId); assert.equal(h.calls[0][1].resume, true);
});

test('reloaded controlled chat closes a previously full-access process before resuming', async () => {
  const h = harness(); h.session.runtimeSessionId = randomUUID();
  h.setSessions([{ sessionId: h.session.runtimeSessionId, phase: 'running', reaped: false, permission: 'full', model: 'gpt-test', effort: 'high', workspaceId: 'workspace' }]);
  await h.ensureNativeSession();
  assert.deepEqual(h.calls.map(([kind]) => kind), ['close', 'start']);
  assert.equal(h.calls[1][1].permission, 'controlled'); assert.equal(h.calls[1][1].resume, true);
});

test('failed close can be retried; it never permanently poisons the start queue', async () => {
  let attempts = 0;
  const h = harness({ async close() { attempts += 1; if (attempts === 1) throw new Error('temporary IPC failure'); } });
  h.state.nativeSessionId = 'closing';
  await assert.rejects(h.closeNativeSession(), /temporary/);
  await h.ensureNativeSession();
  assert.equal(attempts, 2); assert.equal(h.calls.filter(([kind]) => kind === 'start').length, 1);
});

test('stale events cannot mutate another chat and asynchronous stop rejection remains visible', () => {
  const h = harness(); h.state.nativeSessionId = 'current'; h.state.turnActive = true;
  h.handleEvent({ sessionId: 'old', type: 'error', payload: { terminal: true, message: 'old error' } });
  assert.equal(h.session.lastError, undefined); assert.equal(h.state.turnActive, true);
  h.handleEvent({ sessionId: 'current', type: 'error', payload: { code: 'interrupt_failed', terminal: false, message: 'Stop rejected' } });
  assert.equal(h.state.turnActive, true); assert.equal(h.toasts[0], 'Stop rejected');
});
