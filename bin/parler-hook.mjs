#!/usr/bin/env node
import { hookMain } from '../src/hooks.mjs';

const deadline = setTimeout(() => process.exit(0), 2800);
deadline.unref();
await hookMain();
process.exitCode = 0;
