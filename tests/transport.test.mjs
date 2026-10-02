import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer as createTcpServer } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LIMITS, sha256 } from '../src/common.mjs';
import { readJson, multipartBody, readMultipart, requestPeer } from '../src/transport.mjs';

const exec = promisify(execFile);
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'parler-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function attachment(bytes, id = 'file1') {
  return { id, filename: 'research.md', media_type: 'text/markdown', size_bytes: bytes.length, sha256: sha256(bytes) };
}
function envelope(attachments = []) {
  return { to: 'node2/session2', kind: 'result', body: { text: 'Research attached.' }, attachments };
}
function uploadParts(value, files = [], boundary = 'test-boundary') {
  const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="envelope"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}`)];
  for (const { name, bytes } of files) {
    parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`), bytes);
  }
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { bytes: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
function split(bytes, chunkSize) {
  return Readable.from((function* () {
    for (let at = 0; at < bytes.length; at += chunkSize) yield bytes.subarray(at, at + chunkSize);
  })());
}

test('JSON reading enforces byte limits and object input', async () => {
  assert.deepEqual(await readJson(split(Buffer.from('{"ok":true}'), 1), 11), { ok: true });
  await assert.rejects(readJson(split(Buffer.from('{"ok":true}'), 1), 10), { code: 'LIMIT_EXCEEDED', status: 413 });
  for (const text of ['[1]', 'null', '{broken']) {
    await assert.rejects(readJson(Readable.from([text]), 100), { code: 'INVALID_JSON' });
  }
  await assert.rejects(readJson(Readable.from([Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])]), 100), { code: 'INVALID_JSON' });
});

test('multipart streams to private staging with split boundaries and binary boundary-like bytes', async t => {
  const stagingDir = await temporary(t);
  const bytes = Buffer.from('## Research\n\0\xff\r\n--test-boundaryXXpayload\r\n', 'latin1');
  const value = envelope([attachment(bytes)]);
  const upload = uploadParts(value, [{ name: 'attachment:file1', bytes }]);
  let reserved = false;
  const result = await readMultipart(split(upload.bytes, 1), upload.contentType, {
    stagingDir, reserve: input => { assert.deepEqual(input, value); reserved = true; return 'reserved'; },
  });
  assert.equal(reserved, true);
  assert.equal(result.reservationId, 'reserved');
  assert.deepEqual(result.envelope, value);
  assert.equal(result.stagedAttachments.length, 1);
  assert.deepEqual(await readFile(result.stagedAttachments[0].path), bytes);
  assert.equal((await stat(result.stagedAttachments[0].path)).mode & 0o777, 0o600);
});

test('multipartBody round-trips local and complete network envelopes in bounded chunks', async t => {
  const dir = await temporary(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0xa5);
  const path = join(dir, 'source');
  await writeFile(path, bytes);
  const value = { ...envelope([attachment(bytes)]), protocol: 'parler/0', from: 'node1/session1', id: 'message1' };
  const upload = multipartBody(value, [{ ...attachment(bytes), path }]);
  let largest = 0;
  async function* observed() { for await (const chunk of upload.body) { largest = Math.max(largest, chunk.length); yield chunk; } }
  const result = await readMultipart(observed(), upload.contentType, { stagingDir: join(dir, 'staging') });
  assert.equal(largest <= 64 * 1024, true);
  assert.deepEqual(await readFile(result.stagedAttachments[0].path), bytes);
  assert.equal(result.envelope.from, value.from);
});

test('zero-byte files and envelopes without attachments are supported', async t => {
  const dir = await temporary(t);
  const bytes = Buffer.alloc(0);
  const upload = uploadParts(envelope([attachment(bytes)]), [{ name: 'attachment:file1', bytes }]);
  const result = await readMultipart(split(upload.bytes, 7), upload.contentType, { stagingDir: dir });
  assert.equal((await stat(result.stagedAttachments[0].path)).size, 0);
  const noFiles = uploadParts(envelope());
  const empty = await readMultipart(split(noFiles.bytes, 5), noFiles.contentType, { stagingDir: dir });
  assert.deepEqual(empty.stagedAttachments, []);
});

test('manifest per-file, combined size, count, and envelope limits are rejected before reservation', async t => {
  const dir = await temporary(t);
  const cases = [
    [envelope([attachment(Buffer.alloc(11))]), { ...LIMITS, fileBytes: 10 }],
    [envelope([attachment(Buffer.alloc(6)), attachment(Buffer.alloc(6), 'file2')]), { ...LIMITS, messageBytes: 10 }],
    [envelope([attachment(Buffer.alloc(0))]), { ...LIMITS, attachmentCount: 0 }],
    [envelope(), { ...LIMITS, envelopeBytes: 10 }],
  ];
  for (const [value, limits] of cases) {
    const upload = uploadParts(value);
    let reserved = false;
    await assert.rejects(readMultipart(split(upload.bytes, 17), upload.contentType, {
      stagingDir: dir, limits, reserve: () => { reserved = true; },
    }), { code: 'LIMIT_EXCEEDED', status: 413 });
    assert.equal(reserved, false);
    assert.deepEqual(await readdir(dir), []);
  }
});

