const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

function harness(overrides = {}, locale = 'en') {
  const roots = new Map();
  const calls = [], toasts = [], saved = [];
  let native = [];
  function element(tag = 'div') {
    let text = '';
    return {
      tag, value: '', children: [], style: {}, attributes: {}, events: {}, hidden: false,
      get textContent() { return text; }, set textContent(value) { text = value; this.children = []; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); },
      addEventListener(name, handler) { this.events[name] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focused = true; },
      classList: { add() {}, remove() {}, toggle() {} },
    };
  }
  function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children) { const found = find(child, predicate); if (found) return found; }
  }
  const document = {
    documentElement: {},
    querySelector(selector) { if (!roots.has(selector)) roots.set(selector, element()); return roots.get(selector); },
    querySelectorAll() { return []; }, createElement: element,
    getElementById(id) { for (const root of roots.values()) { const found = find(root, node => node.id === id); if (found) return found; } return null; },
  };
  const bridge = {
    async restoreWorkspace() { return null; },
    async selectWorkspace() { calls.push(['select']); return { id: 'selected', path: '/original' }; },
    async listSessions() { return native; },
    async startSession(request) {
      calls.push(['start', request]);
      native = [{ sessionId: request.clientSessionId, phase: 'running', reaped: false, workspaceId: request.workspace, model: request.model, effort: request.effort, permission: request.permission }];
      return { model: request.model === 'default' ? 'gpt-new' : request.model };
    },
    async send(request) { calls.push(['send', request]); },
    async close(request) { calls.push(['close', request]); native = []; },
    ...overrides,
  };
  const context = {
    document, TextEncoder, URLSearchParams, crypto: { randomUUID }, toasts, saved, browsingHistory() { return false; },
    localStorage: { setItem() {} }, setTimeout() {}, clearTimeout() {},
    window: { __CLARITIDE_CCB__: bridge, location: { search: '?locale=' + locale }, setTimeout(callback) { callback(); }, confirm() { return true; } },
  };
  const bootstrap = `
    renderProjects = renderConversation = renderAttachments = renderActivity = syncControls = removeRunIndicator = appendRunIndicator = scrollConversation = autoSizePrompt = rememberDraft = function () {};
    showToast = function (text) { toasts.push(text); };
    save = function () { saved.push(JSON.stringify(state.projects)); return true; };
    recordEvent = function () {};
    browsingHistory = function () { return Boolean(state.testHistoryView); };
    appendMessage = function (role, text, time, persist, attachments) { if (persist) activeSession().messages.push({role, text, time, attachments}); return {textContent:text}; };
    window.testApi = { state, fillModels, setModel, chooseRecoveryModel, unavailableSelectedModel, runtimeContentForSession, ensureNativeSession, chooseRecoveryWorkspace, appendErrorCard, appendHistoryRecoveryCard, send, sameWorkspacePath, memoryAccountSnapshot };
  `;
  vm.runInNewContext(script.replace('void init();', bootstrap), context);
  const api = context.window.testApi;
  const session = { id: 'chat', model: 'gpt-old', effort: 'high', permission: 'controlled', messages: [], events: [] };
  const project = { id: 'project', name: 'Project', path: '/original', sessions: [session] };
  api.state.projects = [project]; api.state.activeProjectId = project.id; api.state.activeSessionId = session.id;
  api.state.storageReady = true; api.state.accountScope = 'account-test'; api.state.storageEpoch = 0;
  api.state.status = { available: true, allowedModels: ['gpt-old', 'gpt-new'], defaultModel: 'gpt-new', maxMessageBytes: 65536 };
  return { ...api, project, session, calls, toasts, saved, document, prompt: document.querySelector('#prompt'),
    node: selector => document.querySelector(selector), id: id => document.getElementById(id),
    button(text) { for (const root of roots.values()) { const found = find(root, node => node.tag === 'button' && node.textContent === text); if (found) return found; } },
  };
}
const bytes = value => new TextEncoder().encode(value).length;

function longChat() {
  return [
    { role: 'user', text: 'old-private-goal ' + '中'.repeat(23000) },
    { role: 'agent', text: 'old answer' },
    { role: 'user', text: 'recent question' },
    { role: 'agent', text: 'recent answer' },
  ];
}

