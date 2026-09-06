const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const bridgePath = process.env.SEESEEYOU_BRIDGE_PATH;
if (!bridgePath) {
  throw new Error('SEESEEYOU_BRIDGE_PATH must point to the patched seeseeyou_bridge.js');
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function aiRuntimeFetch(url) {
  if (url.includes('/me/ai/runtime-config')) {
    return response({
      enabled: true,
      gateway_url: 'https://watch.sding.me/api/v1/agent-ai/openai/v1',
      default_model: 'gpt-5.6-sol',
      allowed_models: ['gpt-5.6-sol'],
    });
  }
  if (url.endsWith('/me/ai/runtime-token')) {
    return response({
      token: 'art_bridge_test_token',
      expires_in: 900,
      default_model: 'gpt-5.6-sol',
      allowed_models: ['gpt-5.6-sol'],
      session_id: 'ars_bridge_test_session',
    });
  }
  throw new Error(`Unexpected URL: ${url}`);
}

function loadBridge({
  initialStorage = {},
  invoke,
  fetch,
  confirm = () => true,
  platform = 'Win32',
  installerLocale,
  documentLanguage = 'zh-CN',
  languageButton = null,
}) {
  const values = new Map(Object.entries(initialStorage));
  const listeners = new Map();
  const alerts = [];
  let reloads = 0;
  const document = {
    documentElement: { lang: documentLanguage },
    addEventListener(name, listener) { listeners.set(name, listener); },
    querySelector(selector) {
      return selector === '[data-language-toggle]' ? languageButton : null;
    },
    getElementById() { return null; },
    createElement() { return {}; },
  };
  const versionedInvoke = async (command, args) => {
    const value = await invoke(command, args);
    if (command === 'get_sync_status' && value && typeof value === 'object') {
      return {
        desktop_version: '0.2.2',
        bridge_protocol: 2,
        ...value,
      };
    }
    return value;
  };
  const window = {
    __SEESEEYOU_BRIDGE_TEST_MODE__: true,
    __CLARITIDE_INSTALLER_LOCALE__: installerLocale,
    __TAURI_INTERNALS__: { invoke: versionedInvoke },
    location: {
      origin: 'https://watch.sding.me',
      href: 'https://watch.sding.me/admin/my-day/?desktop=1',
      reload() { reloads += 1; },
    },
    localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); },
    },
    navigator: { platform },
    fetch,
    confirm,
    alert(message) { alerts.push(String(message)); },
    addEventListener(name, listener) { listeners.set(name, listener); },
    setTimeout() { return 1; },
    setInterval() { return 1; },
  };
  const context = {
    window,
    document,
    Headers,
    FormData,
    URL,
    encodeURIComponent,
    console,
  };
  vm.runInNewContext(fs.readFileSync(bridgePath, 'utf8'), context, { filename: bridgePath });
  return {
    bridge: window.__SEESEEYOU_BRIDGE_TEST__,
    agentDesktop: window.__CLARITIDE_AGENT_DESKTOP__,
    storage: values,
    alerts,
    get reloads() { return reloads; },
  };
}

test('Claritide branding and platform detection cover all desktop packages', () => {
  const source = fs.readFileSync(bridgePath, 'utf8');
  assert.match(source, /mark\.textContent = 'C'/);

  const base = {
    invoke: async () => null,
    fetch: async () => response({}),
  };
  assert.equal(loadBridge({ ...base, platform: 'Win32' }).bridge.desktopPlatform(), 'Windows');
  assert.equal(loadBridge({ ...base, platform: 'MacIntel' }).bridge.desktopPlatform(), 'macOS');
  assert.equal(loadBridge({ ...base, platform: 'Linux x86_64' }).bridge.desktopPlatform(), 'Linux');
});

