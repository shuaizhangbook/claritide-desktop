const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH || path.join(__dirname, '../workbench/agent-workbench.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const nodes = new Map(), calls = [], drawn = [], toasts = [], approvals = [];
  function node() {
    return { value: '', _text: '', hidden: false, disabled: false, style: {}, children: [], listeners: {}, attributes: {},
      get textContent() { return this._text; },
      set textContent(value) { this._text = value; this.children.forEach(child => { child.parentNode = null; }); this.children = []; },
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      addEventListener(kind, callback) { this.listeners[kind] = callback; },
      setAttribute(key, value) { this.attributes[key] = String(value); }, getAttribute(key) { return this.attributes[key]; }, removeAttribute(key) { delete this.attributes[key]; }, focus() {},
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; },
      querySelectorAll(selector) {
        const matches = child => selector[0] === '#' ? child.id === selector.slice(1) : String(child.className || '').split(/\s+/).includes(selector.slice(1));
        return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    };
  }
  let streamingBody = null;
  const document = {
    documentElement: {},
    querySelector(selector) {
      if (selector === '#conversationInner .message.agent:last-of-type .message-body') return streamingBody;
      if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector);
    }, querySelectorAll() { return []; }, createElement: node, createElementNS: node,
    getElementById(id) { for (const item of nodes.values()) { const found = item.querySelector('#' + id); if (found) return found; } return null; },
  };
  const storage = new Map();
  const context = {
    document, TextEncoder, URLSearchParams, crypto: { randomUUID }, calls, drawn, toasts, approvals,
    localStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, value); } },
    setTimeout() { return 1; }, clearTimeout() {}, requestAnimationFrame() {},
    window: { location: { search: '?locale=en' }, setTimeout(callback) { callback(); },
      __CLARITIDE_CCB__: {
        async listSessions() { return []; },
        async startSession(request) { calls.push(['start', request]); return { model: request.model }; },
        async send(request) { calls.push(['send', request]); if (options.send) return options.send(request); },
        async close(request) { calls.push(['close', request]); if (options.close) return options.close(request); },
        async stop(request) { calls.push(['stop', request]); },
        async respondToApproval(request) { calls.push(['approval', request]); return options.respondToApproval(request); },
      },
    },
    drawMessage(role, text, time, persist, attachments) {
      const body = node(); body.textContent = text;
      drawn.push({ role, text }); if (role === 'agent') streamingBody = body;
      if (persist) context.window.testApi.activeSession().messages.push({ role, text, time, attachments });
      return body;
    },
  };
  vm.runInNewContext(script.replace('void init();', `
    ${options.realUI ? '' : 'renderProjects = renderActivity = function () {};'}
    renderAttachments = scrollConversation = removeRunIndicator = function () {};
    appendRunIndicator = updateRunIndicator = function (text) { drawn.push({ indicator: text }); };
    appendMessage = drawMessage;
    renderAnswer = function (body, text) { body._streaming = false; body.textContent = text; drawn.push({ final: text }); };
    appendResultCard = function (result) { drawn.push({ result: result }); };
    appendErrorCard = function (message) { drawn.push({ error: message }); };
    ${options.realApproval ? '' : 'renderApproval = function (approval) { approvals.push(approval.requestId); };'}
    showToast = function (text) { toasts.push(text); };
    window.testApi = { state, activeSession, send, stop, selectProject, selectSession, continueViewedSession, returnToRunningSession,
      handleEvent, runningSession, browsingHistory, historyProjects, syncControls, renderConversation, resetRunningView,
      renderProjects, renderActivity, openActivity, recordEvent, resetAccountMemory, taskRuns: ClaritideTaskRuns,
      ${options.realUI ? 'bindActivityDetails, activityEvents,' : ''} };
  `), context);
  const api = context.window.testApi;
  const session = (id, time) => ({ id, name: id, model: 'gpt-test', effort: 'high', permission: 'controlled', messages: [], events: [], updatedAt: time });
  const a = session('chat-a', 100), b = session('chat-b', 300), c = session('chat-c', 200);
  api.state.projects = [
    { id: 'project-a', name: 'Alpha', path: '/a', nativeWorkspace: { id: 'workspace-a', path: '/a' }, sessions: [a, b] },
    { id: 'project-b', name: 'Beta', path: '/b', nativeWorkspace: { id: 'workspace-b', path: '/b' }, sessions: [c] },
  ];
  Object.assign(api.state, { activeProjectId: 'project-a', activeSessionId: 'chat-a', storageReady: true, accountScope: 'account-a', storageEpoch: 1,
    status: { available: true, allowedModels: ['gpt-test'], maxMessageBytes: 65536 } });
  function running() {
    Object.assign(api.state, { nativeSessionId: 'native-a', runningProjectId: 'project-a', runningSessionId: 'chat-a', runStorageEpoch: 1, turnActive: true });
  }
  return { ...api, a, b, c, running, calls, drawn, approvals, toasts, byId: id => document.getElementById(id), element: selector => document.querySelector(selector), prompt: document.querySelector('#prompt') };
}

