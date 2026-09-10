const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.CLARITIDE_AGENT_HTML_PATH || path.join(__dirname, '../workbench/agent-workbench.html'), 'utf8');
const source = html.match(/\/\/ BEGIN CLARITIDE_TASK_RUNS([\s\S]*?)\/\/ END CLARITIDE_TASK_RUNS/)[1];
const context = {};
vm.runInNewContext(source, context);
const runs = context.ClaritideTaskRuns;
const plain = value => JSON.parse(JSON.stringify(value));

function setup() {
  const session = { messages: [{ role: 'user', text: 'Keep the original conversation' }] };
  runs.start(session, 'run-1', 'Produce a checked report', 100);
  return { session, run: session.taskRuns[0], event(type, payload) { return runs.update(session, type, payload, 200); } };
}

test('canonical tool starts enrich the original operation without duplicating or prematurely completing it', () => {
  const h = setup();
  h.event('tool_started', { toolUseId: 'write-1', tool: 'Write' });
  h.event('tool_started', { toolUseId: 'write-1', tool: 'Write', canonical: true, input: { file_path: '/report.md' } });
  assert.equal(h.run.operations.length, 1);
  assert.equal(h.run.operations[0].detail, '/report.md');
  assert.equal(h.run.operations[0].status, 'running');
  assert.equal(h.run.operations[0].evidence, null);
  h.event('turn_completed', {});
  assert.equal(h.run.status, 'finished');
  assert.equal(h.run.operations[0].status, 'unknown', 'ending a turn does not prove the requested file was written');
});

test('only correlated successful tool results update the plan and file evidence', () => {
  const h = setup();
  const plan = { items: [{ content: 'Check totals', status: 'in_progress', activeForm: 'Checking totals' }], truncated: false };
  h.event('tool_completed', { toolUseId: 'orphan', outcome: 'succeeded', plan });
  assert.equal(h.run.plan, null);
  h.event('tool_started', { toolUseId: 'plan', tool: 'TodoWrite', input: { todos: plan.items } });
  assert.equal(h.run.plan, null, 'the request is not the accepted plan');
  h.event('tool_completed', { toolUseId: 'plan', tool: 'TodoWrite', outcome: 'succeeded', isError: false, plan });
  assert.deepEqual(plain(h.run.plan), plan);
  h.event('tool_started', { toolUseId: 'write', tool: 'Write' });
  h.event('tool_completed', { toolUseId: 'write', tool: 'Write', outcome: 'succeeded', evidence: { kind: 'file', path: '/report.md', status: 'succeeded' } });
  assert.equal(h.run.operations[1].evidence.path, '/report.md');
  assert.equal(h.run.operations[1].evidence.status, 'succeeded');
});

test('failure, unknown exits and incomplete commands never become successful verification', () => {
  const h = setup();
  h.event('tool_started', { toolUseId: 'test', tool: 'Bash' });
  h.event('tool_completed', { toolUseId: 'test', isError: true, outcome: 'succeeded', preview: 'FAILED 1 test', evidence: { kind: 'command', command: 'npm test', status: 'succeeded', exitCode: 1 }, plan: { items: [{ content: 'Tests', status: 'completed' }] } });
  assert.equal(h.run.operations[0].status, 'failed');
  assert.equal(h.run.operations[0].evidence.status, 'failed');
  assert.equal(h.run.plan, null);
  h.event('tool_started', { toolUseId: 'background', tool: 'Bash' });
  h.event('tool_completed', { toolUseId: 'background', outcome: 'unknown', evidence: { kind: 'command', command: 'npm test &', status: 'unknown' } });
  assert.equal(h.run.operations[1].evidence.exitCode, null);
  h.event('turn_completed', { success: true });
  assert.equal(h.run.operations[0].status, 'failed');
  assert.equal(h.run.operations[1].status, 'unknown');
});

test('command evidence remains authoritative when the transport only confirms tool invocation success', () => {
  for (const status of ['unknown', 'failed']) {
    const h = setup();
    h.event('tool_started', { toolUseId: 'command', tool: 'Bash' });
    h.event('tool_completed', { toolUseId: 'command', outcome: 'succeeded', evidence: { kind: 'command', command: 'check', status, exitCode: status === 'failed' ? 1 : null } });
    assert.equal(h.run.operations[0].status, status);
    assert.equal(h.run.operations[0].evidence.status, status);
    assert.equal(runs.restore(plain(h.session.taskRuns))[0].operations[0].status, status);
  }
});

