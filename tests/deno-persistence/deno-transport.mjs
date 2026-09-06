import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

// DENO_KEEP_ALIVE=1 retains the unmitigated reproduction; Node keeps its defaults.
export const axiosConfig =
  process.versions.deno && process.env.DENO_KEEP_ALIVE !== '1'
    ? {
        // Avoid Deno replaying a timed-out request on a reused connection.
        httpAgent: new HttpAgent({ keepAlive: false }),
        httpsAgent: new HttpsAgent({ keepAlive: false }),
      }
    : undefined;
