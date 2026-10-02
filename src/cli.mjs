import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, LIMITS, attachmentManifest, filename, identifier } from './common.mjs';
import { localRequest, saveBinding, resolveBinding, adminToken } from './local-client.mjs';

const valueOptions = new Set(['state', 'session', 'client', 'format', 'label', 'listen', 'port', 'worker-interval-ms', 'for', 'output', 'native-id', 'workspace', 'title', 'project-label', 'task-summary', 'tag', 'query', 'client-kind', 'project', 'peer', 'to', 'kind', 'text', 'reply-to', 'conversation-id', 'ttl-seconds', 'attach', 'json', 'limit', 'wait-seconds', 'message', 'delivery-token', 'attachment']);
const repeatOptions = new Set(['attach', 'tag']);
const HELP = `Parler: private session messages and attachments
Usage: parler [--state DIR] [--session ADDRESS|NATIVE_ID] COMMAND

  init [--label NAME --listen PRIVATE_IP --port PORT]
  daemon [--worker-interval-ms N]
  info
  peer export --for NODE_ID --output FILE
  peer import FILE | peer list
  session register --client codex|claude-code --native-id ID
                   [--workspace DIR --title TITLE --project-label LABEL]
  session update [--title TITLE --task-summary TEXT --project-label LABEL --tag TAG]
  session show | session close
  sessions [--query TEXT --client-kind KIND --project LABEL --peer ID --refresh]
  send --to ADDRESS [--kind request|result|message|progress|error --text TEXT]
       [--attach FILE ... --reply-to ID --conversation-id ID --ttl-seconds N]
       [--json FILE|-] (without --text or --json, read JSON stdin)
  receive [--limit N --wait-seconds N]
  ack --message ID --delivery-token TOKEN
  status --message ID
  attachments list --message ID
  attachments export --message ID --attachment ID --output FILE

Root options can appear anywhere. Output is JSON; credentials are never printed.
Exports create files exclusively inside the registered session workspace.
`;

export function parseArgs(args) {
  const options = {}, positionals = [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (argument === '-h') { options.help = true; continue; }
    if (!argument.startsWith('--')) { positionals.push(argument); continue; }
    const equals = argument.indexOf('=');
    const key = argument.slice(2, equals < 0 ? undefined : equals);
    if (key === 'help' || key === 'refresh') {
      if (equals >= 0) throw new AppError('INVALID_INPUT', `--${key} takes no value`);
      options[key] = true; continue;
    }
    if (!valueOptions.has(key)) throw new AppError('INVALID_INPUT', `Unknown option --${key}`);
    let value = equals < 0 ? args[++i] : argument.slice(equals + 1);
    if (value === undefined || (equals < 0 && value.startsWith('--'))) throw new AppError('INVALID_INPUT', `--${key} requires a value; use --${key}=VALUE for values beginning with --`);
    if (repeatOptions.has(key)) (options[key] ??= []).push(value);
    else {
      if (options[key] !== undefined) throw new AppError('INVALID_INPUT', `Duplicate --${key}`);
      options[key] = value;
    }
  }
  return { options, positionals };
}