test('authorization expiry and recovery preserve selected model and unsent draft', () => {
  const h = harness(); h.prompt.value = 'unfinished'; h.state.draftModel = 'draft-special';
  h.state.status = { available: false, allowedModels: [] };
  h.fillModels([]);
  assert.equal(h.session.model, 'gpt-old'); assert.equal(h.state.draftModel, 'draft-special');
  assert.equal(h.node('#modelSelect').value, 'gpt-old'); assert.equal(h.saved.length, 0);
  h.state.status = { available: true, allowedModels: ['gpt-old', 'gpt-new'], defaultModel: 'gpt-new' };
  h.fillModels(h.state.status.allowedModels);
  assert.equal(h.session.model, 'gpt-old'); assert.equal(h.prompt.value, 'unfinished'); assert.equal(h.saved.length, 0);
  h.state.activeSessionId = ''; h.fillModels([]);
  assert.equal(h.state.draftModel, 'draft-special', 'a new-chat choice is not changed by a status refresh either');
});

test('a genuinely removed model blocks startup and offers an explicit replacement', async () => {
  const h = harness(); h.prompt.value = 'continue'; h.state.status.allowedModels = ['gpt-new'];
  h.fillModels(['gpt-new']);
  assert.match(h.node('#modelSelect').children[0].textContent, /unavailable/);
  assert.equal(h.node('#modelSelect').children[0].disabled, true);
  await h.send();
  assert.equal(h.calls.length, 0); assert.equal(h.session.model, 'gpt-old'); assert.equal(h.prompt.value, 'continue');
  const choose = h.button('Choose an available model'); assert.ok(choose);
  await choose.events.click(); assert.equal(h.node('#modelEffortPopover').hidden, false);
  h.setModel('gpt-new');
  await h.send();
  assert.equal(h.calls.find(call => call[0] === 'start')[1].model, 'gpt-new');
});

for (const reload of ['same-account sign-in', 'workbench reload']) {
  test(reload + ' restores the saved project folder without opening the picker', async () => {
    const restoredPaths = [];
    const h = harness({
      async restoreWorkspace(request) {
        restoredPaths.push(request.path);
        return { id: 'fresh-native-grant', path: '/original' };
      },
      async selectWorkspace() { throw new Error('The approved folder must not require a picker'); },
    });
    h.session.runtimeSessionId = randomUUID();
    h.project.nativeWorkspace = { id: 'old-ephemeral-grant', path: '/original' };
    const saved = h.memoryAccountSnapshot();
    assert.equal(saved.projects[0].nativeWorkspace, undefined, 'UI storage is not a folder grant');
    h.state.projects = reload === 'workbench reload' ? JSON.parse(JSON.stringify(saved.projects)) : saved.projects;
    h.state.storageEpoch += 2;
    const restoredProject = h.state.projects[0];
    const previousSessionId = restoredProject.sessions[0].runtimeSessionId;
    assert.equal(await h.ensureNativeSession(), previousSessionId);
    assert.deepEqual(restoredPaths, ['/original']);
    assert.equal(h.calls[0][0], 'start');
    assert.equal(h.calls[0][1].workspace, 'fresh-native-grant');
    assert.equal(h.calls[0][1].resume, true);
    assert.equal(h.calls[0][1].permission, 'controlled');
    assert.equal(restoredProject.nativeWorkspace.id, 'fresh-native-grant');
  });
}

test('a folder without a native account grant falls back to explicit selection', async () => {
  let restores = 0;
  const h = harness({ async restoreWorkspace(request) {
    restores += 1;
    assert.deepEqual(Object.keys(request), ['path'], 'the caller cannot nominate another account');
    assert.equal(request.path, '/original');
    return null;
  } });
  await h.ensureNativeSession();
  assert.equal(restores, 1);
  assert.deepEqual(h.calls.map(([kind]) => kind), ['select', 'start']);
  assert.equal(h.project.nativeWorkspace.id, 'selected');
});

