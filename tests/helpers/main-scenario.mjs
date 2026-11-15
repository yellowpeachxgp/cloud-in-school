import net from 'node:net';
import { app, server } from '../../apps/api/src/main.mjs';
const scenario = process.env.TEST_SHUTDOWN_SCENARIO;
// 仅测试进程导入此模块；生产入口没有故障开关。
if (scenario === 'hung') app.registerLifecycleTask('scanner');
if (scenario === 'finance') app.registerLifecycleTask('finance');
if (scenario === 'slow-save') {
  const flush = app.store.flushSnapshotStrictSync.bind(app.store);
  app.store.flushSnapshotStrictSync = () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 220);
    return flush();
  };
}
const ready = () => {
  if (scenario === 'socket') {
    const socket = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write('POST /api/v1/reservation-plans HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999\r\n\r\n{');
      process.send?.({ ready: true });
    });
    socket.on('error', () => {});
  } else process.send?.({ ready: true });
};
if (server.listening) ready(); else server.once('listening', ready);
// 验证残留后台句柄不会延长最终退出。
setInterval(() => {}, 60_000);
