import http from 'node:http';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { AppError, LIMITS } from './common.mjs';

export async function adminToken(stateDir) {
  const token = (await fs.readFile(path.join(stateDir, 'admin.token'), 'utf8')).trim();
  if (!token) throw new AppError('INVALID_STATE', 'Missing admin credential');
  return token;
}

function bindingName(session) {
  return createHash('sha256').update(`${session.client_kind}\0${session.native_id}`).digest('hex') + '.json';
}

export async function saveBinding(stateDir, session) {
  if (!session || typeof session.token !== 'string' || !session.token || typeof session.address !== 'string' ||
      typeof session.native_id !== 'string' || !['codex', 'claude-code'].includes(session.client_kind) || typeof session.workspace !== 'string') {
    throw new AppError('INVALID_BINDING', 'Daemon returned an invalid session binding');
  }
  const directory = path.join(stateDir, 'bindings');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new AppError('INVALID_BINDING', 'Bindings directory must not be a symlink');
  await fs.chmod(directory, 0o700);
  const target = path.join(directory, bindingName(session));
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(session) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return session;
}

export async function resolveBinding(stateDir, { session, client, cwd } = {}) {
  if (client && !['codex', 'claude-code'].includes(client)) throw new AppError('INVALID_INPUT', 'Client must be codex or claude-code');
  const explicit = session || process.env.PARLER_SESSION;
  const native = explicit || (client === 'claude-code' ? process.env.CLAUDE_SESSION_ID : client === 'codex' ? process.env.CODEX_THREAD_ID : process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID);
  const directory = path.join(stateDir, 'bindings');
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  const bindings = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const file = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077)) throw new AppError('INVALID_BINDING', 'Session binding must be a private regular file');
      const value = JSON.parse(await file.readFile('utf8'));
      if (typeof value.token !== 'string' || !value.token || typeof value.address !== 'string' || typeof value.workspace !== 'string') throw new AppError('INVALID_BINDING', 'Invalid stored session binding');
      if (client && value.client_kind !== client) continue;
      if (native && value.address !== native && value.native_id !== native && value.session_id !== native) continue;
      bindings.push(value);
    } finally { await file.close(); }
  }
  // cwd is deliberately not used to select among sessions: concurrent sessions
  // in a single workspace must never accidentally impersonate one another.
  if (bindings.length !== 1) throw new AppError(bindings.length ? 'AMBIGUOUS_SESSION' : 'SESSION_NOT_FOUND', bindings.length ? 'Multiple session bindings match; pass --session ADDRESS or set PARLER_SESSION' : 'No session binding found; register the session first');
  return bindings[0];
}

export async function localRequest(stateDir, { method = 'GET', path: requestPath, body, token, timeoutMs = 2000, contentType, raw = false, maxResponseBytes = LIMITS.snapshotBytes } = {}) {
  if (!requestPath?.startsWith('/local/') || /[\r\n]/.test(requestPath)) throw new AppError('INVALID_INPUT', 'Invalid local request path');
  if (token !== undefined && (typeof token !== 'string' || !token || /[\r\n]/.test(token))) throw new AppError('INVALID_INPUT', 'Invalid local credential');
  const streamed = body && typeof body[Symbol.asyncIterator] === 'function';
  let bytes;
  if (body !== undefined && !streamed) {
    bytes = Buffer.from(JSON.stringify(body));
    if (bytes.length > LIMITS.envelopeBytes) throw new AppError('LIMIT_EXCEEDED', 'Request JSON exceeds the envelope size limit', 413);
  }
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = contentType || 'application/json';
  if (bytes) headers['content-length'] = bytes.length;
  return await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(stateDir, 'daemon.sock'), path: requestPath, method, headers });
    const timer = setTimeout(() => req.destroy(new AppError('DAEMON_TIMEOUT', 'Local daemon request timed out', 504, true)), timeoutMs);
    const settle = (fn, value) => { clearTimeout(timer); fn(value); };
    req.on('error', error => settle(reject, error instanceof AppError ? error : new AppError('DAEMON_UNAVAILABLE', 'Cannot connect to local daemon; start parler daemon', 503, true)));
    req.on('response', res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          const error = new AppError('LIMIT_EXCEEDED', 'Daemon response exceeds the size limit', 413);
          settle(reject, error); res.destroy(); req.destroy(error);
        }
        else chunks.push(chunk);
      });
      res.on('error', error => settle(reject, new AppError('DAEMON_RESPONSE', 'Local daemon response was interrupted', 502, true)));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        let parsed;
        if (!raw || res.statusCode >= 400) {
          try { parsed = JSON.parse(data.toString('utf8')); }
          catch { settle(reject, new AppError('DAEMON_RESPONSE', 'Local daemon returned invalid JSON', 502)); return; }
        }
        if (res.statusCode >= 400) {
          const error = parsed?.error;
          settle(reject, new AppError(error?.code || 'DAEMON_ERROR', error?.message || 'Local daemon rejected the request', res.statusCode, !!error?.retryable));
        } else settle(resolve, raw ? data : parsed);
      });
    });
    (async () => {
      try {
        if (streamed) { for await (const chunk of body) if (!req.write(chunk)) await once(req, 'drain'); req.end(); }
        else req.end(bytes);
      } catch (error) { req.destroy(error); }
    })();
  });
}
