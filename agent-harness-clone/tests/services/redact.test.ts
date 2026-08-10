import assert from 'node:assert/strict';
import test from 'node:test';
import { REDACTED, redact } from '../../src/services/redact.js';

test('redaction preserves diagnostic error codes while removing authorization codes', () => {
  const result = redact({
    code: 'HEADLESS_PAYLOAD_INVALID',
    error: { code: 'MODEL_ERROR' },
    oauthCode: 'oauth-secret',
    authorizationCode: 'authorization-secret',
  }) as Record<string, unknown>;

  assert.equal(result.code, 'HEADLESS_PAYLOAD_INVALID');
  assert.deepEqual(result.error, { code: 'MODEL_ERROR' });
  assert.equal(result.oauthCode, REDACTED);
  assert.equal(result.authorizationCode, REDACTED);
});
