const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

function harness(narrow = false, platform = 'Win32') {
  const nodes = new Map();
  const document = { documentElement: {}, activeElement: null };
  function makeNode() {
    const classes = new Set();
    return {
      disabled: false, hidden: false, tabIndex: 0, isConnected: true,
      children: [], attrs: {}, handlers: {}, textContent: '',
      classList: { add(v) { classes.add(v); }, remove(v) { classes.delete(v); }, toggle(v, on) { if (on) classes.add(v); else classes.delete(v); }, contains(v) { return classes.has(v); } },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(v) { this.children.push(v); return v; },
      addEventListener(k, fn) { this.handlers[k] = fn; },
      querySelectorAll() { return this.children; },
      contains(v) { return this.children.includes(v); },
      getClientRects() { return this.hidden ? [] : [{}]; },
      focus() { document.activeElement = this; },
    };
  }
  document.querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector, makeNode()); return nodes.get(selector); };
  document.querySelectorAll = () => [];
  document.createElement = makeNode;
  const media = { matches: narrow, addEventListener(_kind, fn) { this.onchange = fn; } };
  const context = { document, URLSearchParams, navigator: { platform }, window: { location: { search: '' }, matchMedia() { return media; } } };
  vm.runInNewContext(script.replace('void init();', `
    var calls = { newChat: 0, choose: 0 };
    newConversation = function () { calls.newChat += 1; };
    chooseWorkspace = async function () { calls.choose += 1; };
    closeMenus = closeControlPopovers = syncControls = function () {};
    window.api = { ui, state, initLayout, setSidebarOpen, openModal, closeModal, handleGlobalKeydown, renderWelcome, calls };
  `), context);
  context.window.api.state.storageReady = true; context.window.api.state.accountScope = 'acct_test';
  return { ...context.window.api, document, node: document.querySelector, makeNode, media };
}

test('narrow sidebar starts closed, opens with focus and closes on Escape without starting a chat', () => {
  const h = harness(true);
  h.initLayout();
  assert.equal(h.node('#workspaceSidebar').inert, true);
  assert.equal(h.node('#sidebarBackdrop').hidden, true);
  h.setSidebarOpen(true, true);
  assert.equal(h.node('.main').inert, true);
  assert.equal(h.document.activeElement, h.node('#closeSidebar'));
  let prevented = false;
  h.handleGlobalKeydown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.node('.main').inert, false);
  assert.equal(h.node('#workspaceSidebar').inert, true);
  assert.equal(h.document.activeElement, h.node('#toggleSidebar'));
  assert.equal(h.calls.newChat, 0);
});

test('dialogs focus a safe control, constrain Tab and restore the opener on Escape', () => {
  const h = harness();
  const opener = h.makeNode(); opener.focus();
  const cancel = h.node('#cancelFullAccess');
  const confirm = h.makeNode();
  h.node('#fullAccessModal').children = [cancel, confirm];
  h.state.pendingFullAccess = { draft: true };
  h.openModal('fullAccessModal');
  assert.equal(h.document.activeElement, cancel);
  assert.equal(h.node('.app').inert, true);
  confirm.focus();
  h.handleGlobalKeydown({ key: 'Tab', preventDefault() {} });
  assert.equal(h.document.activeElement, cancel);
  h.handleGlobalKeydown({ key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(h.document.activeElement, confirm);
  h.handleGlobalKeydown({ key: 'n', ctrlKey: true, preventDefault() {} });
  assert.equal(h.calls.newChat, 0);
  h.handleGlobalKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(h.state.pendingFullAccess, null);
  assert.equal(h.node('.app').inert, false);
  assert.equal(h.document.activeElement, opener);
});

test('project modal Escape restores focus and Cmd/Ctrl shortcuts respect composition', () => {
  const h = harness(false, 'MacIntel');
  h.initLayout();
  assert.equal(h.node('#newChatShortcut').textContent, '⌘ N');
  const opener = h.makeNode(); opener.focus();
  h.openModal('projectModal');
  assert.equal(h.document.activeElement, h.node('#chooseFolder'));
  h.handleGlobalKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(h.document.activeElement, opener);
  h.handleGlobalKeydown({ key: 'n', metaKey: true, preventDefault() {} });
  h.handleGlobalKeydown({ key: 'n', ctrlKey: true, preventDefault() {} });
  h.handleGlobalKeydown({ key: 'n', metaKey: true, isComposing: true, preventDefault() {} });
  assert.equal(h.calls.newChat, 2);
});

test('empty welcome has an actionable folder entry and project welcome explains permission scope', () => {
  const h = harness(); const host = h.makeNode();
  h.renderWelcome(host, null);
  const button = host.children[0].children[0].children.find(n => n.handlers.click);
  assert.equal(button.textContent, '打开文件夹开始');
  button.handlers.click();
  assert.equal(h.ui.modalId, 'projectModal');
  assert.equal(h.calls.choose, 1);
  const ready = h.makeNode(); h.renderWelcome(ready, { name: 'Demo' });
  assert.match(ready.children[0].children[0].children[1].textContent, /所选权限/);
});