test('native workspace storage failure preserves the draft and does not open a picker', async () => {
  const h = harness({ async restoreWorkspace() { throw new Error('Workspace grant storage is unavailable'); } });
  h.prompt.value = 'Keep the pending request';
  h.state.attachments = [{ name: 'notes.txt', content: 'Keep the attachment' }];
  await h.send();
  assert.equal(h.calls.length, 0);
  assert.equal(h.prompt.value, 'Keep the pending request');
  assert.equal(h.state.attachments[0].content, 'Keep the attachment');
  assert.equal(h.project.path, '/original');
  assert.equal(h.session.messages.length, 0);
  assert.match(h.session.lastError.message, /Workspace grant storage is unavailable/);
});

for (const result of [undefined, { id: 'wrong-restored-grant', path: '/different' }]) {
  test('an invalid native restoration result cannot select or rebind a folder: ' + String(result && result.path), async () => {
    const h = harness({ async restoreWorkspace() { return result; } });
    await assert.rejects(h.ensureNativeSession(), /original project folder/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.project.path, '/original');
    assert.equal(h.project.nativeWorkspace, undefined);
  });
}

for (const change of ['account', 'chat']) {
  for (const result of [null, { id: 'late-native-grant', path: '/original' }]) {
    test('a late folder restoration after changing ' + change + ' cannot start or open a picker: ' + String(result && result.id), async () => {
      let resolve;
      const h = harness({ async restoreWorkspace() { return new Promise(done => { resolve = done; }); } });
      const pending = h.ensureNativeSession();
      for (let tick = 0; tick < 10 && !resolve; tick += 1) await Promise.resolve();
      assert.equal(typeof resolve, 'function');
      if (change === 'account') { h.state.accountScope = 'another-account'; h.state.storageEpoch += 1; }
      else h.state.activeSessionId = 'another-chat';
      resolve(result);
      await assert.rejects(pending, /active chat changed/);
      assert.equal(h.calls.length, 0);
      assert.equal(h.project.nativeWorkspace, undefined);
      assert.equal(h.session.runtimeSessionId, undefined);
    });
  }
}

test('cancelling selection after an unavailable grant keeps the original project and unsent input', async () => {
  let picks = 0;
  const h = harness({ async selectWorkspace() { picks += 1; return null; } });
  h.prompt.value = 'Keep this draft';
  h.state.attachments = [{ name: 'notes.txt', content: 'Keep these notes' }];
  await h.send();
  assert.equal(picks, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.prompt.value, 'Keep this draft');
  assert.equal(h.state.attachments[0].content, 'Keep these notes');
  assert.equal(h.session.messages.length, 0);
  assert.equal(h.project.path, '/original');
});

test('restoring the current native grant reuses its running session without closing or restarting it', async () => {
  const sessionId = randomUUID();
  let restores = 0;
  const h = harness({
    async restoreWorkspace() { restores += 1; return { id: 'current-grant', path: '/original' }; },
    async listSessions() { return [{ sessionId, phase: 'running', reaped: false, configurationCurrent: true,
      workspaceId: 'current-grant', permission: 'controlled', model: 'gpt-old', effort: 'high' }]; },
    async selectWorkspace() { throw new Error('Unexpected picker'); },
  });
  h.session.runtimeSessionId = sessionId;
  assert.equal(await h.ensureNativeSession(), sessionId);
  assert.equal(restores, 1);
  assert.equal(h.project.nativeWorkspace.id, 'current-grant');
  assert.equal(h.state.nativeSessionId, sessionId);
  assert.equal(h.calls.length, 0, 'restoration must not close, start, or send to the existing child');
});

test('an already selected native workspace does not need restoration or another picker', async () => {
  const h = harness({
    async restoreWorkspace() { throw new Error('Unexpected restoration'); },
    async selectWorkspace() { throw new Error('Unexpected picker'); },
  });
  h.project.nativeWorkspace = { id: 'current-grant', path: '/original' };
  await h.ensureNativeSession();
  assert.equal(h.calls[0][1].workspace, 'current-grant');
});

test('an older bridge without restoration still supports explicit folder selection', async () => {
  const h = harness({ restoreWorkspace: undefined });
  await h.ensureNativeSession();
  assert.deepEqual(h.calls.map(([kind]) => kind), ['select', 'start']);
});

