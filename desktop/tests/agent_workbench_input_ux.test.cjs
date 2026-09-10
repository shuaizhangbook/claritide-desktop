const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const projectKey = 'test.account.projects';
const draftKey = 'test.account.composer';

function harness(options = {}) {
  const elements = new Map();
  const frames = [];
  const storage = options.storage || new Map();
  const calls = [];
  const toasts = [];
  const confirmations = [];
  function element() {
    return {
      value: '', textContent: '', children: [], style: {}, hidden: false,
      scrollTop: 0, scrollHeight: 1000, clientHeight: 300,
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener() {}, setAttribute() {}, remove() {}, focus() {},
    };
  }
  const document = {
    documentElement: {},
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    querySelectorAll() { return []; }, createElement: element, getElementById() { return null; },
  };
  const bridge = {
    async listSessions() { return []; },
    async startSession(request) { calls.push(['start', request]); return { model: request.model }; },
    async send(request) { calls.push(['send', request]); if (options.send) return options.send(request); },
    async close(request) { calls.push(['close', request]); },
    async stop(request) { calls.push(['stop', request]); },
  };
  const context = {
    document, console, TextEncoder, URLSearchParams, crypto: { randomUUID },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { if (options.storageFailure) throw new Error('QuotaExceededError'); storage.set(key, value); },
    },
    setTimeout() { return 1; }, clearTimeout() {}, requestAnimationFrame(callback) { frames.push(callback); },
    window: {
      __CLARITIDE_CCB__: bridge, location: { search: '?locale=en' },
      setTimeout(callback) { callback(); },
      confirm(message) { confirmations.push(message); return options.confirm !== false; },
    }, toasts,
  };
  const bootstrap = `
    renderProjects = renderConversation = renderAttachments = renderActivity = syncControls = removeRunIndicator = appendRunIndicator = function () {};
    showToast = function (text) { toasts.push(text); };
    appendErrorCard = function () {};
    recordEvent = function () {};
    appendMessage = function (role, text, time, persist, attachments) { if (persist) activeSession().messages.push({role, text, time, attachments}); return {textContent:text}; };
    window.testApi = { ui, state, load, save, rememberDraft, restoreDraft, persistComposerState, selectProject, selectSession, newConversation, ensureConversation, deleteSession, deleteProject, retryFailedRequest, send, onSendClick, onPromptKeydown, onConversationScroll, scrollConversation, addFiles, handleEvent };
  `;
  vm.runInNewContext(script.replace('void init();', bootstrap), context);
  const api = context.window.testApi;
  function session(id) { return { id, name: id, model: 'gpt-test', effort: 'high', permission: 'controlled', messages: [], events: [] }; }
  api.state.projects = [
    { id: 'project-a', name: 'A', path: '/a', nativeWorkspace: { id: 'workspace-a', path: '/a' }, sessions: [session('chat-a'), session('chat-b')] },
    { id: 'project-b', name: 'B', path: '/b', nativeWorkspace: { id: 'workspace-b', path: '/b' }, sessions: [session('chat-c')] },
  ];
  api.state.activeProjectId = 'project-a'; api.state.activeSessionId = 'chat-a';
  api.state.storageReady = true; api.state.accountScope = 'acct_test'; api.state.storageEpoch = 1;
  api.state.storageClient = {
    async save(projects, composer) {
      if (options.storageFailure) throw new Error('QuotaExceededError');
      storage.set(projectKey, JSON.stringify(projects)); storage.set(draftKey, JSON.stringify(composer));
    },
  };
  api.state.status = { available: true, allowedModels: ['gpt-test'], defaultModel: 'gpt-test', maxMessageBytes: 65536 };
  return { ...api, calls, toasts, storage, confirmations, prompt: document.querySelector('#prompt'), element: selector => document.querySelector(selector), flushFrames() { while (frames.length) frames.shift()(); } };
}
const plain = value => JSON.parse(JSON.stringify(value));
const file = (name, content) => ({ name, content, size: new TextEncoder().encode(content).length });

test('new chat closes an open narrow sidebar only when switching is allowed', () => {
  const h = harness();
  h.ui.narrow = true; h.ui.sidebarOpen = true; h.element('.main').inert = true;
  h.state.turnActive = true;
  h.newConversation();
  assert.equal(h.ui.sidebarOpen, true);
  assert.equal(h.state.activeSessionId, 'chat-a');
  h.state.turnActive = false;
  h.newConversation();
  assert.equal(h.ui.sidebarOpen, false);
  assert.equal(h.element('.main').inert, false);
  assert.equal(h.element('#workspaceSidebar').inert, true);
  assert.equal(h.state.activeSessionId, '');
});

