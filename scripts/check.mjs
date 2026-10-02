import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let count = 0;
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith('.mjs')) { execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' }); count++; }
  }
}
for (const directory of ['src', 'bin', 'scripts', 'tests']) visit(directory);
console.log(`Syntax checked ${count} modules.`);