test('a wrong folder leaves project metadata unchanged, then retry opens the picker again', async () => {
  const folders = [{ id: 'wrong', path: '/different' }, { id: 'right', path: '/original' }];
  let selections = 0;
  const h = harness({ async selectWorkspace() { return folders[selections++]; } });
  h.session.runtimeSessionId = randomUUID(); h.prompt.value = 'resume';
  await h.send();
  assert.equal(selections, 1); assert.equal(h.project.path, '/original'); assert.equal(h.project.nativeWorkspace, undefined);
  assert.equal(h.calls.length, 0); assert.equal(h.session.workspaceRecoveryNeeded, true);
  assert.ok(h.button('Choose the original folder'));
  await h.chooseRecoveryWorkspace(h.session.id);
  assert.equal(selections, 2); assert.equal(h.project.nativeWorkspace, undefined, 'picker success is not native resume success');
  await h.send();
  assert.equal(h.project.nativeWorkspace.id, 'right'); assert.equal(h.project.path, '/original');
  assert.equal(h.calls.find(call => call[0] === 'start')[1].resume, true);
  assert.equal(h.session.workspaceRecoveryNeeded, false);
});

test('native resume failure discards a candidate without changing the saved folder', async () => {
  let starts = 0, picks = 0;
  const h = harness({
    async selectWorkspace() { picks += 1; return { id: 'candidate-' + picks, path: '/original' }; },
    async startSession() { starts += 1; throw new Error('Native history could not be resumed'); },
  });
  h.session.runtimeSessionId = randomUUID();
  await assert.rejects(h.ensureNativeSession(), /could not be resumed/);
  assert.equal(h.project.path, '/original'); assert.equal(h.project.nativeWorkspace, undefined); assert.equal(h.saved.length, 0);
  await assert.rejects(h.ensureNativeSession(), /could not be resumed/);
  assert.equal(starts, 2); assert.equal(picks, 2);
});

test('cancelling or completing a folder picker after changing chats cannot rebind a project', async () => {
  let resolve;
  const h = harness({ async selectWorkspace() { return new Promise(done => { resolve = done; }); } });
  const choosing = h.chooseRecoveryWorkspace(h.session.id);
  h.state.activeSessionId = '';
  resolve({ id: 'late', path: '/original' }); await choosing;
  assert.equal(h.project.nativeWorkspace, undefined); assert.equal(h.state.workspaceRetryCandidate, undefined);
  h.state.activeSessionId = h.session.id;
  const cancelled = h.chooseRecoveryWorkspace(h.session.id); resolve(null); await cancelled;
  assert.equal(h.project.nativeWorkspace, undefined); assert.equal(h.project.path, '/original');
});

test('folder matching handles Windows canonical prefixes while keeping Unix case sensitive', () => {
  const h = harness();
  assert.equal(h.sameWorkspacePath('C:\\Users\\Person\\Code', '\\\\?\\c:\\users\\person\\code\\'), true);
  assert.equal(h.sameWorkspacePath('\\\\server\\share\\Code', '\\\\SERVER\\SHARE\\code'), true);
  assert.equal(h.sameWorkspacePath('UNC\\server\\share\\Code', '\\\\server\\share\\code'), true);
  assert.equal(h.sameWorkspacePath('/Code', '/code'), false);
});

test('long history opens an explicit recovery choice before any native work starts', async () => {
  const h = harness(); h.session.messages = longChat(); h.prompt.value = 'next';
  const original = JSON.stringify(h.session.messages);
  await h.send();
  assert.equal(h.calls.length, 0); assert.ok(h.id('historyRecoveryCard')); assert.equal(h.session.textContinuation, undefined);
  h.id('historyRecoveryRounds').value = '1'; h.id('historyRecoveryRounds').events.input();
  assert.equal(h.button('Use this context').disabled, false);
  h.button('Use this context').events.click();
  assert.equal(h.calls.length, 0, 'choosing context does not silently send');
  assert.equal(JSON.stringify(h.session.messages), original);
  await h.send();
  const sent = h.calls.find(call => call[0] === 'send')[1].content;
  assert.match(sent, /recent question/); assert.match(sent, /recent answer/); assert.doesNotMatch(sent, /old-private-goal/);
  assert.equal(h.session.messages[0].text, JSON.parse(original)[0].text);
  assert.equal(h.session.textContinuation, undefined, 'a later recovery must make a new choice');
});

