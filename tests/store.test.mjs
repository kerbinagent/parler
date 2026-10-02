import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { PROTOCOL, sha256 } from '../src/common.mjs';

function setup(t, options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'parler-store-'));
  let time = Date.parse('2026-10-01T12:00:00Z');
  let store = new Store({ stateDir, nodeId: 'host-a', now: () => time, ...options });
  t.after(() => { try { store.close(); } catch {} rmSync(stateDir, { recursive: true, force: true }); });
  return { get store() { return store; }, stateDir, advance(ms) { time += ms; }, restart() { store.close(); store = new Store({ stateDir, nodeId: 'host-a', now: () => time, ...options }); }, get time() { return time; } };
}
function session(store, native = randomUUID(), metadata = {}) {
  return store.registerSession({ client_kind: 'codex', native_id: native, workspace: '/private/work', ...metadata });
}
function envelope(ctx, from, to, attachments = [], fields = {}) {
  return { protocol: PROTOCOL, id: randomUUID(), conversation_id: randomUUID(), from, to, kind: 'result', body: { text: 'Research complete' }, created_at: new Date(ctx.time).toISOString(), expires_at: new Date(ctx.time + 60000).toISOString(), attachments, ...fields };
}
function stage(store, text, id = randomUUID()) {
  const bytes = Buffer.from(text), descriptor = { id, filename: 'research.md', media_type: 'text/markdown; charset=utf-8', size_bytes: bytes.length, sha256: sha256(bytes) };
  const path = join(store.stagingDir, randomUUID());
  writeFileSync(path, bytes, { mode: 0o600 });
  return { descriptor, staged: { ...descriptor, path } };
}
function inbox(ctx, recipient, fields = {}) {
  const e = envelope(ctx, 'host-b/researcher', recipient.address, [], fields);
  ctx.store.putMessage({ direction: 'inbox', envelope: e });
  return e;
}

test('sessions persist stable native bindings, tokens, safe advertisements and roles', t => {
  const ctx = setup(t), first = session(ctx.store, 'native-1', { title: 'Migration research', visible_peers: ['host-b'] });
  assert.equal(session(ctx.store, 'native-1').session_id, first.session_id);
  assert.equal(ctx.store.authenticateSession(first.token).native_id, 'native-1');
  assert.throws(() => ctx.store.authenticateSession('bad'), { status: 401 });
  assert.equal(ctx.store.listLocalSessions('host-c').length, 0);
  const publicRecord = ctx.store.listLocalSessions('host-b')[0];
  for (const key of ['token', 'native_id', 'workspace', 'visible_peers']) assert.equal(key in publicRecord, false);
  assert.equal(publicRecord.coordinator_role, 'main');
  assert.throws(() => ctx.store.registerSession({ client_kind: 'codex', native_id: 'sub', role: 'subagent' }), { code: 'INVALID_INPUT' });
  ctx.advance(121000);
  assert.equal(ctx.store.listLocalSessions()[0].presence, 'stale');
  ctx.store.touchSession(first.session_id, 'PostToolUse');
  assert.equal(ctx.store.listLocalSessions()[0].activity, 'working');
  const before = ctx.store.createSnapshot('host-b');
  ctx.restart();
  assert.equal(ctx.store.authenticateSession(first.token).session_id, first.session_id);
  assert.ok(ctx.store.createSnapshot('host-b').revision > before.revision);
  ctx.store.closeSession(first.session_id);
  assert.equal(ctx.store.listLocalSessions()[0].presence, 'closed');
  assert.equal(statSync(ctx.stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(ctx.stateDir, 'store.sqlite')).mode & 0o777, 0o600);
});