function keyEvent(overrides = {}) {
  return { key: 'Enter', shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...overrides };
}

test('IME confirmation and Shift+Enter never submit or stop; active Enter keeps a manual draft', async () => {
  const h = harness(); h.prompt.value = '中文候选';
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
    const event = keyEvent(extra); h.onPromptKeydown(event); assert.equal(event.prevented, false);
  }
  assert.equal(h.calls.length, 0);
  h.state.nativeSessionId = 'native'; h.state.turnActive = true;
  const event = keyEvent(); h.onPromptKeydown(event);
  await h.send();
  assert.equal(event.prevented, true); assert.equal(h.prompt.value, '中文候选'); assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse(h.storage.get(draftKey)).drafts['["project-a","chat-a"]'].text, '中文候选');
  h.state.turnActive = false;
  await Promise.resolve(); assert.equal(h.calls.length, 0, 'finishing a task does not secretly queue the draft');
  h.state.turnActive = true; await h.onSendClick();
  assert.deepEqual(h.calls.map(call => call[0]), ['stop']);
});

test('draft text and text attachments are isolated across chats, projects and new chat', () => {
  const h = harness(); h.prompt.value = 'Only A'; h.state.attachments = [file('a.md', 'A notes')];
  h.selectSession('project-a', 'chat-b');
  assert.equal(h.prompt.value, ''); assert.equal(h.state.attachments.length, 0);
  h.prompt.value = 'Only B'; h.newConversation();
  assert.equal(h.prompt.value, ''); h.prompt.value = 'New A task';
  h.selectProject('project-b'); assert.equal(h.prompt.value, ''); h.prompt.value = 'New B task';
  h.selectSession('project-a', 'chat-a');
  assert.equal(h.prompt.value, 'Only A'); assert.deepEqual(plain(h.state.attachments), [file('a.md', 'A notes')]);
  h.selectSession('project-a', 'chat-b'); assert.equal(h.prompt.value, 'Only B');
  h.newConversation(); assert.equal(h.prompt.value, 'New A task');
  h.selectProject('project-b'); assert.equal(h.prompt.value, 'New B task');
});

test('reload restores the last selected chat and drafts without restoring full-access permission', () => {
  const h = harness(); h.selectSession('project-b', 'chat-c');
  h.state.projects[1].sessions[0].permission = 'full';
  h.prompt.value = 'Continue this later'; h.state.attachments = [file('brief.txt', '中文内容')];
  h.rememberDraft(true); h.save();
  const reloaded = harness({ storage: h.storage }); reloaded.load({ projects: JSON.parse(h.storage.get(projectKey)), composer: JSON.parse(h.storage.get(draftKey)) }); reloaded.restoreDraft();
  assert.equal(reloaded.state.activeProjectId, 'project-b'); assert.equal(reloaded.state.activeSessionId, 'chat-c');
  assert.equal(reloaded.prompt.value, 'Continue this later'); assert.deepEqual(plain(reloaded.state.attachments), [file('brief.txt', '中文内容')]);
  assert.equal(reloaded.state.projects[1].sessions[0].permission, 'controlled');
});

test('the first send moves a project draft to its created chat and consumes only the accepted input', async () => {
  let accept; const h = harness({ send: () => new Promise(resolve => { accept = resolve; }) });
  h.newConversation(); h.prompt.value = 'First task'; h.state.attachments = [file('first.txt', 'first')];
  const sending = h.send();
  for (let i = 0; i < 10 && !accept; i += 1) await Promise.resolve();
  assert.ok(accept); h.prompt.value = 'Next task typed during startup';
  accept(); await sending;
  assert.equal(h.prompt.value, 'Next task typed during startup'); assert.equal(h.state.attachments.length, 0);
  assert.equal(h.state.turnActive, true);
  const saved = JSON.parse(h.storage.get(draftKey));
  assert.equal(saved.drafts['["project-a",""]'], undefined);
  assert.equal(saved.drafts[JSON.stringify(['project-a', h.state.activeSessionId])].text, 'Next task typed during startup');
});

