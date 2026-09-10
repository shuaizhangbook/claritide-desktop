const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH || path.join(__dirname, '../workbench/agent-workbench.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

function harness(options = {}) {
  let document;
  class Element {
    constructor(tag, text = '') {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
      this.className = ''; this.attributes = {}; this.style = {}; this.listeners = {}; this._text = text;
      this.classList = {
        add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).concat(names))].filter(Boolean).join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle: () => {},
      };
    }
    set innerHTML(value) { throw new Error('Untrusted HTML insertion'); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = String(value); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); }
    addEventListener(kind, callback) { this.listeners[kind] = callback; }
    async click() { if (this.listeners.click) await this.listeners.click({ target: this }); }
    focus() { document.activeElement = this; }
    select() { document.selectedText = this.value; }
    matches(selector) {
      if (selector.endsWith(':last-of-type')) {
        if (!this.parentNode || this.parentNode.children.filter(child => child.tagName === this.tagName).at(-1) !== this) return false;
        selector = selector.replace(':last-of-type', '');
      }
      const id = selector.match(/#([\w-]+)/);
      if (id && this.id !== id[1]) return false;
      const tag = selector.match(/^[\w-]+/);
      if (tag && this.tagName !== tag[0].toUpperCase()) return false;
      for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        if (!(match[1] in this.attributes) || match[2] !== undefined && this.attributes[match[1]] !== match[2]) return false;
      }
      return [...selector.matchAll(/\.([\w-]+)/g)].every(match => this.className.split(/\s+/).includes(match[1]));
    }
    querySelectorAll(selector) {
      const parts = selector.split(/\s+/);
      const descendants = this.children.flatMap(child => [child, ...child.descendants()]);
      return descendants.filter(node => {
        if (!node.matches(parts.at(-1))) return false;
        let ancestor = node.parentNode;
        for (let index = parts.length - 2; index >= 0; index -= 1) {
          while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentNode;
          if (!ancestor) return false;
          ancestor = ancestor.parentNode;
        }
        return true;
      });
    }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const root = new Element('html'), body = root.appendChild(new Element('body'));
  for (const id of new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(match => match[1]))) { const node = body.appendChild(new Element('div')); node.id = id; node.value = ''; }
  const copied = [], toasts = [], decisions = [], navigation = [];
  document = {
    documentElement: root, body, activeElement: null,
    createElement: tag => new Element(tag), createTextNode: text => new Element('#text', String(text)),
    querySelector: selector => root.querySelector(selector), querySelectorAll: selector => root.querySelectorAll(selector),
    getElementById: id => root.querySelector('#' + id),
    execCommand: options.execCommand || (() => { copied.push(document.selectedText); return true; }),
  };
  const context = {
    document, console, TextEncoder, URLSearchParams, localStorage: { setItem() {} }, setTimeout() {}, clearTimeout() {},
    window: {
      location: { search: '?locale=' + (options.locale || 'en'), assign: url => navigation.push(url) },
      navigator: options.fallbackClipboard ? {} : { clipboard: { async writeText(text) { copied.push(text); } } },
      __CLARITIDE_CCB__: { async respondToApproval(value) { decisions.push(value); if (options.rejectApproval) throw new Error('Approval transport unavailable'); } },
    }, toasts,
  };
  vm.runInNewContext(script.replace('void init();', `
    renderProjects = syncControls = scrollConversation = recordEvent = removeRunIndicator = updateRunIndicator = save = function () {};
    showToast = function (text) { toasts.push(text); };
    window.testApi = { state, renderAnswer, appendMessage, appendResultCard, appendErrorCard, renderApproval, handleEvent, copyOutputText, markdownTarget,
      fillModels, setModel, onModelKeydown, renderTaskSummary, normalizeSession, taskRuns: ClaritideTaskRuns };
  `), context);
  const api = context.window.testApi;
  const session = { id: 'chat', messages: [], events: [] };
  api.state.projects = [{ id: 'project', path: '/project', sessions: [session] }];
  api.state.storageReady = true; api.state.accountScope = 'acct_test'; api.state.storageEpoch = 1;
  api.state.runningProjectId = 'project'; api.state.runningSessionId = 'chat'; api.state.runStorageEpoch = 1;
  api.state.activeProjectId = 'project'; api.state.activeSessionId = 'chat'; api.state.nativeSessionId = 'native';
  return { ...api, session, document, copied, toasts, decisions, navigation, host: document.querySelector('#conversationInner') };
}