test('directory capacity reclaims only closed sessions without retained mail or reservations', t => {
  const ctx = setup(t, { limits: { snapshotSessions: 2 }, timing: { retentionSeconds: 1 } });
  const active = session(ctx.store, 'active'), closed = session(ctx.store, 'closed');
  const message = inbox(ctx, closed);
  ctx.store.closeSession(closed.session_id);
  assert.throws(() => session(ctx.store, 'next'), { code: 'SESSION_LIMIT' });
  ctx.advance(61001);
  const reservation = ctx.store.reserveBytes(closed.session_id, 0);
  assert.throws(() => session(ctx.store, 'next'), { code: 'SESSION_LIMIT' });
  ctx.store.releaseReservation(reservation);
  const next = session(ctx.store, 'next');
  assert.notEqual(next.session_id, closed.session_id);
  assert.equal(ctx.store.authenticateSession(active.token).session_id, active.session_id);
  assert.throws(() => ctx.store.authenticateSession(closed.token), { code: 'UNAUTHORIZED' });
  assert.throws(() => ctx.store.messageStatus(closed.session_id, message.id), { code: 'NOT_FOUND' });
  assert.equal(ctx.store.createSnapshot().sessions.length, 2);
});

test('new messages reject future clocks and expiry beyond the configured delivery window', t => {
  const ctx = setup(t, { timing: { maxTtlSeconds: 120 } }), recipient = session(ctx.store);
  assert.throws(() => inbox(ctx, recipient, { created_at: '2099-01-01T00:00:00Z', expires_at: '2099-01-01T00:01:00Z' }), { code: 'INVALID_INPUT' });
  assert.throws(() => inbox(ctx, recipient, { expires_at: new Date(ctx.time + 181000).toISOString() }), { code: 'INVALID_INPUT' });
  inbox(ctx, recipient, { created_at: new Date(ctx.time + 59000).toISOString(), expires_at: new Date(ctx.time + 119000).toISOString() });
  assert.equal(ctx.store.receive(recipient.session_id).messages.length, 1);
  assert.equal(ctx.store.stats().messages, 1);
});

test('complete attachments are immutable, durable, authorized, deduplicated and conflict checked', t => {
  const ctx = setup(t), sender = session(ctx.store), recipient = session(ctx.store), stranger = session(ctx.store);
  const { descriptor, staged } = stage(ctx.store, '# Results\nA researched answer.');
  const e = envelope(ctx, sender.address, recipient.address, [descriptor]);
  const out = ctx.store.putMessage({ direction: 'outbox', envelope: e, stagedAttachments: [staged] });
  assert.equal(out.status, 'queued');
  assert.equal(readdirSync(ctx.store.stagingDir).length, 0);
  const original = ctx.store.attachment(sender.session_id, e.id, descriptor.id);
  assert.equal(readFileSync(original.path, 'utf8'), '# Results\nA researched answer.');
  assert.throws(() => ctx.store.attachment(stranger.session_id, e.id, descriptor.id), { status: 404 });
  ctx.store.putMessage({ direction: 'inbox', envelope: e, stagedAttachments: [original] });
  assert.equal(ctx.store.stats().blob_bytes, descriptor.size_bytes);
  assert.equal(ctx.store.sessionBytes(sender.session_id), descriptor.size_bytes);
  assert.equal(ctx.store.sessionBytes(recipient.session_id), descriptor.size_bytes);
  ctx.restart();
  assert.equal(readFileSync(ctx.store.attachment(recipient.session_id, e.id, descriptor.id).path, 'utf8'), '# Results\nA researched answer.');
  assert.equal(ctx.store.putMessage({ direction: 'inbox', envelope: e }).status, 'persisted_remote');
  assert.throws(() => ctx.store.putMessage({ direction: 'inbox', envelope: { ...e, body: { text: 'Changed' } } }), { status: 409 });
  assert.equal(ctx.store.receive(recipient.session_id).messages.length, 1);
  assert.equal(ctx.store.receive(recipient.session_id).messages.length, 0);
});