test('background output and activity stay with the running chat while other histories are browsed', () => {
  const h = harness(); h.running();
  h.handleEvent({ sessionId: 'native-a', type: 'text_delta', payload: { text: 'First ' } });
  h.selectSession('project-b', 'chat-c');
  h.drawn.length = 0;
  h.handleEvent({ sessionId: 'native-a', type: 'text_delta', payload: { text: 'second' } });
  h.handleEvent({ sessionId: 'native-a', type: 'tool_started', payload: { tool: 'Read' } });
  assert.equal(h.state.runningStream, 'First second');
  assert.equal(h.drawn.length, 0, 'background text and indicators never appear in the viewed history');
  assert.equal(h.a.events.at(-1).kind, 'tool_started'); assert.equal(h.c.events.length, 0);
  assert.equal(h.calls.filter(([kind]) => kind === 'close').length, 0);
  h.returnToRunningSession();
  assert.equal(h.state.activeSessionId, 'chat-a'); assert.ok(h.drawn.some(item => item.role === 'agent'));
  assert.equal(h.element('#conversationInner .message.agent:last-of-type .message-body').textContent, 'First second');
  h.selectSession('project-a', 'chat-b'); h.drawn.length = 0;
  h.handleEvent({ sessionId: 'native-a', type: 'assistant_final', payload: { text: 'Final answer' } });
  assert.equal(h.a.messages.at(-1).text, 'Final answer'); assert.equal(h.b.messages.length, 0); assert.equal(h.drawn.length, 0);
});

test('folder toggles expand independently without switching or stopping the running chat', () => {
  const h = harness({ realUI: true }); h.running(); h.renderProjects();
  const projects = () => h.element('#projectList').children;
  const toggle = index => projects()[index].querySelector('.project-toggle');
  const list = index => projects()[index].querySelector('.session-list');
  assert.equal(toggle(0).getAttribute('aria-expanded'), 'true');
  toggle(0).listeners.click();
  assert.equal(list(0).hidden, true);
  toggle(1).listeners.click();
  assert.equal(list(1).hidden, false); assert.equal(list(0).hidden, true);
  assert.equal(h.state.activeSessionId, 'chat-a'); assert.equal(h.state.turnActive, true);
  assert.deepEqual(h.calls, []);
  h.renderProjects(); assert.equal(list(0).hidden, true, 'stream rerenders retain the fold');
  h.element('#historySearch').value = 'alpha'; h.renderProjects();
  assert.equal(list(0).hidden, false); assert.equal(toggle(0).disabled, true);
  h.element('#historySearch').value = ''; h.renderProjects(); assert.equal(list(0).hidden, true);
});

test('details default to the latest task and count only its events; chat history is explicit', () => {
  const h = harness({ realUI: true });
  h.taskRuns.start(h.a, 'run-old', 'Old request', 100);
  h.recordEvent('task_started', { message: 'Old request' }, 100);
  h.recordEvent('tool_started', { tool: 'Old tool' }, 101);
  h.taskRuns.update(h.a, 'turn_completed', {}, 110);
  h.taskRuns.start(h.a, 'run-new', 'New request', 200);
  h.recordEvent('task_started', { message: 'New request' }, 200);
  h.recordEvent('tool_started', { tool: 'New tool' }, 201);
  h.openActivity();
  assert.equal(h.element('#eventCount').textContent, '2 items');
  assert.equal(h.element('#eventLog').querySelectorAll('.task-summary').length, 1);
  assert.equal(h.element('#eventLog').querySelector('.task-goal').textContent, 'New request');
  assert.deepEqual(Array.from(h.activityEvents(h.a, 'run-new'), e => e.payload.tool || e.payload.message), ['New request', 'New tool']);
  h.openActivity('all');
  assert.equal(h.element('#eventCount').textContent, '4 items');
  assert.equal(h.element('#eventLog').querySelectorAll('.task-summary').length, 2);
});

