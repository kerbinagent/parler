import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { AppError, DEFAULTS, LIMITS, VERSION, cleanText, identifier, privateHost, privateEndpoint, fail } from './common.mjs';

export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('INVALID_STATE', 'State directory must be a real directory');
  chmodSync(path, 0o700);
}
export function writePrivateJson(path, value) {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    const dirfd = openSync(dirname(path), 'r');
    try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}
export function endpointFor(listen, port) {
  return `https://${listen.includes(':') ? `[${listen}]` : listen}:${port}`;
}
export function initState({ stateDir = '.parler', label = 'parler-host', listen = '127.0.0.1', port = 7743, limits = {}, timing = {} } = {}) {
  stateDir = resolve(stateDir);
  if (!privateHost(listen)) fail('INVALID_ENDPOINT', 'Listener must be a literal LAN/private IP; wildcard, public, and tailnet addresses are unsupported');
  port = Number(port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('INVALID_INPUT', 'Port must be an integer between 0 and 65535');
  cleanText(label, 'host label', 80);
  privateDirectory(stateDir);
  if (existsSync(join(stateDir, 'config.json'))) fail('ALREADY_INITIALIZED', 'State already initialized; choose another --state directory', 409);
  const nodeId = randomUUID();
  const keyPath = join(stateDir, 'private.key'), certPath = join(stateDir, 'certificate.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '3650', '-subj', `/CN=${nodeId}`, '-addext', `subjectAltName=IP:${listen}`], { stdio: 'pipe', timeout: 30000 });
    chmodSync(keyPath, 0o600); chmodSync(certPath, 0o600);
  } catch (error) {
    for (const path of [keyPath, certPath]) { try { unlinkSync(path); } catch {} }
    throw new AppError('CERTIFICATE_INIT_FAILED', `Could not create a local certificate with openssl: ${error.code ?? 'generation failed'}`, 500);
  }
  const config = {
    version: VERSION, node_id: nodeId, label, listen, port,
    endpoint: endpointFor(listen, port),
    limits: { ...LIMITS, ...limits }, timing: { ...DEFAULTS, ...timing },
    peers: [],
  };
  validateConfig(config);
  writePrivateJson(join(stateDir, 'config.json'), config);
  writeFileSync(join(stateDir, 'admin.token'), randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  privateDirectory(join(stateDir, 'bindings'));
  return { node_id: nodeId, label, endpoint: config.endpoint, state_dir: stateDir };
}

function validateConfig(config) {
  identifier(config.node_id, 'node id'); cleanText(config.label, 'host label', 80);
  if (!privateHost(config.listen)) fail('INVALID_STATE', 'Configured listener must be a private IP');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) fail('INVALID_STATE', 'Invalid listen port');
  for (const [key, value] of Object.entries(config.limits ?? {})) {
    if (!(key in LIMITS) || !Number.isSafeInteger(value) || value < 1) fail('INVALID_STATE', `Invalid limit ${key}`);
  }
  if (config.limits.fileBytes > LIMITS.fileBytes || config.limits.messageBytes > LIMITS.messageBytes || config.limits.attachmentCount > LIMITS.attachmentCount || config.limits.envelopeBytes > LIMITS.envelopeBytes) {
    fail('INVALID_STATE', 'v0 transfer limits may be lowered, but cannot exceed v0 protocol maxima');
  }
  for (const [key, value] of Object.entries(config.timing ?? {})) {
    if (!(key in DEFAULTS) || !Number.isSafeInteger(value) || value < 1) fail('INVALID_STATE', `Invalid timing ${key}`);
  }
  if (!Array.isArray(config.peers) || config.peers.length > 256) fail('INVALID_STATE', 'Invalid peers');
  const nodes = new Set();
  for (const peer of config.peers) {
    identifier(peer.node_id, 'peer node id');
    if (nodes.has(peer.node_id) || peer.node_id === config.node_id) fail('INVALID_STATE', 'Duplicate or self peer');
    nodes.add(peer.node_id);
    if (peer.endpoint) privateEndpoint(peer.endpoint);
    if (peer.certificate) validateCertificate(peer.certificate);
    for (const key of ['token', 'incoming_token']) if (peer[key] !== undefined && !/^[a-f0-9]{64}$/.test(peer[key])) fail('INVALID_STATE', `Invalid peer ${key}`);
    for (const key of ['allowed_sources', 'allowed_destinations']) {
      if (peer[key] !== undefined && (!Array.isArray(peer[key]) || peer[key].some(id => id !== '*' && !/^[A-Za-z0-9_-]{1,128}$/.test(id)))) fail('INVALID_STATE', `Invalid ${key}`);
    }
  }
  return config;
}
export function validateCertificate(pem) {
  if (typeof pem !== 'string' || Buffer.byteLength(pem) > 16384) fail('INVALID_CERTIFICATE', 'Invalid certificate');
  try { return new X509Certificate(pem); } catch { fail('INVALID_CERTIFICATE', 'Invalid X509 certificate'); }
}
export function loadConfig(stateDir) {
  let value;
  try { value = JSON.parse(readFileSync(join(resolve(stateDir), 'config.json'), 'utf8')); }
  catch { fail('NOT_INITIALIZED', 'State not initialized; run parler init first', 404); }
  value.limits = { ...LIMITS, ...value.limits };
  value.timing = { ...DEFAULTS, ...value.timing };
  return validateConfig(value);
}
export function saveConfig(stateDir, config) {
  validateConfig(config);
  writePrivateJson(join(resolve(stateDir), 'config.json'), config);
}
