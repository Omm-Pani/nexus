import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron');

// ELECTRON_RUN_AS_NODE turns the binary into a plain Node runtime, so the app
// starts with no browser process and no `electron` module — a confusing
// failure that some shells and CI images cause by default. Strip it here
// rather than requiring every caller to remember.
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [here, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: environment,
});
child.on('exit', (code, signal) => {
  process.exit(signal === null ? code ?? 0 : 1);
});
