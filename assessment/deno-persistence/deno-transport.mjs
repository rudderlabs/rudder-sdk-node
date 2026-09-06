import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

// Deno 2.9.6 can replay a cancelled request on a reused connection.
// DENO_KEEP_ALIVE=1 retains the unmitigated reproduction; Node keeps its defaults.
export const axiosConfig =
  process.versions.deno && process.env.DENO_KEEP_ALIVE !== '1'
    ? {
        httpAgent: new HttpAgent({ keepAlive: false }),
        httpsAgent: new HttpsAgent({ keepAlive: false }),
      }
    : undefined;
