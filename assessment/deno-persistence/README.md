# Deno persistence assessment

Assessment for [SDK-5397](https://linear.app/rudderstack/issue/SDK-5397), performed
on 2026-09-06 against the published npm package, independently of the core test
suite in [PR #467](https://github.com/rudderlabs/rudder-sdk-node/pull/467).

## Decision

The assessment applies a Deno-only transport workaround through the SDK's
existing `axiosConfig`: HTTP and HTTPS agents use `keepAlive: false`. This
prevents Deno 2.9.6 from replaying a cancelled request on a reused connection.
All seven normal persistence scenarios pass with the workaround. Node retains
its default transport configuration.

Keep persistence outside the current public Deno support claim until active-job
recovery and shutdown behavior are defined. Immediate recovery of a locked job
still fails in both runtimes, and persistence `flush()` does not guarantee delivery.

No production SDK code or core CI contract changes. Applications must explicitly
apply the configuration below to obtain the workaround. The timeout defect also
affects core in-memory delivery; it is not specific to Bull/Redis.

## Environment

| Component                   | Version                           |
| --------------------------- | --------------------------------- |
| Deno                        | 2.9.6, macOS arm64                |
| Node comparison             | 26.0.0, macOS arm64               |
| Published SDK               | 3.0.12                            |
| Bull                        | 4.16.5                            |
| ioredis                     | 5.11.1                            |
| Redis                       | 7.4.11, Docker `redis:7.4-alpine` |
| msgpackr / msgpackr-extract | 1.12.1 / 3.0.4                    |

The checked-in `deno.lock` records the resolved dependency tree. Tests use a
local HTTP receiver, a dedicated Redis container, and a placeholder write key.
No real RudderStack events are sent.

## Results

With the workaround, the normal combined run passes 7/7 scenarios in both
Deno and Node. Without it, Deno passes 6/7 and fails the one-request assertion
in the timeout scenario. The assertion remains unchanged. Separate core HTTP
and HTTPS regression probes also pass with the workaround and fail without it
in Deno; both pass in Node. Restart checks run as separate processes.

| Check                                                                  | Deno                                                                      | Node                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Load and initialize `createPersistenceQueue()` with real Redis         | Pass                                                                      | Pass                                           |
| JSON and gzip delivery, batch path, authentication, event contents     | Pass                                                                      | Pass                                           |
| HTTP 503 followed by success                                           | Two requests; event callback succeeds once                                | Same                                           |
| HTTP 400                                                               | Failed job; event callback receives an error once                         | Same                                           |
| HTTP 503 until `maxAttempts: 2`                                        | Two requests; failed job; error callback once                             | Same                                           |
| Request timeout after earlier flows                                    | One request with workaround; two without it; terminal error callback once | One HTTP request; terminal error callback once |
| Request timeout in a fresh process (`SCENARIO=timeout-terminal`)       | One HTTP request; terminal error callback once                            | One HTTP request in combined run               |
| Timer flush after the first automatically flushed event                | Pass                                                                      | Pass                                           |
| Paused job survives SDK process exit and is delivered by a new process | Pass                                                                      | Pass                                           |
| Paused job survives Redis container restart and SDK restart            | Pass                                                                      | Not separately tested                          |
| Immediate restart with an active job lock                              | Initialization fails with `Could not remove job 1`                        | Same                                           |
| Restart after the active lock expires                                  | Persisted event delivered                                                 | Same                                           |
| Callback recovery after restart                                        | Callbacks are not persisted                                               | Same                                           |
| `await client.flush()` after first event                               | Resolves before persisted event delivery                                  | Same                                           |

`flows.mjs` asserts request contents, callback counts, and Redis job states.
The restart modes inspect the stored event before ending the first process.
The active restart mode deliberately exits while Bull owns the job lock.

### Timeout cause and workaround

Deno 2.9.6 can resend an explicitly destroyed request on a reused HTTP
connection. The reproduction was reduced to `node:http` without the SDK,
Axios, Bull, or Redis. Its retry predicate does not exclude destroyed/aborted
requests, and the retry path resets the destroyed state. See the
[Deno source](https://github.com/denoland/deno/blob/v2.9.6/ext/node/polyfills/_http_client.js#L1005).
A separate Node proxy confirmed that two requests reach an independent process.

The related [fetch retry issue](https://github.com/denoland/deno/issues/35610)
was fixed in a different code path. It does not resolve this reproduction.

The assessment uses `deno-transport.mjs` to disable connection reuse only in
Deno. A core request that succeeds before a timeout exercises the condition
that a fresh-connection timeout test misses. `transport-regression.mjs` tests
that sequence over HTTP and optionally HTTPS, using the same workaround.

Applications can use the existing SDK configuration without modifying the SDK:

```js
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import Analytics from 'npm:@rudderstack/rudder-sdk-node@3.0.12';

const client = new Analytics(writeKey, {
  dataPlaneUrl,
  axiosConfig: {
    httpAgent: new HttpAgent({ keepAlive: false }),
    httpsAgent: new HttpsAgent({ keepAlive: false }),
  },
});
```

This configuration is intended for Deno. It increases connection setup overhead;
Node applications do not need it for this defect. If an application supplies its
own Axios instance or custom agents, it must apply equivalent settings there and
preserve any existing proxy/TLS configuration. Remove the workaround only after
a fixed Deno version passes the warm-connection regression.

Set `DENO_KEEP_ALIVE=1` to disable the workaround in the assessment. The
unmitigated Deno run must fail the one-request assertion. This diagnostic option
is not an SDK configuration option. The native build-script warning is unrelated.

### Recovery limitation

`createPersistenceQueue()` tries to remove the previous active job before it
starts a processor. Bull rejects removal while the previous process's lock is
valid. Immediate restart therefore invokes the initialization error callback;
the assessment rejects that callback and exits nonzero. Retrying initialization
after the default 30-second lock expires succeeded in both runtimes.

This is not a Deno-specific failure. A follow-up should define recovery of
locked jobs and test restart before lock expiry. Do not remove live workers'
locks as a workaround. Multi-processor operation, Redis Cluster, Redis TLS,
and reconnecting a live client during a Redis outage were not assessed.

### Flush and callback limitations

The first event triggers an automatic flush. A subsequent empty `flush()` and
its callback complete before Bull delivers that event. Waiting for that Promise
is not a persistence drain operation. Event callbacks indicate the tested
delivery outcomes while the process remains alive. Callbacks are held in memory
and are intentionally unavailable after restart.

The assessment uses internal Bull handles to inspect jobs and close connections.
Those handles are test instrumentation, not a recommended public shutdown API.

## Permissions and installation

Run `deno install --config deno.json` in this directory. The configuration uses
`nodeModulesDir: "auto"` and a pinned npm import. Installation reports an ignored
`msgpackr-extract` build script. All tested persistence flows ran without enabling
that script or granting `--allow-ffi`.

Runtime permissions used:

```sh
deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 flows.mjs
```

Unrestricted `--allow-env` is required because the transitive `debug` dependency
enumerates `process.env`. Scoped environment permission fails during import.
Network permission covers only the local HTTP receiver and Redis. No explicit
read, write, subprocess, or FFI permission was needed. Deno grants npm packages
access to their own package files; Bull's Lua files load under those rules.
See [Deno's npm compatibility documentation](https://docs.deno.com/runtime/fundamentals/node/).

## Reproduce

1. Start a dedicated Redis instance:

   ```sh
   docker run --detach --name sdk-5397-redis \
     --publish 127.0.0.1:16379:6379 redis:7.4.11-alpine
   ```

2. Install dependencies in this directory:

   ```sh
   deno install --config deno.json --frozen
   ```

3. Run the normal flows:

   ```sh
   deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 flows.mjs
   node flows.mjs
   ```

4. Test paused-job recovery, optionally restarting Redis between processes:

   ```sh
   deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 flows.mjs seed
   docker restart sdk-5397-redis
   deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 flows.mjs recover
   ```

5. Reproduce the active-lock failure with immediate consecutive invocations:

   ```sh
   deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 flows.mjs seed-active
   deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 flows.mjs recover-active
   ```

   The second command must fail with `Could not remove job`. After at least
   31 seconds from the first process's exit, rerun `recover-active`; delivery
   should succeed. For the Node comparison, use `node flows.mjs` with the same
   mode arguments. The two runtimes use separate Redis key prefixes.

6. Remove the dedicated assessment container:

   ```sh
   docker rm --force sdk-5397-redis
   ```

`REDIS_PORT` overrides port 16379. `SCENARIO` selects one named normal flow.
Restart tests reserve HTTP port 18079 and must run sequentially. Normal tests
use a dynamically allocated HTTP port. Each invocation has a 45-second deadline.

To verify the timeout duplication with an independent request counter, start
`node receiver-proxy.mjs` in another terminal. Then run:

```sh
DENO_KEEP_ALIVE=1 HTTP_PORT=18081 RECEIVER_URL=http://127.0.0.1:18080 \
  deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 flows.mjs
```

The proxy prints event names and message IDs. The combined Deno run prints the
timeout event twice with the same ID. Stop the proxy with Ctrl+C after the run.

## Core HTTP and HTTPS regression

The core regression needs no Redis instance:

```sh
deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 transport-regression.mjs
node transport-regression.mjs
```

For HTTPS, generate a local test certificate and key in a temporary directory:

```sh
mkdir -p /tmp/sdk-5397-tls
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout /tmp/sdk-5397-tls/key.pem -out /tmp/sdk-5397-tls/cert.pem \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 \
  --allow-read=/tmp/sdk-5397-tls transport-regression.mjs \
  /tmp/sdk-5397-tls/cert.pem /tmp/sdk-5397-tls/key.pem
node transport-regression.mjs /tmp/sdk-5397-tls/cert.pem /tmp/sdk-5397-tls/key.pem
```

The HTTPS probe trusts only the supplied test certificate; certificate
verification remains enabled. The read permission is only for loading the test
certificate and key. Set `DENO_KEEP_ALIVE=1` before either Deno command to verify
the unmitigated failure. Do not commit generated private keys.
