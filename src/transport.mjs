import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { request as httpsRequest, Agent } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { once } from 'node:events';
import { join } from 'node:path';
import { AppError, LIMITS, attachmentManifest, identifier, privateEndpoint } from './common.mjs';

const HEADER_BYTES = 8192;
const CHUNK_BYTES = 64 * 1024;
const invalidMultipart = message => new AppError('INVALID_MULTIPART', message);
const jsonDecoder = new TextDecoder('utf-8', { fatal: true });

function iteratorFor(stream) {
  return typeof stream.iterator === 'function'
    ? stream.iterator({ destroyOnReturn: false }) : stream[Symbol.asyncIterator]();
}

export async function readJson(stream, maxBytes = LIMITS.envelopeBytes) {
  const iterator = iteratorFor(stream);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      size += chunk.length;
      if (size > maxBytes) throw new AppError('LIMIT_EXCEEDED', 'JSON body exceeds the byte limit', 413);
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(jsonDecoder.decode(Buffer.concat(chunks))); }
    catch { throw new AppError('INVALID_JSON', 'Body must contain valid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_JSON', 'Body must be a JSON object');
    return value;
  } finally {
    await iterator.return?.();
  }
}

// The only retained body bytes are one source chunk and a delimiter-sized tail.
class MultipartReader {
  constructor(stream, maxBytes, delimiter) {
    this.iterator = iteratorFor(stream);
    this.buffer = Buffer.alloc(0);
    this.done = false;
    this.bytes = 0;
    this.maxBytes = maxBytes;
    this.delimiter = delimiter;
  }
  async fill() {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) { this.done = true; return false; }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) throw new AppError('LIMIT_EXCEEDED', 'Multipart body exceeds the byte limit', 413);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    return true;
  }
  async need(count) {
    while (this.buffer.length < count && await this.fill()) {}
    if (this.buffer.length < count) throw invalidMultipart('Truncated multipart body');
  }
  async take(count) {
    await this.need(count);
    const bytes = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }
  async headers() {
    const endMarker = Buffer.from('\r\n\r\n');
    for (;;) {
      const end = this.buffer.indexOf(endMarker);
      if (end >= 0) {
        if (end > HEADER_BYTES) throw new AppError('LIMIT_EXCEEDED', 'Multipart headers exceed the byte limit', 413);
        const bytes = await this.take(end + 4);
        return parseHeaders(bytes.subarray(0, end));
      }
      if (this.buffer.length > HEADER_BYTES + 3) throw new AppError('LIMIT_EXCEEDED', 'Multipart headers exceed the byte limit', 413);
      if (!await this.fill()) throw invalidMultipart('Truncated multipart headers');
    }
  }
  async part(onBytes, maxBytes) {
    let total = 0;
    const emit = async count => {
      if (!count) return;
      total += count;
      if (total > maxBytes) throw new AppError('LIMIT_EXCEEDED', 'Multipart part exceeds its declared byte limit', 413);
      const bytes = this.buffer.subarray(0, count);
      this.buffer = this.buffer.subarray(count);
      await onBytes(bytes);
    };
    for (;;) {
      const at = this.buffer.indexOf(this.delimiter);
      if (at >= 0) {
        await this.need(at + this.delimiter.length + 2);
        const suffixAt = at + this.delimiter.length;
        const suffix = this.buffer.subarray(suffixAt, suffixAt + 2).toString('ascii');
        if (suffix === '\r\n' || suffix === '--') {
          await emit(at);
          await this.take(this.delimiter.length + 2);
          return { total, closed: suffix === '--' };
        }
        // A boundary-like sequence with a different suffix is ordinary binary.
        await emit(at + 1);
      } else {
        await emit(Math.max(0, this.buffer.length - this.delimiter.length - 1));
        if (!await this.fill()) throw invalidMultipart('Missing closing multipart boundary');
      }
    }
  }
  async finish() {
    while (await this.fill()) {
      if (this.buffer.length > 2) throw invalidMultipart('Unexpected bytes after closing boundary');
    }
    if (this.buffer.length && !this.buffer.equals(Buffer.from('\r\n'))) throw invalidMultipart('Unexpected bytes after closing boundary');
  }
}

function parseHeaders(bytes) {
  // Latin-1 avoids accepting non-ASCII bytes by truncating their high bits.
  const text = bytes.toString('latin1');
  if (/[^\x20-\x7e\r\n]/.test(text)) throw invalidMultipart('Invalid multipart headers');
  const headers = new Map();
  const lines = text.split('\r\n');
  if (lines.length > 16) throw invalidMultipart('Too many multipart headers');
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!match || headers.has(match[1].toLowerCase())) throw invalidMultipart('Invalid or duplicate multipart header');
    headers.set(match[1].toLowerCase(), match[2]);
  }
  const disposition = /^form-data;\s*name="([^"\r\n]+)"(?:;\s*filename="[^"\r\n]*")?$/i.exec(headers.get('content-disposition') ?? '');
  if (!disposition || headers.has('content-transfer-encoding')) throw invalidMultipart('Multipart requires named binary form-data parts');
  return { name: disposition[1], contentType: headers.get('content-type') };
}

