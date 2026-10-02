import test from 'node:test';
import assert from 'node:assert/strict';
import { privateEndpoint, privateHost, attachmentManifest, LIMITS, sha256 } from '../src/common.mjs';

test('private endpoints exclude cloud/DERP-prone addresses and ambiguous URL forms', () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.2', '::1', 'fd01::2']) assert.equal(privateHost(host), true, host);
  for (const host of ['0.0.0.0', '8.8.8.8', '100.64.0.1', 'fd7a:115c:a1e0::2', 'fd7a:115c:a1e0:0000:0000:0000:0000:0002', 'localhost', 'example.com', '::']) assert.equal(privateHost(host), false, host);
  assert.equal(privateEndpoint('https://127.0.0.1:7743'), 'https://127.0.0.1:7743');
  for (const value of ['http://127.0.0.1', 'https://example.com', 'https://100.70.1.2', 'https://user:secret@10.0.0.1', 'https://10.0.0.1/x', 'https://10.0.0.1/?redirect=yes']) assert.throws(() => privateEndpoint(value));
});

test('attachment metadata enforces independent file and combined size limits', () => {
  const item = (id, size) => ({ id, filename: 'research.md', media_type: 'text/markdown', size_bytes: size, sha256: sha256('') });
  assert.throws(() => attachmentManifest([item('a', LIMITS.fileBytes + 1)]), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => attachmentManifest(Array.from({ length: 4 }, (_, i) => item(`a${i}`, LIMITS.fileBytes))), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => attachmentManifest([item('a', 0), item('a', 0)]), { code: 'INVALID_INPUT' });
  assert.throws(() => attachmentManifest([{ ...item('a', 0), filename: '../private.md' }]), { code: 'INVALID_INPUT' });
  assert.equal(attachmentManifest([item('a', LIMITS.fileBytes)]).length, 1);
});
