import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { runCli, parseArgs, exportAttachment } from '../src/cli.mjs';
import { saveBinding, resolveBinding, localRequest } from '../src/local-client.mjs';
import { LIMITS } from '../src/common.mjs';
import { readMultipart } from '../src/transport.mjs';

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parler-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function session(workspace, id = randomUUID(), client = 'codex') {
  return { address: `node/${id}`, session_id: id, native_id: `native-${id}`, workspace, client_kind: client, token: `secret-${id}`, title: 'Research' };
}
async function invoke(args, input = '') {
  let out = '', err = '';
  const exitCode = await runCli(args, { stdin: Readable.from([input]), stdout: { write(value) { out += value; } }, stderr: { write(value) { err += value; } } });
  return { exitCode, out, err, data: out.startsWith('{') || out.startsWith('[') ? JSON.parse(out) : undefined, error: err ? JSON.parse(err).error : undefined };
}
async function daemon(t, stateDir, handler) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const result = await handler(req, bytes.length ? JSON.parse(bytes) : undefined);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { code: 'TEST_FAILURE', message: error.message } })); }
  });
  await new Promise(resolve => server.listen(path.join(stateDir, 'daemon.sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

test('root options work anywhere and repeatable options preserve order', () => {
  assert.deepEqual(parseArgs(['--state=/tmp/state', 'send', '--attach', 'a.md', '--session', 'a/b', '--attach=b.md', '--tag=x', '--tag', 'y']), {
    options: { state: '/tmp/state', attach: ['a.md', 'b.md'], session: 'a/b', tag: ['x', 'y'] }, positionals: ['send'],
  });
  assert.throws(() => parseArgs(['send', '--to']), /requires a value/);
  assert.throws(() => parseArgs(['send', '--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--state', 'a', '--state', 'b']), /Duplicate/);
});

test('session binding selection rejects ambiguity and keeps private credentials', async t => {
  const state = await directory(t), first = session(state), second = session(state, randomUUID(), 'claude-code');
  await saveBinding(state, first); await saveBinding(state, second);
  assert.equal((await resolveBinding(state, { session: first.address })).token, first.token);
  assert.equal((await resolveBinding(state, { session: second.native_id, client: 'claude-code' })).address, second.address);
  assert.equal((await resolveBinding(state, { client: 'claude-code' })).address, second.address);
  const saved = await fs.readdir(path.join(state, 'bindings'));
  for (const name of saved) assert.equal((await fs.stat(path.join(state, 'bindings', name))).mode & 0o777, 0o600);
  const previous = Object.fromEntries(['PARLER_SESSION', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID'].map(name => [name, process.env[name]]));
  for (const name of Object.keys(previous)) delete process.env[name];
  try { await assert.rejects(resolveBinding(state), { code: 'AMBIGUOUS_SESSION' }); }
  finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});

test('registration saves the credential and session output does not disclose it', async t => {
  const state = await directory(t), registered = session(state);
  await fs.writeFile(path.join(state, 'admin.token'), 'admin-secret', { mode: 0o600 });
  await daemon(t, state, (req, body) => {
    if (req.url === '/local/sessions/register') {
      assert.equal(req.headers.authorization, 'Bearer admin-secret');
      assert.equal(body.client_kind, 'codex'); assert.equal(body.native_id, registered.native_id);
      return registered;
    }
    assert.equal(req.headers.authorization, `Bearer ${registered.token}`);
    return registered;
  });
  const registration = await invoke(['session', 'register', '--client', 'codex', '--native-id', registered.native_id, '--state', state]);
  assert.equal(registration.exitCode, 0); assert.equal(registration.data.address, registered.address);
  assert.equal(registration.data.token, undefined); assert.ok(!registration.out.includes(registered.token));
  const shown = await invoke(['session', 'show', '--state', state, '--session', registered.address]);
  assert.equal(shown.exitCode, 0); assert.equal(shown.data.token, undefined);
});

test('send supports text convenience and bounded JSON stdin', async t => {
  const state = await directory(t), current = session(state); await saveBinding(state, current);
  const received = [];
  await daemon(t, state, (req, body) => { assert.equal(req.url, '/local/messages'); assert.equal(req.headers.authorization, `Bearer ${current.token}`); received.push(body); return { id: 'message-1', status: 'queued' }; });
  const options = ['--state', state, '--session', current.address];
  const sent = await invoke(['send', '--to', 'other/session', '--kind', 'request', '--text', 'Research?', ...options]);
  assert.equal(sent.data.status, 'queued'); assert.deepEqual(received[0], { to: 'other/session', kind: 'request', body: { text: 'Research?' } });
  const json = await invoke(['send', ...options], JSON.stringify({ to: 'other/session', kind: 'result', body: { text: 'Complete' } }));
  assert.equal(json.exitCode, 0); assert.equal(received[1].kind, 'result');
  const oversize = await invoke(['send', ...options], JSON.stringify({ body: { text: 'x'.repeat(LIMITS.envelopeBytes) } }));
  assert.equal(oversize.error.code, 'LIMIT_EXCEEDED'); assert.equal(received.length, 2);
});

test('receive accepts a legal batch larger than the generic response bound', async t => {
  const state = await directory(t), current = session(state); await saveBinding(state, current);
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: `message-${index}`, body: { text: 'x'.repeat(60 * 1024) }, delivery_token: `lease-${index}` }));
  await daemon(t, state, req => {
    assert.equal(req.url, '/local/messages?');
    assert.equal(req.headers.authorization, `Bearer ${current.token}`);
    return { messages };
  });
  const received = await invoke(['receive', '--state', state, '--session', current.address]);
  assert.equal(received.exitCode, 0, received.err);
  assert.equal(received.data.messages.length, 20);
  assert.equal(received.data.messages[19].body.text.length, 60 * 1024);
});

test('peer invitations use an exclusive private file and redact secrets', async t => {
  const state = await directory(t), output = path.join(state, 'invitation.json');
  await fs.writeFile(path.join(state, 'admin.token'), 'admin-secret', { mode: 0o600 });
  await daemon(t, state, () => ({ node_id: 'node', for_node_id: 'other', token: 'pairing-secret', endpoint: 'https://127.0.0.1:7337', certificate: 'certificate' }));
  const result = await invoke(['peer', 'export', '--for', 'other', '--output', output, '--state', state]);
  assert.equal(result.exitCode, 0); assert.ok(!result.out.includes('pairing-secret'));
  assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).token, 'pairing-secret');
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  const second = await invoke(['peer', 'export', '--for', 'other', '--output', output, '--state', state]);
  assert.equal(second.error.code, 'EEXIST');
});

