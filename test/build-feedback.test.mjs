import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeedback, providerFailure, requestFeedback } from '../src/build/build-feedback.mjs';

test('buildfeedback extracts the actionable compiler location on Mac and Windows', () => {
  for (const prefix of ['/Users/test/project/', 'C:\\Users\\test\\project\\']) {
    const result = buildFeedback(`${prefix}src/App.jsx:215:8: ERROR: The symbol "translateRole" has already been declared`);
    assert.equal(result.file, 'src/App.jsx'); assert.equal(result.line, 215); assert.equal(result.column, 8);
    assert.match(result.message, /already been declared/); assert.match(result.explanation, /translateRole.*defined more than once/); assert.match(result.repairPrompt, /do not add functionality/i);
    assert.ok(!result.repairPrompt.includes(prefix));
  }
});
test('unknown build errors retain a bounded readable log without inventing a location', () => {
  const result = buildFeedback('x'.repeat(25000), "The build failed.");
  assert.equal(result.file, null); assert.equal(result.line, null); assert.equal(result.log.length, 20000);
  assert.equal(result.message, "The build failed.");
});

test('nested provider errors are detected even with HTTP 200 and never expose reasoning', () => {
  const failure = providerFailure({provider:'Nvidia', choices:[{finish_reason:'error', error:{code:502,message:'Internal server error',metadata:{error_type:'provider_unavailable'}},message:{content:null,reasoning:'PRIVATE'}}]});
  assert.equal(failure.code, '502');
  const card = requestFeedback(failure, 'Voeg declaraties toe');
  assert.equal(card.action, 'retry'); assert.equal(card.retryPrompt, 'Voeg declaraties toe');
  assert.ok(!JSON.stringify(card).includes('PRIVATE'));
  assert.equal(providerFailure({choices:[{finish_reason:'stop',message:{content:'ok'}}]}), null);
  assert.equal(providerFailure({}, 429).code, '429');
});
