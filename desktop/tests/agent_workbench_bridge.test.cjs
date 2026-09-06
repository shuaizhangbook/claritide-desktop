const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const bridgePath = process.env.CLARITIDE_AGENT_BRIDGE_PATH;
if (!bridgePath) {
  throw new Error('CLARITIDE_AGENT_BRIDGE_PATH must point to agent_workbench_bridge.js');
}

function loadBridge(invoke, location = {
  protocol: 'claritide-agent:',
  hostname: 'localhost',
  port: '',
}) {
  let intervalCallback = null;
  let cleared = false;
  const window = {
    __CLARITIDE_AGENT_BRIDGE_TEST_MODE__: true,
    __TAURI_INTERNALS__: { invoke },
    location,
    setInterval(callback) { intervalCallback = callback; return 7; },
    clearInterval(id) { assert.equal(id, 7); cleared = true; },
  };
  window.top = window;
  const context = { window, console, Date, Error, Object, Promise, Set, TypeError, URLSearchParams };
  vm.runInNewContext(fs.readFileSync(bridgePath, 'utf8'), context, { filename: bridgePath });
  return {
    window,
    bridge: window.__CLARITIDE_CCB__,
    testApi: window.__CLARITIDE_AGENT_BRIDGE_TEST__,
    runInterval() { return intervalCallback && intervalCallback(); },
    get cleared() { return cleared; },
  };
}

test('local bridge initializes on the Windows custom-protocol mapping', () => {
  const harness = loadBridge(async () => null, {
    protocol: 'http:',
    hostname: 'claritide-agent.localhost',
    port: '',
  });
  assert.equal(harness.bridge.capabilityVersion, 2);
});

test('workbench readiness acknowledges the exact launch attempt only when requested', async () => {
  const calls = [];
  const harness = loadBridge(async (command, args) => { calls.push([command, args]); }, {
    protocol: 'http:', hostname: 'claritide-agent.localhost', port: '',
    search: '?locale=zh-CN&attempt=53c6ebe2-b5a2-4db4-8c54-0df5c90fa7a5',
  });
  assert.equal(calls.length, 0, 'bridge injection must not signal an initialized app');
  const urls = [];
  harness.window.history = { replaceState(_state, _title, url) { urls.push(url); } };
  await harness.bridge.markReady();
  assert.equal(calls[0][0], 'agent_workbench_ready');
  assert.equal(calls[0][1].attemptId, '53c6ebe2-b5a2-4db4-8c54-0df5c90fa7a5');
  assert.deepEqual(urls, ['/?locale=zh-CN']);
  const reload = loadBridge(async (command) => { throw new Error('Unexpected command: ' + command); });
  await reload.bridge.markReady();
});

test('local bridge exposes the capability-v2 surface', async () => {
  const calls = [];
  const harness = loadBridge(async (command, args) => {
    calls.push([command, args]);
    if (command === 'agent_get_status') {
      return { allowedModels: ['default', 'gpt-test'], sessions: [{ sessionId: 'one' }] };
    }
    return null;
  });

  assert.equal(harness.bridge.capabilityVersion, 2);
  assert.deepEqual(await harness.bridge.listModels(), ['default', 'gpt-test']);
  assert.deepEqual(await harness.bridge.listSessions(), [{ sessionId: 'one' }]);
  await harness.bridge.selectWorkspace();
  await harness.bridge.startSession({ clientSessionId: 'id', workspace: 'opaque', permission: 'full' });
  await harness.bridge.send({ sessionId: 'id', content: 'hello' });
  await harness.bridge.stop({ sessionId: 'id' });
  await harness.bridge.close({ sessionId: 'id' });
  assert.deepEqual(
    calls.map(([command]) => command),
    [
      'agent_get_status',
      'agent_get_status',
      'agent_select_workspace',
      'agent_start',
      'agent_send',
      'agent_interrupt',
      'agent_close',
    ],
  );
  assert.equal(calls[3][1].request.permission, 'full');
  assert.equal(Object.getOwnPropertyDescriptor(harness.window, '__CLARITIDE_CCB__').writable, false);
});