test('remote workspace receives only the isolated agent-window opener', async () => {
  const calls = [];
  const harness = loadBridge({
    initialStorage: { my_day_session_token: 'signed-in-test-token' },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'get_or_create_installation_id') return 'desktop-test-installation';
      return null;
    },
    fetch: async (url) => aiRuntimeFetch(url),
  });
  assert.deepEqual(Object.keys(harness.agentDesktop), ['capabilityVersion', 'openWorkbench']);
  assert.equal(harness.agentDesktop.capabilityVersion, 1);
  await harness.agentDesktop.openWorkbench();
  assert.deepEqual(calls.map(([command]) => command), [
    'get_or_create_installation_id',
    'open_agent_workbench',
  ]);
  assert.equal(calls[1][1].locale, 'zh-CN');
  assert.equal(calls[1][1].runtime.token, 'art_bridge_test_token');
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls[1][1].runtime.allowedModels)),
    ['gpt-5.6-sol'],
  );
  assert.equal(harness.agentDesktop.startSession, undefined);
  assert.equal(harness.agentDesktop.selectWorkspace, undefined);
});

test('AI Workbench activates an unauthorized desktop installation and retries once', async () => {
  const invokeCalls = [];
  const fetchCalls = [];
  let runtimeConfigReads = 0;
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'signed-in-test-token',
      my_day_selected_team_id: 'team-a',
    },
    invoke: async (command, args) => {
      invokeCalls.push([command, args]);
      if (command === 'get_or_create_installation_id') return 'desktop-installation-a';
      if (command === 'get_sync_status') return { configured: false, paused: true };
      return null;
    },
    fetch: async (url, options = {}) => {
      fetchCalls.push([url, options]);
      if (url.includes('/me/ai/runtime-config')) {
        runtimeConfigReads += 1;
        if (runtimeConfigReads === 1) {
          return response({
            detail: {
              code: 'runtime_device_not_authorized',
              message: 'This desktop installation is not active for the signed-in user.',
            },
          }, 403);
        }
        return aiRuntimeFetch(url);
      }
      if (url.endsWith('/me/teams')) {
        return response({
          employee_id: 'employee-a',
          items: [{ team_id: 'team-a', name: 'Team A' }],
        });
      }
      if (url.endsWith('/devices/auto-enroll')) {
        return response({
          device: { device_id: 'device-a', employee_id: 'employee-a', team_id: 'team-a' },
          credentials: { device_token: 'device-token-a', hmac_secret: 'hmac-a' },
        }, 201);
      }
      return aiRuntimeFetch(url);
    },
  });

  await harness.agentDesktop.openWorkbench();

  assert.equal(runtimeConfigReads, 2);
  const enrollment = fetchCalls.find(([url]) => url.endsWith('/devices/auto-enroll'));
  assert.ok(enrollment);
  assert.equal(enrollment[1].headers.get('X-Team-ID'), 'team-a');
  assert.deepEqual(JSON.parse(enrollment[1].body), {
    installation_id: 'desktop-installation-a',
    device_name: 'Claritide Windows',
    platform: 'Windows',
  });
  const commands = invokeCalls.map(([command]) => command);
  assert.ok(commands.indexOf('configure_sync') < commands.indexOf('open_agent_workbench'));
  const configure = invokeCalls.find(([command]) => command === 'configure_sync');
  assert.equal(configure[1].config.device_id, 'device-a');
  assert.equal(configure[1].config.device_key, 'device-token-a');
  assert.equal(
    invokeCalls.find(([command]) => command === 'open_agent_workbench')[1].runtime.token,
    'art_bridge_test_token',
  );
});

test('installer language is applied once without overriding later manual changes', () => {
  let clicks = 0;
  const languageButton = { click() { clicks += 1; } };
  const base = {
    invoke: async () => null,
    fetch: async () => response({}),
    installerLocale: 'en',
    documentLanguage: 'zh-CN',
    languageButton,
  };
  const first = loadBridge(base);
  assert.equal(first.bridge.applyInstallerLanguagePreference(), true);
  assert.equal(clicks, 1);
  assert.equal(first.storage.get('claritide_installer_locale_applied'), 'en');

  const afterManualSwitch = loadBridge({
    ...base,
    initialStorage: { claritide_installer_locale_applied: 'en' },
  });
  assert.equal(afterManualSwitch.bridge.applyInstallerLanguagePreference(), true);
  assert.equal(clicks, 1);
});

