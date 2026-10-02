#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, chmodSync, copyFileSync, mkdirSync, lstatSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initState, loadConfig, writePrivateJson } from '../src/config.mjs';
import { privateHost } from '../src/common.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const marker = '# Parler local installation';

export function installLocal(options = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
  const home = resolve(options.home ?? homedir());
  const stateDir = resolve(options.stateDir ?? join(home, '.local/state/parler'));
  const binDir = join(home, '.local/bin');
  const configPath = join(stateDir, 'config.json');
  const existing = existsSync(configPath) ? loadConfig(stateDir) : null;
  const networkMode = options.networkMode ?? existing?.network_mode ?? 'private';
  const listen = options.listen ?? existing?.listen ?? '127.0.0.1';
  const port = Number(options.port ?? existing?.port ?? 7743);
  if (!['private', 'tailscale'].includes(networkMode) || !privateHost(listen, { allowTailnet: networkMode === 'tailscale' })) throw new Error('Choose an allowed private listener and private|tailscale network mode');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  if (existing && (existing.network_mode !== networkMode || existing.listen !== listen || existing.port !== port)) throw new Error('Existing state uses different network settings; select another state directory or update its configuration explicitly');
  const writes = [];
  const backups = [];
  for (const [client, target] of [
    ['codex', join(options.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex'), 'hooks.json')],
    ['claude-code', join(options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json')],
  ]) {
    if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw new Error(`Refusing non-regular configuration: ${target}`);
    const document = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error(`Invalid configuration: ${target}`);
    if (document.disableAllHooks === true) throw new Error(`Hooks are explicitly disabled in ${target}; enable them before installing`);
    document.hooks ??= {};
    if (!document.hooks || typeof document.hooks !== 'object' || Array.isArray(document.hooks)) throw new Error(`Invalid hooks object in ${target}`);
    const command = `${quote(process.execPath)} ${quote(join(repository, 'bin/parler-hook.mjs'))} --client ${client} --state ${quote(stateDir)}`;
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
      document.hooks[event] ??= [];
      if (!Array.isArray(document.hooks[event])) throw new Error(`Invalid ${event} hook list in ${target}`);
      if (!document.hooks[event].some(group => group.hooks?.some(hook => hook.command === command))) {
        document.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 3 }] });
      }
    }
    const content = JSON.stringify(document, null, 2) + '\n';
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) writes.push({ target, content, json: document });
  }
  for (const [name, file] of [['parler', 'parler.mjs'], ['parlerd', 'parlerd.mjs'], ['parler-hook', 'parler-hook.mjs']]) {
    const target = join(binDir, name);
    if (existsSync(target) || (() => { try { return lstatSync(target).isSymbolicLink(); } catch { return false; } })()) {
      if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || !readFileSync(target, 'utf8').includes(marker)) throw new Error(`Refusing to overwrite an unrelated command: ${target}`);
    }
    const content = `#!/bin/sh\n${marker}\nexec ${quote(process.execPath)} ${quote(join(repository, 'bin', file))} --state ${quote(stateDir)} "$@"\n`;
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) writes.push({ target, content, executable: true });
  }
  const plan = { state_dir: stateDir, network_mode: networkMode, listen, port, initialize: !existing, changed_files: writes.map(item => item.target), daemon_command: `${quote(join(binDir, 'parler'))} daemon`, codex_action: 'Open /hooks in Codex and review/trust the five Parler definitions', backups };
  if (options.dryRun) return plan;
  if (!existing) initState({ stateDir, networkMode, listen, port, label: options.label ?? hostname() });
  for (const item of writes) {
    mkdirSync(resolve(item.target, '..'), { recursive: true, mode: 0o700 });
    if (existsSync(item.target)) {
      const backup = `${item.target}.parler-backup-${randomUUID()}`;
      copyFileSync(item.target, backup); chmodSync(backup, 0o600); backups.push(backup);
    }
    if (item.json) writePrivateJson(item.target, item.json);
    else { writeFileSync(item.target, item.content, { mode: 0o700 }); chmodSync(item.target, 0o700); }
  }
  const installed = loadConfig(stateDir);
  return { ...plan, node_id: installed.node_id, endpoint: installed.endpoint };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const values = { '--state': 'stateDir', '--listen': 'listen', '--port': 'port', '--network-mode': 'networkMode', '--label': 'label' };
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dry-run') options.dryRun = true;
      else if (values[args[i]] && args[i + 1] && !args[i + 1].startsWith('--')) options[values[args[i]]] = args[++i];
      else throw new Error('Usage: node scripts/install-local.mjs [--state DIR --listen PRIVATE_IP --port PORT --network-mode private|tailscale --label NAME --dry-run]');
    }
    console.log(JSON.stringify(installLocal(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