test('a details button remains bound to its own run and cannot open records after switching owner', () => {
  const h = harness({ realUI: true });
  h.taskRuns.start(h.a, 'run-old', 'Old request', 100);
  const button = h.element('#testDetails'); h.bindActivityDetails(button);
  h.taskRuns.update(h.a, 'turn_completed', {}, 110);
  h.taskRuns.start(h.a, 'run-new', 'New request', 200);
  button.listeners.click();
  assert.equal(h.element('#eventLog').querySelector('.task-goal').textContent, 'Old request');
  h.state.activeSessionId = h.b.id; h.renderActivity();
  button.listeners.click(); assert.equal(h.element('#eventLog').querySelectorAll('.task-summary').length, 0);
  h.state.activeSessionId = h.a.id; h.state.storageEpoch += 1; h.openActivity('run-new');
  button.listeners.click(); assert.equal(h.element('#activityScope').value, 'run-new');
});

test('legacy events use confirmed start boundaries and never guess orphaned or ambiguous records', () => {
  const h = harness({ realUI: true });
  const old = h.taskRuns.start(h.a, 'old', 'Same request', 100); old.status = 'finished'; old.endedAt = 150;
  const current = h.taskRuns.start(h.a, 'current', 'Same request', 200);
  const event = (kind, time, payload = {}) => ({ kind, time, payload });
  h.a.events = [event('tool_completed', 90), event('task_started', 100), event('tool_started', 101),
    event('turn_completed', 150), event('session_started', 190), event('task_started', 200), event('tool_started', 201)];
  assert.deepEqual(Array.from(h.activityEvents(h.a, 'current'), e => e.time), [200, 201]);
  assert.deepEqual(Array.from(h.activityEvents(h.a, 'old'), e => e.time), [100, 101, 150]);
  h.a.events = h.a.events.slice(-1);
  assert.equal(h.activityEvents(h.a, 'current').length, 0, 'missing start markers do not leak old events');
  assert.equal(h.activityEvents(h.a, 'all').length, 1);
  old.endedAt = current.startedAt; h.a.events = [event('task_started', 200), event('tool_started', 201)];
  assert.equal(h.activityEvents(h.a, 'current').length, 0, 'same timestamp boundaries are ambiguous');
});

test('events retain run ownership through storage and timestamp skew, including background completion', () => {
  const h = harness({ realUI: true }); h.running();
  h.taskRuns.start(h.a, 'old', 'Old', 100); h.taskRuns.update(h.a, 'turn_completed', {}, 110);
  h.taskRuns.start(h.a, 'current', 'Current', 200);
  h.state.activeSessionId = h.b.id;
  h.handleEvent({ sessionId: 'native-a', type: 'tool_started', timestampMs: 90, payload: { toolUseId: 'read', tool: 'Read' } });
  h.handleEvent({ sessionId: 'native-a', type: 'turn_completed', timestampMs: 95, payload: {} });
  assert.equal(h.b.events.length, 0);
  const saved = plain(h.a); saved.taskRuns = h.taskRuns.restore(saved.taskRuns);
  assert.deepEqual(Array.from(h.activityEvents(saved, 'current'), e => e.kind), ['tool_started', 'turn_completed']);
  assert.equal(h.activityEvents(saved, 'old').length, 0);
});