test('handwritten summary is quoted verbatim and never replaces the original chat', async () => {
  const h = harness(); h.session.messages = longChat(); h.prompt.value = 'continue';
  await h.send();
  const mode = h.id('historyRecoveryMode'); mode.value = 'summary'; mode.events.change();
  assert.equal(h.button('Use this context').disabled, true);
  const summary = h.id('historyRecoverySummary'); summary.value = 'Goal: keep all user data. Next: migrate safely.'; summary.events.input();
  assert.equal(h.button('Use this context').disabled, false);
  h.button('Use this context').events.click();
  const content = h.runtimeContentForSession(h.session, 'continue', []);
  assert.match(content, /User-provided summary/); assert.match(content, /Goal: keep all user data/);
  assert.doesNotMatch(content, /old-private-goal/); assert.equal(h.session.messages.length, 4);
});

test('recent turns, summary, current request, and attachments share the exact UTF-8 limit', () => {
  const h = harness(); h.session.messages = longChat();
  const choice = { mode: 'recent', rounds: 1 };
  const files = [{ name: '中文.md', content: '附件内容' }];
  const content = h.runtimeContentForSession(h.session, '中文请求', files, choice);
  h.state.status.maxMessageBytes = bytes(content);
  assert.equal(h.runtimeContentForSession(h.session, '中文请求', files, choice), content);
  h.state.status.maxMessageBytes -= 1;
  assert.throws(() => h.runtimeContentForSession(h.session, '中文请求', files, choice), /exceed/);
  assert.throws(() => h.runtimeContentForSession(h.session, 'request', [], { mode: 'summary', summary: '中'.repeat(30000) }), /exceed/);
  assert.throws(() => h.runtimeContentForSession(h.session, 'request', [], { mode: 'recent', rounds: 0.5 }), /at least one/);
});

test('editing a request after choosing context rechecks the limit and keeps the choice and draft', async () => {
  const h = harness(); h.session.messages = longChat(); h.session.textContinuation = { mode: 'summary', summary: 'My short context.' };
  h.prompt.value = '中'.repeat(23000);
  await h.send();
  assert.equal(h.calls.length, 0); assert.equal(h.prompt.value.length, 23000);
  assert.equal(h.session.textContinuation.summary, 'My short context.'); assert.equal(h.id('historyRecoveryCard'), null);
  assert.match(h.toasts[0], /exceed/);
});

test('Chinese recovery actions explain the folder and long-chat choices', async () => {
  const h = harness({ async selectWorkspace() { return { id: 'wrong', path: '/different' }; } }, 'zh-CN');
  h.prompt.value = '继续'; await h.send();
  assert.ok(h.button('重新选择原文件夹')); assert.match(h.session.lastError.message, /原项目文件夹.*\/original/);
  h.session.messages = longChat(); await h.send();
  assert.ok(h.button('使用所选上下文')); assert.equal(h.id('historyRecoveryCard').attributes['aria-label'], '选择续接上下文');
});


test('changing chats while listing native sessions never starts the old chat', async () => {
  let resolve;
  const h = harness({ async listSessions() { return new Promise(done => { resolve = done; }); } });
  h.project.nativeWorkspace = { id: 'workspace', path: '/original' };
  const starting = h.ensureNativeSession();
  for (let i = 0; i < 6 && !resolve; i += 1) await Promise.resolve();
  assert.ok(resolve);
  h.state.activeSessionId = '';
  resolve([]);
  await assert.rejects(starting, /active chat changed/);
  assert.equal(h.calls.length, 0);
});


test('choosing a replacement model closes an idle native session and retains its resume ID', async () => {
  const h = harness(); h.prompt.value = 'continue';
  h.session.runtimeSessionId = randomUUID(); h.state.nativeSessionId = h.session.runtimeSessionId;
  h.state.status.allowedModels = ['gpt-new'];
  await h.send();
  await h.button('Choose an available model').events.click();
  assert.equal(h.calls[0][0], 'close');
  assert.equal(h.state.nativeSessionId, ''); assert.ok(h.session.runtimeSessionId);
  h.setModel('gpt-new'); await h.send();
  const request = h.calls.find(call => call[0] === 'start')[1];
  assert.equal(request.model, 'gpt-new'); assert.equal(request.resume, true);
});


