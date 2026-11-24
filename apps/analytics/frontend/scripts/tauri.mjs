import { spawn } from 'node:child_process';
import path from 'node:path';

const cliPath = path.resolve('node_modules', '@tauri-apps', 'cli', 'tauri.js');
const tauriDirectory = path.resolve('..', 'src-tauri');

const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  cwd: tauriDirectory,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Unable to start Tauri CLI: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