test('a rejected retry gets its own failed run and cannot inherit the previous task details', async () => {
  const h = harness({ realUI: true, send: async () => { throw new Error('Send rejected'); } });
  h.taskRuns.start(h.a, 'previous', 'Previous successful task', 100);
  h.taskRuns.update(h.a, 'turn_completed', {}, 110);
  h.recordEvent('turn_completed', {}, 110);
  h.prompt.value = 'Retry this request'; await h.send();
  assert.equal(h.a.taskRuns.length, 2); assert.equal(h.a.taskRuns.at(-1).status, 'failed');
  assert.equal(h.a.taskRuns.at(-1).goal, 'Retry this request');
  h.openActivity();
  assert.equal(h.element('#eventLog').querySelector('.task-goal').textContent, 'Retry this request');
  assert.equal(h.element('#eventCount').textContent, '1 items');
  assert.equal(h.a.events.at(-1).runId, h.a.taskRuns.at(-1).id);
  assert.equal(h.a.messages.length, 0); assert.equal(h.prompt.value, 'Retry this request');
});

test('background approvals stay visible in the return badge and reappear in their own chat', () => {
  const h = harness(); h.running(); h.selectSession('project-a', 'chat-b');
  h.handleEvent({ sessionId: 'native-a', type: 'approval_requested', payload: { requestId: 'permission-1', toolName: 'Read' } });
  assert.equal(h.approvals.length, 0); assert.match(h.element('#returnRunningSession').textContent, /1 approvals/);
  h.returnToRunningSession(); assert.deepEqual(h.approvals, ['permission-1']);
  h.selectSession('project-a', 'chat-b');
  h.handleEvent({ sessionId: 'native-a', type: 'approval_resolved', payload: { requestId: 'permission-1' } });
  assert.doesNotMatch(h.element('#returnRunningSession').textContent, /approvals/);
});

test('switching waits for native send acceptance, then browsing keeps the accepted native task alive', async () => {
  let accept; const h = harness({ send: () => new Promise(resolve => { accept = resolve; }) });
  h.prompt.value = 'Start A'; const sending = h.send();
  for (let attempt = 0; attempt < 15 && !accept; attempt += 1) await Promise.resolve();
  assert.ok(accept); h.state.starting = false; // Native cleanup may finish while send still awaits acceptance.
  h.selectSession('project-a', 'chat-b');
  assert.equal(h.state.activeSessionId, 'chat-a');
  accept(); await sending;
  h.selectSession('project-a', 'chat-b');
  assert.equal(h.state.activeSessionId, 'chat-b'); assert.equal(h.state.turnActive, true);
  assert.equal(h.calls.filter(([kind]) => kind === 'close').length, 0);
  assert.equal(h.a.messages[0].text, 'Start A'); assert.equal(h.b.messages.length, 0);
});

test('completed background tasks require explicit selection and cleanup before sending in another chat', async () => {
  let finishClose; const h = harness({ close: () => new Promise(resolve => { finishClose = resolve; }) });
  h.running(); h.selectSession('project-a', 'chat-b');
  h.handleEvent({ sessionId: 'native-a', type: 'turn_completed', payload: { numTurns: 1 } });
  h.prompt.value = 'Task B'; await h.send();
  assert.equal(h.browsingHistory(), true); assert.equal(h.calls.filter(([kind]) => kind === 'send').length, 0);
  const switching = h.continueViewedSession();
  for (let attempt = 0; attempt < 10 && !finishClose; attempt += 1) await Promise.resolve();
  assert.ok(finishClose); await h.send(); assert.equal(h.calls.filter(([kind]) => kind === 'send').length, 0);
  finishClose(); await switching; await h.send();
  assert.equal(h.browsingHistory(), false); assert.equal(h.state.runningSessionId, 'chat-b');
  assert.equal(h.calls[0][0], 'close'); assert.equal(h.calls[0][1].sessionId, 'native-a');
  const sent = h.calls.find(([kind]) => kind === 'send')[1];
  assert.notEqual(sent.sessionId, 'native-a'); assert.equal(h.b.messages[0].text, 'Task B');
});

test('late accepted sends and native events cannot write into a switched account', async () => {
  let accept; const h = harness({ send: () => new Promise(resolve => { accept = resolve; }) });
  h.prompt.value = 'A confidential request'; const sending = h.send();
  for (let attempt = 0; attempt < 15 && !accept; attempt += 1) await Promise.resolve();
  const previousNative = h.state.nativeSessionId;
  h.state.storageEpoch += 1; h.state.accountScope = 'account-b'; h.state.activeSessionId = 'chat-b';
  h.state.turnActive = false; h.state.starting = false; h.prompt.value = 'B private draft';
  accept(); await sending;
  assert.equal(h.b.messages.length, 0); assert.equal(h.prompt.value, 'B private draft'); assert.equal(h.state.turnActive, false);
  h.handleEvent({ sessionId: previousNative, type: 'assistant_final', payload: { text: 'Old answer' } });
  assert.equal(h.b.messages.length, 0); assert.equal(h.a.messages.length, 0);
});

