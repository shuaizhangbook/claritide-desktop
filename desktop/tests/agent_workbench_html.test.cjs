const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const htmlPath = process.env.CLARITIDE_AGENT_HTML_PATH;
if (!htmlPath) {
  throw new Error('CLARITIDE_AGENT_HTML_PATH must point to agent-workbench.html');
}

const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

test('native startup is acknowledged after rendering and the first runtime status check', async () => {
  const initSource = scripts[0].slice(scripts[0].indexOf('async function init()'), scripts[0].lastIndexOf('void init();'));
  const calls = [];
  let resolveStatus;
  const status = new Promise(resolve => { resolveStatus = resolve; });
  const context = {
    bridge: { onEvent() { calls.push('subscribe'); }, async markReady() { calls.push('ready'); } },
    handleEvent() {},
    async refreshRuntimeStatus() { calls.push('status'); await status; },
    window: { setInterval() {} },
  };
  for (const name of ['applyTranslations', 'initLayout', 'load', 'restoreDraft', 'bind', 'showLegacyHistoryNotice', 'updateHistoryNotice', 'renderProjects', 'renderConversation', 'renderAttachments', 'renderActivity', 'syncControls']) {
    context[name] = () => { calls.push(name); };
  }
  vm.runInNewContext(initSource + '\nthis.startup = init();', context);
  assert.ok(calls.includes('bind') && calls.includes('renderConversation'));
  assert.equal(calls.includes('ready'), false, 'native navigation success cannot stand in for UI readiness');
  resolveStatus();
  await context.startup;
  assert.deepEqual(calls.slice(-2), ['syncControls', 'ready']);
});

test('failed UI initialization never falsely acknowledges a successful open', async () => {
  const initSource = scripts[0].slice(scripts[0].indexOf('async function init()'), scripts[0].lastIndexOf('void init();'));
  let acknowledged = false;
  const context = {
    applyTranslations() {}, initLayout() {}, load() {}, restoreDraft() {},
    bind() { throw new Error('broken control binding'); },
    bridge: { async markReady() { acknowledged = true; } },
  };
  vm.runInNewContext(initSource + '\nthis.startup = init();', context);
  await assert.rejects(context.startup, /broken control binding/);
  assert.equal(acknowledged, false);
});

test('workbench is a bilingual, deny-by-default local document', () => {
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /Content-Security-Policy[^>]+default-src 'none'/);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'agent-workbench-inline.js' }));
  assert.doesNotMatch(html, /https:\/\/(fonts\.googleapis|cdn\.jsdelivr)/);
  assert.match(html, /locale = new URLSearchParams\(window\.location\.search\)/);
  assert.match(html, /document\.documentElement\.lang = locale/);
  assert.match(html, /Claritide · AI Workbench/);
  assert.match(html, /applyTranslations\(\)/);
  assert.match(html, /locale: locale/);
});