test('English workspace opens the AI Workbench in English', async () => {
  const calls = [];
  const harness = loadBridge({
    documentLanguage: 'en',
    initialStorage: { my_day_session_token: 'signed-in-test-token' },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'get_or_create_installation_id') return 'desktop-test-installation';
      return null;
    },
    fetch: async (url) => aiRuntimeFetch(url),
  });
  await harness.agentDesktop.openWorkbench();
  assert.equal(calls[1][0], 'open_agent_workbench');
  assert.equal(calls[1][1].locale, 'en');
});

test('cold logged-out startup clears an existing native identity', async () => {
  const calls = [];
  const harness = loadBridge({
    invoke: async command => {
      calls.push(command);
      if (command === 'get_sync_status') return { configured: true, paused: false };
      return null;
    },
    fetch: async () => response({}),
  });

  await harness.bridge.ensureDesktopSync(true);
  assert.deepEqual(calls, ['get_sync_status', 'clear_sync']);
});

test('account switch clears the old identity before enrolling the new account', async () => {
  const calls = [];
  let statusReads = 0;
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'new-token',
      my_day_selected_team_id: 'team-new',
    },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'get_sync_status') {
        statusReads += 1;
        return statusReads === 1
          ? { configured: true, paused: true, employee_id: 'employee-old', team_id: 'team-old' }
          : { configured: false, paused: true };
      }
      if (command === 'get_or_create_installation_id') return 'desktop-stable-identity-0001';
      return null;
    },
    fetch: async url => {
      if (url.endsWith('/me/teams')) {
        return response({ employee_id: 'employee-new', items: [{ team_id: 'team-new', name: 'New' }] });
      }
      if (url.endsWith('/devices/auto-enroll')) {
        return response({
          device: { device_id: 'device-new', employee_id: 'employee-new', team_id: 'team-new' },
          credentials: { device_token: 'device-token', hmac_secret: 'hmac' },
        }, 201);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.bridge.ensureDesktopSync(true);
  const commandNames = calls.map(([name]) => name);
  assert.ok(commandNames.indexOf('clear_sync') < commandNames.indexOf('configure_sync'));
  assert.ok(commandNames.includes('get_or_create_installation_id'));
  const configureCall = calls.find(([name]) => name === 'configure_sync');
  assert.equal(configureCall[1].config.local_api_url, 'http://localhost:5600/api/0');
});