function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'token' && key !== 'admin_token').map(([key, item]) => [key, publicResult(item)]));
  return value;
}
function required(options, key) {
  if (!options[key]) throw new AppError('INVALID_INPUT', `--${key} is required`);
  return options[key];
}
function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new AppError('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}
async function boundedJson(input, maxBytes = LIMITS.envelopeBytes) {
  const chunks = []; let count = 0;
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    count += data.length;
    if (count > maxBytes) throw new AppError('LIMIT_EXCEEDED', 'JSON input exceeds the size limit', 413);
    chunks.push(data);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AppError('INVALID_INPUT', 'Input must contain one JSON object'); }
}
async function inputJson(file, stdin, maxBytes = LIMITS.envelopeBytes) {
  if (!file || file === '-') return boundedJson(stdin, maxBytes);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new AppError('LIMIT_EXCEEDED', 'JSON input must be a regular file within the size limit', 413);
    return await boundedJson(handle.createReadStream({ autoClose: false }), maxBytes);
  } finally { await handle.close(); }
}
function mediaType(file) {
  return ({ '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.csv': 'text/csv; charset=utf-8' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

async function prepareAttachments(files = []) {
  if (files.length > LIMITS.attachmentCount) throw new AppError('LIMIT_EXCEEDED', 'Too many attachments', 413);
  const handles = [], items = []; let total = 0;
  try {
    for (const file of files) {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(handle);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AppError('INVALID_ATTACHMENT', 'Attachments must be regular files');
      if (stat.size > LIMITS.fileBytes) throw new AppError('LIMIT_EXCEEDED', 'Attachment exceeds the per-file size limit', 413);
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 })) {
        size += chunk.length;
        if (size > LIMITS.fileBytes) throw new AppError('LIMIT_EXCEEDED', 'Attachment exceeds the per-file size limit', 413);
        hash.update(chunk);
      }
      total += size;
      if (total > LIMITS.messageBytes) throw new AppError('LIMIT_EXCEEDED', 'Combined attachments exceed the per-message size limit', 413);
      items.push({ id: randomUUID(), filename: filename(path.basename(file)), media_type: mediaType(file), size_bytes: size, sha256: hash.digest('hex'), path: process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : file });
    }
    return { items, close: async () => { await Promise.all(handles.map(handle => handle.close())); } };
  } catch (error) { await Promise.all(handles.map(handle => handle.close())); throw error; }
}

