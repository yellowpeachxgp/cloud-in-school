import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createShutdownController } from '../apps/api/src/shutdown.mjs';

test('同步保存耗尽预算后，即使关闭回调同步成功也不能退出 0', async () => {
  const logs = [], exits = [];
  const controller = createShutdownController({
    app: { setDraining() {}, getInFlightTasks: () => ({}), store: { flushSnapshotStrictSync() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90); } } },
    server: { close(cb) { cb(); } }, stopBackgroundTasks() {}, maxDrainMs: 40,
    now: () => performance.now(), logLine: line => logs.push(line), terminate: code => exits.push(code), setExitCode() {}
  });
  const result = await controller.shutdown('SIGTERM');
  assert.equal(result.deadlineExceeded, true);
  assert.equal(result.drained, false);
  assert.deepEqual(exits, [3]);
  assert.ok(logs.at(-1).elapsedMs >= 90);
});
