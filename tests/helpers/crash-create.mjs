import fs from 'node:fs';
import { createCampusCloudApp } from '../../apps/api/src/app.mjs';
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const app = createCampusCloudApp({ requireAdminAccess: false, storeOptions: { snapshotPath: input.snapshotPath, requireDurableSnapshot: true } });
app.store.onPersistStage = stage => { if (stage === input.stage) { fs.writeFileSync(`${process.argv[2]}.checkpoint`, stage); process.kill(process.pid, 'SIGKILL'); } };
await app.inject(input.request);
process.exit(2);