test('corrupt and missing attachments remain invisible and path traversal/symlinks fail', t => {
  const ctx = setup(t), recipient = session(ctx.store);
  const { descriptor, staged } = stage(ctx.store, 'correct');
  const e = envelope(ctx, 'host-b/researcher', recipient.address, [descriptor]);
  assert.throws(() => ctx.store.putMessage({ direction: 'inbox', envelope: e }), { code: 'INCOMPLETE_MESSAGE' });
  writeFileSync(staged.path, 'corrupt');
  assert.throws(() => ctx.store.putMessage({ direction: 'inbox', envelope: e, stagedAttachments: [staged] }), { code: 'INTEGRITY_ERROR' });
  assert.equal(ctx.store.receive(recipient.session_id).messages.length, 0);
  const outside = join(ctx.stateDir, 'outside'); writeFileSync(outside, 'correct');
  assert.throws(() => ctx.store.putMessage({ direction: 'inbox', envelope: e, stagedAttachments: [{ ...staged, path: outside }] }), { code: 'UNSAFE_PATH' });
  const link = join(ctx.store.stagingDir, 'link'); symlinkSync(outside, link);
  assert.throws(() => ctx.store.putMessage({ direction: 'inbox', envelope: e, stagedAttachments: [{ ...staged, path: link }] }), { code: 'UNSAFE_PATH' });
  assert.equal(ctx.store.stats().messages, 0);
});

test('reservations enforce concurrent host/session quotas and logical dedup references', t => {
  const ctx = setup(t, { limits: { hostBytes: 12, sessionBytes: 10 } }), a = session(ctx.store), b = session(ctx.store);
  const r = ctx.store.reserveBytes(a.session_id, 8);
  assert.throws(() => ctx.store.reserveBytes(a.session_id, 3), { code: 'QUOTA_EXCEEDED', retryable: true });
  assert.throws(() => ctx.store.reserveBytes(b.session_id, 5), { code: 'QUOTA_EXCEEDED' });
  ctx.store.releaseReservation(r);
  const first = stage(ctx.store, '12345678'), e = envelope(ctx, a.address, b.address, [first.descriptor]);
  const reserve = ctx.store.reserveBytes(a.session_id, 8);
  ctx.store.putMessage({ direction: 'outbox', envelope: e, stagedAttachments: [first.staged], reservationId: reserve });
  assert.equal(ctx.store.stats().reserved_bytes, 0);
  ctx.store.putMessage({ direction: 'inbox', envelope: e, stagedAttachments: [ctx.store.attachment(a.session_id, e.id, first.descriptor.id)] });
  assert.equal(ctx.store.stats().blob_bytes, 8);
  assert.equal(ctx.store.checkDuplicate('inbox', e).status, 'persisted_remote');
  assert.throws(() => ctx.store.checkDuplicate('inbox', { ...e, kind: 'error' }), { code: 'CONFLICT' });
  assert.equal(ctx.store.checkDuplicate('inbox', { ...e, id: randomUUID() }), null);
  assert.throws(() => ctx.store.putMessage({ direction: 'inbox', envelope: { ...e, id: randomUUID() }, stagedAttachments: [ctx.store.attachment(a.session_id, e.id, first.descriptor.id)] }), { code: 'QUOTA_EXCEEDED' });
});

test('leases reissue after expiry, reject stale tokens, and acknowledgments persist through restart', t => {
  const ctx = setup(t), recipient = session(ctx.store), e = inbox(ctx, recipient);
  const first = ctx.store.receive(recipient.session_id, { leaseSeconds: 1 }).messages[0];
  assert.throws(() => ctx.store.ack(recipient.session_id, e.id, 'bad'), { code: 'INVALID_DELIVERY_TOKEN' });
  ctx.advance(1001);
  assert.throws(() => ctx.store.ack(recipient.session_id, e.id, first.delivery_token), { code: 'LEASE_EXPIRED' });
  const second = ctx.store.receive(recipient.session_id).messages[0];
  assert.notEqual(first.delivery_token, second.delivery_token);
  assert.throws(() => ctx.store.ack(recipient.session_id, e.id, first.delivery_token), { code: 'INVALID_DELIVERY_TOKEN' });
  const receipt = ctx.store.ack(recipient.session_id, e.id, second.delivery_token);
  assert.equal(receipt.status, 'acknowledged');
  ctx.restart();
  assert.deepEqual(ctx.store.ack(recipient.session_id, e.id, second.delivery_token), receipt);
  assert.equal(ctx.store.getReceipt('host-b', e.id).status, 'acknowledged');
  assert.throws(() => ctx.store.getReceipt('host-c', e.id), { status: 404 });
  assert.equal(ctx.store.receive(recipient.session_id).messages.length, 0);
});