test('distinct supported 256-character IDs never collide and invalid IDs are rejected without truncating', () => {
  const h = setup(); const prefix = 'x'.repeat(255);
  for (const suffix of ['a', 'b']) h.event('tool_started', { toolUseId: prefix + suffix, tool: 'Read' });
  assert.equal(h.run.operations.length, 2);
  h.event('tool_completed', { toolUseId: prefix + 'a', outcome: 'succeeded' });
  assert.equal(h.run.operations[0].status, 'succeeded'); assert.equal(h.run.operations[1].status, 'running');
  for (const id of ['x'.repeat(257), 'has space', 'new\nline', '', null]) h.event('tool_started', { toolUseId: id, tool: 'Read' });
  assert.equal(h.run.operations.length, 2);
});

test('duplicate completions and late starts cannot rewrite previously completed evidence', () => {
  const h = setup();
  h.event('tool_started', { toolUseId: 'test', tool: 'Bash' });
  h.event('tool_completed', { toolUseId: 'test', outcome: 'failed', preview: 'failed' });
  h.event('tool_started', { toolUseId: 'test', tool: 'Bash', canonical: true, input: { command: 'test' } });
  h.event('tool_completed', { toolUseId: 'test', outcome: 'succeeded', preview: 'passed' });
  assert.equal(h.run.operations.length, 1);
  assert.equal(h.run.operations[0].status, 'failed');
  assert.equal(h.run.operations[0].preview, 'failed');
  h.event('error', { terminal: true, code: 'session_mismatch' });
  assert.equal(h.run.status, 'failed');
  assert.equal(h.event('turn_completed', {}), false);
});

test('stop settlement stays active until confirmed and reloaded active runs become interrupted', () => {
  const h = setup();
  h.event('tool_started', { toolUseId: 'command', tool: 'Bash' });
  h.event('stopped', { settling: true }); assert.equal(h.run.status, 'running');
  const restored = runs.restore(plain(h.session.taskRuns));
  assert.equal(restored[0].status, 'interrupted');
  assert.equal(restored[0].operations[0].status, 'unknown');
  assert.equal(h.run.status, 'running', 'normalization must not mutate the live process record');
  h.event('stopped', { settling: false });
  assert.equal(h.run.status, 'stopped');
  assert.equal(h.run.operations[0].status, 'unknown');
});

test('bounded persisted summaries preserve conversation text and disclose truncation', () => {
  const h = setup();
  for (let i = 0; i < 90; i++) h.event('tool_started', { toolUseId: 'tool-' + i, tool: 'Read', input: { file_path: 'x'.repeat(3000) } });
  assert.equal(h.run.operations.length, 80);
  assert.equal(h.run.operations[0].detail.length, 2000);
  assert.equal(h.run.truncated, true);
  for (let i = 0; i < 15; i++) runs.start(h.session, 'run-' + i, 'next', 300);
  assert.equal(h.session.taskRuns.length, 12);
  assert.equal(h.session.taskRunsTruncated, true);
  assert.equal(h.session.messages[0].text, 'Keep the original conversation');
});

test('restoration validates bounded fields, retains failed evidence, and tolerates malformed old records', () => {
  const restored = runs.restore([null, { id: 'saved', status: 'finished', goal: '<img onerror=x>', operations: [null, { id: '1', status: 'failed', tool: 'Bash', evidence: { kind: 'command', status: 'failed', command: 'test', exitCode: 1 }, unexpectedSecret: 'never retained' }], plan: { items: [null, { content: 'Review', status: 'invented' }] }, arbitrary: 'never retained' }]);
  assert.equal(restored.length, 1); assert.equal(restored[0].status, 'finished');
  assert.equal(restored[0].operations.length, 1);
  assert.equal(restored[0].operations[0].status, 'failed');
  assert.equal(restored[0].plan.items[0].status, 'pending');
  assert.doesNotMatch(JSON.stringify(restored), /never retained/);
});
