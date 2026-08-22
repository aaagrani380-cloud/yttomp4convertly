import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['server.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['worker.js'], { stdio: 'inherit' })
];

let shuttingDown = false;
const shutdown = signal => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill(signal);
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
for (const child of children) child.on('exit', code => {
  if (!shuttingDown && code && code !== 0) shutdown('SIGTERM');
});