test('expiry and grace retention preserve historical bytes then reclaim them and reject retransmission', t => {
  const ctx = setup(t, { timing: { retentionSeconds: 2 } }), recipient = session(ctx.store);
  const item = stage(ctx.store, 'report'), e = envelope(ctx, 'host-b/researcher', recipient.address, [item.descriptor]);
  ctx.store.putMessage({ direction: 'inbox', envelope: e, stagedAttachments: [item.staged] });
  ctx.advance(60001); ctx.store.maintenance();
  assert.equal(ctx.store.messageStatus(recipient.session_id, e.id).status, 'expired');
  assert.equal(ctx.store.receive(recipient.session_id).messages.length, 0);
  assert.equal(readFileSync(ctx.store.attachment(recipient.session_id, e.id, item.descriptor.id).path, 'utf8'), 'report');
  ctx.advance(2000); ctx.store.maintenance();
  assert.equal(ctx.store.stats().blob_bytes, 0);
  assert.throws(() => ctx.store.attachment(recipient.session_id, e.id, item.descriptor.id), { status: 404 });
  assert.throws(() => ctx.store.putMessage({ direction: 'inbox', envelope: e }), { code: 'MESSAGE_EXPIRED' });
});

test('notices are throttled, never contain bodies, and Stop continuation is bounded until a new prompt', t => {
  const ctx = setup(t), recipient = session(ctx.store);
  const first = inbox(ctx, recipient);
  assert.deepEqual(ctx.store.pendingNotice(recipient.session_id, { event: 'PostToolUse' }), { message_ids: [first.id], attachment_count: 0 });
  const second = inbox(ctx, recipient);
  assert.equal(ctx.store.pendingNotice(recipient.session_id, { event: 'PostToolUse' }).message_ids.length, 0);
  assert.deepEqual(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop' }).message_ids, [second.id]);
  const third = inbox(ctx, recipient);
  assert.equal(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop', stop_hook_active: true }).message_ids.length, 0);
  ctx.store.touchSession(recipient.session_id, 'PostToolUse');
  assert.equal(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop' }).message_ids.length, 0);
  ctx.store.touchSession(recipient.session_id, 'UserPromptSubmit');
  assert.deepEqual(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop' }).message_ids, [first.id, second.id, third.id]);
  assert.equal(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop' }).message_ids.length, 0);
});

test('discovery checks ownership, replaces complete snapshots, ignores old revisions and exposes stale records', t => {
  const ctx = setup(t), local = session(ctx.store, 'migration', { title: 'Migration research', tags: ['database'] });
  const record = ctx.store.listLocalSessions()[0];
  const remote = { ...record, session_id: 'researcher', address: 'host-b/researcher', client_kind: 'claude-code', title: 'Migration research', token: 'must-not-leak', native_id: 'must-not-leak', workspace: '/private/must-not-leak' };
  const snapshot = { node_id: 'host-b', revision: 1, published_at: new Date(ctx.time).toISOString(), sessions: [remote] };
  assert.equal(ctx.store.applySnapshot('host-b', snapshot).applied, true);
  let matches = ctx.store.listSessions({ query: 'migration' });
  assert.equal(matches.sessions.length, 2);
  assert.equal(matches.sessions.some(record => record.address === local.address), true);
  const advertised = matches.sessions.find(record => record.node_id === 'host-b');
  assert.equal(advertised.client_kind, 'claude-code');
  for (const key of ['token', 'native_id', 'workspace']) assert.equal(key in advertised, false);
  assert.throws(() => ctx.store.applySnapshot('host-b', { ...snapshot, revision: 2, sessions: [{ ...remote, address: 'host-c/researcher' }] }), { code: 'INVALID_SNAPSHOT' });
  assert.throws(() => ctx.store.applySnapshot('host-b', { ...snapshot, revision: 2, sessions: [{ ...remote, coordinator_role: 'subagent' }] }), { code: 'INVALID_SNAPSHOT' });
  ctx.advance(121000);
  assert.equal(ctx.store.applySnapshot('host-b', { ...snapshot, published_at: new Date(ctx.time).toISOString() }).applied, false);
  matches = ctx.store.listSessions({ peer: 'host-b' });
  assert.equal(matches.sessions[0].directory_fresh, false);
  assert.equal(matches.sessions[0].presence, 'stale');
  ctx.restart();
  assert.equal(ctx.store.listSessions({ peer: 'host-b' }).sessions[0].title, 'Migration research');
  assert.equal(ctx.store.applySnapshot('host-b', { ...snapshot, revision: 2, sessions: [] }).applied, true);
  assert.equal(ctx.store.listSessions({ peer: 'host-b' }).sessions.length, 0);
});

test('outbox retries persist scheduling and remote receipts reconcile to acknowledged', t => {
  const ctx = setup(t), sender = session(ctx.store);
  const e = envelope(ctx, sender.address, 'host-b/researcher');
  ctx.store.putMessage({ direction: 'outbox', envelope: e });
  assert.equal(ctx.store.dueOutbox()[0].id, e.id);
  ctx.store.setDeliveryResult(e.id, { status: 'retry', error: { code: 'UNAVAILABLE', message: 'Peer offline', retryable: true } });
  assert.equal(ctx.store.dueOutbox().length, 0);
  ctx.advance(1000); ctx.restart();
  assert.equal(ctx.store.dueOutbox()[0].attempts, 1);
  ctx.store.setDeliveryResult(e.id, { status: 'persisted_remote' });
  ctx.advance(30000);
  assert.equal(ctx.store.dueOutbox()[0].status, 'persisted_remote');
  ctx.store.setDeliveryResult(e.id, { status: 'acknowledged' });
  assert.equal(ctx.store.dueOutbox().length, 0);
  assert.equal(ctx.store.messageStatus(sender.session_id, e.id).status, 'acknowledged');
});


test('leased work is not announced again until its lease expires; new turns recover unseen handling', t => {
  const ctx = setup(t), recipient = session(ctx.store), e = inbox(ctx, recipient);
  const leased = ctx.store.receive(recipient.session_id, { leaseSeconds: 1 }).messages[0];
  ctx.store.touchSession(recipient.session_id, 'UserPromptSubmit');
  assert.equal(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop' }).message_ids.length, 0);
  ctx.advance(1001); ctx.store.maintenance();
  assert.deepEqual(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop' }).message_ids, [e.id]);
  assert.equal(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop' }).message_ids.length, 0);
  assert.throws(() => ctx.store.ack(recipient.session_id, e.id, leased.delivery_token), { code: 'INVALID_DELIVERY_TOKEN' });
  ctx.store.touchSession(recipient.session_id, 'SessionStart');
  assert.deepEqual(ctx.store.pendingNotice(recipient.session_id, { event: 'Stop' }).message_ids, [e.id]);
});

test('restart reclaims abandoned transfer reservations, staging and orphan blobs without losing committed files', t => {
  const ctx = setup(t, { limits: { hostBytes: 16, sessionBytes: 16 } }), recipient = session(ctx.store);
  const kept = stage(ctx.store, 'keep'), e = envelope(ctx, 'host-b/researcher', recipient.address, [kept.descriptor]);
  ctx.store.putMessage({ direction: 'inbox', envelope: e, stagedAttachments: [kept.staged] });
  ctx.store.reserveBytes(recipient.session_id, 12);
  stage(ctx.store, 'abandoned');
  writeFileSync(join(ctx.store.blobDir, sha256('orphan')), 'orphan');
  ctx.restart();
  assert.equal(ctx.store.stats().reserved_bytes, 0);
  assert.equal(ctx.store.stats().blob_bytes, 4);
  assert.equal(readdirSync(ctx.store.stagingDir).length, 0);
  assert.equal(readFileSync(ctx.store.attachment(recipient.session_id, e.id, kept.descriptor.id).path, 'utf8'), 'keep');
  assert.doesNotThrow(() => ctx.store.reserveBytes(recipient.session_id, 12));
});

test('receipt inquiry expires pending logical status without deleting active staging', t => {
  const ctx = setup(t), recipient = session(ctx.store), e = inbox(ctx, recipient);
  const pending = stage(ctx.store, 'active transfer');
  ctx.advance(60001);
  assert.equal(ctx.store.getReceipt('host-b', e.id).status, 'expired');
  assert.equal(readFileSync(pending.staged.path, 'utf8'), 'active transfer');
});