export async function exportAttachment(workspace, output, bytes, descriptor) {
  filename(descriptor.filename);
  if (bytes.length !== descriptor.size_bytes || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new AppError('INTEGRITY_ERROR', 'Attachment size or SHA-256 does not match its manifest', 409);
  if (typeof output !== 'string' || !output || output.includes('\0') || output.split(/[\\/]/).includes('..') || output.includes('\\')) throw new AppError('UNSAFE_PATH', 'Export path must not contain traversal or backslashes');
  const root = await fs.realpath(workspace);
  const destination = path.resolve(root, output);
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new AppError('UNSAFE_PATH', 'Export destination must be inside the session workspace');
  const components = relative.split(path.sep);
  const basename = components.pop(); filename(basename);
  // Linux dirfd paths anchor every operation to a directory opened without
  // following symlinks. Never resolve a checked parent path a second time.
  if (process.platform !== 'linux') throw new AppError('UNSUPPORTED_PLATFORM', 'Safe workspace attachment export currently requires Linux');
  const directories = [];
  let targetHandle;
  let createdPath;
  try {
    let directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directories.push(directory);
    for (const component of components) {
      const entry = `/proc/self/fd/${directory.fd}/${component}`;
      try { await fs.mkdir(entry, { mode: 0o777 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      directory = await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push(directory);
    }
    createdPath = `/proc/self/fd/${directory.fd}/${basename}`;
    targetHandle = await fs.open(createdPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
    try { await targetHandle.writeFile(bytes); await targetHandle.sync(); }
    catch (error) { await fs.unlink(createdPath); throw error; }
    return { output: destination, size_bytes: bytes.length, sha256: descriptor.sha256 };
  } catch (error) {
    if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw new AppError('UNSAFE_PATH', 'Export path contains a symlink or non-directory');
    if (error.code === 'EEXIST') throw new AppError('OUTPUT_EXISTS', 'Export destination already exists; choose a new path', 409);
    throw error;
  } finally {
    await targetHandle?.close();
    await Promise.all(directories.map(handle => handle.close()));
  }
}

export async function runCli(args = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { options: o, positionals: p } = parseArgs(args);
    if (o.help || !p.length) { stdout.write(HELP); return 0; }
    if (o.format && o.format !== 'json') throw new AppError('INVALID_INPUT', 'Only --format json is supported');
    const stateDir = path.resolve(o.state || process.env.PARLER_STATE || '.parler');
    const [command, subcommand] = p;
    const print = result => stdout.write(JSON.stringify(publicResult(result), null, 2) + '\n');
    const admin = async (method, requestPath, body) => localRequest(stateDir, { method, path: requestPath, body, token: await adminToken(stateDir), timeoutMs: 10000 });
    let binding;
    const session = async () => binding ??= await resolveBinding(stateDir, { session: o.session, client: o.client, cwd: process.cwd() });
    const request = async (method, requestPath, body, extra = {}) => localRequest(stateDir, { method, path: requestPath, body, token: (await session()).token, timeoutMs: 10000, ...extra });
    const one = () => { if (p.length !== 1) throw new AppError('INVALID_INPUT', `Unexpected argument for ${command}`); };
    let result;
    switch (command) {
      case 'init': {
        one();
        const { initState } = await import('./config.mjs');
        const info = await initState({ stateDir, label: o.label, listen: o.listen, port: integer(o.port, 'port', { min: 0, max: 65535 }) });
        result = { node_id: info.node_id, label: info.label, endpoint: info.endpoint }; break;
      }
      case 'daemon': {
        one();
        const { startDaemon } = await import('./daemon.mjs');
        const daemon = await startDaemon({ stateDir, workerIntervalMs: integer(o['worker-interval-ms'], 'worker interval', { min: 10, max: 3600000 }) });
        print({ status: 'listening', socket_path: daemon.socketPath, network_address: daemon.networkAddress });
        let stopping = false;
        const stop = async () => { if (stopping) return; stopping = true; await daemon.close(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        return 0;
      }
      case 'info': one(); result = await admin('GET', '/local/info'); break;
      case 'peer': {
        if (subcommand === 'list' && p.length === 2) result = await admin('GET', '/local/peers');
        else if (subcommand === 'import' && p.length === 3) result = await admin('POST', '/local/peers/import', await inputJson(p[2], stdin));
        else if (subcommand === 'export' && p.length === 2) {
          const output = path.resolve(required(o, 'output'));
          const invitation = await admin('POST', '/local/peers/export', { for_node_id: required(o, 'for') });
          await fs.writeFile(output, JSON.stringify(invitation, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          result = { node_id: invitation.node_id, for_node_id: invitation.for_node_id, output };
        } else throw new AppError('INVALID_INPUT', 'Use peer list, peer import FILE, or peer export --for ID --output FILE');
        break;
      }
      case 'session': {
        if (p.length !== 2) throw new AppError('INVALID_INPUT', 'Unexpected session command argument');
        const patch = { title: o.title, task_summary: o['task-summary'], project_label: o['project-label'], tags: o.tag };
        if (subcommand === 'register') {
          const client = required(o, 'client');
          if (!['codex', 'claude-code'].includes(client)) throw new AppError('INVALID_INPUT', 'Client must be codex or claude-code');
          result = await admin('POST', '/local/sessions/register', { client_kind: client, native_id: required(o, 'native-id'), workspace: path.resolve(o.workspace || process.cwd()), ...patch });
          await saveBinding(stateDir, result);
        } else if (subcommand === 'update') { result = await request('PATCH', '/local/session', patch); }
        else if (subcommand === 'show') result = await request('GET', '/local/session');
        else if (subcommand === 'close') result = await request('POST', '/local/session/close', {});
        else throw new AppError('INVALID_INPUT', 'Unknown session subcommand');
        break;
      }
      case 'sessions': {
        one(); const query = new URLSearchParams();
        for (const [key, value] of [['query', o.query], ['client_kind', o['client-kind']], ['project', o.project], ['peer', o.peer], ['refresh', o.refresh ? '1' : undefined]]) if (value !== undefined) query.set(key, value);
        result = await request('GET', `/local/sessions?${query}`); break;
      }
      case 'send': {
        one();
        if (o.text !== undefined && o.json !== undefined) throw new AppError('INVALID_INPUT', 'Use either --text or --json');
        let envelope = o.text !== undefined ? { body: { text: o.text } } : await inputJson(o.json, stdin);
        if (o.to !== undefined) envelope.to = o.to;
        if (!envelope.to) throw new AppError('INVALID_INPUT', 'Message requires --to ADDRESS or JSON to');
        if (o.kind !== undefined || envelope.kind === undefined) envelope.kind = o.kind || 'message';
        for (const [key, value] of [['reply_to', o['reply-to']], ['conversation_id', o['conversation-id']], ['ttl_seconds', integer(o['ttl-seconds'], 'TTL', { min: 1, max: 604800 })]]) if (value !== undefined) envelope[key] = value;
        if (envelope.attachments?.length) throw new AppError('INVALID_INPUT', 'Use --attach FILE to upload attachment bytes; JSON manifests alone are not accepted');
        const prepared = await prepareAttachments(o.attach);
        try {
          if (prepared.items.length) {
            const { multipartBody } = await import('./transport.mjs');
            envelope.attachments = prepared.items.map(({ path: filePath, ...item }) => item);
            const { contentType, body } = multipartBody(envelope, prepared.items);
            result = await request('POST', '/local/messages', body, { contentType, timeoutMs: 30000 });
          } else result = await request('POST', '/local/messages', envelope);
        } finally { await prepared.close(); }
        break;
      }
      case 'receive': {
        one(); const query = new URLSearchParams();
        const limit = integer(o.limit, 'limit', { min: 1, max: 100 });
        const wait = integer(o['wait-seconds'], 'wait seconds', { min: 0, max: 30 });
        if (limit !== undefined) query.set('limit', limit);
        if (wait !== undefined) query.set('wait_seconds', wait);
        result = await request('GET', `/local/messages?${query}`, undefined, { timeoutMs: ((wait || 0) + 10) * 1000, maxResponseBytes: (limit ?? 20) * (LIMITS.envelopeBytes + 1024) + 1024 }); break;
      }
      case 'ack': one(); result = await request('POST', `/local/messages/${identifier(required(o, 'message'))}/ack`, { delivery_token: required(o, 'delivery-token') }); break;
      case 'status': one(); result = await request('GET', `/local/messages/${identifier(required(o, 'message'))}`); break;
      case 'attachments': {
        if (p.length !== 2) throw new AppError('INVALID_INPUT', 'Unexpected attachments command argument');
        const message = identifier(required(o, 'message'));
        const manifest = await request('GET', `/local/messages/${message}/attachments`);
        if (subcommand === 'list') result = manifest;
        else if (subcommand === 'export') {
          const attachmentId = identifier(required(o, 'attachment'));
          const items = Array.isArray(manifest) ? manifest : manifest.attachments;
          const descriptor = items?.find(item => item.id === attachmentId);
          if (!descriptor) throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment is not in this message', 404);
          attachmentManifest([descriptor]);
          const bytes = await request('GET', `/local/messages/${message}/attachments/${attachmentId}`, undefined, { raw: true, maxResponseBytes: LIMITS.fileBytes });
          const exported = await exportAttachment((await session()).workspace, required(o, 'output'), bytes, descriptor);
          result = { message_id: message, attachment_id: attachmentId, ...exported };
        } else throw new AppError('INVALID_INPUT', 'Use attachments list or attachments export');
        break;
      }
      default: throw new AppError('INVALID_INPUT', `Unknown command ${command}; use --help`);
    }
    print(result); return 0;
  } catch (error) {
    const code = error.code || 'CLI_ERROR';
    const message = error instanceof AppError ? error.message : ({ ENOENT: 'Required file or directory was not found', EACCES: 'File access denied', EPERM: 'File access denied', EEXIST: 'Output file already exists', ELOOP: 'Symlink inputs are not allowed' })[code] || 'Operation failed; check configuration and daemon availability';
    stderr.write(JSON.stringify({ error: { code, message, retryable: !!error.retryable } }) + '\n');
    return 1;
  }
}