test('attachment export checks hash, traversal, symlinks and overwrite', async t => {
  const root = await directory(t), outside = await directory(t), bytes = Buffer.from('# Findings\n');
  const descriptor = { id: 'attachment', filename: 'research.md', media_type: 'text/markdown', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const result = await exportAttachment(root, 'deliverables/research.md', bytes, descriptor);
  assert.equal(await fs.readFile(result.output, 'utf8'), bytes.toString());
  await assert.rejects(exportAttachment(root, 'deliverables/research.md', bytes, descriptor), { code: 'OUTPUT_EXISTS' });
  await assert.rejects(exportAttachment(root, '../escape.md', bytes, descriptor), { code: 'UNSAFE_PATH' });
  await assert.rejects(exportAttachment(root, path.join(outside, 'escape.md'), bytes, descriptor), { code: 'UNSAFE_PATH' });
  await fs.symlink(outside, path.join(root, 'link'));
  await assert.rejects(exportAttachment(root, 'link/escape.md', bytes, descriptor), { code: 'UNSAFE_PATH' });
  await fs.symlink(path.join(outside, 'escape.md'), path.join(root, 'destination.md'));
  await assert.rejects(exportAttachment(root, 'destination.md', bytes, descriptor), { code: 'OUTPUT_EXISTS' });
  await assert.rejects(exportAttachment(root, 'corrupt.md', Buffer.from('corrupt'), descriptor), { code: 'INTEGRITY_ERROR' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('send rejects oversized files and symlinks before daemon admission', async t => {
  const state = await directory(t), current = session(state), large = path.join(state, 'large.md');
  await saveBinding(state, current);
  const handle = await fs.open(large, 'w'); await handle.truncate(LIMITS.fileBytes + 1); await handle.close();
  const options = ['send', '--state', state, '--session', current.address, '--to', 'other/session', '--text', 'result'];
  assert.equal((await invoke([...options, '--attach', large])).error.code, 'LIMIT_EXCEEDED');
  await fs.symlink(large, path.join(state, 'link.md'));
  assert.equal((await invoke([...options, '--attach', path.join(state, 'link.md')])).error.code, 'ELOOP');
});

test('CLI uploads deliverable bytes through multipart without daemon filesystem paths', async t => {
  const state = await directory(t), current = session(state), file = path.join(state, 'research.md');
  await saveBinding(state, current);
  const original = Buffer.from('# Research\nSources and findings.\n');
  await fs.writeFile(file, original);
  const stagingDir = path.join(state, 'staging'); await fs.mkdir(stagingDir, { mode: 0o700 });
  let captured;
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${current.token}`);
      captured = await readMultipart(req, req.headers['content-type'], { stagingDir, limits: LIMITS, reserve: () => 'reservation' });
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'result-id', status: 'queued' }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { code: error.code, message: error.message } })); }
  });
  await new Promise(resolve => server.listen(path.join(state, 'daemon.sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await invoke(['send', '--state', state, '--session', current.address, '--to', 'other/session', '--kind', 'result', '--text', 'Complete', '--attach', file]);
  assert.equal(result.exitCode, 0, result.err);
  assert.equal(captured.envelope.attachments[0].filename, 'research.md');
  assert.equal(captured.envelope.attachments[0].path, undefined);
  await fs.writeFile(file, 'changed after capture');
  assert.deepEqual(await fs.readFile(captured.stagedAttachments[0].path), original);
});

test('local requests enforce timeout, authentication and response bounds', async t => {
  const state = await directory(t);
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer session-secret');
    if (req.url === '/local/large') res.end(JSON.stringify({ text: 'x'.repeat(2048) }));
    else if (req.url === '/local/denied') { res.statusCode = 403; res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Permission denied', retryable: false } })); }
  });
  await new Promise(resolve => server.listen(path.join(state, 'daemon.sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(localRequest(state, { path: '/local/large', token: 'session-secret', maxResponseBytes: 1024 }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(localRequest(state, { path: '/local/denied', token: 'session-secret' }), { code: 'FORBIDDEN', status: 403 });
  await assert.rejects(localRequest(state, { path: '/local/hang', token: 'session-secret', timeoutMs: 20 }), { code: 'DAEMON_TIMEOUT', retryable: true });
});
