#!/usr/bin/env node
import { resolve } from 'node:path';
import { startDaemon } from '../src/daemon.mjs';

const argv = process.argv.slice(2);
let stateDir = process.env.PARLER_STATE ?? '.parler';
let workerIntervalMs;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--state') stateDir = argv[++i];
  else if (argv[i] === '--worker-interval-ms') workerIntervalMs = Number(argv[++i]);
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('Usage: parlerd [--state DIRECTORY] [--worker-interval-ms MILLISECONDS]');
    process.exit(0);
  } else { console.error(`Unknown option: ${argv[i]}`); process.exit(1); }
}
try {
  const daemon = await startDaemon({ stateDir: resolve(stateDir), workerIntervalMs });
  console.log(JSON.stringify({ event: 'ready', node_id: daemon.info.node_id, endpoint: daemon.info.endpoint, socket: daemon.socketPath, network_status: daemon.info.network_status }));
  const shutdown = async () => { await daemon.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
}
