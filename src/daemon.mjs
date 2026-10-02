import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync, readFileSync, unlinkSync, chmodSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, PROTOCOL, VERSION, address, identifier, equalSecret, cleanText, sessionPatch, validateEnvelope, validateAdmissionTime, attachmentManifest, privateEndpoint, fail } from './common.mjs';
import { loadConfig, saveConfig, privateDirectory, endpointFor, validateCertificate } from './config.mjs';
import { Store } from './store.mjs';
import { readJson, readMultipart, multipartBody, requestPeer as sendPeer } from './transport.mjs';

const ALLOWED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);

class DuplicateReceipt extends Error {
  constructor(receipt) { super('Message already stored'); this.receipt = receipt; }
}
async function concurrently(items, limit, fn) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++]);
  }));
}
function drainDuplicate(request, maximum) {
  if (request.readableEnded) return Promise.resolve();
  return new Promise((resolveDrain, reject) => {
    let bytes = 0;
    const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAbort); };
    const onEnd = () => { cleanup(); resolveDrain(); };
    const onError = error => { cleanup(); reject(error); };
    const onAbort = () => onError(new AppError('TRANSFER_INTERRUPTED', 'Duplicate transfer interrupted', 400, true));
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > maximum) { onError(new AppError('LIMIT_EXCEEDED', 'Duplicate upload exceeds the transfer limit', 413)); request.destroy(); }
    };
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAbort);
    request.resume();
  });
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
function errorResponse(response, error) {
  const known = error instanceof AppError;
  json(response, known ? error.status : 500, { error: {
    code: known ? error.code : 'INTERNAL_ERROR',
    message: known ? error.message : 'Daemon operation failed',
    retryable: known ? error.retryable : true,
  } });
}
function bearer(request) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('Bearer ')) fail('UNAUTHORIZED', 'A valid credential is required', 401);
  return value.slice(7);
}
function positiveInt(value, fallback, max, name) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) fail('INVALID_INPUT', `${name} must be an integer between 1 and ${max}`);
  return number;
}
function permit(list, sessionId) { return !list || list.includes('*') || list.includes(sessionId); }
function peerPublic(peer) {
  return { node_id: peer.node_id, label: peer.label, endpoint: peer.endpoint, paired_incoming: !!peer.incoming_token, paired_outgoing: !!(peer.token && peer.endpoint && peer.certificate), allowed_sources: peer.allowed_sources ?? ['*'], allowed_destinations: peer.allowed_destinations ?? ['*'] };
}

