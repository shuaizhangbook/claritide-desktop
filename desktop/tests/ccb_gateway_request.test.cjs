const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const path = process.env.CLARITIDE_CCB_REQUEST_BODY_PATH;
if (!path) throw new Error('CLARITIDE_CCB_REQUEST_BODY_PATH is required');
const source = stripTypeScriptTypes(fs.readFileSync(path, 'utf8'))
  .replace(/^import .*envUtils\.js'\s*$/m, '')
  .replace(/export function /g, 'function ');

function request(env) {
  const context = { process: { env }, params: { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }], tools: [], toolChoice: undefined, enableThinking: false, maxTokens: 8192 } };
  vm.runInNewContext(source + '\nresult = buildOpenAIRequestBody(params);', context);
  return context.result;
}

test('Chat reasoning reaches the wire only after explicit gateway capability opt-in', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const body = request({ CLAUDE_CODE_EFFORT_LEVEL: effort, CLARITIDE_GATEWAY_REASONING: '1' });
    assert.equal(body.reasoning_effort, effort); assert.equal(body.max_tokens, 8192);
  }
});

test('generic providers and unsupported values retain their original request shape', () => {
  for (const env of [{}, { CLAUDE_CODE_EFFORT_LEVEL: 'high' }, { CLAUDE_CODE_EFFORT_LEVEL: 'invalid', CLARITIDE_GATEWAY_REASONING: '1' }]) {
    assert.equal(Object.hasOwn(request(env), 'reasoning_effort'), false);
  }
});

test('gateway context budgeting reaches the existing compaction threshold with positive headroom', () => {
  function moduleSource(file) {
    return stripTypeScriptTypes(fs.readFileSync(file, 'utf8'))
      .replace(/^import[\s\S]*?from '[^']+'\s*$/gm, '')
      .replace(/^export /gm, '');
  }
  const contextSource = moduleSource(process.env.CLARITIDE_CCB_CONTEXT_PATH);
  const compactSource = moduleSource(process.env.CLARITIDE_CCB_AUTOCOMPACT_PATH);
  const context = { process: { env: { CLARITIDE_GATEWAY_CONTEXT_TOKENS: '32768', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' } },
    getSdkBetas: () => [], getMaxOutputTokensForModel: () => 8192,
    isEnvTruthy: () => false, getChatGPTModelContextWindow: () => undefined,
    getModelCapability: () => undefined, getCanonicalName: value => value,
  };
  vm.createContext(context);
  vm.runInContext(contextSource, context);
  vm.runInContext(compactSource, context);
  assert.equal(context.getContextWindowForModel('gpt-test'), 32768);
  assert.equal(context.getEffectiveContextWindowSize('gpt-test'), 24576);
  assert.equal(context.getAutoCompactThreshold('gpt-test'), 11576);
  for (const value of ['', '16384', '999999', '32768oops']) {
    context.process.env.CLARITIDE_GATEWAY_CONTEXT_TOKENS = value;
    assert.equal(context.getContextWindowForModel('gpt-test'), 200000);
  }
  assert.equal(context.process.env.USER_TYPE, undefined);
});
