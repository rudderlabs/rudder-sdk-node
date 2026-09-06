# Deno persistence assessment

Assessment for [SDK-5397](https://linear.app/rudderstack/issue/SDK-5397), performed
on 2026-09-06 against the published npm package, independently of the core test
suite in [PR #467](https://github.com/rudderlabs/rudder-sdk-node/pull/467).

## Decision

Basic Bull/Redis persistence runs in the tested Deno environment without native
build script approval. Keep persistence outside the current public Deno support
claim. The combined Deno assessment observes a duplicate HTTP request during
the timeout scenario. Immediate recovery of an active, locked job also fails in
both runtimes, and the persistence flush API does not provide a delivery
completion guarantee. Investigate the timeout discrepancy and define recovery
and shutdown behavior before expanding support.

This assessment does not change SDK behavior or add persistence to the core
Deno CI contract. The in-memory example in SDK-5399 can proceed independently.

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

The normal combined run passed 6 of 7 scenarios in Deno and 7 of 7 in Node.
The Deno run intentionally retains a failing assertion for the observed timeout
duplication. The restart checks below run as separate processes.

| Check                                                                  | Deno                                                                                               | Node                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Load and initialize `createPersistenceQueue()` with real Redis         | Pass                                                                                               | Pass                                           |
| JSON and gzip delivery, batch path, authentication, event contents     | Pass                                                                                               | Pass                                           |
| HTTP 503 followed by success                                           | Two requests; event callback succeeds once                                                         | Same                                           |
| HTTP 400                                                               | Failed job; event callback receives an error once                                                  | Same                                           |
| HTTP 503 until `maxAttempts: 2`                                        | Two requests; failed job; error callback once                                                      | Same                                           |
| Request timeout after earlier flows                                    | **Fail:** two HTTP requests with the same message ID; terminal `ECONNABORTED`; error callback once | One HTTP request; terminal error callback once |
| Request timeout in a fresh process (`SCENARIO=timeout-terminal`)       | One HTTP request; terminal error callback once                                                     | One HTTP request in combined run               |
| Timer flush after the first automatically flushed event                | Pass                                                                                               | Pass                                           |
| Paused job survives SDK process exit and is delivered by a new process | Pass                                                                                               | Pass                                           |
| Paused job survives Redis container restart and SDK restart            | Pass                                                                                               | Not separately tested                          |
| Immediate restart with an active job lock                              | Initialization fails with `Could not remove job 1`                                                 | Same                                           |
| Restart after the active lock expires                                  | Persisted event delivered                                                                          | Same                                           |
| Callback recovery after restart                                        | Callbacks are not persisted                                                                        | Same                                           |
| `await client.flush()` after first event                               | Resolves before persisted event delivery                                                           | Same                                           |

`flows.mjs` asserts request contents, callback counts, and Redis job states.
The restart modes inspect the stored event before ending the first process.
The active restart mode deliberately exits while Bull owns the job lock.

### Timeout discrepancy

The full Deno run repeatedly observed two copies of the timeout event at the
receiver, with the same `messageId`, despite `retryCount: 0`. The SDK reported
one terminal `ECONNABORTED` callback. Node observed one request with the same
script and dependencies. Running only the timeout scenario in a new Deno
process also observed one request.

A separate Node HTTP proxy also received both copies before forwarding them to
the Deno receiver. This confirms two HTTP requests reached an independent
process; the result is not only duplicate request accounting inside the Deno
receiver.

The assessment keeps the one-request assertion and exits nonzero on this
discrepancy. It continues the remaining scenarios to collect their results.
The cause is not established; shared HTTP connection state is a candidate
because preceding flows change the result. A follow-up must reduce the case
and distinguish Deno's HTTP implementation, Axios, and the SDK queue logic.
Do not claim timeout delivery parity or general persistence support from the
successful isolated case.

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
HTTP_PORT=18081 RECEIVER_URL=http://127.0.0.1:18080 \
  deno run --config deno.json --no-prompt --allow-env --allow-net=127.0.0.1 flows.mjs
```

The proxy prints event names and message IDs. The combined Deno run prints the
timeout event twice with the same ID. Stop the proxy with Ctrl+C after the run.