function boundaryFrom(contentType) {
  if (typeof contentType !== 'string') throw invalidMultipart('Missing multipart content type');
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=?-]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))\s*$/i.exec(contentType);
  if (!match) throw invalidMultipart('Invalid multipart boundary');
  return match[1] ?? match[2];
}

export async function readMultipart(stream, contentType, { stagingDir, limits = LIMITS, reserve = () => undefined }) {
  const boundary = boundaryFrom(contentType);
  const reader = new MultipartReader(stream,
    limits.envelopeBytes + limits.messageBytes + (limits.attachmentCount + 1) * (HEADER_BYTES + 160) + 160,
    Buffer.from(`\r\n--${boundary}`));
  const ownedPaths = [];
  const stagedAttachments = [];
  let reservationId;
  try {
    const initial = Buffer.from(`--${boundary}\r\n`);
    if (!(await reader.take(initial.length)).equals(initial)) throw invalidMultipart('Multipart must begin with its boundary');
    const firstHeaders = await reader.headers();
    if (firstHeaders.name !== 'envelope' || (firstHeaders.contentType && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(firstHeaders.contentType))) throw invalidMultipart('First multipart part must be a JSON envelope');
    const envelopeChunks = [];
    let part = await reader.part(bytes => { envelopeChunks.push(bytes); }, limits.envelopeBytes);
    let envelope;
    try { envelope = JSON.parse(jsonDecoder.decode(Buffer.concat(envelopeChunks))); }
    catch { throw new AppError('INVALID_JSON', 'Envelope must contain valid JSON'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new AppError('INVALID_JSON', 'Envelope must be a JSON object');
    const manifest = attachmentManifest(envelope.attachments ?? [], limits);
    reservationId = await reserve(envelope);
    if (manifest.length) {
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      const info = await lstat(stagingDir);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new AppError('INVALID_STAGING', 'Staging must be a private directory', 500);
    }
    const expected = new Map(manifest.map(item => [item.id, item]));
    while (!part.closed) {
      if (stagedAttachments.length >= manifest.length) throw invalidMultipart('Unexpected attachment part');
      const headers = await reader.headers();
      const descriptor = headers.name.startsWith('attachment:') && expected.get(headers.name.slice(11));
      if (!descriptor) throw invalidMultipart('Unknown or duplicate attachment part');
      expected.delete(descriptor.id);
      const path = join(stagingDir, `${randomBytes(24).toString('hex')}.upload`);
      const file = await open(path, 'wx', 0o600);
      ownedPaths.push(path);
      const hash = createHash('sha256');
      try {
        part = await reader.part(async bytes => {
          hash.update(bytes);
          let written = 0;
          while (written < bytes.length) {
            const result = await file.write(bytes, written, bytes.length - written);
            if (!result.bytesWritten) throw new AppError('STAGING_WRITE_FAILED', 'Cannot write attachment staging file', 500, true);
            written += result.bytesWritten;
          }
        }, descriptor.size_bytes);
        if (part.total !== descriptor.size_bytes || hash.digest('hex') !== descriptor.sha256) throw new AppError('INTEGRITY_FAILED', 'Attachment size or SHA-256 does not match its manifest');
        await file.sync();
      } finally { await file.close(); }
      stagedAttachments.push({ ...descriptor, path });
    }
    if (expected.size) throw invalidMultipart('Missing attachment part');
    await reader.finish();
    return { envelope, stagedAttachments, reservationId };
  } catch (error) {
    await Promise.all(ownedPaths.map(path => unlink(path).catch(() => {})));
    if (reservationId !== undefined) error.reservationId = reservationId;
    throw error;
  } finally { await reader.iterator.return?.(); }
}

export function multipartBody(envelope, attachments = []) {
  const manifest = attachmentManifest(envelope.attachments ?? []);
  const json = Buffer.from(JSON.stringify(envelope));
  if (json.length > LIMITS.envelopeBytes) throw new AppError('LIMIT_EXCEEDED', 'Message envelope is too large', 413);
  if (!Array.isArray(attachments) || attachments.length !== manifest.length) throw invalidMultipart('Attachments must match the envelope manifest');
  const sources = new Map();
  for (const attachment of attachments) {
    if (sources.has(attachment.id) || typeof attachment.path !== 'string') throw invalidMultipart('Invalid attachment source');
    sources.set(attachment.id, attachment);
  }
  if (manifest.some(item => !sources.has(item.id))) throw invalidMultipart('Attachments must match the envelope manifest');
  const boundary = `parler-${randomBytes(24).toString('hex')}`;
  async function* body() {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="envelope"\r\nContent-Type: application/json\r\n\r\n`);
    yield json;
    for (const descriptor of manifest) {
      yield Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="attachment:${descriptor.id}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const stream = createReadStream(sources.get(descriptor.id).path, { highWaterMark: CHUNK_BYTES });
      let total = 0;
      const hash = createHash('sha256');
      for await (const bytes of stream) {
        total += bytes.length;
        if (total > descriptor.size_bytes) throw new AppError('INTEGRITY_FAILED', 'Attachment changed after its manifest was created');
        hash.update(bytes);
        yield bytes;
      }
      if (total !== descriptor.size_bytes || hash.digest('hex') !== descriptor.sha256) throw new AppError('INTEGRITY_FAILED', 'Attachment changed after its manifest was created');
    }
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: body() };
}

export async function requestPeer(peer, { method = 'GET', path, body, contentType, nodeId, timeoutMs = 10000, maxResponseBytes = LIMITS.snapshotBytes, signal, allowTailnet = false }) {
  const cancelled = new AppError('PEER_CANCELLED', 'Private peer request was cancelled', 503, true);
  if (signal?.aborted) throw cancelled;
  const endpoint = new URL(privateEndpoint(peer.endpoint, { allowTailnet }));
  identifier(nodeId, 'node id');
  if (typeof peer.token !== 'string' || !peer.token.length || peer.token.length > 4096 || /[^\x21-\x7e]/.test(peer.token)) throw new AppError('INVALID_PEER', 'Invalid peer authentication token');
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\r\n#]/.test(path) || !/^[A-Z]+$/.test(method)) throw new AppError('INVALID_INPUT', 'Invalid peer request method or path');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AppError('INVALID_INPUT', 'Invalid peer timeout');
  let certificate;
  try { certificate = new X509Certificate(peer.certificate).raw; }
  catch { throw new AppError('INVALID_PEER', 'Invalid pinned peer certificate'); }
  const agent = new Agent({ keepAlive: false });
  const controller = new AbortController();
  let socket, request;
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const cancel = () => {
    rejectCancellation(cancelled);
    controller.abort(cancelled);
    request?.destroy();
    socket?.destroy();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const timedOut = new AppError('PEER_TIMEOUT', 'Private peer request timed out', 504, true);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timedOut);
      controller.abort(timedOut);
      request?.destroy();
      socket?.destroy();
    }, timeoutMs);
  });
  const operation = async () => {
    socket = tlsConnect({ host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: Number(endpoint.port || 443), rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    // No HTTP bytes (including auth headers) leave until the certificate is pinned.
    await once(socket, 'secureConnect', { signal: controller.signal });
    const actual = socket.getPeerCertificate().raw;
    if (!actual || actual.length !== certificate.length || !timingSafeEqual(actual, certificate)) throw new AppError('CERTIFICATE_MISMATCH', 'Peer TLS certificate does not match the paired certificate', 403);
    agent.createConnection = () => socket;
    const headers = { Authorization: `Bearer ${peer.token}`, 'X-Parler-Node': nodeId, Accept: 'application/json' };
    let payload = body;
    if (body !== undefined && typeof body?.[Symbol.asyncIterator] !== 'function') {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = contentType ?? 'application/json';
      headers['Content-Length'] = String(payload.length);
    } else if (body !== undefined) headers['Content-Type'] = contentType ?? 'application/octet-stream';
    request = httpsRequest(endpoint, { method, path, headers, agent, signal: controller.signal });
    const responsePromise = new Promise((resolve, reject) => {
      request.once('error', reject);
      request.once('response', async response => {
        try {
          if (response.statusCode >= 300 && response.statusCode < 400) {
            response.destroy();
            throw new AppError('REDIRECT_REJECTED', 'Private peer redirects are forbidden', 502);
          }
          const value = await readJson(response, maxResponseBytes);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = value.error;
            throw new AppError(
              typeof error?.code === 'string' && error.code.length <= 128 ? error.code : 'PEER_ERROR',
              typeof error?.message === 'string' && error.message.length <= 512 ? error.message : 'Private peer rejected the request',
              response.statusCode, error?.retryable === true || response.statusCode >= 500);
          }
          resolve(value);
        } catch (error) { response.destroy(); reject(error); }
      });
    });
    const write = async () => {
      if (payload !== undefined) {
        if (typeof payload[Symbol.asyncIterator] === 'function') {
          for await (const chunk of payload) {
            if (request.destroyed) throw new AppError('PEER_UNAVAILABLE', 'Private peer closed its connection', 503, true);
            if (!request.write(chunk)) await once(request, 'drain', { signal: controller.signal });
          }
        } else request.write(payload);
      }
      request.end();
    };
    // Observe upload errors even when a peer rejects a request before reading it.
    const upload = write();
    upload.catch(error => request.destroy(error));
    const response = await responsePromise;
    await upload;
    return response;
  };
  try { return await Promise.race([operation(), timeout, cancellation]); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PEER_UNAVAILABLE', 'Unable to reach the configured private peer', 503, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
    request?.destroy();
    socket?.destroy();
    agent.destroy();
  }
}
