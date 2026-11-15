import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

for (const scenario of ['normal', 'hung', 'finance', 'socket', 'slow-save', 'repeat']) {
  test(`真实 main 子进程关闭：${scenario}`, { timeout: 8_000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-main-'));
    const child = fork('apps/api/src/main.mjs', [], {
      execArgv: ['--import', './tests/helpers/main-scenario.mjs'],
      // 正常路径允许真实 fsync 的主机抖动；故障路径仍用 150ms 验证严格超时。
      env: { PATH: process.env.PATH, HOME: dir, PORT: '0', HOST: '127.0.0.1', CLOUD_SNAPSHOT_PATH: path.join(dir, 'state.json'), CLOUD_REQUIRE_DURABLE_SNAPSHOT: 'true', SHUTDOWN_TIMEOUT_MS: ['normal', 'repeat'].includes(scenario) ? '4000' : '150', TEST_SHUTDOWN_SCENARIO: scenario },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    const hardKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    t.after(() => { clearTimeout(hardKill); child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
    const exited = once(child, 'exit');
    await once(child, 'message');
    child.kill('SIGTERM');
    if (scenario === 'repeat') setTimeout(() => child.kill('SIGINT'), 10).unref();
    const [code, signal] = await exited;
    assert.equal(signal, null, output + errors);
    const final = output.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } }).filter(line => line.phase === 'shutdown_complete');
    assert.equal(final.length, 1, output + errors);
    const expected = ['normal', 'repeat'].includes(scenario) ? 0 : 3;
    assert.equal(code, expected, output + errors);
    assert.equal(final[0].exit_code, code);
    assert.equal(final[0].drained, expected === 0);
    assert.equal(final[0].deadlineExceeded, expected !== 0);
    if (scenario === 'slow-save') assert.ok(final[0].elapsedMs >= 220);
  });
}

test('独立 supervisor 对永久阻塞的真实 main 强制退出并记录未知关闭结果', { timeout: 8_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'));
  const child = fork('tests/helpers/supervisor-scenario.mjs', [], {
    execArgv: [], env: { PATH: process.env.PATH, HOME: dir, PORT: '0', HOST: '127.0.0.1', CLOUD_SNAPSHOT_PATH: path.join(dir, 'state.json'), CLOUD_REQUIRE_DURABLE_SNAPSHOT: 'true', SHUTDOWN_TIMEOUT_MS: '100', SHUTDOWN_HARD_TIMEOUT_MS: '300' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let output = '', errors = '';
  child.stderr.on('data', b => { errors += b; });
  const ready = new Promise(resolve => child.stdout.on('data', b => { output += b; if (output.includes('"listening"')) resolve(); }));
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  const exited = once(child, 'exit');
  await ready; child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(signal, null);
  assert.equal(code, 137, output + errors);
  assert.match(errors, /hard_deadline_exceeded/);
  assert.doesNotMatch(output, /shutdown_complete/);
});