test('input-first composer exposes only the six primary controls', () => {
  for (const id of [
    'addContext',
    'projectButton',
    'permissionButton',
    'modelEffortButton',
    'voiceButton',
    'send',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.equal((html.match(/id="prompt"/g) || []).length, 1);
  assert.equal((html.match(/id="modelSelect"/g) || []).length, 1);
  assert.equal((html.match(/id="permissionButton"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="topModel"|id="bottomModel"|id="topPermission"|id="bottomPermission"/);
  assert.match(html, /描述你想完成的任务/);
  assert.match(html, /event\.key === 'Enter' && !event\.shiftKey/);
});

test('projects and chats are automatic, manageable, and safe to remove', () => {
  assert.match(html, /id="newProject"/);
  assert.match(html, /id="newSession"/);
  assert.match(html, /id="projectList"/);
  assert.match(html, /function ensureConversation\(value\)/);
  assert.match(html, /session = ensureConversation\(value\)/);
  assert.match(html, /function deleteProject\(projectId\)/);
  assert.match(html, /function deleteSession\(sessionId\)/);
  assert.match(html, /不会删除本地文件/);
  assert.match(html, /bridge\.selectWorkspace\(\)/);
  assert.match(html, /bridge\.startSession/);
});

test('model and effort share one control and pass a validated session effort', () => {
  assert.match(html, /id="modelEffortButton"/);
  assert.match(html, /id="modelEffortPopover"/);
  assert.match(html, /id="effortRange"[^>]+aria-describedby="effortNote"/);
  assert.match(html, /var EFFORT_LEVELS = \['low', 'medium', 'high', 'xhigh', 'max'\]/);
  assert.match(html, /effort: requestEffort\(\)/);
  assert.match(html, /model: session\.model/);
});

test('permission controls preserve session-scoped full-access confirmation', () => {
  assert.match(html, /data-permission="controlled"/);
  assert.match(html, /data-permission="readonly"/);
  assert.match(html, /data-permission="full"/);
  assert.match(html, /id="fullAccessModal"/);
  assert.match(html, /这是高风险权限/);
  assert.match(html, /仅本对话授权/);
  assert.match(html, /permission: session\.permission/);
  assert.match(html, /if \(session\.permission === 'full'\) session\.permission = 'controlled'/);
  assert.match(html, /fullAccessGrants/);
});

test('files, voice, stop, progress, result, and error states are functional', () => {
  assert.match(html, /id="fileInput"[^>]+multiple/);
  assert.match(html, /await file\.text\(\)/);
  assert.match(html, /buildRuntimeContent\(value, attachments\)/);
  assert.match(html, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.match(html, /recognition\.start\(\)/);
  assert.match(html, /function onSendClick\(\)\s*\{\s*if \(state\.turnActive\) return stop\(\)/);
  assert.match(html, /addEventListener\('keydown', onPromptKeydown\)/);
  assert.match(html, /className = 'run-indicator'/);
  assert.match(html, /className = 'result-card'/);
  assert.match(html, /className = approvalUnsupported \? 'approval-card' : 'error-card'/);
  assert.match(html, /bridge\.send/);
  assert.match(html, /bridge\.stop/);
  assert.match(html, /bridge\.onEvent\(handleEvent\)/);
});

test('same-window navigation and return are explicit', () => {
  assert.match(html, /返回/);
  assert.match(html, /var WORKSPACE_URL = 'https:\/\/watch\.sding\.me\/admin\/my-day\/\?desktop=1';/);
  assert.match(html, /window\.location\.assign\(WORKSPACE_URL\)/);
  assert.match(html, /await closeNativeSession\(true\)/);
  assert.match(html, /clearOnline: clearOnline === true/);
  assert.doesNotMatch(html, /window\.open\(/);
});

test('bundled runtime uses only the authorized online gateway and in-memory token', () => {
  const runtimePath = process.env.CLARITIDE_AGENT_RUNTIME_PATH;
  if (!runtimePath) return;
  const runtime = fs.readFileSync(runtimePath, 'utf8');
  assert.match(runtime, /ONLINE_GATEWAY_URL: &str = "https:\/\/watch\.sding\.me\/api\/v1\/agent-ai\/openai\/v1"/);
  assert.match(runtime, /source == RuntimeSource::Bundled && online\.is_none\(\)/);
  assert.match(runtime, /\.env\("CLAUDE_CODE_USE_OPENAI", "1"\)/);
  assert.match(runtime, /\.env\("OPENAI_BASE_URL", &online\.gateway_url\)/);
  assert.match(runtime, /\.env\("OPENAI_API_KEY", &online\.token\)/);
  assert.match(runtime, /\.env\("OPENAI_MODEL", &model\)/);
  assert.match(runtime, /online_runtime: Option<OnlineRuntimeConfig>/);
  assert.doesNotMatch(runtime, /write\([^\n]*online\.token|serialize[^\n]*online_runtime/i);
});

test('runtime and user-controlled values render as text, never trusted HTML', () => {
  assert.match(html, /bubble\.textContent = safeText\(text\)/);
  assert.match(html, /copy\.textContent = eventDetail\(event\.kind, event\.payload\)/);
  assert.match(html, /name\.textContent = project\.name/);
  assert.match(html, /title\.textContent = session\.name/);
  assert.doesNotMatch(html, /innerHTML\s*=/);
});