test('retry restores the selected chat failed request and attachments, never another chat input', async () => {
  const h = harness({ send: async () => { throw new Error('Native queue rejected'); } });
  h.prompt.value = 'Failed A'; h.state.attachments = [file('a.txt', 'attachment A')]; await h.send();
  h.selectSession('project-a', 'chat-b'); h.prompt.value = 'B draft';
  h.retryFailedRequest('chat-a'); assert.equal(h.prompt.value, 'B draft');
  h.selectSession('project-a', 'chat-a'); h.prompt.value = 'Replacement draft'; h.state.attachments = [];
  h.retryFailedRequest('chat-a');
  assert.equal(h.prompt.value, 'Failed A'); assert.deepEqual(plain(h.state.attachments), [file('a.txt', 'attachment A')]);
  assert.equal(h.confirmations.length, 1); assert.equal(h.calls.filter(call => call[0] === 'send').length, 1);
});

test('declining retry replacement preserves the current draft', () => {
  const h = harness({ confirm: false });
  h.state.projects[0].sessions[0].lastFailedRequest = { text: 'Failed text', attachments: [] };
  h.prompt.value = 'New important text'; h.retryFailedRequest('chat-a');
  assert.equal(h.prompt.value, 'New important text');
});

test('storage errors do not fail an accepted send or erase live drafts and stay visibly recoverable', async () => {
  const h = harness({ storageFailure: true }); h.prompt.value = 'Keep working';
  await h.send();
  assert.equal(h.state.turnActive, true); assert.equal(h.prompt.value, '');
  assert.equal(h.state.projects[0].sessions[0].lastError, null);
  h.prompt.value = 'Unsaved next task'; await h.rememberDraft(true); h.save(); await h.state.storagePending;
  assert.equal(h.prompt.value, 'Unsaved next task');
  assert.equal(h.element('#storageNotice').hidden, false);
  assert.match(h.element('#storageNoticeText').textContent, /not saved/);
  assert.equal(h.element('#exportHistory').hidden, false);
});

test('malformed stored drafts do not invalidate existing chats and oversized text remains live', () => {
  const h = harness(); h.save(); h.load({ projects: JSON.parse(h.storage.get(projectKey)), composer: '{bad json' });
  assert.equal(h.state.projects.length, 2);
  h.prompt.value = '中'.repeat(100000); h.rememberDraft(true);
  assert.equal(h.prompt.value.length, 100000); assert.equal(Object.keys(JSON.parse(h.storage.get(draftKey)).drafts).length, 0);
  assert.ok(h.toasts.some(text => /storage limit/.test(text)));
});

test('persistent drafts are bounded by count and bytes while live recent drafts remain usable', () => {
  const h = harness();
  for (let i = 0; i < 30; i += 1) h.state.composerDrafts['key-' + i] = { text: 't'.repeat(60000), attachments: [], updatedAt: i };
  h.persistComposerState();
  const saved = JSON.parse(h.storage.get(draftKey));
  assert.ok(Object.keys(saved.drafts).length <= 20);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved.drafts)).length < 1024 * 1024);
  assert.ok(saved.drafts['key-29']); assert.equal(Object.keys(h.state.composerDrafts).length, 30);
});

test('scrolling up pauses stream following even with a queued frame; explicit return resumes', () => {
  const h = harness(); const conversation = h.element('#conversation');
  h.scrollConversation();
  conversation.scrollTop = 120; h.onConversationScroll(); h.flushFrames();
  assert.equal(conversation.scrollTop, 120); assert.equal(h.element('#backToLatest').hidden, false);
  conversation.scrollHeight = 1600; h.scrollConversation(); h.flushFrames(); assert.equal(conversation.scrollTop, 120);
  h.scrollConversation(true); h.flushFrames(); assert.equal(conversation.scrollTop, 1600); assert.equal(h.element('#backToLatest').hidden, true);
  conversation.scrollTop = 1290; h.onConversationScroll(); assert.equal(h.state.followConversation, true);
});

test('a file read that finishes after changing chats cannot attach to the new chat', async () => {
  let finish; const h = harness();
  const adding = h.addFiles([{ name: 'old.txt', size: 3, text: () => new Promise(resolve => { finish = resolve; }) }]);
  h.selectSession('project-a', 'chat-b'); finish('old'); await adding;
  assert.equal(h.state.attachments.length, 0);
});

test('deleting selected chat restores the project draft and removes only that chat draft', async () => {
  const h = harness(); h.newConversation(); h.prompt.value = 'Project draft';
  h.selectSession('project-a', 'chat-a'); h.prompt.value = 'Chat A draft';
  await h.deleteSession('chat-a');
  assert.equal(h.prompt.value, 'Project draft');
  assert.equal(JSON.parse(h.storage.get(draftKey)).drafts['["project-a","chat-a"]'], undefined);
});
