// Explicit, process-local test secrets: no production/public fallback keys.
import crypto from 'node:crypto';
process.env.CLOUD_SESSION_SIGNING_SECRET = crypto.randomBytes(32).toString('hex');
process.env.KMS_MASTER_SEED = crypto.randomBytes(32).toString('hex');
