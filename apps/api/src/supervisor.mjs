import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 单独进程计时，能够在 API 线程阻塞于同步 I/O 时强制终止。 */
export function supervise({
  entryPath = fileURLToPath(new URL('./main.mjs', import.meta.url)),
  hardTimeoutMs = Math.max(1, Number(process.env.SHUTDOWN_HARD_TIMEOUT_MS) || 20_000)
} = {}) {
  hardTimeoutMs = Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0 ? hardTimeoutMs : 20_000;
  const child = spawn(process.execPath, [entryPath], { stdio: 'inherit', env: process.env });
  let hardTimer = null;
  let hardDeadlineExceeded = false;
  const forward = signal => {
    child.kill(signal);
    if (hardTimer) return;
    hardTimer = setTimeout(() => {
      hardDeadlineExceeded = true;
      console.error(JSON.stringify({ service: 'cloud-api-supervisor', phase: 'hard_deadline_exceeded', deadlineExceeded: true, drained: false, exit_code: 137 }));
      child.kill('SIGKILL');
    }, hardTimeoutMs);
  };
  const term = () => forward('SIGTERM');
  const interrupt = () => forward('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  child.once('error', error => {
    console.error(JSON.stringify({ service: 'cloud-api-supervisor', phase: 'spawn_failed', error: error.message }));
    process.exitCode = 3;
  });
  child.once('exit', (code, signal) => {
    clearTimeout(hardTimer);
    process.removeListener('SIGTERM', term);
    process.removeListener('SIGINT', interrupt);
    process.exitCode = hardDeadlineExceeded ? 137 : code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 3);
  });
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) supervise();