test('failed uploads remove all staging files and expose the reservation for release', async t => {
  const dir = await temporary(t);
  const bytes = Buffer.from('research');
  const value = envelope([attachment(bytes), attachment(bytes, 'file2')]);
  const valid = uploadParts(value, [{ name: 'attachment:file1', bytes }, { name: 'attachment:file2', bytes }]);
  const malformed = [
    uploadParts(value, [{ name: 'attachment:file1', bytes }]).bytes,
    uploadParts(value, [{ name: 'attachment:file1', bytes }, { name: 'attachment:file1', bytes }]).bytes,
    uploadParts(value, [{ name: 'attachment:file1', bytes }, { name: 'attachment:unknown', bytes }]).bytes,
    uploadParts(value, [{ name: 'attachment:file1', bytes }, { name: 'attachment:file2', bytes: Buffer.from('bad-hash') }]).bytes,
    valid.bytes.subarray(0, valid.bytes.length - 20),
    Buffer.concat([valid.bytes, Buffer.from('trailing bytes')]),
  ];
  for (const payload of malformed) {
    await assert.rejects(readMultipart(split(payload, 13), valid.contentType, { stagingDir: dir, reserve: () => 'reservation1' }), error => {
      assert.equal(error.reservationId, 'reservation1');
      return true;
    });
    assert.deepEqual(await readdir(dir), []);
  }
});

test('multipart limits oversized attachment data without retaining staging files', async t => {
  const dir = await temporary(t);
  const value = envelope([attachment(Buffer.from('a'))]);
  const upload = uploadParts(value, [{ name: 'attachment:file1', bytes: Buffer.alloc(65536) }]);
  await assert.rejects(readMultipart(split(upload.bytes, 4096), upload.contentType, {
    stagingDir: dir, reserve: () => 'reservation1',
  }), { code: 'LIMIT_EXCEEDED', reservationId: 'reservation1' });
  assert.deepEqual(await readdir(dir), []);
});

test('multipart rejects envelope order, invalid boundaries, duplicate headers, oversized headers, and unsafe manifests', async t => {
  const dir = await temporary(t);
  const valid = uploadParts(envelope());
  const mutations = [
    valid.bytes.toString().replace('name="envelope"', 'name="attachment:file1"'),
    valid.bytes.toString().replace('Content-Type: application/json', 'Content-Type: application/json\r\nContent-Type: application/json'),
    valid.bytes.toString().replace('Content-Type: application/json', `X-Huge: ${'x'.repeat(9000)}`),
    uploadParts(envelope([{ ...attachment(Buffer.alloc(0)), filename: '../escape' }])).bytes,
  ];
  for (const payload of mutations) await assert.rejects(readMultipart(Readable.from([payload]), valid.contentType, { stagingDir: dir }));
  await assert.rejects(readMultipart(Readable.from([]), 'multipart/form-data; boundary="bad\r\n"', { stagingDir: dir }), { code: 'INVALID_MULTIPART' });
  assert.deepEqual(await readdir(dir), []);
});

test('multipartBody detects a source modified after manifest creation', async t => {
  const dir = await temporary(t);
  const bytes = Buffer.from('original');
  const path = join(dir, 'source');
  await writeFile(path, 'modified');
  const upload = multipartBody(envelope([attachment(bytes)]), [{ ...attachment(bytes), path }]);
  await assert.rejects(async () => { for await (const _ of upload.body) {} }, { code: 'INTEGRITY_FAILED' });
});

async function credentials(dir, label) {
  const key = join(dir, `${label}.key`), cert = join(dir, `${label}.crt`);
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', `/CN=${label}`, '-days', '1'], { maxBuffer: 64 * 1024 });
  return { key: await readFile(key), cert: await readFile(cert, 'utf8') };
}
async function server(t, options, handler) {
  const service = createServer(options, handler);
  service.on('tlsClientError', () => {});
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(() => new Promise(resolve => { service.close(resolve); service.closeAllConnections(); }));
  return { service, endpoint: `https://127.0.0.1:${service.address().port}` };
}

test('private peer HTTPS pins certificates and sends authentication and streamed multipart', async t => {
  const dir = await temporary(t);
  const options = await credentials(dir, 'peer');
  const path = join(dir, 'research.md');
  const bytes = Buffer.from('# Research\nFindings.');
  await writeFile(path, bytes);
  let received;
  const { endpoint } = await server(t, options, async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer secret');
      assert.equal(req.headers['x-parler-node'], 'node1');
      assert.equal(req.url, '/v0/messages');
      received = await readMultipart(req, req.headers['content-type'], { stagingDir: join(dir, 'received') });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"status":"persisted_remote"}');
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  const upload = multipartBody(envelope([attachment(bytes)]), [{ ...attachment(bytes), path }]);
  const result = await requestPeer({ endpoint, certificate: options.cert, token: 'secret' }, {
    method: 'POST', path: '/v0/messages', body: upload.body, contentType: upload.contentType, nodeId: 'node1',
  });
  assert.deepEqual(result, { status: 'persisted_remote' });
  assert.deepEqual(await readFile(received.stagedAttachments[0].path), bytes);
});

