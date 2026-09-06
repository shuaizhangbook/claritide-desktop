(function () {
  'use strict';

  var TRUSTED_ORIGIN = 'https://watch.sding.me';
  var API = TRUSTED_ORIGIN + '/api/v1';
  var DESKTOP_VERSION = '0.2.2';
  var BRIDGE_PROTOCOL = 2;
  var TOKEN_KEYS = ['usage_admin_token', 'my_day_session_token'];
  var TEAM_KEY = 'my_day_selected_team_id';
  var DEVICE_KEY = 'seeseeyou_desktop_device_id';
  var INSTALLER_LOCALE_KEY = 'claritide_installer_locale_applied';
  var syncRunning = false;
  var syncRerunRequested = false;
  var syncClearPending = false;
  var loggingOut = false;
  var agentActivationRunning = false;
  var agentWorkbenchLaunchPromise = null;
  var rebindRequired = false;
  var lastSessionToken = '';
  var lastTeamSelection = '';
  var lastSyncAttempt = 0;
  var lastNativeTriggerAt = 0;
  var currentSyncState = 'hidden';
  var currentSyncDetail = '';

  if (window.location.origin !== TRUSTED_ORIGIN) return;
  window.__SEESEEYOU_DESKTOP__ = {
    version: DESKTOP_VERSION,
    bridgeProtocol: BRIDGE_PROTOCOL
  };

  function invoke(command, args) {
    var candidate = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof candidate !== 'function') return Promise.reject(new Error('Native bridge unavailable'));
    return candidate(command, args || {});
  }

  // This remote page receives only an opener. Runtime control, workspace
  // selection, messages, and events exist exclusively in the bundled local
  // `agent-workbench` WebView under window.__CLARITIDE_CCB__.
  Object.defineProperty(window, '__CLARITIDE_AGENT_DESKTOP__', {
    value: Object.freeze({
      capabilityVersion: 1,
      openWorkbench: function () {
        return openAgentWorkbench();
      }
    }),
    configurable: false,
    enumerable: false,
    writable: false
  });

  function sessionToken() {
    for (var i = 0; i < TOKEN_KEYS.length; i += 1) {
      var token = window.localStorage.getItem(TOKEN_KEYS[i]);
      if (token) return token;
    }
    return '';
  }

  function isEnglish() {
    var lang = String(document.documentElement.lang || '').toLowerCase();
    if (lang.indexOf('en') === 0) return true;
    try {
      return window.WorkI18n && typeof window.WorkI18n.isEnglish === 'function'
        ? window.WorkI18n.isEnglish()
        : false;
    } catch (_error) {
      return false;
    }
  }

  function copy(zh, en) {
    return isEnglish() ? en : zh;
  }

  function normalizedInstallerLocale(value) {
    value = String(value || '').trim().toLowerCase();
    if (value === 'en' || value === 'en-us' || value === 'english') return 'en';
    if (value === 'zh' || value === 'zh-cn' || value === 'chinesesimplified') return 'zh-CN';
    return '';
  }

  function applyInstallerLanguagePreference() {
    var desired = normalizedInstallerLocale(window.__CLARITIDE_INSTALLER_LOCALE__);
    if (!desired) return true;
    try {
      if (window.localStorage.getItem(INSTALLER_LOCALE_KEY) === desired) return true;
    } catch (_error) {}

    var current = isEnglish() ? 'en' : 'zh-CN';
    if (current !== desired) {
      var toggle = document.querySelector('[data-language-toggle]');
      if (!toggle || typeof toggle.click !== 'function') return false;
      try {
        window.localStorage.setItem(INSTALLER_LOCALE_KEY, desired);
      } catch (_error) {}
      toggle.click();
      return true;
    }

    try {
      window.localStorage.setItem(INSTALLER_LOCALE_KEY, desired);
    } catch (_error) {}
    return true;
  }

  function showAgentWorkbenchTransition() {
    var existing = document.getElementById('claritideAgentTransition');
    if (existing) return function () {};
    var overlay = document.createElement('div');
    overlay.id = 'claritideAgentTransition';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.textContent = copy('正在打开 AI 工作台…', 'Opening AI Workbench…');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:grid',
      'place-items:center',
      'background:#f7f7f5',
      'color:#4d514c',
      'font:600 14px Inter,system-ui,sans-serif'
    ].join(';');
    document.documentElement.appendChild(overlay);
    return function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
  }

  function agentRuntimeErrorMessage(error) {
    var status = Number(error && error.status || 0);
    var code = String(error && error.code || '');
    if (status === 401) {
      return copy('登录状态已失效，请重新登录后再试。', 'Your sign-in expired. Please sign in again.');
    }
    if (status === 403 || code === 'runtime_device_not_authorized') {
      return copy(
        '当前账号、团队或设备尚未获得 AI 使用权限，请联系团队管理员。',
        'This account, team, or device is not authorized to use AI. Contact your team administrator.'
      );
    }
    if (status === 429) {
      return copy('AI 使用额度暂时不可用，请稍后再试。', 'AI usage is temporarily unavailable. Please try again later.');
    }
    if (status === 503) {
      return copy('AI 服务暂时不可用，请稍后再试。', 'The AI service is temporarily unavailable. Please try again later.');
    }
    return copy('无法打开 AI 工作台：', 'Unable to open AI Workbench: ') +
      String(error && error.message ? error.message : error);
  }

  async function revokeRuntimeToken(token, webToken) {
    if (!token) return;
    try {
      await apiRequest('/me/ai/runtime-token/revoke', {
        method: 'POST',
        headers: { 'X-Agent-Runtime-Token': token }
      }, webToken);
    } catch (_error) {}
  }

  function runtimeDeviceNotAuthorized(error) {
    return Number(error && error.status || 0) === 403 &&
      String(error && error.code || '') === 'runtime_device_not_authorized';
  }

  function requireAgentAccount(token) {
    if (loggingOut || sessionToken() !== token) {
      throw Object.assign(new Error(copy(
        '账号已切换，请使用当前账号重新打开 AI 工作台。',
        'Your account changed. Open AI Workbench again with the current account.'
      )), { code: 'desktop_account_changed' });
    }
  }

  async function waitForSyncIdle() {
    var deadline = Date.now() + 5000;
    while (syncRunning && Date.now() < deadline) {
      await new Promise(function (resolve) { window.setTimeout(resolve, 100); });
    }
  }

  async function activateAgentInstallation(installation, token) {
    await waitForSyncIdle();
    requireAgentAccount(token);
    agentActivationRunning = true;
    try {
      var teamData = await apiRequest('/me/teams', {}, token);
      requireAgentAccount(token);
      var teams = Array.isArray(teamData && teamData.items) ? teamData.items : [];
      if (!teams.length) {
        throw Object.assign(new Error('Join an active team to use the AI Workbench'), {
          status: 403,
          code: 'no_active_team'
        });
      }

      var status = await invoke('get_sync_status').catch(function () { return null; });
      requireAgentAccount(token);
      if (status && status.employee_id && status.employee_id !== teamData.employee_id) {
        await invoke('clear_sync');
        requireAgentAccount(token);
        status = null;
      }
      var statusTeam = status && status.team_id && teams.some(function (team) {
        return team.team_id === status.team_id;
      }) ? status.team_id : '';
      var teamId = statusTeam || selectedTeam(teams);
      if (!teamId) {
        throw Object.assign(new Error('Select the current team before opening the AI Workbench'), {
          status: 409,
          code: 'team_selection_required'
        });
      }

      var platform = desktopPlatform();
      var enrollment = await apiRequest('/devices/auto-enroll', {
        method: 'POST',
        headers: { 'X-Team-ID': teamId },
        body: JSON.stringify({
          installation_id: String(installation || ''),
          device_name: 'Claritide ' + platform,
          platform: platform
        })
      }, token);
      requireAgentAccount(token);
      window.localStorage.setItem(DEVICE_KEY, String(enrollment.device.device_id));
      await invoke('configure_sync', {
        config: {
          server_url: TRUSTED_ORIGIN,
          local_api_url: 'http://localhost:5600/api/0',
          device_id: enrollment.device.device_id,
          employee_id: enrollment.device.employee_id,
          team_id: enrollment.device.team_id,
          device_key: enrollment.credentials.device_token,
          hmac_secret: enrollment.credentials.hmac_secret
        }
      });
      requireAgentAccount(token);
      rebindRequired = false;
      lastSessionToken = token;
      lastTeamSelection = window.localStorage.getItem(TEAM_KEY) || '';
      lastNativeTriggerAt = Date.now();
      setSyncState('connecting', copy('正在连接当前电脑。', 'Connecting this computer.'));
      window.setTimeout(function () { ensureDesktopSync(true); }, 1800);
    } finally {
      agentActivationRunning = false;
    }
  }

  async function agentRuntimeConfig(installation, token) {
    var query = '?installation_id=' + encodeURIComponent(String(installation || ''));
    try {
      return await apiRequest('/me/ai/runtime-config' + query, {}, token);
    } catch (error) {
      if (!runtimeDeviceNotAuthorized(error)) throw error;
      await activateAgentInstallation(installation, token);
      return apiRequest('/me/ai/runtime-config' + query, {}, token);
    }
  }

  async function openAgentWorkbench() {
    var token = sessionToken();
    if (!token) {
      throw Object.assign(new Error('Sign-in required'), { status: 401 });
    }
    var installation = await installationId();
    requireAgentAccount(token);
    var config = await agentRuntimeConfig(installation, token);
    requireAgentAccount(token);
    if (!config || config.enabled !== true) {
      throw Object.assign(new Error('AI runtime is not enabled'), {
        status: 403,
        code: 'runtime_device_not_authorized'
      });
    }
    var issued = await apiRequest('/me/ai/runtime-token', {
      method: 'POST',
      body: JSON.stringify({
        installation_id: String(installation || ''),
        model: String(config.default_model || ''),
        client_version: DESKTOP_VERSION
      })
    }, token);
    var runtimeToken = String(issued && issued.token || '');
    try {
      requireAgentAccount(token);
      return await invoke('open_agent_workbench', {
        locale: isEnglish() ? 'en' : 'zh-CN',
        authorization: 'Bearer ' + token,
        runtime: {
          gatewayUrl: String(config.gateway_url || ''),
          token: runtimeToken,
          expiresIn: Number(issued && issued.expires_in || 0),
          defaultModel: String(issued && issued.default_model || config.default_model || ''),
          gatewayLimits: issued && issued.gateway_limits || config.gateway_limits || null,
          allowedModels: Array.isArray(issued && issued.allowed_models)
            ? issued.allowed_models.map(String)
            : [],
          sessionId: String(issued && issued.session_id || '')
        }
      });
    } catch (error) {
      await revokeRuntimeToken(runtimeToken, token);
      throw error;
    }
  }

  async function copyAgentDiagnostics(error, host) {
    var status = await invoke('get_sync_status').catch(function () { return null; });
    var info = status && status.build_info || {};
    var code = String(error && error.code || '');
    var raw = String(error && error.message || error || '');
    var nativeCode = raw.match(/\bAI_WORKBENCH_[A-Z_]+\b/);
    var hresult = raw.match(/\b0x[0-9A-Fa-f]{8}\b/);
    var lines = [
      'Claritide diagnostics',
      'version: ' + DESKTOP_VERSION,
      'platform: ' + desktopPlatform(),
      'bridgeProtocol: ' + BRIDGE_PROTOCOL
    ];
    ['buildNumber', 'productRevision', 'webuiRevision', 'engineRevision', 'platform'].forEach(function (key) {
      var value = info[key];
      if (typeof value === 'string' && /^[A-Za-z0-9._ -]{1,100}$/.test(value)) lines.push(key + ': ' + value);
    });
    if (/^[A-Za-z0-9_]{1,80}$/.test(code)) lines.push('errorCode: ' + code);
    if (nativeCode) lines.push('nativeCode: ' + nativeCode[0]);
    if (hresult) lines.push('HRESULT: ' + hresult[0]);
    var httpStatus = Number(error && error.status || 0);
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) lines.push('httpStatus: ' + httpStatus);
    var content = lines.join('\n');
    try {
      if (!window.navigator.clipboard || typeof window.navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      await window.navigator.clipboard.writeText(content);
      return true;
    } catch (_error) {
      var field = document.getElementById('claritideAgentDiagnostics');
      if (!field) {
        field = document.createElement('textarea');
        field.id = 'claritideAgentDiagnostics'; field.readOnly = true;
        field.setAttribute('aria-label', copy('诊断信息，请复制后发送给支持人员', 'Diagnostics — copy and send to support'));
        field.style.cssText = 'box-sizing:border-box;width:100%;height:160px;margin-top:16px;font:12px monospace';
        host.appendChild(field);
      }
      field.value = content;
      if (typeof field.focus === 'function') field.focus();
      if (typeof field.select === 'function') field.select();
      return false;
    }
  }

  function showAgentWorkbenchOpenError(error, sourceButton) {
    var clearTransition = showAgentWorkbenchTransition();
    var overlay = document.getElementById('claritideAgentTransition');
    if (!overlay) return;
    overlay.textContent = '';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'claritideAgentErrorTitle');
    overlay.setAttribute('aria-describedby', 'claritideAgentErrorMessage');
    var panel = document.createElement('section');
    panel.style.cssText = 'box-sizing:border-box;width:min(480px,calc(100vw - 40px));max-height:calc(100vh - 48px);overflow:auto;padding:28px;border:1px solid #dde1dc;border-radius:16px;background:#fff;box-shadow:0 16px 48px #00000012';
    var title = document.createElement('h2');
    title.id = 'claritideAgentErrorTitle';
    title.style.cssText = 'margin:0 0 12px;font-size:18px;color:#242824';
    title.textContent = copy('AI 工作台未能打开', 'AI Workbench could not open');
    var message = document.createElement('p');
    message.id = 'claritideAgentErrorMessage';
    message.style.cssText = 'margin:0;line-height:1.65;font-weight:400;white-space:pre-wrap;overflow-wrap:anywhere';
    message.textContent = agentRuntimeErrorMessage(error);
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:24px';
    var diagnostics = document.createElement('button');
    diagnostics.id = 'claritideAgentCopyDiagnostics'; diagnostics.type = 'button';
    diagnostics.textContent = copy('复制诊断', 'Copy diagnostics');
    diagnostics.style.cssText = 'padding:9px 12px;border:1px solid #d9ded7;border-radius:9px;background:#fff;color:#384036;font:inherit;cursor:pointer';
    diagnostics.addEventListener('click', async function () {
      diagnostics.disabled = true;
      var copied = await copyAgentDiagnostics(error, panel);
      diagnostics.textContent = copied ? copy('已复制', 'Copied') : copy('复制诊断', 'Copy diagnostics');
      diagnostics.disabled = false;
    });
    var close = document.createElement('button');
    close.id = 'claritideAgentClose';
    close.type = 'button';
    close.textContent = copy('关闭', 'Close');
    close.style.cssText = 'padding:9px 18px;border:1px solid #d9ded7;border-radius:9px;background:#fff;color:#384036;font:inherit;cursor:pointer';
    var retry = document.createElement('button');
    retry.id = 'claritideAgentRetry';
    retry.type = 'button';
    retry.textContent = copy('重试', 'Retry');
    retry.style.cssText = 'padding:9px 18px;border:1px solid #245d45;border-radius:9px;background:#245d45;color:#fff;font:inherit;cursor:pointer';
    function dismiss() {
      clearTransition();
      var entry = ensureAgentWorkbenchEntry() || sourceButton;
      if (entry && typeof entry.focus === 'function') entry.focus();
    }
    close.addEventListener('click', dismiss);
    retry.addEventListener('click', function () {
      dismiss();
      launchAgentWorkbench(ensureAgentWorkbenchEntry() || sourceButton);
    });
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
      if (event.key === 'Tab') {
        event.preventDefault();
        var field = document.getElementById('claritideAgentDiagnostics');
        var controls = [diagnostics, close, retry];
        if (field) controls.push(field);
        controls = controls.filter(function (control) { return !control.disabled; });
        var index = controls.indexOf(document.activeElement);
        controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length].focus();
      }
    });
    actions.appendChild(diagnostics);
    actions.appendChild(close);
    actions.appendChild(retry);
    panel.appendChild(title);
    panel.appendChild(message);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    retry.focus();
  }

  function launchAgentWorkbench(button, event) {
    if (event) {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      else event.stopPropagation();
    }
    // One launch owns authorization and the transition even if My Day replaces
    // or re-enables its navigation button while native navigation is pending.
    if (agentWorkbenchLaunchPromise) return agentWorkbenchLaunchPromise;
    if (!button || button.disabled) return;
    button.disabled = true;
    var oldTransition = document.getElementById('claritideAgentTransition');
    if (oldTransition && oldTransition.parentNode) oldTransition.parentNode.removeChild(oldTransition);
    var clearTransition = showAgentWorkbenchTransition();
    agentWorkbenchLaunchPromise = openAgentWorkbench().then(function () {
      agentWorkbenchLaunchPromise = null;
      clearTransition();
      button.disabled = false;
      ensureAgentWorkbenchEntry();
    }, function (error) {
      agentWorkbenchLaunchPromise = null;
      clearTransition();
      button.disabled = false;
      ensureAgentWorkbenchEntry();
      // A WebView can suppress alert(); keep the failure visible with recovery
      // controls in the document until the user retries or dismisses it.
      showAgentWorkbenchOpenError(error, button);
    });
    return agentWorkbenchLaunchPromise;
  }

  function ensureAgentWorkbenchEntry() {
    var nav = document.querySelector('.global-nav');
    if (!nav) return null;
    var assistantButton = document.getElementById('navAssistant');
    var generatedButton = document.getElementById('navAgentWorkbench');
    var button = assistantButton || generatedButton;
    if (assistantButton && generatedButton && generatedButton !== assistantButton && generatedButton.parentNode) {
      generatedButton.parentNode.removeChild(generatedButton);
    }
    if (!button) {
      button = document.createElement('button');
      button.id = 'navAgentWorkbench';
      button.type = 'button';
      nav.appendChild(button);
    }
    if (button.dataset.claritideAgentEntry !== '1') {
      button.dataset.claritideAgentEntry = '1';
      button.addEventListener('click', function (event) {
        launchAgentWorkbench(button, event);
      }, true);
    }
    button.hidden = false;
    button.disabled = Boolean(agentWorkbenchLaunchPromise);
    button.textContent = copy('AI 工作台', 'AI Workbench');
    button.setAttribute('aria-label', button.textContent);
    return button;
  }

  function desktopPlatform() {
    var navigatorValue = window.navigator || {};
    var platform = String(
      navigatorValue.userAgentData && navigatorValue.userAgentData.platform
        ? navigatorValue.userAgentData.platform
        : navigatorValue.platform || navigatorValue.userAgent || ''
    ).toLowerCase();
    if (platform.indexOf('mac') !== -1) return 'macOS';
    if (platform.indexOf('linux') !== -1 || platform.indexOf('x11') !== -1) return 'Linux';
    return 'Windows';
  }

  function showDesktopError(message) {
    if (typeof window.alert === 'function') window.alert(String(message || ''));
  }

  function brandDesktopWorkspace() {
    document.title = 'Claritide';
    var company = document.querySelector('.global-company');
    if (company) company.textContent = 'Claritide';
    var currentMark = document.querySelector('.global-brand-mark');
    if (currentMark && currentMark.tagName === 'IMG') {
      var mark = document.createElement('span');
      mark.className = currentMark.className;
      mark.textContent = 'C';
      mark.setAttribute('aria-hidden', 'true');
      mark.style.cssText = [
        'display:grid',
        'place-items:center',
        'background:linear-gradient(145deg,#0d9588,#08675f)',
        'box-shadow:0 8px 22px rgba(13,143,131,.24)',
        'color:#fff',
        'font-size:20px',
        'font-weight:900'
      ].join(';');
      currentMark.replaceWith(mark);
    }
  }

  function ensureSyncBadge() {
    var existing = document.getElementById('seeseeyouDesktopSync');
    if (existing) return existing;
    var host = document.querySelector('.global-actions');
    if (!host) return null;
    var badge = document.createElement('button');
    badge.id = 'seeseeyouDesktopSync';
    badge.type = 'button';
    badge.style.cssText = [
      'display:none',
      'min-height:32px',
      'padding:0 11px',
      'border:1px solid #c8ded9',
      'border-radius:999px',
      'background:#f5faf8',
      'color:#526965',
      'font:inherit',
      'font-size:12px',
      'font-weight:750',
      'cursor:pointer',
      'white-space:nowrap'
    ].join(';');
    badge.addEventListener('click', function () {
      if ((currentSyncState === 'diagnostic' || currentSyncState === 'error' ||
          currentSyncState === 'version') && currentSyncDetail &&
          typeof window.alert === 'function') {
        window.alert(currentSyncDetail);
      }
      if (rebindRequired) {
        rebindDesktopSync();
      } else if (currentSyncState !== 'version') {
        ensureDesktopSync(true);
      } else {
        return;
      }
    });
    host.insertBefore(badge, host.firstChild);
    return badge;
  }

  function setSyncState(state, detail, label) {
    currentSyncState = state;
    currentSyncDetail = detail || '';
    var badge = ensureSyncBadge();
    if (!badge) return;
    if (state === 'hidden') {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.gap = '6px';
    badge.dataset.state = state;
    badge.title = detail || '';
    if (state === 'active') {
      badge.textContent = label || copy('● 同步正常', '● Sync healthy');
      badge.style.borderColor = '#bfe3dd';
      badge.style.background = '#eaf8f5';
      badge.style.color = '#087d75';
    } else if (state === 'connecting') {
      badge.textContent = copy('● 正在连接本机', '● Connecting local sync');
      badge.style.borderColor = '#c8ded9';
      badge.style.background = '#f5faf8';
      badge.style.color = '#526965';
    } else if (state === 'waiting') {
      badge.textContent = label || copy('● 加入团队后同步', '● Join a team to sync');
      badge.style.borderColor = '#c8ded9';
      badge.style.background = '#f5faf8';
      badge.style.color = '#526965';
    } else if (state === 'diagnostic') {
      badge.textContent = label || copy(
        '● 状态检测异常 · v' + DESKTOP_VERSION + ' · 重试',
        '● Status check issue · v' + DESKTOP_VERSION + ' · Retry'
      );
      badge.style.borderColor = '#ecd9b4';
      badge.style.background = '#fdf5e8';
      badge.style.color = '#8b5d0a';
    } else if (state === 'version') {
      badge.textContent = label || copy('● 客户端版本不一致', '● Desktop version mismatch');
      badge.style.borderColor = '#e7c4c1';
      badge.style.background = '#fff1f0';
      badge.style.color = '#a03d36';
    } else {
      badge.textContent = copy('● 同步异常 · 重试', '● Sync issue · Retry');
      badge.style.borderColor = '#ecd9b4';
      badge.style.background = '#fdf5e8';
      badge.style.color = '#8b5d0a';
    }
  }

  async function apiRequest(path, options, tokenOverride) {
    var opts = options || {};
    var headers = new Headers(opts.headers || {});
    var token = tokenOverride === undefined ? sessionToken() : tokenOverride;
    if (token) {
      headers.set('Authorization', 'Bearer ' + token);
      headers.set('X-Admin-Token', token);
    }
    if (opts.body && !(opts.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    var response = await window.fetch(API + path, Object.assign({}, opts, { headers: headers }));
    var body = await response.json().catch(function () { return null; });
    if (!response.ok) {
      var detail = body && body.detail;
      var message = typeof detail === 'string'
        ? detail
        : detail && typeof detail.message === 'string'
          ? detail.message
          : 'Request failed (' + response.status + ')';
      var error = new Error(message);
      error.status = response.status;
      error.code = detail && typeof detail === 'object' ? String(detail.code || '') : '';
      throw error;
    }
    return body;
  }

  async function installationId() {
    return invoke('get_or_create_installation_id');
  }

  function selectedTeam(teams) {
    var selected = window.localStorage.getItem(TEAM_KEY) || '';
    if (teams.some(function (team) { return team.team_id === selected; })) return selected;
    return teams.length === 1 ? teams[0].team_id : '';
  }

  function syncContextChanged(token, teamSelection) {
    return sessionToken() !== token ||
      (window.localStorage.getItem(TEAM_KEY) || '') !== teamSelection;
  }

  function teamName(teams, teamId) {
    var team = teams.find(function (item) { return item.team_id === teamId; });
    return team ? String(team.name || team.team_id) : String(teamId || '');
  }

  function rawErrorMessage(error) {
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    if (error !== undefined && error !== null) {
      try {
        var serialized = JSON.stringify(error);
        if (serialized && serialized !== '{}') return serialized;
      } catch (_error) {}
      return String(error);
    }
    return copy('未知错误', 'Unknown error');
  }

  function versionParts(value) {
    return String(value || '').replace(/^v/i, '').split('.').map(function (part) {
      var parsed = parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  }

  function compareVersions(left, right) {
    var a = versionParts(left);
    var b = versionParts(right);
    var length = Math.max(a.length, b.length);
    for (var i = 0; i < length; i += 1) {
      var difference = (a[i] || 0) - (b[i] || 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }

  function desktopVersionIssue(status) {
    if (!status) return '';
    var actualProtocol = Number(status.bridge_protocol);
    if (actualProtocol !== BRIDGE_PROTOCOL) {
      return copy('Web 与桌面通信协议不一致。Web 需要 ', 'Web and desktop bridge protocol mismatch. Web requires ') +
        BRIDGE_PROTOCOL + copy('，桌面程序为 ', ', desktop is ') +
        (Number.isFinite(actualProtocol) ? actualProtocol : copy('未知', 'unknown')) + '。';
    }
    var actualVersion = String(status.desktop_version || '');
    if (!actualVersion || compareVersions(actualVersion, DESKTOP_VERSION) !== 0) {
      return copy('Web 与桌面程序版本不一致。Web 为 ', 'Web and desktop versions do not match. Web is ') +
        DESKTOP_VERSION + copy('，桌面程序为 ', ', desktop is ') +
        (actualVersion || copy('未知', 'unknown')) + '。';
    }
    return '';
  }

  function recentSuccessfulUpload(status) {
    var lastSuccess = Number(status && status.last_success_at_ms);
    if (!Number.isFinite(lastSuccess) || lastSuccess <= 0) return false;
    var ageMs = Date.now() - lastSuccess;
    return ageMs >= -60000 && ageMs <= 15 * 60 * 1000;
  }

  function syncErrorDetail(error) {
    if (error && error.status === 404) {
      return copy('服务器尚未部署桌面同步接口，请更新服务器后重试。',
        'The desktop sync API is not deployed on the server yet.');
    }
    if (error && error.status === 401) {
      return copy('登录状态已失效，请重新登录。', 'Your session expired. Sign in again.');
    }
    if (error && error.code === 'no_active_team') {
      return copy('账号没有可用团队，加入团队后即可同步。', 'Join an active team to enable sync.');
    }
    if (error && (error.code === 'device_team_change_forbidden' ||
        error.code === 'device_employee_change_forbidden')) {
      return copy('这台电脑曾绑定其他团队或账号，点击同步状态可安全重新绑定。',
        'This computer was connected to another team or account. Click the sync status to rebind safely.');
    }
    return rawErrorMessage(error);
  }

  async function rebindDesktopSync() {
    if (syncRunning || loggingOut) return;
    var confirmed = window.confirm(copy(
      '原团队已不可用。是否将这台电脑重新绑定到当前团队？旧设备的历史记录会保留。',
      'The previous team is no longer available. Rebind this computer to the current team? The old device history will be preserved.'
    ));
    if (!confirmed) return;
    setSyncState('connecting', copy('正在重新绑定这台电脑。', 'Rebinding this computer.'));
    try {
      await invoke('clear_sync');
      await invoke('rotate_installation_id');
      rebindRequired = false;
      lastSyncAttempt = 0;
      await ensureDesktopSync(true);
    } catch (error) {
      setSyncState('error', syncErrorDetail(error));
    }
  }

  async function ensureDesktopSync(force) {
    if (loggingOut || agentActivationRunning) return;
    var token = sessionToken();
    var teamSelection = window.localStorage.getItem(TEAM_KEY) || '';
    if (syncRunning) {
      if (force || token !== lastSessionToken || teamSelection !== lastTeamSelection) {
        syncRerunRequested = true;
      }
      return;
    }
    if (!force && token === lastSessionToken && teamSelection === lastTeamSelection &&
        Date.now() - lastSyncAttempt < 30000) return;

    syncRunning = true;
    syncRerunRequested = false;
    lastSyncAttempt = Date.now();
    try {
      if (!token) {
        rebindRequired = false;
        setSyncState('hidden');
        var loggedOutStatus = await invoke('get_sync_status');
        if ((loggedOutStatus && loggedOutStatus.configured) ||
            syncClearPending) {
          await invoke('clear_sync');
        }
        lastSessionToken = '';
        lastTeamSelection = '';
        syncClearPending = false;
        return;
      }

      setSyncState('connecting');
      if ((lastSessionToken && token !== lastSessionToken) || syncClearPending) {
        try {
          await invoke('pause_sync');
          syncClearPending = false;
        } catch (_error) {
          syncClearPending = true;
          throw new Error(copy('无法断开旧账号的本机同步，请稍后重试。',
            'Unable to disconnect the previous local sync. Try again.'));
        }
      }
      lastSessionToken = token;
      lastTeamSelection = teamSelection;

      var status = null;
      var nativeStatusError = null;
      try {
        status = await invoke('get_sync_status');
        if (status && status.device_id) {
          window.localStorage.setItem(DEVICE_KEY, String(status.device_id));
        }
      } catch (error) {
        nativeStatusError = error;
      }
      if (syncContextChanged(token, teamSelection)) {
        syncRerunRequested = true;
        return;
      }
      var teamData = await apiRequest('/me/teams', {}, token);
      if (syncContextChanged(token, teamSelection)) {
        syncRerunRequested = true;
        return;
      }
      var teams = Array.isArray(teamData.items) ? teamData.items : [];
      if (!teams.length) {
        rebindRequired = false;
        if (status && status.configured && !status.paused) await invoke('pause_sync');
        setSyncState('waiting', copy('加入或创建团队后，这台电脑会自动开始同步。',
          'Join or create a team and this computer will start syncing automatically.'));
        return;
      }

      var versionIssue = desktopVersionIssue(status);
      if (recentSuccessfulUpload(status)) {
        var healthyDetail = copy('最近一次上传已被线上服务接受：',
          'The latest upload was accepted by the online service: ') +
          new Date(Number(status.last_success_at_ms)).toLocaleString() + '。';
        if (versionIssue) healthyDetail += ' ' + versionIssue;
        setSyncState('active', healthyDetail, versionIssue
          ? copy('● 同步正常 · 版本待更新', '● Sync healthy · Update available')
          : copy('● 同步正常', '● Sync healthy'));
        return;
      }
      if (nativeStatusError) {
        setSyncState('diagnostic', copy('本机状态查询失败：', 'Local status check failed: ') +
          rawErrorMessage(nativeStatusError));
        return;
      }
      if (versionIssue) {
        setSyncState('version', versionIssue);
        return;
      }

      if (status && status.configured) {
        if (status.employee_id && status.employee_id !== teamData.employee_id) {
          await invoke('clear_sync');
          status = await invoke('get_sync_status');
        }
      }

      if (status && status.configured) {
        if (status.team_id && !teams.some(function (team) { return team.team_id === status.team_id; })) {
          await invoke('pause_sync');
          rebindRequired = true;
          throw new Error(copy('原团队已不可用，点击同步状态可重新绑定当前团队。',
            'The previous team is no longer available. Click the sync status to rebind to the current team.'));
        }
        rebindRequired = false;
        if (status.binary_ready === false) {
          throw new Error(copy('后台同步程序缺失，请重新安装 Claritide。',
            'The background sync program is missing. Reinstall Claritide.'));
        }
        var resumeTeamId = status.team_id || selectedTeam(teams);
        if (!resumeTeamId) {
          throw new Error(copy('请先选择这台电脑所属的团队，然后点击重试。',
            'Choose this computer\'s team, then retry.'));
        }
        var boundTeamName = teamName(teams, resumeTeamId);
        if (status.paused || !status.team_id) {
          if (!status.paused) await invoke('pause_sync');
          await invoke('resume_sync', {
            employeeId: teamData.employee_id,
            teamId: resumeTeamId
          });
          if (loggingOut || syncContextChanged(token, teamSelection)) {
            await invoke('pause_sync');
            return;
          }
          lastNativeTriggerAt = Date.now();
          setSyncState('connecting', copy('正在恢复本机同步。', 'Resuming local sync.'));
          window.setTimeout(function () { ensureDesktopSync(true); }, 1800);
          return;
        }
        if (status.last_error) {
          if (force && Date.now() - lastNativeTriggerAt > 10000) {
            lastNativeTriggerAt = Date.now();
            await invoke('trigger_sync_now');
            setSyncState('connecting', copy('正在重试后台同步。', 'Retrying background sync.'));
            window.setTimeout(function () { ensureDesktopSync(true); }, 1800);
            return;
          }
          throw new Error(copy('最近一次后台同步未成功：', 'The latest background sync failed: ') +
            String(status.last_error));
        }
        if (status.running || !status.last_success_at_ms) {
          if (!status.running && Date.now() - lastNativeTriggerAt > 10000) {
            lastNativeTriggerAt = Date.now();
            await invoke('trigger_sync_now');
          }
          setSyncState('connecting', copy('首次同步完成后会自动更新状态。',
            'The status will update after the first sync completes.'));
          window.setTimeout(function () { ensureDesktopSync(true); }, 1800);
          return;
        }
        var selectedDiffers = teamSelection && status.team_id && teamSelection !== status.team_id;
        var detail = selectedDiffers
          ? copy('当前页面切换到了其他团队；为保护历史归属，本机活动仍固定同步至 ',
              'The page is showing another team. To protect historical attribution, local activity remains synced to ') + boundTeamName
          : copy('最近一次同步已成功。本机活动固定同步至 ',
              'The latest sync succeeded. Local activity is assigned to ') + boundTeamName;
        setSyncState('active', detail, copy('● 同步正常', '● Sync healthy'));
        return;
      }

      var teamId = selectedTeam(teams);
      if (!teamId) {
        throw new Error(copy('请先在右上角选择这台电脑所属的团队，然后点击重试。',
          'Choose this computer\'s team, then retry.'));
      }
      var nativeInstallationId = await installationId();
      var platform = desktopPlatform();
      if (syncContextChanged(token, teamSelection)) {
        syncRerunRequested = true;
        return;
      }
      var enrollment = await apiRequest('/devices/auto-enroll', {
        method: 'POST',
        headers: { 'X-Team-ID': teamId },
        body: JSON.stringify({
          installation_id: nativeInstallationId,
          device_name: 'Claritide ' + platform,
          platform: platform
        })
      }, token);
      window.localStorage.setItem(DEVICE_KEY, String(enrollment.device.device_id));
      if (syncContextChanged(token, teamSelection)) {
        syncRerunRequested = true;
        return;
      }
      await invoke('configure_sync', {
        config: {
          server_url: TRUSTED_ORIGIN,
          local_api_url: 'http://localhost:5600/api/0',
          device_id: enrollment.device.device_id,
          employee_id: enrollment.device.employee_id,
          team_id: enrollment.device.team_id,
          device_key: enrollment.credentials.device_token,
          hmac_secret: enrollment.credentials.hmac_secret
        }
      });
      rebindRequired = false;
      if (loggingOut || syncContextChanged(token, teamSelection)) {
        await invoke('pause_sync');
        return;
      }
      lastNativeTriggerAt = Date.now();
      setSyncState('connecting', copy('正在执行首次后台同步。',
        'The first background sync is running.'));
      window.setTimeout(function () { ensureDesktopSync(true); }, 1800);
    } catch (error) {
      if (!token) {
        syncClearPending = true;
        setSyncState('hidden');
      } else {
        if (error && (error.code === 'device_team_change_forbidden' ||
            error.code === 'device_employee_change_forbidden')) {
          rebindRequired = true;
        }
        setSyncState('error', syncErrorDetail(error));
      }
    } finally {
      syncRunning = false;
      if (syncRerunRequested && !loggingOut) {
        syncRerunRequested = false;
        window.setTimeout(function () { ensureDesktopSync(true); }, 0);
      }
    }
  }

  async function desktopGoogleLogin(button) {
    if (button.dataset.desktopBusy === '1') return;
    var original = button.innerHTML;
    button.dataset.desktopBusy = '1';
    button.disabled = true;
    button.textContent = copy('请在浏览器完成 Google 登录…', 'Finish signing in with Google in your browser…');
    try {
      var started = await apiRequest('/auth/google/start?client=desktop');
      var authorizationUrl = new URL(started.authorization_url);
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== 'accounts.google.com') {
        throw new Error('Untrusted Google authorization URL');
      }
      await invoke('open_external', { url: authorizationUrl.toString() });
      var deadline = Date.now() + Math.max(30, Math.min(Number(started.expires_in) || 600, 600)) * 1000;
      while (Date.now() < deadline) {
        var authStatus;
        try {
          authStatus = await apiRequest('/auth/google/status', {
            method: 'POST',
            body: JSON.stringify({ poll_token: started.poll_token })
          });
        } catch (pollError) {
          if (pollError && pollError.status && pollError.status < 500) throw pollError;
          await new Promise(function (resolve) { window.setTimeout(resolve, 2000); });
          continue;
        }
        if (authStatus.status === 'ready') {
          var completed = await apiRequest('/auth/google/complete', {
            method: 'POST',
            body: JSON.stringify({ poll_token: started.poll_token })
          });
          window.localStorage.setItem('my_day_session_token', completed.token);
          window.localStorage.setItem('usage_admin_token', completed.token);
          window.location.reload();
          return;
        }
        await new Promise(function (resolve) { window.setTimeout(resolve, 1500); });
      }
      throw new Error(copy('Google 登录等待超时，请重试。', 'Google sign-in timed out. Try again.'));
    } catch (error) {
      var message = syncErrorDetail(error);
      var gateError = document.getElementById('gateErr');
      if (gateError) {
        gateError.textContent = message;
        gateError.style.display = '';
      }
      button.innerHTML = original;
      button.disabled = false;
      button.dataset.desktopBusy = '0';
    }
  }

  function trustedHttpsUrl(value) {
    var parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      throw new Error(copy('服务器返回了不安全的外部链接。', 'The server returned an unsafe external link.'));
    }
    return parsed.toString();
  }

  async function desktopLogout(button) {
    if (button.dataset.desktopBusy === '1') return;
    loggingOut = true;
    var logoutToken = sessionToken();
    var original = button.textContent;
    button.dataset.desktopBusy = '1';
    button.disabled = true;
    button.textContent = copy('正在安全退出…', 'Signing out safely…');
    TOKEN_KEYS.forEach(function (key) { window.localStorage.removeItem(key); });
    try {
      await invoke('clear_sync');
    } catch (error) {
      button.disabled = false;
      button.dataset.desktopBusy = '0';
      button.textContent = original;
      button.title = copy('无法停止旧账号同步，请重试：', 'Unable to stop the previous sync. Retry: ') +
        syncErrorDetail(error);
      showDesktopError(button.title);
      if (logoutToken) {
        window.localStorage.setItem('my_day_session_token', logoutToken);
        window.localStorage.setItem('usage_admin_token', logoutToken);
      }
      loggingOut = false;
      return;
    }
    try {
      await apiRequest('/auth/logout', { method: 'POST' }, logoutToken);
    } catch (_error) {}
    var waitDeadline = Date.now() + 5000;
    while (syncRunning && Date.now() < waitDeadline) {
      await new Promise(function (resolve) { window.setTimeout(resolve, 50); });
    }
    try {
      await invoke('clear_sync');
    } catch (error) {
      if (logoutToken) {
        window.localStorage.setItem('my_day_session_token', logoutToken);
        window.localStorage.setItem('usage_admin_token', logoutToken);
      }
      button.disabled = false;
      button.dataset.desktopBusy = '0';
      button.textContent = original;
      button.title = copy('无法完成安全退出，请重试：', 'Unable to finish signing out safely. Retry: ') +
        syncErrorDetail(error);
      showDesktopError(button.title);
      loggingOut = false;
      return;
    }
    window.localStorage.removeItem(DEVICE_KEY);
    lastSessionToken = '';
    lastTeamSelection = '';
    window.location.reload();
  }

  async function desktopCalendarConnect(button) {
    if (button.dataset.desktopBusy === '1') return;
    var original = button.textContent;
    button.dataset.desktopBusy = '1';
    button.disabled = true;
    button.textContent = copy('正在浏览器打开授权…', 'Opening authorization in your browser…');
    try {
      var baseline = await apiRequest('/me/calendar');
      var baselineSignature = JSON.stringify((baseline.connections || []).map(function (connection) {
        return [connection.id, connection.status, connection.last_sync_at, connection.connected_at];
      }));
      var connectionId = Number(button.dataset.connectionId || 0);
      var suffix = connectionId ? '?connection_id=' + encodeURIComponent(connectionId) : '';
      var response = await apiRequest('/integrations/cronofy/start' + suffix);
      await invoke('open_external', { url: trustedHttpsUrl(response.authorization_url) });
      button.textContent = copy('等待浏览器授权完成…', 'Waiting for browser authorization…');
      var deadline = Date.now() + Math.max(60, Math.min(Number(response.expires_in) || 600, 600)) * 1000;
      while (Date.now() < deadline && sessionToken()) {
        await new Promise(function (resolve) { window.setTimeout(resolve, 2500); });
        var current = await apiRequest('/me/calendar').catch(function () { return null; });
        if (!current) continue;
        var signature = JSON.stringify((current.connections || []).map(function (connection) {
          return [connection.id, connection.status, connection.last_sync_at, connection.connected_at];
        }));
        if (signature !== baselineSignature) {
          window.location.reload();
          return;
        }
      }
      button.disabled = false;
      button.dataset.desktopBusy = '0';
      button.textContent = original;
    } catch (error) {
      button.disabled = false;
      button.dataset.desktopBusy = '0';
      button.textContent = original;
      button.title = syncErrorDetail(error);
    }
  }

  async function desktopTelegramBind(button) {
    if (button.dataset.desktopBusy === '1') return;
    var original = button.textContent;
    button.dataset.desktopBusy = '1';
    button.disabled = true;
    try {
      var result = await apiRequest('/employee/telegram/bind-link', { method: 'POST' });
      await invoke('open_external', { url: trustedHttpsUrl(result.url) });
      var userDrop = document.getElementById('userDrop');
      if (userDrop) userDrop.classList.remove('open');
      button.textContent = copy('已在浏览器打开 Telegram', 'Telegram opened in your browser');
    } catch (error) {
      button.title = syncErrorDetail(error);
      button.textContent = original;
      showDesktopError(copy('无法打开 Telegram：', 'Unable to open Telegram: ') + button.title);
    } finally {
      window.setTimeout(function () {
        button.disabled = false;
        button.dataset.desktopBusy = '0';
        button.textContent = original;
      }, 3000);
    }
  }

  async function desktopGoogleSignup(button) {
    if (button.dataset.desktopBusy === '1') return;
    var invite = new URL(window.location.href).searchParams.get('t') || '';
    if (!invite) return;
    var original = button.textContent;
    button.dataset.desktopBusy = '1';
    button.disabled = true;
    button.textContent = copy('请在浏览器完成 Google 注册…', 'Finish Google signup in your browser…');
    try {
      var started = await apiRequest('/auth/google/start?invite_token=' + encodeURIComponent(invite));
      await invoke('open_external', { url: trustedHttpsUrl(started.authorization_url) });
      var errorBox = document.getElementById('jErr');
      if (errorBox) {
        errorBox.textContent = copy('请在浏览器完成注册，然后返回 Claritide 登录。',
          'Finish signup in the browser, then return to Claritide and sign in.');
        errorBox.style.display = '';
      }
      window.setTimeout(function () {
        button.textContent = original;
        button.disabled = false;
        button.dataset.desktopBusy = '0';
      }, 10000);
    } catch (error) {
      button.textContent = original;
      button.disabled = false;
      button.dataset.desktopBusy = '0';
      button.title = syncErrorDetail(error);
    }
  }

  async function ensureAutostartControl() {
    var menu = document.getElementById('userDrop');
    var logout = document.getElementById('logout');
    if (!menu || !logout || document.getElementById('seeseeyouAutostart')) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'seeseeyouAutostart';
    logout.parentNode.insertBefore(button, logout);
    async function refresh() {
      try {
        var enabled = await invoke('get_autostart_enabled');
        button.dataset.enabled = enabled ? '1' : '0';
        button.textContent = enabled
          ? copy('✓ 开机自动启动', '✓ Start automatically')
          : copy('开机自动启动', 'Start automatically');
      } catch (_error) {
        button.hidden = true;
      }
    }
    button.addEventListener('click', async function (event) {
      event.stopImmediatePropagation();
      button.disabled = true;
      try {
        await invoke('set_autostart_enabled', { enabled: button.dataset.enabled !== '1' });
        await refresh();
      } finally {
        button.disabled = false;
      }
    }, true);
    await refresh();
  }

  document.addEventListener('click', function (event) {
    var logoutButton = event.target && event.target.closest
      ? event.target.closest('#logout')
      : null;
    if (logoutButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      desktopLogout(logoutButton);
      return;
    }

    var googleButton = event.target && event.target.closest
      ? event.target.closest('#googleLogin')
      : null;
    if (googleButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      desktopGoogleLogin(googleButton);
      return;
    }

    var googleSignupButton = event.target && event.target.closest
      ? event.target.closest('#googleJoin')
      : null;
    if (googleSignupButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      desktopGoogleSignup(googleSignupButton);
      return;
    }

    var calendarButton = event.target && event.target.closest
      ? event.target.closest('[data-calendar-action="connect"],[data-calendar-action="reconnect"]')
      : null;
    if (calendarButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      desktopCalendarConnect(calendarButton);
      return;
    }

    var telegramButton = event.target && event.target.closest
      ? event.target.closest('#telegramBindLink')
      : null;
    if (telegramButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      desktopTelegramBind(telegramButton);
      return;
    }

    var consoleButton = event.target && event.target.closest
      ? event.target.closest('#consoleLink')
      : null;
    if (consoleButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      invoke('open_external', { url: TRUSTED_ORIGIN + '/admin/#people' }).catch(function () {});
      var consoleMenu = document.getElementById('userDrop');
      if (consoleMenu) consoleMenu.classList.remove('open');
      return;
    }

    var teamChoice = event.target && event.target.closest
      ? event.target.closest('[data-team-menu],[data-team-switch]')
      : null;
    if (teamChoice) {
      window.setTimeout(function () { ensureDesktopSync(true); }, 250);
    }

    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    var target = new URL(link.href, window.location.href);
    var internal = target.origin === window.location.origin ||
      target.protocol === 'tauri:' || target.protocol === 'about:';
    if (!internal) {
      event.preventDefault();
      event.stopImmediatePropagation();
      invoke('open_external', { url: target.href }).catch(function () {});
    }
  }, true);

  document.addEventListener('DOMContentLoaded', function () {
    applyInstallerLanguagePreference();
    brandDesktopWorkspace();
    ensureAgentWorkbenchEntry();
    ensureSyncBadge();
    ensureAutostartControl();
    ensureDesktopSync(true);
  });
  window.addEventListener('storage', function (event) {
    if (TOKEN_KEYS.indexOf(event.key) >= 0 || event.key === TEAM_KEY) ensureDesktopSync(true);
  });
  window.addEventListener('work-i18n-change', function () {
    ensureAgentWorkbenchEntry();
    ensureDesktopSync(true);
  });
  window.setInterval(function () {
    applyInstallerLanguagePreference();
    ensureAgentWorkbenchEntry();
    ensureDesktopSync(false);
  }, 5000);

  if (window.__SEESEEYOU_BRIDGE_TEST_MODE__) {
    window.__SEESEEYOU_BRIDGE_TEST__ = {
      ensureDesktopSync: ensureDesktopSync,
      desktopLogout: desktopLogout,
      rebindDesktopSync: rebindDesktopSync,
      selectedTeam: selectedTeam,
      trustedHttpsUrl: trustedHttpsUrl,
      rawErrorMessage: rawErrorMessage,
      desktopPlatform: desktopPlatform,
      desktopVersionIssue: desktopVersionIssue,
      recentSuccessfulUpload: recentSuccessfulUpload,
      desktopTelegramBind: desktopTelegramBind,
      ensureAgentWorkbenchEntry: ensureAgentWorkbenchEntry,
      applyInstallerLanguagePreference: applyInstallerLanguagePreference,
      getSyncViewState: function () {
        return { state: currentSyncState, detail: currentSyncDetail };
      }
    };
  }
}());
