import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const PROTOCOL = 'parler/0';
export const VERSION = '0.1.0';
export const MiB = 1024 * 1024;
export const LIMITS = Object.freeze({
  fileBytes: 10 * MiB,
  messageBytes: 32 * MiB,
  attachmentCount: 8,
  envelopeBytes: 64 * 1024,
  hostBytes: 1024 * MiB,
  sessionBytes: 256 * MiB,
  snapshotBytes: MiB,
  snapshotSessions: 256,
  sessionRecordBytes: 4096,
  retainedMessages: 10000,
});
export const DEFAULTS = Object.freeze({
  ttlSeconds: 86400,
  maxTtlSeconds: 7 * 86400,
  leaseSeconds: 60,
  retentionSeconds: 7 * 86400,
  presenceSeconds: 120,
  snapshotSeconds: 30,
  cacheSeconds: 120,
  hookThrottleSeconds: 5,
});

export class AppError extends Error {
  constructor(code, message, status = 400, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
export function fail(code, message, status = 400, retryable = false) {
  throw new AppError(code, message, status, retryable);
}
export function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function cleanText(value, name, max, { optional = false, allowEmpty = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || [...value].length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_INPUT', `${name} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters without control characters`);
  }
  return value;
}
export function identifier(value, name = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('INVALID_INPUT', `Invalid ${name}`);
  return value;
}
export function address(value) {
  if (typeof value !== 'string') fail('INVALID_INPUT', 'Invalid session address');
  const parts = value.split('/');
  if (parts.length !== 2) fail('INVALID_INPUT', 'Session address must be node_id/session_id');
  parts.forEach(part => identifier(part, 'session address'));
  return { nodeId: parts[0], sessionId: parts[1] };
}
export function filename(value) {
  cleanText(value, 'filename', 255);
  if (value === '.' || value === '..' || /[/\\]/.test(value)) fail('INVALID_INPUT', 'Attachment filename must be a basename');
  return value;
}
export function sessionPatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Session metadata must be an object');
  const output = {};
  for (const [key, max] of [['title', 80], ['task_summary', 240], ['project_label', 128], ['alias', 80]]) {
    if (input[key] !== undefined) output[key] = cleanText(input[key], key, max, { allowEmpty: key !== 'title' });
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 8) fail('INVALID_INPUT', 'At most 8 tags are allowed');
    output.tags = [...new Set(input.tags.map(tag => cleanText(tag, 'tag', 32)))];
  }
  if (input.visible_peers !== undefined) {
    if (!Array.isArray(input.visible_peers) || input.visible_peers.length > 256) fail('INVALID_INPUT', 'Invalid peer visibility list');
    output.visible_peers = [...new Set(input.visible_peers.map(peer => peer === '*' ? '*' : identifier(peer, 'peer')) )];
  }
  return output;
}
export function attachmentManifest(items = [], limits = LIMITS) {
  if (!Array.isArray(items) || items.length > limits.attachmentCount) fail('LIMIT_EXCEEDED', 'Too many attachments', 413);
  let total = 0;
  const ids = new Set();
  const result = items.map(item => {
    if (!item || typeof item !== 'object') fail('INVALID_INPUT', 'Invalid attachment descriptor');
    const id = identifier(item.id, 'attachment id');
    if (ids.has(id)) fail('INVALID_INPUT', 'Duplicate attachment id');
    ids.add(id);
    filename(item.filename);
    cleanText(item.media_type, 'media_type', 128);
    if (!Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0 || item.size_bytes > limits.fileBytes) fail('LIMIT_EXCEEDED', 'Attachment exceeds the per-file size limit', 413);
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) fail('INVALID_INPUT', 'Invalid attachment SHA-256');
    total += item.size_bytes;
    return { id, filename: item.filename, media_type: item.media_type, size_bytes: item.size_bytes, sha256: item.sha256 };
  });
  if (total > limits.messageBytes) fail('LIMIT_EXCEEDED', 'Combined attachment bytes exceed the per-message limit', 413);
  return result;
}
export function validateEnvelope(input, limits = LIMITS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Invalid message envelope');
  if (Buffer.byteLength(JSON.stringify(input)) > limits.envelopeBytes) fail('LIMIT_EXCEEDED', 'Message envelope is too large', 413);
  if (input.protocol !== PROTOCOL) fail('UNSUPPORTED_PROTOCOL', 'Unsupported protocol version');
  identifier(input.id, 'message id');
  identifier(input.conversation_id, 'conversation id');
  address(input.from); address(input.to);
  if (!['message', 'request', 'progress', 'result', 'error'].includes(input.kind)) fail('INVALID_INPUT', 'Invalid message kind');
  if (input.reply_to !== null && input.reply_to !== undefined) identifier(input.reply_to, 'reply_to');
  const created = Date.parse(input.created_at), expires = Date.parse(input.expires_at);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires - created > DEFAULTS.maxTtlSeconds * 1000) fail('INVALID_INPUT', 'Invalid message timestamps or TTL');
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body) || typeof input.body.text !== 'string') fail('INVALID_INPUT', 'Message body must contain text');
  attachmentManifest(input.attachments ?? [], limits);
  return input;
}

export function validateAdmissionTime(envelope, now, maxTtlSeconds = DEFAULTS.maxTtlSeconds) {
  const skew = 60000;
  if (Date.parse(envelope.created_at) > now + skew || Date.parse(envelope.expires_at) > now + maxTtlSeconds * 1000 + skew) fail('INVALID_INPUT', 'Message timestamps exceed the delivery window');
  if (Date.parse(envelope.expires_at) <= now) fail('MESSAGE_EXPIRED', 'Message delivery TTL expired', 410);
}

// A strict-local endpoint is a literal LAN/private IP. Tailnet addresses are
// excluded because application-layer checks cannot prevent DERP fallback.
// Operators must also enforce private routing at the OS/network layer.
export function privateHost(host) {
  if (typeof host !== 'string') return false;
  let value = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) === 4) {
    const n = value.split('.').map(Number);
    return n[0] === 127 || n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168);
  }
  if (isIP(value) === 6) {
    value = new URL(`https://[${value}]`).hostname.slice(1, -1);
    return value === '::1' || (/^f[cd]/.test(value) && !value.startsWith('fd7a:115c:a1e0:'));
  }
  return false;
}
export function privateEndpoint(input) {
  let url;
  try { url = new URL(input); } catch { fail('INVALID_ENDPOINT', 'Peer endpoint must be an HTTPS URL with a literal private IP'); }
  if (url.protocol !== 'https:' || !privateHost(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    fail('INVALID_ENDPOINT', 'Only direct HTTPS endpoints using literal private IPs are allowed; DNS, public IPs, proxies, and tailnet addresses are not supported');
  }
  return url.origin;
}
