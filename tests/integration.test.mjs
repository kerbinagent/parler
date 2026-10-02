import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initState } from '../src/config.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { multipartBody, requestPeer } from '../src/transport.mjs';
import { LIMITS, PROTOCOL, sha256 } from '../src/common.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function waitFor(fn, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = await fn();
    if (result) return result;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(30);
  }
}

async function local(node, method, route, body, token = node.admin) {
  const multipart = body?.contentType && body?.body;
  const contentType = multipart ? body.contentType : 'application/json';
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path.join(node.stateDir, 'daemon.sock'), method,
      path: route, headers: { authorization: `Bearer ${token}`, 'content-type': contentType } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks), headers: res.headers }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Local request timed out')));
    (async () => {
      try {
        if (multipart) {
          for await (const chunk of body.body) {
            if (!request.write(chunk)) await new Promise((resolveDrain, rejectDrain) => {
              request.once('drain', resolveDrain);
              request.once('error', rejectDrain);
            });
          }
          request.end();
        } else request.end(body === undefined ? undefined : JSON.stringify(body));
      } catch (error) { request.destroy(error); }
    })();
  });
  if (response.headers['content-type']?.includes('application/json')) response.json = JSON.parse(response.bytes);
  return response;
}

async function ok(node, method, route, body, token) {
  const response = await local(node, method, route, body, token);
  assert.ok(response.status >= 200 && response.status < 300,
    `${method} ${route}: ${response.status} ${response.bytes.toString()}`);
  return response.json;
}

