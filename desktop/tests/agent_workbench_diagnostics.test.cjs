const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const source = script.slice(script.indexOf('function diagnosticsText('), script.indexOf('function effortLabel('));

test('local diagnostics include the installed build without account, prompt, credential or path fields', () => {
  const context = {};
  vm.runInNewContext(source, context);
  const text = context.diagnosticsText({
    available: true, accountScope: 'acct_secret', token: 'private-token', lastError: '/Users/private/file',
    capabilities: { effort: true }, allowedEfforts: ['max', 'low', 'low', 'private-token', '/Users/private/file', 'high\nsecret', { secret: 'private' }],
    messages: ['private prompt'], buildInfo: {
      appVersion: '0.2.2', buildNumber: '34', productRevision: 'a'.repeat(40),
      webuiRevision: 'b'.repeat(40), platform: 'windows-x86_64', runId: '33954233073',
      workflow: 'private-workflow', token: 'private-build-token', engineRevision: 'oops\nsecret',
    },
  });
  assert.match(text, /appVersion: 0\.2\.2/);
  assert.match(text, /buildNumber: 34/);
  assert.match(text, /runtimeAvailable: true/);
  assert.match(text, /effortAdvertised: true/);
  assert.match(text, /allowedEfforts: low, max/);
  assert.doesNotMatch(text, /private|secret|prompt|workflow|engineRevision/);
});

test('clipboard failure leaves local diagnostics selectable and never copies the full runtime state', async () => {
  const field = { value: 'safe report', focus() { this.focused = true; }, select() { this.selected = true; } };
  const context = { $: () => field, navigator: {}, english: true, showToast() {} };
  vm.runInNewContext(source, context);
  await context.copyDiagnostics();
  assert.equal(field.focused, true);
  assert.equal(field.selected, true);
  let copied;
  context.navigator.clipboard = { async writeText(value) { copied = value; } };
  await context.copyDiagnostics();
  assert.equal(copied, 'safe report');
});