test('workspace restoration forwards only to the local native command and preserves rejection', async () => {
  const calls = [];
  const workspace = { id: 'new-native-grant', path: 'C:\\Work\\July', name: 'July' };
  const harness = loadBridge(async (command, args) => {
    calls.push([command, args]);
    return workspace;
  });
  assert.equal(await harness.bridge.restoreWorkspace({ path: workspace.path }), workspace);
  assert.equal(calls[0][0], 'agent_restore_workspace');
  assert.equal(calls[0][1].request.path, workspace.path);
  assert.throws(() => harness.bridge.restoreWorkspace(null), /object/);
  const failure = new Error('Workspace grant storage is unavailable');
  const rejected = loadBridge(async () => { throw failure; });
  await assert.rejects(rejected.bridge.restoreWorkspace({ path: workspace.path }), error => error === failure);
});

test('event subscription polls normalized events and stops after unsubscribe', async () => {
  let polls = 0;
  const harness = loadBridge(async command => {
    if (command !== 'agent_poll_events') return null;
    polls += 1;
    return [{
      eventId: 1,
      sessionId: 'session-one',
      type: 'text_delta',
      timestampMs: 10,
      payload: { text: 'hello' },
    }];
  });
  const events = [];
  const unsubscribe = harness.bridge.onEvent(event => events.push(event));
  await harness.testApi.poll();
  assert.ok(polls >= 1);
  assert.equal(events.at(-1).type, 'text_delta');
  unsubscribe();
  assert.equal(harness.testApi.handlerCount(), 0);
  assert.equal(harness.cleared, true);
});

test('resume and approval use only the existing local command surface', async () => {
  const calls = [];
  const harness = loadBridge(async (command, args) => { calls.push([command, args]); });
  await harness.bridge.resume({ clientSessionId: 'one', workspace: 'opaque' });
  await harness.bridge.respondToApproval({ sessionId: 'one', requestId: 'approval-one', decision: 'allow_once' });
  assert.equal(calls[0][0], 'agent_start');
  assert.equal(calls[0][1].request.resume, true);
  assert.equal(calls[0][1].request.clientSessionId, 'one');
  assert.equal(calls[1][0], 'agent_send');
  assert.equal(calls[1][1].request.approval.decision, 'allow_once');
  assert.equal(calls[1][1].request.approval.requestId, 'approval-one');
  assert.equal(calls[1][1].request.content, undefined);
});

test('bridge does not initialize without Tauri internals', () => {
  const window = {
    location: { protocol: 'claritide-agent:', hostname: 'localhost', port: '' },
    setInterval() {},
    clearInterval() {},
  };
  window.top = window;
  vm.runInNewContext(fs.readFileSync(bridgePath, 'utf8'), { window, console });
  assert.equal(window.__CLARITIDE_CCB__, undefined);
});

test('bridge refuses remote, port-bearing, and subframe origins', () => {
  const source = fs.readFileSync(bridgePath, 'utf8');
  for (const candidate of [
    { protocol: 'https:', hostname: 'watch.sding.me', port: '' },
    { protocol: 'http:', hostname: 'claritide-agent.localhost', port: '8765' },
  ]) {
    const window = {
      location: candidate,
      __TAURI_INTERNALS__: { invoke: async () => null },
      setInterval() {},
      clearInterval() {},
    };
    window.top = window;
    vm.runInNewContext(source, { window, console });
    assert.equal(window.__CLARITIDE_CCB__, undefined);
  }

  const top = {};
  const window = {
    top,
    location: { protocol: 'claritide-agent:', hostname: 'localhost', port: '' },
    __TAURI_INTERNALS__: { invoke: async () => null },
    setInterval() {},
    clearInterval() {},
  };
  vm.runInNewContext(source, { window, console });
  assert.equal(window.__CLARITIDE_CCB__, undefined);
});
