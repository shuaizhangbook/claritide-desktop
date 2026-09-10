const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const bridgePath = process.env.SEESEEYOU_BRIDGE_PATH;
if (!bridgePath) {
  throw new Error('SEESEEYOU_BRIDGE_PATH must point to the patched seeseeyou_bridge.js');
}

const source = fs.readFileSync(bridgePath, 'utf8');

function loadEntry(documentLanguage) {
  const calls = [];
  const fetchCalls = [];
  let button = null;
  let transition = null;
  const nav = {
    appendChild(element) { button = element; },
  };
  const document = {
    documentElement: {
      lang: documentLanguage,
      appendChild(element) {
        transition = element;
        element.parentNode = {
          removeChild() { transition = null; },
        };
      },
    },
    title: '',
    querySelector(selector) { return selector === '.global-nav' ? nav : null; },
    getElementById(id) {
      if (id === 'navAgentWorkbench') return button;
      if (id === 'claritideAgentTransition') return transition;
      return null;
    },
    createElement() {
      const listeners = new Map();
      return {
        dataset: {},
        style: {},
        addEventListener(name, listener) { listeners.set(name, listener); },
        setAttribute() {},
        click(event) { return listeners.get('click')(event); },
      };
    },
    addEventListener() {},
  };
  const window = {
    __SEESEEYOU_BRIDGE_TEST_MODE__: true,
    __TAURI_INTERNALS__: {
      invoke(command, args) {
        calls.push([command, args]);
        if (command === 'get_or_create_installation_id') {
          return Promise.resolve('install-test-123');
        }
        return Promise.resolve();
      },
    },
    location: {
      origin: 'https://watch.sding.me',
      href: 'https://watch.sding.me/admin/my-day/?desktop=1',
    },
    localStorage: {
      getItem(key) { return key === 'usage_admin_token' ? 'session-test-token' : null; },
      setItem() {},
      removeItem() {},
    },
    navigator: { platform: 'Win32' },
    fetch: async (url, options) => {
      fetchCalls.push([url, options]);
      if (String(url).includes('/me/ai/runtime-config')) {
        return {
          ok: true,
          async json() {
            return {
              enabled: true,
              gateway_url: 'https://watch.sding.me/api/v1/agent-ai/openai/v1',
              default_model: 'gpt-5.6-sol',
              allowed_models: ['gpt-5.6-sol'],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            token: 'art_test_runtime_token',
            expires_in: 900,
            default_model: 'gpt-5.6-sol',
            allowed_models: ['gpt-5.6-sol'],
            session_id: 'ars_test_session',
          };
        },
      };
    },
    confirm() { return true; },
    alert() {},
    addEventListener() {},
    setTimeout() { return 1; },
    setInterval() { return 1; },
  };

  vm.runInNewContext(source, {
    window,
    document,
    Headers,
    FormData,
    URL,
    encodeURIComponent,
    console,
  }, { filename: bridgePath });
  window.__SEESEEYOU_BRIDGE_TEST__.ensureAgentWorkbenchEntry();
  return { button, calls, fetchCalls, getTransition: () => transition };
}

test('visible AI Workbench entry invokes the native opener with the active locale', async () => {
  for (const [language, expectedLabel, expectedLocale] of [
    ['zh-CN', 'AI 工作台', 'zh-CN'],
    ['en', 'AI Workbench', 'en'],
  ]) {
    const harness = loadEntry(language);
    harness.button.click({
      preventDefault() {},
      stopPropagation() {},
    });
    assert.equal(harness.button.textContent, expectedLabel);
    assert.equal(
      harness.getTransition().textContent,
      expectedLocale === 'en' ? 'Opening AI Workbench…' : '正在打开 AI 工作台…',
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(harness.getTransition(), null);
    assert.equal(harness.button.disabled, false);
    assert.deepEqual(harness.calls.map(call => call[0]), [
      'get_or_create_installation_id',
      'open_agent_workbench',
    ]);
    assert.equal(harness.calls[1][1].locale, expectedLocale);
    assert.deepEqual(
      JSON.parse(harness.fetchCalls[1][1].body),
      {
        installation_id: 'install-test-123',
        model: 'gpt-5.6-sol',
        client_version: '0.2.2',
      },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(harness.calls[1][1].runtime)), {
      gatewayUrl: 'https://watch.sding.me/api/v1/agent-ai/openai/v1',
      token: 'art_test_runtime_token',
      expiresIn: 900,
      defaultModel: 'gpt-5.6-sol',
      allowedModels: ['gpt-5.6-sol'],
      sessionId: 'ars_test_session',
    });
  }
});

test('AI authorization stays ephemeral and is never persisted by the remote bridge', () => {
  assert.match(source, /\/me\/ai\/runtime-config/);
  assert.match(source, /\/me\/ai\/runtime-token/);
  assert.match(source, /runtime:\s*\{[\s\S]*gatewayUrl:[\s\S]*expiresIn:/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(runtime|OPENAI|art_)/i);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*(runtimeToken|issued\.token)/);
});

test('AI Workbench entry survives initial render and language changes', () => {
  assert.match(
    source,
    /DOMContentLoaded'[\s\S]*brandDesktopWorkspace\(\);\s*ensureAgentWorkbenchEntry\(\);/,
  );
  assert.match(
    source,
    /work-i18n-change'[\s\S]*ensureAgentWorkbenchEntry\(\);\s*ensureDesktopSync\(true\);/,
  );
});

test('desktop replaces the Web assistant navigation with the local workbench action', () => {
  assert.match(source, /document\.getElementById\('navAssistant'\)/);
  assert.match(source, /var button = assistantButton \|\| generatedButton/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /launchAgentWorkbench\(button, event\)/);
});

test('unauthorized installations are enrolled and retried before opening CCB', () => {
  assert.match(source, /runtimeDeviceNotAuthorized\(error\)/);
  assert.match(source, /await activateAgentInstallation\(installation, token\)/);
  assert.match(source, /\/devices\/auto-enroll/);
  assert.match(source, /await invoke\('configure_sync'/);
  assert.match(source, /return apiRequest\('\/me\/ai\/runtime-config' \+ query, \{\}, token\)/);
});