test('retry on a real worker error triggers the native scheduler', async () => {
  const calls = [];
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      my_day_selected_team_id: 'team-a',
    },
    invoke: async command => {
      calls.push(command);
      if (command === 'get_sync_status') {
        return {
          configured: true,
          paused: false,
          binary_ready: true,
          employee_id: 'employee-a',
          team_id: 'team-a',
          last_error: 'network unavailable',
        };
      }
      return null;
    },
    fetch: async url => {
      if (url.endsWith('/me/teams')) {
        return response({ employee_id: 'employee-a', items: [{ team_id: 'team-a', name: 'Team A' }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.bridge.ensureDesktopSync(true);
  assert.ok(calls.includes('trigger_sync_now'));
});

test('recent server-acknowledged upload stays healthy despite a stale worker error', async () => {
  const now = Date.now();
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      my_day_selected_team_id: 'team-a',
    },
    invoke: async command => {
      if (command === 'get_sync_status') {
        return {
          configured: true,
          paused: false,
          employee_id: 'employee-a',
          team_id: 'team-a',
          device_id: 'device-a',
          last_success_at_ms: now - 30000,
          last_error: 'an older timeout',
        };
      }
      return null;
    },
    fetch: async url => {
      if (url.endsWith('/me/teams')) {
        return response({ employee_id: 'employee-a', items: [{ team_id: 'team-a', name: 'Team A' }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.bridge.ensureDesktopSync(true);
  const view = harness.bridge.getSyncViewState();
  assert.equal(view.state, 'active');
  assert.match(view.detail, /线上服务接受|accepted by the online service/);
});

test('native status failure is diagnostic and preserves a raw string error', async () => {
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      my_day_selected_team_id: 'team-a',
    },
    invoke: async command => {
      if (command === 'get_sync_status') throw 'command get_sync_status not found';
      return null;
    },
    fetch: async url => {
      if (url.endsWith('/me/teams')) {
        return response({
          employee_id: 'employee-a',
          items: [{ team_id: 'team-a', name: 'Team A' }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.bridge.ensureDesktopSync(true);
  const view = harness.bridge.getSyncViewState();
  assert.equal(view.state, 'diagnostic');
  assert.match(view.detail, /command get_sync_status not found/);
  assert.equal(harness.bridge.rawErrorMessage('native raw failure'), 'native raw failure');
});

test('web and desktop bridge protocol mismatch is detected', async () => {
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      my_day_selected_team_id: 'team-a',
    },
    invoke: async command => {
      if (command === 'get_sync_status') {
        return {
          desktop_version: '0.1.3',
          bridge_protocol: 1,
          configured: true,
          paused: false,
          employee_id: 'employee-a',
          team_id: 'team-a',
        };
      }
      return null;
    },
    fetch: async url => {
      if (url.endsWith('/me/teams')) {
        return response({
          employee_id: 'employee-a',
          items: [{ team_id: 'team-a', name: 'Team A' }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.bridge.ensureDesktopSync(true);
  const view = harness.bridge.getSyncViewState();
  assert.equal(view.state, 'version');
  assert.match(view.detail, /协议不一致|protocol mismatch/);
});

test('recent server activity overrides a stale native worker error', async () => {
  const calls = [];
  const now = Date.now();
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      my_day_selected_team_id: 'team-a',
    },
    invoke: async command => {
      calls.push(command);
      if (command === 'get_sync_status') {
        return {
          desktop_version: '0.2.2',
          bridge_protocol: 2,
          configured: true,
          paused: false,
          employee_id: 'employee-a',
          team_id: 'team-a',
          device_id: 'device-a',
          last_success_at_ms: now - 30000,
          last_error: 'old timeout that already recovered',
        };
      }
      return null;
    },
    fetch: async url => {
      if (url.endsWith('/me/teams')) {
        return response({
          employee_id: 'employee-a',
          items: [{ team_id: 'team-a', name: 'Team A' }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.bridge.ensureDesktopSync(true);
  assert.equal(harness.bridge.getSyncViewState().state, 'active');
  assert.equal(calls.includes('trigger_sync_now'), false);
});

test('explicit rebind clears the stale identity before rotating and enrolling', async () => {
  const calls = [];
  let configured = true;
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      my_day_selected_team_id: 'team-current',
    },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'get_sync_status') {
        return configured
          ? { configured: true, paused: false, binary_ready: true, employee_id: 'employee-a', team_id: 'team-old' }
          : { configured: false, paused: true };
      }
      if (command === 'clear_sync') configured = false;
      if (command === 'get_or_create_installation_id') return 'desktop-rebound-identity-0001';
      return null;
    },
    fetch: async url => {
      if (url.endsWith('/me/teams')) {
        return response({ employee_id: 'employee-a', items: [{ team_id: 'team-current', name: 'Current' }] });
      }
      if (url.endsWith('/devices/auto-enroll')) {
        return response({
          device: { device_id: 'device-current', employee_id: 'employee-a', team_id: 'team-current' },
          credentials: { device_token: 'device-token', hmac_secret: 'hmac' },
        }, 201);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.bridge.ensureDesktopSync(true);
  await harness.bridge.rebindDesktopSync();
  const commandNames = calls.map(([name]) => name);
  assert.ok(commandNames.indexOf('clear_sync') < commandNames.indexOf('rotate_installation_id'));
  assert.ok(commandNames.indexOf('rotate_installation_id') < commandNames.indexOf('configure_sync'));
});

test('server identity conflict offers rebind even when local sync config is gone', async () => {
  const calls = [];
  let enrollmentAttempts = 0;
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      my_day_selected_team_id: 'team-new',
    },
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'get_sync_status') return { configured: false, paused: true };
      if (command === 'get_or_create_installation_id') return 'desktop-server-bound-identity';
      return null;
    },
    fetch: async url => {
      if (url.endsWith('/me/teams')) {
        return response({ employee_id: 'employee-a', items: [{ team_id: 'team-new', name: 'New' }] });
      }
      if (url.endsWith('/devices/auto-enroll')) {
        enrollmentAttempts += 1;
        if (enrollmentAttempts === 1) {
          return response({
            detail: {
              code: 'device_team_change_forbidden',
              message: 'This device is already bound to another team.',
            },
          }, 409);
        }
        return response({
          device: { device_id: 'device-new', employee_id: 'employee-a', team_id: 'team-new' },
          credentials: { device_token: 'device-token', hmac_secret: 'hmac' },
        }, 201);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.bridge.ensureDesktopSync(true);
  await harness.bridge.rebindDesktopSync();
  const commandNames = calls.map(([name]) => name);
  assert.ok(commandNames.includes('rotate_installation_id'));
  assert.ok(commandNames.includes('configure_sync'));
  assert.equal(enrollmentAttempts, 2);
});

test('Telegram daily-report binding opens the trusted link through the native bridge', async () => {
  const calls = [];
  const harness = loadBridge({
    initialStorage: { my_day_session_token: 'token' },
    invoke: async (command, args) => { calls.push([command, args]); },
    fetch: async url => {
      assert.ok(url.endsWith('/employee/telegram/bind-link'));
      return response({ url: 'https://t.me/SeeSeeYouBot?start=desktop-token' });
    },
  });
  const button = { dataset: {}, disabled: false, textContent: '连接 Telegram 日报提醒', title: '' };

  await harness.bridge.desktopTelegramBind(button);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'open_external');
  assert.equal(
    calls[0][1].url,
    'https://t.me/SeeSeeYouBot?start=desktop-token',
  );
  assert.equal(harness.alerts.length, 0);
});

test('Telegram ACL failures are shown instead of failing silently', async () => {
  const harness = loadBridge({
    initialStorage: { my_day_session_token: 'token' },
    invoke: async command => {
      if (command === 'open_external') throw 'Command open_external not allowed by ACL';
    },
    fetch: async () => response({ url: 'https://t.me/SeeSeeYouBot?start=desktop-token' }),
  });
  const button = { dataset: {}, disabled: false, textContent: '连接 Telegram 日报提醒', title: '' };

  await harness.bridge.desktopTelegramBind(button);
  assert.match(button.title, /not allowed by ACL/);
  assert.match(harness.alerts[0], /not allowed by ACL/);
});

test('desktop logout clears synchronization credentials before removing the session', async () => {
  const calls = [];
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      usage_admin_token: 'token',
    },
    invoke: async command => { calls.push(command); },
    fetch: async url => {
      assert.ok(url.endsWith('/auth/logout'));
      return response({ ok: true });
    },
  });
  const button = { dataset: {}, disabled: false, textContent: '退出登录', title: '' };

  await harness.bridge.desktopLogout(button);
  assert.equal(calls[0], 'clear_sync');
  assert.equal(harness.storage.has('my_day_session_token'), false);
  assert.equal(harness.storage.has('usage_admin_token'), false);
  assert.equal(harness.reloads, 1);
});

test('desktop logout restores the session if the final native clear fails', async () => {
  let clearCalls = 0;
  const harness = loadBridge({
    initialStorage: {
      my_day_session_token: 'token',
      usage_admin_token: 'token',
    },
    invoke: async command => {
      if (command === 'clear_sync') {
        clearCalls += 1;
        if (clearCalls === 2) throw new Error('locked');
      }
    },
    fetch: async () => response({ ok: true }),
  });
  const button = { dataset: {}, disabled: false, textContent: '退出登录', title: '' };

  await harness.bridge.desktopLogout(button);
  assert.equal(harness.storage.get('my_day_session_token'), 'token');
  assert.equal(harness.storage.get('usage_admin_token'), 'token');
  assert.equal(harness.reloads, 0);
  assert.match(button.title, /无法完成安全退出/);
  assert.match(harness.alerts[0], /locked/);
});