test('answers render headings, emphasis, lists, tables and copyable code while retaining exact source', async () => {
  const h = harness();
  const source = '# Result\n\n**Strong** and *emphasis* with `inline`.\n\n- first\n- second\n\n| File | State |\n| --- | --- |\n| app.js | updated |\n\n```js\nconst value = "<img onerror=alert(1)>";\nconsole.log(value);\n```';
  const body = h.appendMessage('agent', source, 1, true, []);
  assert.equal(body.querySelector('h1').textContent, 'Result');
  assert.equal(body.querySelector('strong').textContent, 'Strong');
  assert.equal(body.querySelector('em').textContent, 'emphasis');
  assert.equal(body.querySelectorAll('li').length, 2);
  assert.equal(body.querySelectorAll('th').length, 2);
  assert.equal(body.querySelectorAll('td').length, 2);
  assert.equal(body.querySelectorAll('img').length, 0);
  await body.querySelector('.markdown-code button').click();
  assert.equal(h.copied[0], 'const value = "<img onerror=alert(1)>";\nconsole.log(value);');
  assert.equal(h.session.messages[0].text, source);
  assert.equal(body._markdownSource, source);
});

test('model-controlled HTML and unsafe schemes stay inert; supported destinations explicitly copy without navigation', async () => {
  const h = harness();
  const source = '<img src=x onerror=alert(1)> <script>alert(2)</script>\n\n[bad](javascript:alert) [data](data:text/html,boom) [file](file:///tmp/private) [docs](https://example.test/docs) [code](src/app.js) [windows](C:\\project\\app.js)';
  const body = h.appendMessage('agent', source, 1, false, []);
  assert.equal(body.querySelectorAll('img').length + body.querySelectorAll('script').length + body.querySelectorAll('a').length, 0);
  assert.ok(body.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(body.textContent.includes('[bad](javascript:alert)'));
  const links = body.querySelectorAll('.markdown-link');
  assert.equal(links.length, 3);
  assert.match(links[0].textContent, /copy URL/);
  assert.match(links[1].textContent, /copy path/);
  for (const link of links) await link.click();
  assert.deepEqual(h.copied, ['https://example.test/docs', 'src/app.js', 'C:\\project\\app.js']);
  assert.deepEqual(h.navigation, []);
});

test('canonical replies replace provisional deltas, preserve separate assistant segments and persist Markdown rather than UI labels', () => {
  const h = harness(); h.appendMessage('user', 'Please help', 1, true, []);
  h.handleEvent({ sessionId: 'native', type: 'text_delta', payload: { text: 'Provisional' } });
  h.handleEvent({ sessionId: 'native', type: 'text_delta', payload: { text: ' text' } });
  assert.equal(h.host.querySelector('.message-body').textContent, 'Provisional text');
  h.handleEvent({ sessionId: 'native', type: 'assistant_final', payload: { text: '**Plan**' } });
  h.handleEvent({ sessionId: 'native', type: 'text_delta', payload: { text: '```js\n' } });
  const answer = '```js\nconsole.log(1);\n```';
  h.handleEvent({ sessionId: 'native', type: 'assistant_final', payload: { text: answer } });
  assert.equal(h.host.querySelectorAll('.message.agent').length, 2);
  assert.equal(h.session.messages.length, 3);
  assert.equal(h.session.messages[1].text, '**Plan**');
  assert.equal(h.session.messages[2].text, answer);
  assert.equal(h.host.querySelectorAll('.markdown-code').length, 1);
  assert.ok(!h.session.messages[2].text.includes('Copy code'));
});

test('a new turn cannot overwrite a previous formatted response', () => {
  const h = harness();
  h.appendMessage('user', 'First', 1, true, []);
  h.handleEvent({ sessionId: 'native', type: 'assistant_final', payload: { text: '# First answer' } });
  h.appendMessage('user', 'Second', 1, true, []);
  h.handleEvent({ sessionId: 'native', type: 'assistant_final', payload: { text: '# Second answer' } });
  assert.deepEqual(Array.from(h.session.messages, message => message.text), ['First', '# First answer', 'Second', '# Second answer']);
  assert.deepEqual(h.host.querySelectorAll('h1').map(node => node.textContent), ['First answer', 'Second answer']);
});

test('short user messages use one outer width constraint and retain the exact short text', () => {
  const h = harness(); h.appendMessage('user', 'hi', 1, false, []);
  const wrap = h.host.querySelector('.user-message-wrap');
  assert.ok(wrap); assert.equal(wrap.querySelector('.user-bubble').textContent, 'hi');
  assert.match(html, /\.user-message-wrap\s*\{[^}]*max-width:\s*min\(560px, 82%\)/);
  for (const rule of html.matchAll(/\.user-bubble\s*\{([^}]+)\}/g)) assert.doesNotMatch(rule[1], /max-width:\s*min\(/);
});

test('model choices match authorization, keep the saved unavailable choice and support keyboard navigation', async () => {
  const h = harness(); h.state.nativeSessionId = ''; h.session.model = 'gpt-one';
  h.state.status = { available: true, allowedModels: ['gpt-one', 'gpt-two'] };
  h.fillModels(h.state.status.allowedModels);
  const list = h.document.querySelector('#modelSelect');
  assert.equal(list.children.length, 2); assert.equal(list.children[0].tagName, 'BUTTON');
  assert.equal(list.children[0].attributes['aria-selected'], 'true');
  list.children[0].focus();
  const key = value => h.onModelKeydown({ key: value, preventDefault() {}, stopPropagation() {} });
  key('ArrowDown'); assert.equal(h.document.activeElement.value, 'gpt-two');
  await h.document.activeElement.click(); assert.equal(h.session.model, 'gpt-two');
  key('Home'); assert.equal(h.document.activeElement.value, 'gpt-one');
  key('End'); assert.equal(h.document.activeElement.value, 'gpt-two');
  key('Escape'); assert.equal(h.document.activeElement.id, 'modelEffortButton');
  assert.equal(h.document.querySelector('#modelEffortPopover').hidden, true);
  h.state.status.allowedModels = ['gpt-one']; h.fillModels(['gpt-one']);
  assert.equal(list.children[0].value, 'gpt-two'); assert.equal(list.children[0].disabled, true);
  assert.match(list.children[0].textContent, /unavailable/);
  assert.match(h.document.querySelector('#modelAvailabilityNote').textContent, /one available model/);
  await list.children[0].click(); assert.equal(h.session.model, 'gpt-two');
});

test('stale model options cannot change another account and expired authorization keeps choices disabled', async () => {
  const h = harness(); h.state.nativeSessionId = ''; h.session.model = 'gpt-one';
  h.state.status = { available: true, allowedModels: ['gpt-one', 'gpt-two'] }; h.fillModels(h.state.status.allowedModels);
  const oldOption = h.document.querySelector('#modelSelect').children[1];
  h.state.storageEpoch += 1; await oldOption.click(); assert.equal(h.session.model, 'gpt-one');
  h.state.status = { available: false, allowedModels: [] }; h.fillModels([]);
  assert.equal(h.document.querySelector('#modelSelect').children[0].disabled, true);
  h.setModel('gpt-two'); assert.equal(h.session.model, 'gpt-one');
});

test('session mismatch shows a Chinese summary and retains only safe copyable diagnostics', async () => {
  const h = harness({ locale: 'zh-CN' });
  const raw = 'The agent runtime emitted an event for a different session';
  h.session.lastError = { code: 'session_mismatch', message: raw };
  h.appendErrorCard(raw, false);
  const card = h.host.querySelector('.error-card');
  assert.match(card.querySelector('.card-copy').textContent, /会话标识不一致/);
  assert.doesNotMatch(card.querySelector('.card-copy').textContent, /The agent runtime|已修复/);
  const details = card.querySelector('details'); assert.ok(!details.open);
  assert.equal(details.querySelector('pre').textContent, 'session_mismatch\n' + raw);
  h.host.textContent = '';
  h.handleEvent({ sessionId: 'native', type: 'error', payload: { code: 'session_mismatch', message: raw, terminal: true, diagnostics: {
    eventType: 'stream_event', streamEventType: 'message_start', startMode: 'resume', initialized: false,
    turnActive: true, sessionIdMatchesExpected: false, sessionIdFormat: 'uuid',
    sessionId: 'private-id', token: 'private-token', eventSubtype: 'private-subtype'
  } } });
  const diagnosticCard = h.host.querySelector('.error-card');
  const diagnosticText = diagnosticCard.querySelector('pre').textContent;
  assert.match(diagnosticText, /"startMode": "resume"/);
  assert.doesNotMatch(diagnosticText, /private-/);
  assert.doesNotMatch(JSON.stringify(h.session.lastError), /private-/);
  await diagnosticCard.querySelectorAll('button').find(button => button.textContent === '复制错误详情').click();
  assert.equal(h.copied.at(-1), diagnosticText);
});

test('tool evidence is rendered inertly, persisted on its owner, and cannot be routed into the viewed chat', () => {
  const h = harness();
  h.taskRuns.start(h.session, 'run-1', 'Create report', 1);
  h.handleEvent({ sessionId: 'native', type: 'tool_started', payload: { toolUseId: 'write', tool: 'Write', input: { file_path: '<img src=x>' } } });
  h.handleEvent({ sessionId: 'native', type: 'tool_completed', payload: { toolUseId: 'write', tool: 'Write', outcome: 'succeeded', evidence: { kind: 'file', status: 'succeeded', path: '<img src=x>' }, preview: '<script>bad()</script>' } });
  const card = h.host.querySelector('#taskSummary');
  assert.match(card.textContent, /1 recorded file changes/);
  assert.equal(card.querySelectorAll('img').length + card.querySelectorAll('script').length, 0);
  assert.match(card.textContent, /<img src=x>/);
  const saved = JSON.parse(JSON.stringify(h.session.taskRuns)); assert.equal(saved[0].operations[0].evidence.path, '<img src=x>');
  const other = { id: 'other', messages: [], events: [] }; h.state.projects[0].sessions.push(other); h.state.activeSessionId = 'other';
  h.host.textContent = '';
  h.handleEvent({ sessionId: 'native', type: 'tool_started', payload: { toolUseId: 'read', tool: 'Read' } });
  assert.equal(h.session.taskRuns[0].operations.length, 2); assert.equal(other.taskRuns, undefined); assert.equal(h.host.textContent, '');
  h.state.storageEpoch += 1;
  h.handleEvent({ sessionId: 'native', type: 'tool_completed', payload: { toolUseId: 'read', outcome: 'succeeded' } });
  assert.equal(h.session.taskRuns[0].operations[1].status, 'running', 'late prior-account events are discarded');
});

test('plans and failed checks remain visible after a successful turn result and history reload', () => {
  const h = harness(); h.taskRuns.start(h.session, 'run-1', 'Check report', 1);
  h.handleEvent({ sessionId: 'native', type: 'tool_started', payload: { toolUseId: 'plan', tool: 'TodoWrite' } });
  h.handleEvent({ sessionId: 'native', type: 'tool_completed', payload: { toolUseId: 'plan', outcome: 'succeeded', plan: { items: [{ content: 'Review report', status: 'in_progress', activeForm: 'Reviewing report' }] } } });
  h.handleEvent({ sessionId: 'native', type: 'tool_started', payload: { toolUseId: 'check', tool: 'Bash' } });
  h.handleEvent({ sessionId: 'native', type: 'tool_completed', payload: { toolUseId: 'check', outcome: 'failed', isError: true, evidence: { kind: 'command', status: 'failed', command: 'npm test', exitCode: 1 }, preview: 'One assertion failed' } });
  h.handleEvent({ sessionId: 'native', type: 'turn_completed', payload: { success: true } });
  h.normalizeSession(h.session); h.host.textContent = ''; h.renderTaskSummary();
  const card = h.host.querySelector('#taskSummary');
  assert.match(card.textContent, /0 \/ 1 steps/); assert.match(card.textContent, /Bash · Run failed/);
  assert.match(card.textContent, /Exit code: 1/); assert.match(card.textContent, /One assertion failed/);
  assert.match(card.textContent, /Run finished/); assert.doesNotMatch(card.textContent, /Tests passed/);
});

test('completion shows only a finished run and copies the actual response; no stale previous-turn copy action', async () => {
  const h = harness(); const answer = '**Done**\n\n```txt\nactual output\n```';
  h.session.messages.push({ role: 'agent', text: answer }); h.appendResultCard({ durationMs: 1000, numTurns: 2 });
  const card = h.host.querySelector('.result-card');
  assert.match(card.textContent, /Run finished/); assert.doesNotMatch(card.textContent, /Task completed|tests passed|files changed/i);
  await card.querySelector('button').click(); assert.equal(h.copied[0], answer);
  h.host.textContent = ''; h.session.messages.push({ role: 'user', text: 'Another task' }); h.appendResultCard({});
  assert.doesNotMatch(h.host.textContent, /Copy response/);
});

test('approval presents the command and exact folded request while preserving all three native decisions', async () => {
  for (const decision of ['allow_once', 'allow_session', 'deny']) {
    const h = harness();
    const approval = { requestId: 'request-1', tool: 'Bash', input: { command: 'git status; python changed.py', timeout: 60000, description: '<img src=x>' } };
    h.renderApproval(approval);
    const card = h.host.querySelector('.approval-card');
    assert.match(card.querySelector('.card-title').textContent, /running this command/);
    assert.equal(card.querySelector('.approval-operation').textContent, approval.input.command);
    const details = card.querySelector('details'); assert.ok(!details.open);
    assert.deepEqual(JSON.parse(details.querySelector('pre').textContent), approval);
    assert.match(card.querySelector('.card-copy').textContent, /exact tool and input/);
    const buttons = card.querySelectorAll('.card-button');
    await buttons[['allow_once', 'allow_session', 'deny'].indexOf(decision)].click();
    assert.equal(h.decisions.length, 1);
    assert.equal(h.decisions[0].decision, decision);
    assert.equal(h.decisions[0].sessionId, 'native'); assert.equal(h.decisions[0].requestId, 'request-1');
    assert.equal(h.host.querySelector('.approval-card'), null);
  }
});

test('file approval names the target and failed decisions remain retryable', async () => {
  const h = harness({ locale: 'zh-CN', rejectApproval: true });
  const approval = { requestId: 'edit', tool: 'Edit', input: { file_path: '/project/app.js', old_string: 'old', new_string: 'new' } };
  h.renderApproval(approval);
  const card = h.host.querySelector('.approval-card');
  assert.match(card.querySelector('.card-title').textContent, /修改这个文件/);
  assert.equal(card.querySelector('.approval-operation').textContent, '/project/app.js');
  await card.querySelector('.card-button').click();
  assert.match(card.querySelector('.approval-status').textContent, /Approval transport unavailable/);
  assert.match(card.querySelector('.card-copy').textContent, /本会话授权仅适用于此工具的相同操作/);
  assert.ok(card.querySelectorAll('.card-button').every(button => button.disabled === false));
  assert.equal(h.host.querySelector('.approval-card'), card);
});

test('clipboard fallback copies exact text, removes its temporary field and restores focus; failures are explicit', async () => {
  const h = harness({ fallbackClipboard: true });
  const prompt = h.document.querySelector('#prompt'); prompt.focus();
  await h.copyOutputText('retained\ntext', null);
  assert.deepEqual(h.copied, ['retained\ntext']); assert.equal(h.document.activeElement, prompt);
  assert.equal(h.document.querySelectorAll('textarea').length, 0);
  const failing = harness({ fallbackClipboard: true, execCommand: () => false });
  await failing.copyOutputText('text', null);
  assert.match(failing.toasts[0], /Could not copy/); assert.equal(failing.document.querySelectorAll('textarea').length, 0);
});