test('certificate mismatch sends no HTTP headers or body', async t => {
  const dir = await temporary(t);
  const options = await credentials(dir, 'peer');
  const other = await credentials(dir, 'other');
  let received = 0;
  const { endpoint } = await server(t, options, (req, res) => { received++; res.end('{}'); });
  await assert.rejects(requestPeer({ endpoint, certificate: other.cert, token: 'secret' }, {
    method: 'POST', path: '/v0/messages', body: { private: 'payload' }, nodeId: 'node1',
  }), { code: 'CERTIFICATE_MISMATCH', retryable: false });
  assert.equal(received, 0);
});

test('private peer rejects redirects, bounds response bytes, and propagates remote errors', async t => {
  const dir = await temporary(t);
  const options = await credentials(dir, 'peer');
  const { endpoint } = await server(t, options, (req, res) => {
    if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('Location', 'https://example.com'); res.end(); }
    else if (req.url === '/large') res.end(JSON.stringify({ data: 'x'.repeat(1000) }));
    else { res.statusCode = 409; res.end(JSON.stringify({ error: { code: 'CONFLICT', message: 'Already exists', retryable: false } })); }
  });
  const peer = { endpoint, certificate: options.cert, token: 'secret' };
  await assert.rejects(requestPeer(peer, { path: '/redirect', nodeId: 'node1' }), { code: 'REDIRECT_REJECTED' });
  await assert.rejects(requestPeer(peer, { path: '/large', nodeId: 'node1', maxResponseBytes: 100 }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(requestPeer(peer, { path: '/conflict', nodeId: 'node1' }), { code: 'CONFLICT', status: 409, retryable: false });
});

test('private peer timeout covers stalled response and upload', async t => {
  const dir = await temporary(t);
  const options = await credentials(dir, 'peer');
  const { endpoint } = await server(t, options, () => {});
  const peer = { endpoint, certificate: options.cert, token: 'secret' };
  await assert.rejects(requestPeer(peer, { path: '/stall', nodeId: 'node1', timeoutMs: 80 }), { code: 'PEER_TIMEOUT', retryable: true });
  async function* stalled() { await new Promise(() => {}); }
  await assert.rejects(requestPeer(peer, { method: 'POST', path: '/stall', nodeId: 'node1', body: stalled(), timeoutMs: 80 }), { code: 'PEER_TIMEOUT' });
});

test('external cancellation rejects pre-aborted calls and interrupts a TLS handshake', async t => {
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(requestPeer({}, { signal: preAborted.signal }), { code: 'PEER_CANCELLED', retryable: true });
  const dir = await temporary(t);
  const options = await credentials(dir, 'peer');
  const sockets = new Set();
  let connection;
  const connected = new Promise(resolve => { connection = resolve; });
  const service = createTcpServer(socket => { sockets.add(socket); connection(); });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(() => new Promise(resolve => { service.close(resolve); for (const socket of sockets) socket.destroy(); }));
  const controller = new AbortController();
  const request = requestPeer({ endpoint: `https://127.0.0.1:${service.address().port}`, certificate: options.cert, token: 'secret' }, {
    path: '/stall', nodeId: 'node1', signal: controller.signal, timeoutMs: 10000,
  });
  await connected;
  controller.abort();
  await assert.rejects(request, { code: 'PEER_CANCELLED', retryable: true });
});

test('external cancellation interrupts upload backpressure and closes the source iterator', async t => {
  const dir = await temporary(t);
  const options = await credentials(dir, 'peer');
  let accepted;
  const incoming = new Promise(resolve => { accepted = resolve; });
  const { endpoint } = await server(t, options, req => { req.pause(); accepted(); });
  const controller = new AbortController();
  let closed = false;
  async function* body() {
    try { for (;;) yield Buffer.alloc(1024 * 1024); }
    finally { closed = true; }
  }
  const request = requestPeer({ endpoint, certificate: options.cert, token: 'secret' }, {
    method: 'POST', path: '/stall', nodeId: 'node1', signal: controller.signal, body: body(), timeoutMs: 10000,
  });
  await incoming;
  controller.abort();
  await assert.rejects(request, { code: 'PEER_CANCELLED', retryable: true });
  await nextTurn();
  assert.equal(closed, true);
});

test('non-private, DNS, tailnet, insecure, and credentialed endpoints fail before connecting', async () => {
  for (const endpoint of ['https://example.com', 'https://8.8.8.8', 'https://100.100.1.1', 'https://[fd7a:115c:a1e0::1]', 'http://127.0.0.1', 'https://user:pass@127.0.0.1', 'https://127.0.0.1/path']) {
    await assert.rejects(requestPeer({ endpoint, token: 'secret' }, { path: '/v0/sessions', nodeId: 'node1' }), { code: 'INVALID_ENDPOINT' });
  }
});
