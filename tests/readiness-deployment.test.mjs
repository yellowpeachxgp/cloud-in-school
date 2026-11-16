import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';

test('真实探针在排空或 KMS 不可用时返回 503，恢复后才就绪', async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  assert.equal((await app.inject({ url: '/readyz' })).status, 200);
  app.setDraining(true);
  assert.equal((await app.inject({ url: '/readyz' })).status, 503);
  app.setDraining(false);
  app.kmsVault.setKmsOnline(false);
  const unavailable = await app.inject({ url: '/readyz' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.ok, false);
  app.kmsVault.setKmsOnline(true);
  assert.equal((await app.inject({ url: '/readyz' })).status, 200);
});

for (const explicit of [false, true]) {
  test(`真实 main 兼容旧快照路径变量，显式新路径优先：${explicit}`, { timeout: 8000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-snapshot-'));
    const legacy = path.join(dir, 'legacy.json');
    const current = path.join(dir, 'current.json');
    const child = fork('apps/api/src/main.mjs', [], {
      execArgv: ['--import', './tests/helpers/main-scenario.mjs'],
      env: { PATH: process.env.PATH, HOME: dir, HOST: '127.0.0.1', PORT: '0', DIS_PERSIST_PATH: legacy,
        ...(explicit ? { CLOUD_SNAPSHOT_PATH: current } : {}), SHUTDOWN_TIMEOUT_MS: '4000' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let errors = '';
    child.stderr.on('data', b => { errors += b; });
    const hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    t.after(() => { clearTimeout(hardKill); child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
    const exited = once(child, 'exit');
    await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors || '入口提前退出'); })]);
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(signal, null, errors);
    assert.equal(code, 0, errors);
    assert.equal(fs.existsSync(explicit ? current : legacy), true, '最终快照必须写入配置的路径');
    assert.equal(fs.existsSync(explicit ? legacy : current), false);
  });
}