test('history searches names and saved text and sorts by recent use without changing stored arrays', () => {
  const h = harness(); h.c.messages.push({ role: 'agent', text: 'Invoice decision evidence' });
  const before = plain(h.state.projects);
  const all = h.historyProjects(''); assert.deepEqual(Array.from(all[0].sessions, item => item.id), ['chat-b', 'chat-a']);
  assert.deepEqual(Array.from(h.historyProjects('  INVOICE  '), item => item.project.id), ['project-b']);
  assert.deepEqual(Array.from(h.historyProjects('alpha')[0].sessions, item => item.id), ['chat-b', 'chat-a']);
  assert.equal(h.historyProjects('not found').length, 0); assert.deepEqual(plain(h.state.projects), before);
});

test('history composer cannot send or stop another task, and storage locks keep editing disabled', async () => {
  const h = harness(); h.running(); h.selectSession('project-a', 'chat-b');
  h.prompt.value = 'B draft'; h.syncControls();
  for (const id of ['prompt', 'addContext', 'modelEffortButton', 'permissionButton', 'send', 'deleteActiveSession']) assert.equal(h.element('#' + id).disabled, true, id);
  await h.send(); assert.equal(h.calls.length, 0);
  await h.stop(); assert.equal(h.state.activeSessionId, 'chat-a'); assert.equal(h.calls.length, 0, 'stop from another history returns to the task before a stop action');
  h.state.storageReady = false; h.syncControls(); assert.equal(h.element('#prompt').disabled, true); assert.equal(h.element('#send').disabled, true);
});

test('background terminal errors are saved only on the owner and stale native events are ignored', () => {
  const h = harness(); h.running(); h.selectSession('project-a', 'chat-b'); h.drawn.length = 0;
  h.handleEvent({ sessionId: 'stale-native', type: 'error', payload: { terminal: true, message: 'Stale error' } });
  assert.equal(h.state.turnActive, true);
  h.handleEvent({ sessionId: 'native-a', type: 'error', payload: { terminal: true, code: 'runtime_failed', message: 'Task failed' } });
  assert.equal(h.a.lastError.message, 'Task failed'); assert.equal(h.b.lastError, undefined); assert.equal(h.drawn.length, 0);
  assert.equal(h.state.turnActive, false); assert.equal(h.element('#continueViewedSession').hidden, false);
});

for (const rejected of [false, true]) {
  test('approval responses update the visible card after browsing away and back: ' + (rejected ? 'rejection' : 'acceptance'), async () => {
    let accept, reject;
    const h = harness({ realApproval: true, respondToApproval: () => new Promise((resolve, fail) => { accept = resolve; reject = fail; }) });
    h.running(); h.handleEvent({ sessionId: 'native-a', type: 'approval_requested', payload: { requestId: 'approval-x', toolName: 'Read', input: { path: '/a/file' } } });
    const oldCard = h.byId('approval-approval-x');
    const responding = oldCard.querySelector('.card-button').listeners.click();
    h.selectSession('project-a', 'chat-b'); h.returnToRunningSession();
    const currentCard = h.byId('approval-approval-x');
    assert.notEqual(currentCard, oldCard); assert.equal(currentCard.querySelector('.card-button').disabled, true);
    await currentCard.querySelector('.card-button').listeners.click();
    assert.equal(h.calls.filter(([kind]) => kind === 'approval').length, 1, 'a rebuilt pending card cannot submit a duplicate decision');
    if (rejected) reject(new Error('Approval transport interrupted')); else accept();
    await responding;
    if (rejected) {
      assert.equal(currentCard.querySelector('.card-button').disabled, false);
      assert.match(currentCard.querySelector('.approval-status').textContent, /transport interrupted/);
    } else assert.equal(h.byId('approval-approval-x'), null, 'the rebuilt visible card is removed after acceptance');
  });
}
