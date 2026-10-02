import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync, realpathSync, openSync, closeSync, readSync, fsyncSync, renameSync, unlinkSync, readdirSync, constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { LIMITS, DEFAULTS, PROTOCOL, fail, identifier, address, sessionPatch, validateEnvelope, validateAdmissionTime, canonicalJson, cleanText } from './common.mjs';

const iso = value => new Date(value).toISOString();
const secret = () => randomBytes(32).toString('base64url');
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const emptyNotice = () => ({ message_ids: [], attachment_count: 0 });
const clients = ['codex', 'claude-code', 'other'];

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('UNSAFE_STATE', 'State directories must be real directories');
  chmodSync(path, 0o700);
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function verifyFile(path, descriptor) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!lstatSync(path).isFile()) fail('INTEGRITY_ERROR', 'Attachment is not a regular file', 409);
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let total = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) {
      total += count;
      if (total > descriptor.size_bytes) fail('INTEGRITY_ERROR', 'Attachment size mismatch', 409);
      hash.update(buffer.subarray(0, count));
    }
    if (total !== descriptor.size_bytes || hash.digest('hex') !== descriptor.sha256) fail('INTEGRITY_ERROR', 'Attachment size or SHA-256 mismatch', 409);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export class Store {
  constructor({ stateDir, nodeId, limits = LIMITS, timing = DEFAULTS, now = () => Date.now() }) {
    this.stateDir = resolve(stateDir);
    this.nodeId = identifier(nodeId, 'node id');
    this.limits = { ...LIMITS, ...limits };
    this.timing = { ...DEFAULTS, ...timing };
    this.now = now;
    privateDirectory(this.stateDir);
    this.blobDir = join(this.stateDir, 'blobs');
    this.stagingDir = join(this.stateDir, 'staging');
    privateDirectory(this.blobDir); privateDirectory(this.stagingDir);
    const dbPath = join(this.stateDir, 'store.sqlite');
    try { if (lstatSync(dbPath).isSymbolicLink()) fail('UNSAFE_STATE', 'Database must not be a symbolic link'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, client TEXT NOT NULL, native TEXT NOT NULL, token TEXT UNIQUE NOT NULL, record TEXT NOT NULL, last_notice INTEGER NOT NULL DEFAULT 0, stop_used INTEGER NOT NULL DEFAULT 0, UNIQUE(client,native));
      CREATE TABLE IF NOT EXISTS snapshots (peer TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, session TEXT NOT NULL, bytes INTEGER NOT NULL, host_bytes INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (key TEXT PRIMARY KEY, id TEXT NOT NULL, sender TEXT NOT NULL, owner TEXT NOT NULL, direction TEXT NOT NULL, envelope TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL, retain INTEGER NOT NULL, lease INTEGER, delivery_token TEXT, announced INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, error TEXT, acknowledged INTEGER, UNIQUE(direction,sender,id));
      CREATE INDEX IF NOT EXISTS inbox_owner ON messages(owner,direction,status);
      CREATE TABLE IF NOT EXISTS attachments (message_key TEXT NOT NULL REFERENCES messages(key) ON DELETE CASCADE, id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, descriptor TEXT NOT NULL, PRIMARY KEY(message_key,id));
      CREATE TABLE IF NOT EXISTS tombstones (key TEXT PRIMARY KEY, id TEXT NOT NULL, sender TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL, until_at INTEGER NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(reservations)').all().some(column => column.name === 'host_bytes')) this.db.exec('ALTER TABLE reservations ADD COLUMN host_bytes INTEGER NOT NULL DEFAULT 0; UPDATE reservations SET host_bytes=bytes');
    const existing = this.db.prepare('SELECT value FROM meta WHERE key=?').get('node_id');
    if (existing && existing.value !== this.nodeId) { this.db.close(); fail('WRONG_NODE', 'Store belongs to a different node'); }
    this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('node_id', this.nodeId);
    this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('revision', '0');
    // The daemon holds its exclusive state lock before opening Store. No transfer
    // can survive process restart, so abandoned reservations/staging are recoverable.
    this.db.prepare('DELETE FROM reservations').run();
    for (const name of readdirSync(this.stagingDir)) {
      const path = join(this.stagingDir, name);
      if (!lstatSync(path).isDirectory()) unlinkSync(path);
    }
    syncDirectory(this.stagingDir);
    this.maintenance();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  capabilities() {
    return { protocol: PROTOCOL, attachments: true, file_bytes: this.limits.fileBytes, message_bytes: this.limits.messageBytes, attachment_count: this.limits.attachmentCount, message_kinds: ['message', 'request', 'progress', 'result', 'error'], delivery_modes: ['hooks', 'poll'] };
  }
  registerSession(input) {
    if (input && ((input.coordinator_role !== undefined && input.coordinator_role !== 'main') || (input.role !== undefined && input.role !== 'main'))) fail('INVALID_INPUT', 'Only main agent sessions may register');
    if (!input || !clients.includes(input.client_kind)) fail('INVALID_INPUT', 'Invalid client kind');
    cleanText(input.native_id, 'native_id', 256);
    if (input.workspace !== undefined) cleanText(input.workspace, 'workspace', 4096);
    const previous = this.db.prepare('SELECT id FROM sessions WHERE client=? AND native=?').get(input.client_kind, input.native_id);
    if (previous) {
      const record = this.getSession(previous.id);
      const next = { ...record, ...sessionPatch(input), ...(input.workspace !== undefined ? { workspace: input.workspace } : {}), presence: 'online', activity: 'unknown', last_seen_at: iso(this.now()), updated_at: iso(this.now()) };
      this.saveSession(next); return next;
    }
    if (this.db.prepare('SELECT count(*) AS n FROM sessions').get().n >= this.limits.snapshotSessions) {
      this.maintenance();
      // Retire only explicitly closed bindings with no retained mail or transfer.
      // A resumed native session is enrolled anew by its next SessionStart hook.
      const retired = this.db.prepare("SELECT id FROM sessions WHERE json_extract(record,'$.presence')='closed' AND NOT EXISTS (SELECT 1 FROM messages WHERE owner=sessions.id) AND NOT EXISTS (SELECT 1 FROM reservations WHERE session=sessions.id) ORDER BY json_extract(record,'$.updated_at'),id LIMIT 1").get();
      if (retired) this.db.prepare('DELETE FROM sessions WHERE id=?').run(retired.id);
      else fail('SESSION_LIMIT', 'Session directory is full; close unused sessions and wait for their retained mail to expire', 429);
    }
    const id = randomUUID(), timestamp = iso(this.now());
    const record = { session_id: id, address: `${this.nodeId}/${id}`, client_kind: input.client_kind, coordinator_role: 'main', native_id: input.native_id, workspace: input.workspace ?? '', token: secret(), title: `${input.project_label ? `${input.project_label} ` : ''}${input.client_kind}`, task_summary: '', project_label: '', alias: '', tags: [], visible_peers: ['*'], presence: 'online', activity: 'unknown', created_at: timestamp, last_seen_at: timestamp, updated_at: timestamp, capabilities: this.capabilities(), ...sessionPatch(input) };
    this.checkRecord(record);
    this.db.prepare('INSERT INTO sessions(id,client,native,token,record) VALUES (?,?,?,?,?)').run(id, record.client_kind, record.native_id, record.token, json(record));
    return record;
  }
  checkRecord(record) {
    if (Buffer.byteLength(json(this.publicRecord(record))) > this.limits.sessionRecordBytes) fail('LIMIT_EXCEEDED', 'Session record exceeds metadata limit', 413);
  }
  saveSession(record) { this.checkRecord(record); this.db.prepare('UPDATE sessions SET record=? WHERE id=?').run(json(record), record.session_id); }
  getSession(id) {
    identifier(id, 'session id');
    const row = this.db.prepare('SELECT record FROM sessions WHERE id=?').get(id);
    if (!row) fail('NOT_FOUND', 'Session not found', 404);
    return parse(row.record);
  }
  authenticateSession(token) {
    if (typeof token !== 'string' || token.length > 256) fail('UNAUTHORIZED', 'Invalid session token', 401);
    const row = this.db.prepare('SELECT record FROM sessions WHERE token=?').get(token);
    if (!row) fail('UNAUTHORIZED', 'Invalid session token', 401);
    return parse(row.record);
  }
  updateSession(id, patch) {
    const record = { ...this.getSession(id), ...sessionPatch(patch), updated_at: iso(this.now()) };
    this.saveSession(record); return record;
  }
  touchSession(id, event) {
    const record = this.getSession(id);
    const activity = event === 'Stop' ? 'idle' : ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event) ? 'working' : 'unknown';
    Object.assign(record, { presence: 'online', activity, last_seen_at: iso(this.now()), updated_at: iso(this.now()) });
    this.saveSession(record);
    if (['UserPromptSubmit', 'SessionStart'].includes(event)) {
      this.db.prepare('UPDATE sessions SET stop_used=0 WHERE id=?').run(id);
      this.db.prepare("UPDATE messages SET announced=0 WHERE owner=? AND direction='inbox' AND status='persisted_remote' AND expires>? AND (lease IS NULL OR lease<=?)").run(id, this.now(), this.now());
    }
    return record;
  }
  closeSession(id) {
    const record = { ...this.getSession(id), presence: 'closed', activity: 'idle', updated_at: iso(this.now()) };
    this.saveSession(record); return record;
  }
  publicRecord(record) {
    const { token, native_id, workspace, visible_peers, ...output } = record;
    if (output.presence !== 'closed' && this.now() - Date.parse(output.last_seen_at) > this.timing.presenceSeconds * 1000) output.presence = 'stale';
    return output;
  }
  listLocalSessions(peerId) {
    if (peerId !== undefined) identifier(peerId, 'peer id');
    return this.db.prepare('SELECT record FROM sessions ORDER BY id').all().map(row => parse(row.record)).filter(record => peerId === undefined || record.visible_peers.includes('*') || record.visible_peers.includes(peerId)).map(record => this.publicRecord(record));
  }
  createSnapshot(peerId) {
    return this.transaction(() => {
      const revision = Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('revision').value) + 1;
      const snapshot = { node_id: this.nodeId, revision, published_at: iso(this.now()), sessions: this.listLocalSessions(peerId) };
      if (Buffer.byteLength(json(snapshot)) > this.limits.snapshotBytes) fail('LIMIT_EXCEEDED', 'Discovery snapshot is too large', 413);
      this.db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(revision), 'revision'); return snapshot;
    });
  }
  applySnapshot(peerId, input) {
    identifier(peerId, 'peer id');
    if (!input || input.node_id !== peerId || peerId === this.nodeId || !Number.isSafeInteger(input.revision) || input.revision < 1 || !Array.isArray(input.sessions) || !Number.isFinite(Date.parse(input.published_at))) fail('INVALID_SNAPSHOT', 'Invalid discovery snapshot');
    if (Date.parse(input.published_at) > this.now() + 60000) fail('INVALID_SNAPSHOT', 'Snapshot publication time is in the future');
    if (input.sessions.length > this.limits.snapshotSessions || Buffer.byteLength(json(input)) > this.limits.snapshotBytes) fail('LIMIT_EXCEEDED', 'Discovery snapshot exceeds limit', 413);
    const seen = new Set();
    const sessions = input.sessions.map(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INVALID_SNAPSHOT', 'Invalid session record');
      if ((record.coordinator_role !== undefined && record.coordinator_role !== 'main') || (record.role !== undefined && record.role !== 'main')) fail('INVALID_SNAPSHOT', 'Only main agent sessions may advertise');
      const owner = address(record.address);
      if (owner.nodeId !== peerId || owner.sessionId !== record.session_id || seen.has(record.address) || !clients.includes(record.client_kind)) fail('INVALID_SNAPSHOT', 'Invalid discovery session owner');
      seen.add(record.address);
      if (!['online', 'stale', 'closed'].includes(record.presence) || !['working', 'idle', 'unknown'].includes(record.activity)) fail('INVALID_SNAPSHOT', 'Invalid session presence');
      for (const name of ['last_seen_at', 'updated_at']) if (!Number.isFinite(Date.parse(record[name])) || Date.parse(record[name]) > this.now() + 60000) fail('INVALID_SNAPSHOT', 'Invalid session timestamp');
      if (!record.title) fail('INVALID_SNAPSHOT', 'Session title required');
      if (Buffer.byteLength(json(record)) > this.limits.sessionRecordBytes) fail('LIMIT_EXCEEDED', 'Session record too large', 413);
      const patch = sessionPatch(record);
      // Whitelist advertised fields: native IDs, tokens, and workspace paths never enter discovery.
      const capabilities = record.capabilities;
      if (!capabilities || capabilities.protocol !== PROTOCOL) fail('INVALID_SNAPSHOT', 'Invalid session capabilities');
      return { address: record.address, session_id: record.session_id, client_kind: record.client_kind, coordinator_role: 'main', title: patch.title, task_summary: patch.task_summary ?? '', project_label: patch.project_label ?? '', alias: patch.alias ?? '', tags: patch.tags ?? [], presence: record.presence, activity: record.activity, last_seen_at: record.last_seen_at, updated_at: record.updated_at, capabilities: { protocol: PROTOCOL, attachments: capabilities.attachments === true, file_bytes: this.safeLimit(capabilities.file_bytes), message_bytes: this.safeLimit(capabilities.message_bytes), attachment_count: this.safeLimit(capabilities.attachment_count), message_kinds: ['message', 'request', 'progress', 'result', 'error'], delivery_modes: ['hooks', 'poll'] } };
    });
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT revision FROM snapshots WHERE peer=?').get(peerId);
      if (previous && input.revision <= previous.revision) return { applied: false };
      const snapshot = { node_id: peerId, revision: input.revision, published_at: input.published_at, sessions };
      this.db.prepare('INSERT INTO snapshots(peer,revision,record) VALUES (?,?,?) ON CONFLICT(peer) DO UPDATE SET revision=excluded.revision,record=excluded.record').run(peerId, input.revision, json(snapshot));
      return { applied: true };
    });
  }
  safeLimit(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
  listSessions({ query = '', peer, client_kind, project, limit = 20 } = {}) {
    cleanText(query, 'query', 512, { allowEmpty: true });
    if (peer !== undefined) identifier(peer, 'peer id');
    if (client_kind !== undefined && !clients.includes(client_kind)) fail('INVALID_INPUT', 'Invalid client kind');
    if (!Number.isInteger(limit) || limit < 1 || limit > this.limits.snapshotSessions) fail('INVALID_INPUT', 'Invalid discovery limit');
    const records = this.listLocalSessions().map(record => ({ ...record, node_id: this.nodeId, directory_fresh: true, published_at: iso(this.now()) }));
    for (const row of this.db.prepare('SELECT record FROM snapshots').all()) {
      const snapshot = parse(row.record), fresh = this.now() - Date.parse(snapshot.published_at) <= this.timing.cacheSeconds * 1000;
      for (const record of snapshot.sessions) records.push({ ...this.publicRecord(record), node_id: snapshot.node_id, directory_fresh: fresh, published_at: snapshot.published_at, ...(!fresh && record.presence !== 'closed' ? { presence: 'stale' } : {}) });
    }
    const normalized = query.trim().toLowerCase(), tokens = normalized.split(/\s+/).filter(Boolean);
    const matches = records.filter(record => (!peer || record.node_id === peer) && (!client_kind || record.client_kind === client_kind) && (!project || record.project_label === project)).map(record => {
      const fields = ['alias', 'title', 'task_summary', 'project_label', 'tags'];
      const text = Object.fromEntries(fields.map(field => [field, (Array.isArray(record[field]) ? record[field].join(' ') : record[field] ?? '').toLowerCase()]));
      const matching = fields.filter(field => normalized && (text[field].includes(normalized) || tokens.every(token => text[field].includes(token))));
      const allText = fields.map(field => text[field]).join(' ');
      if (normalized && !tokens.every(token => allText.includes(token))) return null;
      const score = !normalized ? 0 : text.alias === normalized ? 100 : text.title === normalized ? 90 : matching.includes('title') ? 70 : matching.includes('task_summary') ? 50 : 30;
      return { ...record, fresh: record.directory_fresh && record.presence === 'online', match: { score, fields: matching } };
    }).filter(Boolean).sort((a, b) => b.match.score - a.match.score || Number(b.fresh) - Number(a.fresh) || Number(b.activity === 'working') - Number(a.activity === 'working') || a.address.localeCompare(b.address));
    return { sessions: matches.slice(0, limit), truncated: matches.length > limit };
  }
  hostBytes() {
    let bytes = 0;
    for (const name of readdirSync(this.blobDir)) { const stat = lstatSync(join(this.blobDir, name)); if (stat.isFile() && !stat.isSymbolicLink()) bytes += stat.size; }
    return bytes;
  }
  sessionBytes(id) { return this.db.prepare('SELECT coalesce(sum(a.bytes),0) AS n FROM attachments a JOIN messages m ON m.key=a.message_key WHERE m.owner=?').get(id).n; }
  reserveBytes(id, total, physicalBytes = total) {
    this.getSession(id);
    if (!Number.isSafeInteger(total) || total < 0 || total > this.limits.messageBytes) fail('LIMIT_EXCEEDED', 'Invalid transfer reservation size', 413);
    return this.transaction(() => {
      const all = this.db.prepare('SELECT coalesce(sum(host_bytes),0) AS n FROM reservations').get().n;
      const own = this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM reservations WHERE session=?').get(id).n;
      if (this.hostBytes() + all + physicalBytes > this.limits.hostBytes || this.sessionBytes(id) + own + total > this.limits.sessionBytes) fail('QUOTA_EXCEEDED', 'Attachment storage quota exhausted', 507, true);
      const reservation = randomUUID(); this.db.prepare('INSERT INTO reservations(id,session,bytes,host_bytes,created) VALUES (?,?,?,?,?)').run(reservation, id, total, physicalBytes, this.now()); return reservation;
    });
  }
  releaseReservation(id) { if (id !== undefined) this.db.prepare('DELETE FROM reservations WHERE id=?').run(identifier(id, 'reservation id')); }
  messageKey(direction, envelope) { return `${direction}:${envelope.from}:${envelope.id}`; }
  descriptors(row) { return this.db.prepare('SELECT descriptor FROM attachments WHERE message_key=? ORDER BY id').all(row.key).map(item => parse(item.descriptor)); }
  receipt(row) {
    const envelope = parse(row.envelope);
    const routing = Object.fromEntries(['conversation_id', 'from', 'to', 'kind', 'reply_to', 'created_at', 'expires_at'].filter(key => envelope[key] !== undefined).map(key => [key, envelope[key]]));
    return { ...routing, id: row.id, status: row.status, attachment_ids: this.descriptors(row).map(item => item.id), attachments: this.descriptors(row), retain_until: iso(row.retain), attempts: row.attempts, next_attempt_at: iso(row.next_attempt), ...(row.error ? { error: parse(row.error) } : {}), ...(row.acknowledged ? { acknowledged_at: iso(row.acknowledged) } : {}) };
  }
  checkDuplicate(direction, envelope) {
    if (!['outbox', 'inbox'].includes(direction)) fail('INVALID_INPUT', 'Invalid message direction');
    validateEnvelope(envelope, this.limits);
    const owner = address(direction === 'outbox' ? envelope.from : envelope.to);
    if (owner.nodeId !== this.nodeId) fail('FORBIDDEN', 'Message owner must belong to this node', 403);
    this.getSession(owner.sessionId);
    const key = this.messageKey(direction, envelope);
    const digest = createHash('sha256').update(canonicalJson(envelope)).digest('hex');
    const previous = this.db.prepare('SELECT * FROM messages WHERE key=?').get(key);
    if (previous) {
      if (previous.digest !== digest) fail('CONFLICT', 'Message ID already belongs to different content', 409);
      if (previous.retain <= this.now()) fail('MESSAGE_EXPIRED', 'Message retention has ended', 410);
      this.expireStatus(previous);
      return this.receipt(previous);
    }
    const tombstone = this.db.prepare('SELECT * FROM tombstones WHERE key=?').get(key);
    if (tombstone) {
      if (tombstone.digest !== digest) fail('CONFLICT', 'Message ID already belongs to different content', 409);
      fail('MESSAGE_EXPIRED', 'Message retention has ended', 410);
    }
    return null;
  }
  putMessage({ direction, envelope, stagedAttachments = [], reservationId }) {
    if (!['outbox', 'inbox'].includes(direction)) fail('INVALID_INPUT', 'Invalid message direction');
    validateEnvelope(envelope, this.limits);
    const ownerAddress = address(direction === 'outbox' ? envelope.from : envelope.to);
    if (ownerAddress.nodeId !== this.nodeId) fail('FORBIDDEN', 'Message owner must belong to this node', 403);
    const owner = this.getSession(ownerAddress.sessionId);
    const source = address(envelope.from);
    if (direction === 'inbox' && source.nodeId !== this.nodeId && !owner.visible_peers.includes('*') && !owner.visible_peers.includes(source.nodeId)) fail('FORBIDDEN', 'Session is not visible to sender', 403);
    const key = this.messageKey(direction, envelope), digest = createHash('sha256').update(canonicalJson(envelope)).digest('hex');
    const existing = this.checkDuplicate(direction, envelope);
    if (existing) {
      this.releaseReservation(reservationId); this.cleanupStaged(stagedAttachments);
      return existing;
    }
    validateAdmissionTime(envelope, this.now(), this.timing.maxTtlSeconds);
    const manifest = envelope.attachments ?? [], total = manifest.reduce((sum, item) => sum + item.size_bytes, 0);
    if (manifest.length !== stagedAttachments.length) fail('INCOMPLETE_MESSAGE', 'Every attachment must be staged', 400);
    const stagedIds = new Set();
    for (const item of stagedAttachments) {
      if (stagedIds.has(item.id)) fail('INCOMPLETE_MESSAGE', 'Duplicate staged attachment');
      stagedIds.add(item.id);
      const expected = manifest.find(descriptor => descriptor.id === item.id);
      if (!expected || canonicalJson(expected) !== canonicalJson(Object.fromEntries(Object.keys(expected).map(field => [field, item[field]])))) fail('INCOMPLETE_MESSAGE', 'Staged attachment manifest mismatch');
      this.attachmentSource(item);
      const fd = verifyFile(item.path, expected); closeSync(fd);
    }
    let ownReservation = false;
    if (!reservationId) { reservationId = this.reserveBytes(owner.session_id, total, stagedAttachments.reduce((sum, item) => sum + (resolve(item.path) === join(this.blobDir, item.sha256) ? 0 : item.size_bytes), 0)); ownReservation = true; }
    try {
      const reserved = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(reservationId);
      if (!reserved || reserved.session !== owner.session_id || reserved.bytes !== total) fail('INVALID_RESERVATION', 'Invalid attachment reservation');
      if (this.db.prepare('SELECT count(*) AS n FROM messages').get().n >= this.limits.retainedMessages) fail('QUEUE_FULL', 'Retained message limit reached', 507, true);
      for (const item of stagedAttachments) this.promote(item);
      return this.transaction(() => {
        const expires = Date.parse(envelope.expires_at), status = direction === 'outbox' ? 'queued' : 'persisted_remote';
        this.db.prepare('INSERT INTO messages(key,id,sender,owner,direction,envelope,digest,status,expires,retain,next_attempt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(key, envelope.id, envelope.from, owner.session_id, direction, json(envelope), digest, status, expires, expires + this.timing.retentionSeconds * 1000, this.now());
        for (const item of manifest) this.db.prepare('INSERT INTO attachments(message_key,id,hash,bytes,descriptor) VALUES (?,?,?,?,?)').run(key, item.id, item.sha256, item.size_bytes, json(item));
        this.releaseReservation(reservationId);
        return this.receipt(this.db.prepare('SELECT * FROM messages WHERE key=?').get(key));
      });
    } catch (error) {
      if (ownReservation) this.releaseReservation(reservationId);
      if (['ENOSPC', 'EDQUOT', 'EIO'].includes(error.code) || error.errcode === 13) fail('STORAGE_UNAVAILABLE', 'Unable to durably store message bytes', 507, true);
      throw error;
    }
  }
  stagingPath(path) {
    if (typeof path !== 'string' || dirname(resolve(path)) !== this.stagingDir || realpathSync(dirname(path)) !== realpathSync(this.stagingDir)) fail('UNSAFE_PATH', 'Attachment path must be within private staging');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Staged attachment must be a regular file');
    return path;
  }
  attachmentSource(item) {
    if (typeof item.path === 'string' && resolve(item.path) === join(this.blobDir, item.sha256)) {
      const stat = lstatSync(item.path);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Stored attachment must be a regular file');
      return item.path;
    }
    return this.stagingPath(item.path);
  }
  cleanupStaged(items) { for (const item of items) { try { unlinkSync(this.stagingPath(item.path)); } catch {} } }
  promote(item) {
    const destination = join(this.blobDir, item.sha256);
    if (resolve(item.path) === destination) { const fd = verifyFile(destination, item); closeSync(fd); return; }
    try {
      lstatSync(destination);
      const fd = verifyFile(destination, item); closeSync(fd); unlinkSync(item.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const fd = verifyFile(item.path, item); try { fsyncSync(fd); } finally { closeSync(fd); }
      chmodSync(item.path, 0o600); renameSync(item.path, destination); syncDirectory(this.blobDir); syncDirectory(this.stagingDir);
    }
  }
  findMessage(id, messageId, direction) {
    this.getSession(id); identifier(messageId, 'message id');
    const rows = this.db.prepare(`SELECT * FROM messages WHERE owner=? AND id=?${direction ? ' AND direction=?' : ''}`).all(...(direction ? [id, messageId, direction] : [id, messageId]));
    if (!rows.length) fail('NOT_FOUND', 'Message not found', 404);
    // Same-host delivery owns inbox and outbox only if a session messages itself.
    if (rows.length > 1 && new Set(rows.map(row => row.sender)).size > 1) fail('AMBIGUOUS_MESSAGE', 'Message ID is ambiguous; sender IDs must be globally unique', 409);
    return rows.find(row => row.direction === 'inbox') ?? rows[0];
  }
  receive(id, { limit = 20, leaseSeconds = 60 } = {}) {
    this.getSession(id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) fail('INVALID_INPUT', 'Invalid inbox limit or lease duration');
    this.maintenance();
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM messages WHERE owner=? AND direction='inbox' AND status='persisted_remote' AND (lease IS NULL OR lease<=?) AND expires>? ORDER BY rowid LIMIT ?").all(id, this.now(), this.now(), limit);
      const messages = rows.map(row => {
        const token = secret(), lease = Math.min(row.expires, this.now() + leaseSeconds * 1000);
        this.db.prepare('UPDATE messages SET lease=?,delivery_token=?,announced=1 WHERE key=?').run(lease, token, row.key);
        return { ...parse(row.envelope), delivery_token: token, lease_until: iso(lease), retain_until: iso(row.retain) };
      });
      return { messages };
    });
  }
  ack(id, messageId, token) {
    return this.transaction(() => {
      const row = this.findMessage(id, messageId, 'inbox');
      if (typeof token !== 'string' || !token || token !== row.delivery_token) fail('INVALID_DELIVERY_TOKEN', 'Invalid delivery token', 409);
      if (row.status === 'acknowledged') return this.receipt(row);
      if (row.status !== 'persisted_remote' || row.lease <= this.now() || row.expires <= this.now()) fail('LEASE_EXPIRED', 'Delivery lease has expired', 409);
      this.db.prepare("UPDATE messages SET status='acknowledged',acknowledged=?,retain=?,lease=NULL WHERE key=?").run(this.now(), this.now() + this.timing.retentionSeconds * 1000, row.key);
      return this.receipt(this.db.prepare('SELECT * FROM messages WHERE key=?').get(row.key));
    });
  }
  expireStatus(row) {
    if (row.expires <= this.now() && ['queued', 'retry', 'persisted_remote'].includes(row.status)) {
      this.db.prepare("UPDATE messages SET status='expired',lease=NULL WHERE key=?").run(row.key);
      row.status = 'expired'; row.lease = null;
    }
  }
  messageStatus(id, messageId) { const row = this.findMessage(id, messageId); this.expireStatus(row); return this.receipt(row); }
  getReceipt(peerId, messageId) {
    identifier(peerId, 'peer id'); identifier(messageId, 'message id');
    const rows = this.db.prepare("SELECT * FROM messages WHERE direction='inbox' AND id=?").all(messageId).filter(row => address(row.sender).nodeId === peerId);
    if (rows.length > 1) fail('AMBIGUOUS_MESSAGE', 'Message ID is ambiguous', 409);
    if (!rows.length) fail('NOT_FOUND', 'Receipt not found', 404);
    const row = rows[0];
    this.expireStatus(row);
    return this.receipt(row);
  }
  attachment(id, messageId, attachmentId) {
    const row = this.findMessage(id, messageId);
    identifier(attachmentId, 'attachment id');
    const item = this.db.prepare('SELECT descriptor FROM attachments WHERE message_key=? AND id=?').get(row.key, attachmentId);
    if (!item || row.retain <= this.now()) fail('NOT_FOUND', 'Attachment not found or retention ended', 404);
    const descriptor = parse(item.descriptor), path = join(this.blobDir, descriptor.sha256);
    const fd = verifyFile(path, descriptor); closeSync(fd);
    return { ...descriptor, path, retain_until: iso(row.retain) };
  }
  pendingNotice(id, { event, stop_hook_active = false } = {}) {
    this.getSession(id);
    if (!['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event)) return emptyNotice();
    return this.transaction(() => {
      const session = this.db.prepare('SELECT last_notice,stop_used FROM sessions WHERE id=?').get(id);
      if (event === 'PostToolUse' && this.now() - session.last_notice < this.timing.hookThrottleSeconds * 1000) return emptyNotice();
      if (event === 'Stop' && (stop_hook_active || session.stop_used)) return emptyNotice();
      const rows = this.db.prepare("SELECT * FROM messages WHERE owner=? AND direction='inbox' AND status='persisted_remote' AND announced=0 AND expires>? AND (lease IS NULL OR lease<=?) ORDER BY rowid LIMIT 100").all(id, this.now(), this.now());
      if (!rows.length) return emptyNotice();
      for (const row of rows) this.db.prepare('UPDATE messages SET announced=1 WHERE key=?').run(row.key);
      this.db.prepare('UPDATE sessions SET last_notice=?,stop_used=? WHERE id=?').run(this.now(), event === 'Stop' ? 1 : session.stop_used, id);
      return { message_ids: rows.map(row => row.id), attachment_count: rows.reduce((sum, row) => sum + this.descriptors(row).length, 0) };
    });
  }
  dueOutbox(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 'Invalid outbox limit');
    return this.db.prepare("SELECT * FROM messages WHERE direction='outbox' AND status IN ('queued','retry','persisted_remote') AND next_attempt<=? AND expires>? ORDER BY next_attempt,rowid LIMIT ?").all(this.now(), this.now(), limit).map(row => ({ ...parse(row.envelope), attempts: row.attempts, next_attempt_at: iso(row.next_attempt), status: row.status }));
  }
  setDeliveryResult(messageId, { status, error, retryAt } = {}) {
    identifier(messageId, 'message id');
    if (!['queued', 'retry', 'persisted_remote', 'acknowledged', 'rejected', 'expired'].includes(status)) fail('INVALID_INPUT', 'Invalid delivery status');
    const rows = this.db.prepare("SELECT * FROM messages WHERE direction='outbox' AND id=?").all(messageId);
    if (!rows.length) fail('NOT_FOUND', 'Outbox message not found', 404);
    if (rows.length > 1) fail('AMBIGUOUS_MESSAGE', 'Outbox message ID is ambiguous', 409);
    const row = rows[0];
    if (['acknowledged', 'expired', 'rejected'].includes(row.status)) return this.receipt(row);
    const attempt = row.attempts + 1;
    let next = retryAt === undefined ? this.now() + (status === 'persisted_remote' ? 30000 : Math.min(300000, 1000 * 2 ** Math.min(attempt - 1, 12))) : typeof retryAt === 'number' ? retryAt : Date.parse(retryAt);
    if (!Number.isFinite(next)) fail('INVALID_INPUT', 'Invalid retry timestamp');
    next = Math.max(this.now(), next);
    const terminal = ['acknowledged', 'expired', 'rejected'].includes(status);
    // Delivery errors are metadata, never copied peer payloads or credentials.
    const safeError = error ? { code: typeof error === 'string' ? error.slice(0, 80) : typeof error.code === 'string' ? error.code.slice(0, 80) : 'DELIVERY_FAILED', message: typeof error.message === 'string' ? error.message.slice(0, 512) : 'Delivery failed', retryable: error.retryable === true } : null;
    this.db.prepare('UPDATE messages SET status=?,attempts=?,next_attempt=?,error=?,retain=?,acknowledged=? WHERE key=?').run(status, attempt, next, safeError ? json(safeError) : null, terminal ? this.now() + this.timing.retentionSeconds * 1000 : row.retain, status === 'acknowledged' ? this.now() : null, row.key);
    return this.receipt(this.db.prepare('SELECT * FROM messages WHERE key=?').get(row.key));
  }
  maintenance() {
    const timestamp = this.now();
    const deleted = this.transaction(() => {
      this.db.prepare("UPDATE messages SET status='expired',lease=NULL WHERE status IN ('queued','retry','persisted_remote') AND expires<=?").run(timestamp);
      this.db.prepare("UPDATE messages SET lease=NULL,delivery_token=NULL,announced=0 WHERE status='persisted_remote' AND lease<=?").run(timestamp);
      this.db.prepare('DELETE FROM reservations WHERE created<?').run(timestamp - 3600000);
      const rows = this.db.prepare('SELECT * FROM messages WHERE retain<=?').all(timestamp);
      for (const row of rows) {
        this.db.prepare('INSERT OR REPLACE INTO tombstones(key,id,sender,digest,receipt,until_at) VALUES (?,?,?,?,?,?)').run(row.key, row.id, row.sender, row.digest, json(this.receipt(row)), timestamp + 30 * 86400000);
        this.db.prepare('DELETE FROM messages WHERE key=?').run(row.key);
      }
      this.db.prepare('DELETE FROM tombstones WHERE until_at<=?').run(timestamp);
      return rows.length;
    });
    const live = new Set(this.db.prepare('SELECT DISTINCT hash FROM attachments').all().map(row => row.hash));
    let blobs = 0, staging = 0;
    for (const name of readdirSync(this.blobDir)) {
      if (!live.has(name)) { unlinkSync(join(this.blobDir, name)); blobs++; }
    }
    for (const name of readdirSync(this.stagingDir)) {
      const path = join(this.stagingDir, name), stat = lstatSync(path);
      if (stat.mtimeMs < timestamp - 3600000 && !stat.isDirectory()) { unlinkSync(path); staging++; }
    }
    return { messages_deleted: deleted, blobs_deleted: blobs, staging_deleted: staging };
  }
  stats() {
    return { blob_bytes: this.hostBytes(), reserved_bytes: this.db.prepare('SELECT coalesce(sum(host_bytes),0) AS n FROM reservations').get().n, messages: this.db.prepare('SELECT count(*) AS n FROM messages').get().n, sessions: this.db.prepare('SELECT count(*) AS n FROM sessions').get().n, session_usage: this.db.prepare('SELECT id FROM sessions ORDER BY id').all().map(row => ({ session_id: row.id, retained_attachment_bytes: this.sessionBytes(row.id) })), limits: this.limits };
  }
  close() { this.db.close(); }
}