async function cli(node, args, { success = true } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin/parler.mjs'), '--state', node.stateDir,
      '--format', 'json', ...args], { cwd: node.workspace, env: { ...process.env, PARLER_SESSION: '',
        CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
  if (success) assert.equal(result.code, 0, `CLI failed: ${result.stderr}\n${result.stdout}`);
  else assert.notEqual(result.code, 0, 'CLI unexpectedly succeeded');
  if (success) result.json = JSON.parse(result.stdout);
  return result;
}

async function fixture(t, count = 2, { limits = {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'parler-integration-'));
  const nodes = [];
  t.after(async () => {
    for (const node of nodes) if (node.daemon) await node.daemon.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < count; i++) {
    const node = { stateDir: path.join(directory, `node-${i}`), workspace: path.join(directory, `work-${i}`) };
    nodes.push(node);
    await mkdir(node.workspace);
    await initState({ stateDir: node.stateDir, label: `host-${i}`, listen: '127.0.0.1', port: 0,
      timing: { snapshotSeconds: 1 }, limits });
    node.admin = (await readFile(path.join(node.stateDir, 'admin.token'), 'utf8')).trim();
    node.daemon = await startDaemon({ stateDir: node.stateDir, workerIntervalMs: 20 });
    node.info = await ok(node, 'GET', '/local/info');
  }
  return nodes;
}

async function stop(node) {
  await node.daemon.close();
  node.daemon = null;
}

async function restart(node) {
  node.daemon = await startDaemon({ stateDir: node.stateDir, workerIntervalMs: 20 });
  node.info = await ok(node, 'GET', '/local/info');
}

async function pair(a, b) {
  const aInvitation = await ok(a, 'POST', '/local/peers/export', { for_node_id: b.info.node_id });
  const bInvitation = await ok(b, 'POST', '/local/peers/export', { for_node_id: a.info.node_id });
  await ok(a, 'POST', '/local/peers/import', bInvitation);
  await ok(b, 'POST', '/local/peers/import', aInvitation);
  return { aToB: bInvitation, bToA: aInvitation };
}

async function register(node, client, title, nativeId = randomUUID()) {
  const result = await cli(node, ['session', 'register', '--client', client, '--native-id', nativeId,
    '--workspace', node.workspace, '--title', title, '--project-label', 'parler']);
  const session = await ok(node, 'POST', '/local/sessions/register', {
    client_kind: client, native_id: nativeId, workspace: node.workspace, title, project_label: 'parler',
  });
  assert.ok(!result.stdout.includes(session.token), 'CLI must not print a session token');
  return session;
}

function envelope(from, to, overrides = {}) {
  return { protocol: PROTOCOL, id: randomUUID(), conversation_id: randomUUID(), from, to,
    kind: 'request', reply_to: null, created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(), body: { text: 'Research this topic.' },
    attachments: [], ...overrides };
}

async function deliverWithoutReadingReceipt(peer, nodeId, message) {
  const endpoint = new URL(peer.endpoint);
  const socket = tls.connect({ host: endpoint.hostname, port: Number(endpoint.port), rejectUnauthorized: false });
  socket.setTimeout(5000, () => socket.destroy(new Error('Receipt loss test connection timed out')));
  const agent = new https.Agent({ keepAlive: false });
  let request;
  try {
    await once(socket, 'secureConnect');
    assert.deepEqual(socket.getPeerCertificate().raw, new X509Certificate(peer.certificate).raw,
      'Pin TLS certificate before sending authentication headers or message bytes');
    agent.createConnection = () => socket;
    const bytes = Buffer.from(JSON.stringify(message));
    return await new Promise((resolve, reject) => {
      request = https.request(endpoint, { method: 'POST', path: '/v0/messages', agent, headers: {
        authorization: `Bearer ${peer.token}`, 'x-parler-node': nodeId,
        'content-type': 'application/json', 'content-length': bytes.length,
      } }, response => {
        // Headers mean the receiver committed. Lose the connection before consuming its JSON receipt.
        const status = response.statusCode;
        response.destroy();
        request.destroy();
        socket.destroy();
        resolve(status);
      });
      request.once('error', reject);
      request.end(bytes);
    });
  } finally {
    request?.destroy();
    socket.destroy();
    agent.destroy();
  }
}

test('Codex and Claude Code discover each other and exchange durable Markdown deliverables', { timeout: 40_000 }, async t => {
  const [a, b] = await fixture(t);
  await pair(a, b);
  const implementer = await register(a, 'codex', 'Parler implementation');
  const researcher = await register(b, 'claude-code', 'Private network research');
  const duplicateTitle = await register(b, 'codex', 'Private network research');
  const unrelated = await register(a, 'claude-code', 'Unrelated work');
  const subagentTitle = 'Unpublished subagent research';
  const subagent = await local(a, 'POST', '/local/sessions/register', { client_kind: 'codex',
    native_id: randomUUID(), workspace: a.workspace, title: subagentTitle, coordinator_role: 'subagent' });
  assert.ok(subagent.status >= 400 && subagent.status < 500, 'Subagents cannot enroll as coordinators');
  const subagentListing = await ok(a, 'GET', `/local/sessions?query=${encodeURIComponent(subagentTitle)}`, undefined, implementer.token);
  assert.equal(subagentListing.sessions.length, 0);
  const matches = await waitFor(async () => {
    const listing = await ok(a, 'GET', '/local/sessions?query=network%20research&refresh=1', undefined, implementer.token);
    return listing.sessions.find(session => session.address === researcher.address) && listing;
  }, 'remote research session discovery');
  assert.equal(matches.sessions.find(session => session.address === researcher.address).client_kind, 'claude-code');
  assert.ok(matches.sessions.some(session => session.address === duplicateTitle.address),
    'Matching titles return all candidates rather than silently selecting a recipient');
  assert.ok(!JSON.stringify(matches).includes(researcher.native_id));
  assert.ok(!JSON.stringify(matches).includes(b.workspace));
  assert.ok(!JSON.stringify(matches).includes(researcher.token));
  await ok(b, 'PATCH', '/local/session', { title: 'Network attachment research', task_summary: 'Return sources in Markdown' }, researcher.token);
  const changed = await waitFor(async () => {
    const listing = await ok(a, 'GET', '/local/sessions?query=attachment%20research&refresh=1', undefined, implementer.token);
    return listing.sessions.find(session => session.address === researcher.address && session.title === 'Network attachment research');
  }, 'changed title propagation');
  assert.equal(changed.address, researcher.address);
  const request = await ok(a, 'POST', '/local/messages', { to: researcher.address, kind: 'request',
    body: { text: 'Research private delivery and return a Markdown report.' } }, implementer.token);
  const receivedRequest = await waitFor(async () => {
    const inbox = await ok(b, 'GET', '/local/messages', undefined, researcher.token);
    return inbox.messages.find(message => message.id === request.id);
  }, 'research request delivery');
  assert.equal(receivedRequest.from, implementer.address);
  assert.equal((await ok(b, 'GET', '/local/messages', undefined, researcher.token)).messages.length, 0,
    'Concurrent receives must respect active delivery leases');
  const ack = await ok(b, 'POST', `/local/messages/${request.id}/ack`, { delivery_token: receivedRequest.delivery_token }, researcher.token);
  assert.deepEqual(await ok(b, 'POST', `/local/messages/${request.id}/ack`, { delivery_token: receivedRequest.delivery_token }, researcher.token), ack);
  await waitFor(async () => (await ok(a, 'GET', `/local/messages/${request.id}`, undefined, implementer.token)).status === 'acknowledged', 'request acknowledgment reconciliation');

  // Queue while the destination is offline, then delete the only session-owned source file.
  await stop(a);
  const markdown = Buffer.from('# Private delivery research\n\nUTF-8 findings: café, λ.\n\n- Source: https://example.test/research\n');
  const source = path.join(b.workspace, 'research.md');
  await writeFile(source, markdown);
  const sent = await cli(b, ['--session', researcher.address, 'send', '--to', implementer.address,
    '--kind', 'result', '--reply-to', request.id, '--conversation-id', receivedRequest.conversation_id,
    '--text', 'Findings and sources are attached.', '--attach', source]);
  const resultId = sent.json.id;
  assert.ok(resultId);
  await rm(source);
  await stop(b);
  await restart(a);
  await restart(b);
  const receivedResult = await waitFor(async () => {
    const inbox = await ok(a, 'GET', '/local/messages', undefined, implementer.token);
    return inbox.messages.find(message => message.id === resultId);
  }, 'queued result delivery after both daemon restarts');
  assert.equal(receivedResult.kind, 'result');
  assert.equal(receivedResult.reply_to, request.id);
  assert.equal(receivedResult.conversation_id, receivedRequest.conversation_id);
  assert.equal(receivedResult.attachments.length, 1);
  const attachment = receivedResult.attachments[0];
  assert.equal(attachment.filename, 'research.md');
  assert.equal(attachment.sha256, sha256(markdown));
  await stop(b);
  await stop(a);
  await restart(a);
  const exportPath = path.join(a.workspace, 'delivered.md');
  await cli(a, ['--session', implementer.address, 'attachments', 'export', '--message', resultId,
    '--attachment', attachment.id, '--output', exportPath]);
  assert.deepEqual(await readFile(exportPath), markdown, 'Recipient keeps independent bytes after sender shutdown');
  const forbidden = await local(a, 'GET', `/local/messages/${resultId}/attachments/${attachment.id}`, undefined, unrelated.token);
  assert.ok([403, 404].includes(forbidden.status), 'Unrelated sessions must not read known attachment IDs');
  assert.equal((await local(a, 'POST', `/local/messages/${resultId}/ack`, { delivery_token: 'wrong' }, implementer.token)).status >= 400, true);
  await ok(a, 'POST', `/local/messages/${resultId}/ack`, { delivery_token: receivedResult.delivery_token }, implementer.token);
  await cli(a, ['--session', implementer.address, 'attachments', 'export', '--message', resultId,
    '--attachment', attachment.id, '--output', exportPath], { success: false });
  const escapePath = path.join(path.dirname(a.workspace), 'escaped.md');
  await cli(a, ['--session', implementer.address, 'attachments', 'export', '--message', resultId,
    '--attachment', attachment.id, '--output', escapePath], { success: false });
  const outside = path.join(path.dirname(a.workspace), 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(a.workspace, 'link'));
  await cli(a, ['--session', implementer.address, 'attachments', 'export', '--message', resultId,
    '--attachment', attachment.id, '--output', path.join(a.workspace, 'link', 'escaped.md')], { success: false });
});

test('authenticated retries deduplicate, reject conflicts and reject forged sender/snapshot ownership', { timeout: 30_000 }, async t => {
  const [a, b] = await fixture(t);
  const { aToB, bToA } = await pair(a, b);
  const sender = await register(a, 'codex', 'Research request');
  const recipient = await register(b, 'claude-code', 'Research response');
  const message = envelope(sender.address, recipient.address);
  const send = (body, route = '/v0/messages') => requestPeer(aToB, { method: 'POST', path: route, body, nodeId: a.info.node_id });
  assert.equal(await deliverWithoutReadingReceipt(aToB, a.info.node_id, message), 200);
  const first = b.daemon.store.getReceipt(a.info.node_id, message.id);
  assert.equal(first.status, 'persisted_remote', 'Commit survives loss of the receipt connection');
  // The sender lost its connection before reading the receipt and resubmits the immutable envelope.
  const duplicate = await send(message);
  assert.equal(duplicate.id, first.id);
  const inbox = await ok(b, 'GET', '/local/messages', undefined, recipient.token);
  assert.equal(inbox.messages.filter(item => item.id === message.id).length, 1);
  await assert.rejects(send({ ...message, body: { text: 'Conflicting replacement' } }), error => error.status === 409);
  await assert.rejects(send(envelope(sender.address, recipient.address, {
    created_at: '2099-01-01T00:00:00Z', expires_at: '2099-01-01T00:01:00Z',
  })), error => error.status === 400 && error.code === 'INVALID_INPUT');
  assert.equal(b.daemon.store.stats().reserved_bytes, 0, 'Future mail is rejected before transfer reservation');
  await assert.rejects(send(envelope(recipient.address, recipient.address)), error => error.status === 403);
  await assert.rejects(requestPeer({ ...aToB, token: 'invalid-peer-token' }, { method: 'GET', path: '/v0/info', nodeId: a.info.node_id }), error => error.status === 401 || error.status === 403);
  await assert.rejects(send({ node_id: a.info.node_id, revision: 1_000_000,
    published_at: new Date().toISOString(), sessions: [{ ...recipient, token: undefined }] }, '/v0/announcements'),
  error => error.status === 400 || error.status === 403);
  const snapshot = await requestPeer(bToA, { path: '/v0/sessions', nodeId: b.info.node_id });
  const updated = { ...snapshot, revision: snapshot.revision + 1000,
    sessions: snapshot.sessions.map(session => ({ ...session, title: 'Updated authoritative research' })) };
  await send(updated, '/v0/announcements');
  await send(snapshot, '/v0/announcements');
  await send(updated, '/v0/announcements');
  const cached = await ok(b, 'GET', '/local/sessions?query=Updated%20authoritative', undefined, recipient.token);
  assert.ok(cached.sessions.some(session => session.address === sender.address),
    'Old or duplicate snapshots cannot replace metadata from a newer revision');
  const badPeer = await local(a, 'POST', '/local/peers/import', { ...aToB, endpoint: 'https://8.8.8.8:443' });
  assert.equal(badPeer.status, 400);
  assert.equal(badPeer.json.error.code, 'INVALID_ENDPOINT');
  const tailnet = await local(a, 'POST', '/local/peers/import', { ...aToB, endpoint: 'https://100.100.1.2:443' });
  assert.equal(tailnet.status, 400);
  const rawUnauthorized = await local(a, 'GET', '/local/info', undefined, 'wrong-admin-token');
  assert.ok([401, 403].includes(rawUnauthorized.status));
});

test('attachments enforce per-file/combined limits and integrity before inbox visibility', { timeout: 30_000 }, async t => {
  const [a, b] = await fixture(t);
  const { aToB } = await pair(a, b);
  const sender = await register(a, 'codex', 'Deliverable sender');
  const recipient = await register(b, 'claude-code', 'Deliverable receiver');
  const descriptor = (id, bytes) => ({ id, filename: `${id}.md`, media_type: 'text/markdown',
    size_bytes: bytes, sha256: 'a'.repeat(64) });
  const oversized = envelope(sender.address, recipient.address, { attachments: [descriptor('too-big', LIMITS.fileBytes + 1)] });
  await assert.rejects(requestPeer(aToB, { method: 'POST', path: '/v0/messages', body: oversized,
    nodeId: a.info.node_id }), error => error.status === 413);
  const total = envelope(sender.address, recipient.address, { attachments: Array.from({ length: 4 }, (_, i) => descriptor(`file-${i}`, LIMITS.fileBytes)) });
  await assert.rejects(requestPeer(aToB, { method: 'POST', path: '/v0/messages', body: total,
    nodeId: a.info.node_id }), error => error.status === 413);
  const source = path.join(a.workspace, 'corrupt.md');
  const bytes = Buffer.from('# Contents fail their advertised digest\n');
  await writeFile(source, bytes);
  const corrupt = envelope(sender.address, recipient.address, { attachments: [descriptor('corrupt', bytes.length)] });
  const multipart = multipartBody(corrupt, [{ ...corrupt.attachments[0], path: source }]);
  await assert.rejects(requestPeer(aToB, { method: 'POST', path: '/v0/messages', body: multipart.body,
    contentType: multipart.contentType, nodeId: a.info.node_id }), error => error.status >= 400 && error.status < 500);
  assert.equal((await ok(b, 'GET', '/local/messages', undefined, recipient.token)).messages.length, 0);
  const notice = await ok(b, 'POST', '/local/notices', { event: 'Stop', stop_hook_active: false }, recipient.token);
  assert.equal(notice.message_ids.length, 0, 'Failed transfer must not become a hook notice');
  assert.equal((await local(b, 'GET', `/local/messages/${corrupt.id}`, undefined, recipient.token)).status, 404);
});

test('an attachment retry succeeds when its original delivery filled host and session quotas', { timeout: 20_000 }, async t => {
  const bytes = Buffer.alloc(32, 'q');
  const [a, b] = await fixture(t, 2, { limits: { hostBytes: bytes.length, sessionBytes: bytes.length } });
  const { aToB } = await pair(a, b);
  const sender = await register(a, 'codex', 'Quota sender');
  const recipient = await register(b, 'claude-code', 'Quota receiver');
  const source = path.join(a.workspace, 'quota.md');
  await writeFile(source, bytes);
  const descriptor = { id: 'quota-file', filename: 'quota.md', media_type: 'text/markdown',
    size_bytes: bytes.length, sha256: sha256(bytes) };
  const message = envelope(sender.address, recipient.address, { attachments: [descriptor] });
  const send = value => {
    const multipart = multipartBody(value, [{ ...descriptor, path: source }]);
    return requestPeer(aToB, { method: 'POST', path: '/v0/messages', nodeId: a.info.node_id,
      body: multipart.body, contentType: multipart.contentType });
  };
  const receipt = await send(message);
  assert.equal(b.daemon.store.hostBytes(), bytes.length);
  assert.equal(b.daemon.store.sessionBytes(recipient.session_id), bytes.length);
  await assert.rejects(send({ ...message, id: randomUUID() }), error => error.code === 'QUOTA_EXCEEDED' && error.status === 507);
  const duplicate = await send(message);
  assert.equal(duplicate.id, receipt.id, 'A retry returns its existing durable receipt without reserving bytes again');
  assert.deepEqual(duplicate.attachment_ids, receipt.attachment_ids);
  const inbox = await ok(b, 'GET', '/local/messages', undefined, recipient.token);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].id, message.id);
  assert.deepEqual((await local(b, 'GET', `/local/messages/${message.id}/attachments/${descriptor.id}`, undefined, recipient.token)).bytes, bytes);
});