test('authorization failures retain the native error and do not suggest a folder fix', async () => {
  const h = harness({ async startSession() { throw new Error('Online AI authorization expired'); } });
  h.prompt.value = 'continue';
  await h.send();
  assert.equal(h.session.lastError.message, 'Online AI authorization expired');
  assert.equal(h.session.workspaceRecoveryNeeded, false);
  assert.ok(h.button('Retry')); assert.equal(h.button('Choose the original folder'), undefined);
});


for (const [lock, value] of [['pendingSend', true], ['switchingConversation', true], ['testHistoryView', true], ['storageReady', false]]) {
  test('recovery actions cannot affect another task while ' + lock + '=' + value, async () => {
    const h = harness();
    h.session.workspaceRecoveryNeeded = true;
    h.state.attemptingResume = true;
    h.session.runtimeSessionId = randomUUID();
    h.session.lastFailedRequest = { text: 'old request', attachments: [] };
    h.state.nativeSessionId = 'other-task';
    h.appendErrorCard('Resume failed', false);
    h.state[lock] = value;
    await h.button('Choose the original folder').events.click();
    await h.button('Continue with saved chat text').events.click();
    await h.chooseRecoveryWorkspace(h.session.id);
    await h.chooseRecoveryModel(h.session.id);
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.nativeSessionId, 'other-task');
    assert.ok(h.session.runtimeSessionId);
    assert.equal(h.prompt.value, '');

    const context = harness(); context.session.messages = longChat(); context.prompt.value = 'continue';
    context.appendHistoryRecoveryCard(context.session, 'Too long');
    context.id('historyRecoveryRounds').value = '1'; context.id('historyRecoveryRounds').events.input();
    assert.equal(context.button('Use this context').disabled, false);
    context.state[lock] = value;
    context.button('Use this context').events.click();
    assert.equal(context.session.textContinuation, undefined);
    assert.equal(context.calls.length, 0);
  });
}

test('a stale request cannot capture a new account after waiting for native close', async () => {
  const h = harness();
  let release;
  h.state.closingPromise = new Promise(resolve => { release = resolve; });
  const pending = h.ensureNativeSession();
  h.state.storageEpoch += 1;
  h.state.nativeSessionId = 'new-account-session';
  release();
  await assert.rejects(pending, /active chat changed/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.nativeSessionId, 'new-account-session');
});

test('native startup returning after account replacement cannot mutate or close the new account', async () => {
  let release;
  const h = harness({ async startSession() { return new Promise(resolve => { release = resolve; }); } });
  h.project.nativeWorkspace = { id: 'old-workspace', path: '/original' };
  const pending = h.ensureNativeSession();
  for (let i = 0; i < 8 && !release; i += 1) await Promise.resolve();
  assert.ok(release);
  h.state.storageEpoch += 1;
  h.state.nativeSessionId = 'new-account-session';
  release({ model: 'gpt-old' });
  await assert.rejects(pending, /active chat changed/);
  assert.equal(h.state.nativeSessionId, 'new-account-session');
  assert.equal(h.session.runtimeSessionId, undefined);
  assert.equal(h.calls.filter(call => call[0] === 'close').length, 0);
  assert.equal(h.saved.length, 0);
});

test('an open context chooser revalidates an edited draft and attachments on apply', () => {
  const h = harness(); h.session.messages = longChat(); h.prompt.value = 'continue';
  h.appendHistoryRecoveryCard(h.session, 'Too long');
  h.id('historyRecoveryRounds').value = '1'; h.id('historyRecoveryRounds').events.input();
  assert.equal(h.button('Use this context').disabled, false);
  h.state.attachments = [{ name: 'large.txt', content: '中'.repeat(23000) }];
  h.button('Use this context').events.click();
  assert.equal(h.button('Use this context').disabled, true);
  assert.equal(h.session.textContinuation, undefined);
  h.state.attachments = [];
  h.prompt.value = 'updated request';
  h.button('Use this context').events.click();
  assert.equal(h.session.textContinuation.rounds, 1);
  assert.equal(h.prompt.value, 'updated request');
});
