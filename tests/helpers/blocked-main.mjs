import { app } from '../../apps/api/src/main.mjs';
app.store.flushSnapshotStrictSync = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