test('same-host attachment delivery reuses stored bytes when the physical host quota is full', { timeout: 20_000 }, async t => {
  const bytes = Buffer.alloc(32, 'l');
  const [node] = await fixture(t, 1, { limits: { hostBytes: bytes.length, sessionBytes: bytes.length } });
  const sender = await register(node, 'codex', 'Local sender');
  const recipient = await register(node, 'claude-code', 'Local researcher');
  const source = path.join(node.workspace, 'local.md');
  await writeFile(source, bytes);
  const sent = await cli(node, ['--session', sender.address, 'send', '--to', recipient.address,
    '--kind', 'result', '--text', 'Local deliverable.', '--attach', source]);
  const message = await waitFor(async () => {
    const inbox = await ok(node, 'GET', '/local/messages', undefined, recipient.token);
    return inbox.messages.find(item => item.id === sent.json.id);
  }, 'same-host delivery at physical host capacity');
  assert.equal(node.daemon.store.hostBytes(), bytes.length);
  assert.equal(node.daemon.store.sessionBytes(sender.session_id), bytes.length);
  assert.equal(node.daemon.store.sessionBytes(recipient.session_id), bytes.length);
  const delivered = await local(node, 'GET', `/local/messages/${message.id}/attachments/${message.attachments[0].id}`, undefined, recipient.token);
  assert.equal(delivered.status, 200);
  assert.deepEqual(delivered.bytes, bytes);
});
