import { supervise } from '../../apps/api/src/supervisor.mjs';
import { fileURLToPath } from 'node:url';
supervise({ entryPath: fileURLToPath(new URL('./blocked-main.mjs', import.meta.url)) });