export async function startDaemon({ stateDir = '.parler', workerIntervalMs = 1000 } = {}) {
  stateDir = resolve(stateDir);
  if (!Number.isSafeInteger(workerIntervalMs) || workerIntervalMs < 20 || workerIntervalMs > 60000) fail('INVALID_INPUT', 'Worker interval must be 20–60000 milliseconds');
  privateDirectory(stateDir);
  const config = loadConfig(stateDir);
  const admin = readFileSync(join(stateDir, 'admin.token'), 'utf8').trim();
  const certificate = readFileSync(join(stateDir, 'certificate.pem'), 'utf8');
  const socketPath = join(stateDir, 'daemon.sock');
  const lockPath = join(stateDir, 'daemon.lock');
  if (Buffer.byteLength(socketPath) > 100) fail('INVALID_STATE', 'State directory path is too long for a Unix socket; choose a shorter --state path');
  // A process lock protects SQLite maintenance and socket ownership. Recover
  // stale locks only after confirming that their owner no longer exists.
  if (existsSync(lockPath)) {
    let pid;
    try { pid = Number(readFileSync(lockPath, 'utf8')); } catch {}
    let live = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); live = true; } catch (error) { if (error.code !== 'ESRCH') live = true; }
    }
    if (live) fail('DAEMON_RUNNING', 'A daemon already owns this state directory', 409);
    unlinkSync(lockPath);
  }
  const lockfd = openSync(lockPath, 'wx', 0o600);
  try { writeFileSync(lockfd, String(process.pid)); } finally { closeSync(lockfd); }
  if (existsSync(socketPath)) unlinkSync(socketPath);

  let store, network, local, interval, closed = false, activeTick, dirty = true, lastSnapshot = 0, lastMaintenance = 0;
  const connections = new Set();
  const shutdown = new AbortController();
  const requestPeer = (peer, options) => sendPeer(peer, { ...options, signal: shutdown.signal, allowTailnet: config.network_mode === 'tailscale' });
  const peerMap = new Map(config.peers.map(peer => [peer.node_id, peer]));
  const requestBudget = new Map();
  const activeUploads = new Set();
  const info = { node_id: config.node_id, label: config.label, endpoint: config.endpoint, network_mode: config.network_mode, certificate, protocol: PROTOCOL, version: VERSION, limits: config.limits };

  const persistPeers = () => { config.peers = [...peerMap.values()]; saveConfig(stateDir, config); dirty = true; };
  const outgoingPeers = () => [...peerMap.values()].filter(peer => peer.token && peer.endpoint && peer.certificate);
  const authenticatePeer = request => {
    const node = request.headers['x-parler-node'];
    identifier(node, 'peer node id');
    const peer = peerMap.get(node);
    if (!peer || !peer.incoming_token || !equalSecret(bearer(request), peer.incoming_token)) fail('UNAUTHORIZED', 'Peer authentication failed', 401);
    const now = Date.now(), bucket = requestBudget.get(node);
    if (!bucket || now - bucket.start > 60000) requestBudget.set(node, { start: now, count: 1 });
    else if (++bucket.count > 600) fail('RATE_LIMITED', 'Peer request limit exceeded', 429, true);
    return peer;
  };
  const authorizeDestination = (peer, envelope) => {
    const sender = address(envelope.from), recipient = address(envelope.to);
    if (sender.nodeId !== peer.node_id || recipient.nodeId !== config.node_id) fail('FORBIDDEN', 'Peer does not own sender or destination is not local', 403);
    if (!permit(peer.allowed_sources, sender.sessionId) || !permit(peer.allowed_destinations, recipient.sessionId)) fail('FORBIDDEN', 'Peer may not address this session', 403);
    const session = store.getSession(recipient.sessionId);
    if (!session || session.presence === 'closed' || session.closed) fail('SESSION_CLOSED', 'Destination session is unavailable or closed', 410);
    if (session.visible_peers && !permit(session.visible_peers, peer.node_id)) fail('FORBIDDEN', 'Destination is not enrolled for this peer', 403);
    return session;
  };

  async function parseUpload(request, { remotePeer, localSession } = {}) {
    let reservationId;
    let result;
    let total;
    const reserve = envelope => {
      if (remotePeer) {
        validateEnvelope(envelope, config.limits);
        const sender = address(envelope.from), destination = address(envelope.to);
        if (sender.nodeId !== remotePeer.node_id || destination.nodeId !== config.node_id || !permit(remotePeer.allowed_sources, sender.sessionId) || !permit(remotePeer.allowed_destinations, destination.sessionId)) fail('FORBIDDEN', 'Peer does not own the allowed source or destination', 403);
        const duplicate = store.checkDuplicate('inbox', envelope);
        if (duplicate) throw new DuplicateReceipt(duplicate);
        const session = authorizeDestination(remotePeer, envelope);
        validateAdmissionTime(envelope, Date.now(), config.timing.maxTtlSeconds);
        total = (envelope.attachments ?? []).reduce((sum, item) => sum + item.size_bytes, 0);
        reservationId = store.reserveBytes(session.session_id, total);
      } else {
        validateLocalInput(envelope);
        total = (envelope.attachments ?? []).reduce((sum, item) => sum + item.size_bytes, 0);
        reservationId = store.reserveBytes(localSession.session_id, total);
      }
      activeUploads.add(reservationId);
      return reservationId;
    };
    try {
      const type = request.headers['content-type'] ?? '';
      if (/^multipart\/form-data(?:;|$)/i.test(type)) {
        result = await readMultipart(request, type, { stagingDir: store.stagingDir ?? join(stateDir, 'staging'), limits: config.limits, reserve });
      } else if (/^application\/json(?:;|$)/i.test(type)) {
        const envelope = await readJson(request, config.limits.envelopeBytes);
        reserve(envelope);
        if ((envelope.attachments ?? []).length) fail('INVALID_INPUT', 'Attachment-bearing messages require multipart bodies');
        result = { envelope, stagedAttachments: [], reservationId };
      } else fail('UNSUPPORTED_MEDIA_TYPE', 'Use application/json or multipart/form-data', 415);
      return result;
    } catch (error) {
      const id = reservationId ?? error.reservationId;
      if (id) { activeUploads.delete(id); store.releaseReservation(id); }
      throw error;
    }
  }

  function validateLocalInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Invalid send input');
    address(input.to);
    if (!['message', 'request', 'progress', 'result', 'error'].includes(input.kind)) fail('INVALID_INPUT', 'Invalid message kind');
    if (!input.body || typeof input.body.text !== 'string') fail('INVALID_INPUT', 'Message body must contain text');
    attachmentManifest(input.attachments ?? [], config.limits);
    if (input.reply_to !== undefined && input.reply_to !== null) identifier(input.reply_to, 'reply_to');
    if (input.conversation_id !== undefined) identifier(input.conversation_id, 'conversation id');
    if (input.ttl_seconds !== undefined) positiveInt(input.ttl_seconds, config.timing.ttlSeconds, config.timing.maxTtlSeconds, 'ttl_seconds');
    if (Buffer.byteLength(JSON.stringify(input)) > config.limits.envelopeBytes) fail('LIMIT_EXCEEDED', 'Message envelope is too large', 413);
  }

  async function commitUpload(upload, direction, localSession) {
    const { reservationId, stagedAttachments } = upload;
    try {
      let envelope = upload.envelope;
      if (direction === 'outbox') {
        const recipient = address(envelope.to);
        if (recipient.nodeId !== config.node_id) {
          const peer = peerMap.get(recipient.nodeId);
          if (!peer || !peer.token || !peer.endpoint) fail('PEER_NOT_PAIRED', 'Destination host is not paired', 403);
        } else {
          const target = store.getSession(recipient.sessionId);
          if (!target || target.presence === 'closed' || target.closed) fail('SESSION_CLOSED', 'Destination session is closed', 410);
        }
        let conversationId = envelope.conversation_id ?? randomUUID();
        if (envelope.reply_to) {
          const original = store.messageStatus(localSession.session_id, envelope.reply_to);
          const originalEnvelope = original.envelope ?? original;
          if (originalEnvelope.conversation_id) {
            if (envelope.conversation_id && envelope.conversation_id !== originalEnvelope.conversation_id) fail('INVALID_INPUT', 'Reply must use the original conversation');
            conversationId = originalEnvelope.conversation_id;
          }
        }
        const now = Date.now();
        const ttl = envelope.ttl_seconds ?? config.timing.ttlSeconds;
        const attachments = stagedAttachments.map(item => ({ ...item, id: randomUUID() }));
        envelope = {
          protocol: PROTOCOL, id: randomUUID(), conversation_id: conversationId,
          from: localSession.address, to: envelope.to, kind: envelope.kind,
          reply_to: envelope.reply_to ?? null,
          created_at: new Date(now).toISOString(), expires_at: new Date(now + ttl * 1000).toISOString(),
          body: envelope.body,
          attachments: attachments.map(({ path, ...descriptor }) => descriptor),
        };
        stagedAttachments.splice(0, stagedAttachments.length, ...attachments);
      }
      validateEnvelope(envelope, config.limits);
      return store.putMessage({ direction, envelope, stagedAttachments, reservationId });
    } finally {
      activeUploads.delete(reservationId);
      store.releaseReservation(reservationId);
      for (const attachment of stagedAttachments) {
        if (attachment.path && attachment.path.startsWith(`${store.stagingDir ?? join(stateDir, 'staging')}/`)) {
          await fs.rm(attachment.path, { force: true }).catch(() => {});
        }
      }
    }
  }

  async function refreshDiscovery() {
    const results = await Promise.all(outgoingPeers().map(async peer => {
      try {
        const snapshot = await requestPeer(peer, { path: '/v0/sessions', nodeId: config.node_id, timeoutMs: 3000, maxResponseBytes: config.limits.snapshotBytes });
        store.applySnapshot(peer.node_id, snapshot);
        return { node_id: peer.node_id, refreshed: true };
      } catch (error) { return { node_id: peer.node_id, refreshed: false, error: error.code ?? 'UNAVAILABLE' }; }
    }));
    return results;
  }

  async function localHandler(request, response) {
    try {
      const url = new URL(request.url, 'http://local');
      const route = url.pathname, method = request.method;
      if (!route.startsWith('/local/')) fail('NOT_FOUND', 'Unknown route', 404);
      const token = bearer(request);
      const isAdmin = equalSecret(token, admin);
      if (route === '/local/info' && method === 'GET') {
        if (!isAdmin) fail('FORBIDDEN', 'Admin credential required', 403);
        json(response, 200, { ...info, ...(store.stats ? { storage: store.stats() } : {}) }); return;
      }
      if (route === '/local/sessions/register' && method === 'POST') {
        if (!isAdmin) fail('FORBIDDEN', 'Admin credential required', 403);
        const input = await readJson(request, config.limits.envelopeBytes);
        if ((input.coordinator_role !== undefined && input.coordinator_role !== 'main') || (input.role !== undefined && input.role !== 'main') || input.agent_id !== undefined || input.agent_transcript_path !== undefined || input.parent_session_id !== undefined || input.is_subagent === true) fail('MAIN_SESSION_ONLY', 'Only main agent sessions may register with Parler', 403);
        const session = store.registerSession({ ...input, coordinator_role: 'main' });
        dirty = true; json(response, 201, session); return;
      }
      if (route === '/local/peers' && method === 'GET') {
        if (!isAdmin) fail('FORBIDDEN', 'Admin credential required', 403);
        json(response, 200, { peers: [...peerMap.values()].map(peerPublic) }); return;
      }
      if (route === '/local/peers/export' && method === 'POST') {
        if (!isAdmin) fail('FORBIDDEN', 'Admin credential required', 403);
        const input = await readJson(request, config.limits.envelopeBytes);
        const node = identifier(input.for_node_id, 'recipient node id');
        if (node === config.node_id) fail('INVALID_INPUT', 'Cannot pair host with itself');
        const peer = peerMap.get(node) ?? { node_id: node };
        if (peerMap.size >= 256 && !peerMap.has(node)) fail('LIMIT_EXCEEDED', 'Too many peers', 413);
        peer.incoming_token ??= randomBytes(32).toString('hex');
        if (input.allowed_sources !== undefined) peer.allowed_sources = sessionPatch({ visible_peers: input.allowed_sources }).visible_peers;
        if (input.allowed_destinations !== undefined) peer.allowed_destinations = sessionPatch({ visible_peers: input.allowed_destinations }).visible_peers;
        peerMap.set(node, peer); persistPeers();
        json(response, 200, { node_id: config.node_id, label: config.label, endpoint: info.endpoint, certificate: info.certificate, for_node_id: node, token: peer.incoming_token }); return;
      }
      if (route === '/local/peers/import' && method === 'POST') {
        if (!isAdmin) fail('FORBIDDEN', 'Admin credential required', 403);
        const input = await readJson(request, config.limits.envelopeBytes);
        const node = identifier(input.node_id, 'invitation node id');
        if (node === config.node_id || input.for_node_id !== config.node_id) fail('INVALID_INVITATION', 'Invitation is not addressed to this host');
        const endpoint = privateEndpoint(input.endpoint, { allowTailnet: config.network_mode === 'tailscale' });
        validateCertificate(input.certificate); cleanText(input.label, 'peer label', 80);
        if (!/^[a-f0-9]{64}$/.test(input.token)) fail('INVALID_INVITATION', 'Invalid invitation credential');
        if (peerMap.size >= 256 && !peerMap.has(node)) fail('LIMIT_EXCEEDED', 'Too many peers', 413);
        const peer = { ...(peerMap.get(node) ?? {}), node_id: node, label: input.label, endpoint, certificate: input.certificate, token: input.token };
        peerMap.set(node, peer); persistPeers();
        json(response, 200, peerPublic(peer)); return;
      }
      const session = store.authenticateSession(token);
      const id = session.session_id;
      if (route === '/local/session' && method === 'GET') { json(response, 200, stripSecret(session)); return; }
      if (route === '/local/session' && method === 'PATCH') {
        const input = sessionPatch(await readJson(request, config.limits.envelopeBytes));
        const updated = store.updateSession(id, input); dirty = true;
        json(response, 200, stripSecret(updated)); return;
      }
      if (route === '/local/session/touch' && method === 'POST') {
        const input = await readJson(request, config.limits.envelopeBytes);
        if (!ALLOWED_EVENTS.has(input.event)) fail('INVALID_INPUT', 'Unsupported lifecycle event');
        const updated = store.touchSession(id, input.event); dirty = true;
        json(response, 200, stripSecret(updated)); return;
      }
      if (route === '/local/session/close' && method === 'POST') {
        const result = store.closeSession(id); dirty = true;
        json(response, 200, result ? stripSecret(result) : { closed: true }); return;
      }
      if (route === '/local/sessions' && method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1' ? await refreshDiscovery() : undefined;
        const result = store.listSessions({ query: url.searchParams.get('query') ?? undefined, client_kind: url.searchParams.get('client_kind') ?? undefined, project: url.searchParams.get('project') ?? undefined, peer: url.searchParams.get('peer') ?? undefined, limit: positiveInt(url.searchParams.get('limit'), 100, 256, 'limit') });
        const sessions = result.sessions.map(item => ({ ...item, host_label: item.node_id === config.node_id ? config.label : peerMap.get(item.node_id)?.label ?? item.node_id }));
        json(response, 200, { ...result, sessions, ...(refresh ? { refresh } : {}) }); return;
      }
      if (route === '/local/messages' && method === 'POST') {
        if (session.presence === 'closed' || session.closed) fail('SESSION_CLOSED', 'Resume session before sending', 410);
        const upload = await parseUpload(request, { localSession: session });
        const result = await commitUpload(upload, 'outbox', session);
        json(response, 202, result); return;
      }
      if (route === '/local/messages' && method === 'GET') {
        const limit = positiveInt(url.searchParams.get('limit'), 20, 100, 'limit');
        const waitValue = Number(url.searchParams.get('wait_seconds') ?? 0);
        if (!Number.isFinite(waitValue) || waitValue < 0 || waitValue > 30) fail('INVALID_INPUT', 'wait_seconds must be 0–30');
        const deadline = Date.now() + waitValue * 1000;
        let result;
        do {
          result = store.receive(id, { limit, leaseSeconds: config.timing.leaseSeconds });
          if (result.messages.length || Date.now() >= deadline || closed || request.destroyed) break;
          await delay(100);
        } while (true);
        json(response, 200, result); return;
      }
      if (route === '/local/notices' && method === 'POST') {
        const input = await readJson(request, config.limits.envelopeBytes);
        if (!ALLOWED_EVENTS.has(input.event)) fail('INVALID_INPUT', 'Unsupported lifecycle event');
        json(response, 200, store.pendingNotice(id, { event: input.event, stop_hook_active: !!input.stop_hook_active })); return;
      }
      const match = /^\/local\/messages\/([A-Za-z0-9_-]+)(?:\/(ack|attachments)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(route);
      if (match) {
        const messageId = identifier(match[1], 'message id');
        if (!match[2] && method === 'GET') { json(response, 200, store.messageStatus(id, messageId)); return; }
        if (match[2] === 'ack' && method === 'POST') {
          const input = await readJson(request, config.limits.envelopeBytes);
          json(response, 200, store.ack(id, messageId, input.delivery_token)); return;
        }
        if (match[2] === 'attachments' && method === 'GET') {
          const status = store.messageStatus(id, messageId);
          if (!match[3]) {
            const attachments = status.attachments ?? status.envelope?.attachments ?? [];
            json(response, 200, { message_id: messageId, attachments, retain_until: status.retain_until }); return;
          }
          const attachment = store.attachment(id, messageId, match[3]);
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': attachment.size_bytes, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          const stream = createReadStream(attachment.path);
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response); return;
        }
      }
      fail('NOT_FOUND', 'Unknown local route', 404);
    } catch (error) { errorResponse(response, error); }
  }

  async function networkHandler(request, response) {
    try {
      const peer = authenticatePeer(request);
      const url = new URL(request.url, 'https://private');
      const route = url.pathname, method = request.method;
      if (route === '/v0/info' && method === 'GET') { json(response, 200, { ...info, certificate: undefined }); return; }
      if (route === '/v0/sessions' && method === 'GET') { json(response, 200, store.createSnapshot(peer.node_id)); return; }
      if (route === '/v0/announcements' && method === 'POST') {
        const snapshot = await readJson(request, config.limits.snapshotBytes);
        json(response, 200, store.applySnapshot(peer.node_id, snapshot)); return;
      }
      if (route === '/v0/messages' && method === 'POST') {
        const upload = await parseUpload(request, { remotePeer: peer });
        json(response, 200, await commitUpload(upload, 'inbox')); return;
      }
      const match = /^\/v0\/messages\/([A-Za-z0-9_-]+)\/receipt$/.exec(route);
      if (match && method === 'GET') { json(response, 200, store.getReceipt(peer.node_id, match[1])); return; }
      fail('NOT_FOUND', 'Unknown network route', 404);
    } catch (error) {
      if (error instanceof DuplicateReceipt) {
        try {
          // Drain the already-accepted retry without allocating quota or files.
          // Finish reading before returning the receipt so clients can finish
          // their streaming upload instead of observing a premature close.
          await drainDuplicate(request, config.limits.messageBytes + config.limits.envelopeBytes + 100000);
          json(response, 200, error.receipt);
        } catch (drainError) { errorResponse(response, drainError); }
      } else errorResponse(response, error);
    }
  }

  async function deliver(envelope) {
    const destination = address(envelope.to);
    const sender = address(envelope.from);
    try {
      if (Date.parse(envelope.expires_at) <= Date.now()) { store.setDeliveryResult(envelope.id, { status: 'expired' }); return; }
      let receipt;
      if (destination.nodeId === config.node_id) {
        if (envelope.status === 'persisted_remote') receipt = store.getReceipt(config.node_id, envelope.id);
        else {
          const target = store.getSession(destination.sessionId);
          if (!target || target.presence === 'closed' || target.closed) fail('SESSION_CLOSED', 'Destination session is closed', 410);
          const attachments = (envelope.attachments ?? []).map(item => store.attachment(sender.sessionId, envelope.id, item.id));
          receipt = store.putMessage({ direction: 'inbox', envelope: stripWorkerFields(envelope), stagedAttachments: attachments });
        }
      } else {
        const peer = peerMap.get(destination.nodeId);
        if (!peer?.token || !peer.endpoint) fail('PEER_NOT_PAIRED', 'Destination host is not paired', 403);
        if (envelope.status === 'persisted_remote') receipt = await requestPeer(peer, { nodeId: config.node_id, path: `/v0/messages/${envelope.id}/receipt` });
        else {
          const peerInfo = await requestPeer(peer, { nodeId: config.node_id, path: '/v0/info' });
          if (peerInfo.node_id !== peer.node_id || peerInfo.protocol !== PROTOCOL) fail('UNSUPPORTED_PROTOCOL', 'Peer identity/protocol mismatch');
          const limits = peerInfo.limits;
          if ((envelope.attachments ?? []).length) {
            if (!limits) fail('ATTACHMENTS_UNSUPPORTED', 'Peer does not advertise attachment support');
            attachmentManifest(envelope.attachments, { ...config.limits, ...limits });
          }
          const bodyEnvelope = stripWorkerFields(envelope);
          const attachmentFiles = (envelope.attachments ?? []).map(item => store.attachment(sender.sessionId, envelope.id, item.id));
          const multipart = attachmentFiles.length ? multipartBody(bodyEnvelope, attachmentFiles) : null;
          receipt = await requestPeer(peer, { nodeId: config.node_id, method: 'POST', path: '/v0/messages', body: multipart?.body ?? bodyEnvelope, contentType: multipart?.contentType, timeoutMs: 30000 });
        }
      }
      if (!receipt || receipt.id !== envelope.id || !['persisted_remote', 'acknowledged', 'expired'].includes(receipt.status)) fail('INVALID_RECEIPT', 'Peer returned an invalid durable receipt', 502, true);
      const expected = (envelope.attachments ?? []).map(item => item.id).sort();
      const actual = [...(receipt.attachment_ids ?? [])].sort();
      if (expected.join('\0') !== actual.join('\0')) fail('INVALID_RECEIPT', 'Receipt does not cover all attachments', 502, true);
      store.setDeliveryResult(envelope.id, { status: receipt.status, retryAt: Date.now() + Math.max(1000, config.timing.snapshotSeconds * 1000) });
    } catch (error) {
      if (closed) return;
      const terminal = error instanceof AppError && !error.retryable && error.status >= 400 && error.status < 500 && ![404, 408, 429].includes(error.status);
      const backoff = Math.min(60000, 500 * 2 ** Math.min(envelope.attempts ?? 0, 7)) + Math.floor(Math.random() * 250);
      store.setDeliveryResult(envelope.id, { status: terminal ? 'rejected' : envelope.status === 'persisted_remote' ? 'persisted_remote' : 'retry', error: error.code ?? 'DELIVERY_UNAVAILABLE', retryAt: Date.now() + backoff });
    }
  }

  async function tick() {
    if (closed || activeTick) return;
    activeTick = (async () => {
      const now = Date.now();
      await concurrently(store.dueOutbox(20), 4, async envelope => { if (!closed) await deliver(envelope); });
      if (!closed && (dirty || now - lastSnapshot >= config.timing.snapshotSeconds * 1000)) {
        dirty = false; lastSnapshot = now;
        await concurrently(outgoingPeers(), 4, async peer => {
          if (closed) return;
          try {
            const snapshot = store.createSnapshot(peer.node_id);
            await requestPeer(peer, { nodeId: config.node_id, method: 'POST', path: '/v0/announcements', body: snapshot, timeoutMs: 3000, maxResponseBytes: config.limits.snapshotBytes });
          } catch { /* Discovery is best effort. Refresh is available on demand. */ }
        });
      }
      if (!closed && !activeUploads.size && now - lastMaintenance >= 1000) {
        lastMaintenance = now; store.maintenance();
      }
    })().catch(error => {
      // Logs contain only a stable error category, never bodies or credentials.
      console.error(`Parler worker: ${error instanceof AppError ? error.code : 'INTERNAL_ERROR'}`);
    }).finally(() => { activeTick = undefined; });
    await activeTick;
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    shutdown.abort();
    if (interval) clearInterval(interval);
    for (const connection of connections) connection.destroy();
    await Promise.all([network, local].filter(Boolean).map(server => new Promise(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections?.(); })));
    if (activeTick) await activeTick;
    store?.close();
    for (const path of [socketPath, lockPath]) { try { unlinkSync(path); } catch {} }
  };

  try {
    store = new Store({ stateDir, nodeId: config.node_id, limits: config.limits, timing: config.timing });
    network = https.createServer({ key: readFileSync(join(stateDir, 'private.key')), cert: info.certificate, minVersion: 'TLSv1.2', maxHeaderSize: 16384 }, networkHandler);
    local = http.createServer({ maxHeaderSize: 16384 }, localHandler);
    for (const server of [network, local]) {
      server.requestTimeout = 35000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
      server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
      server.on('clientError', (_error, socket) => { socket.destroy(); });
    }
    network.listen(config.port, config.listen);
    await once(network, 'listening');
    const networkAddress = network.address();
    info.endpoint = endpointFor(config.listen, networkAddress.port);
    config.endpoint = info.endpoint;
    // port=0 is reserved for tests/development; persist its bound port so a
    // restart keeps the endpoint advertised in existing invitations.
    if (config.port === 0) config.port = networkAddress.port;
    saveConfig(stateDir, config);
    local.listen(socketPath);
    await once(local, 'listening'); chmodSync(socketPath, 0o600);
    interval = setInterval(tick, workerIntervalMs);
    void tick();
    return { close, networkAddress, socketPath, info, store };
  } catch (error) { await close(); throw error; }
}

function stripSecret(session) {
  const { token, ...result } = session;
  return result;
}
function stripWorkerFields(envelope) {
  const { attempts, next_attempt_at, status, ...result } = envelope;
  return result;
}
