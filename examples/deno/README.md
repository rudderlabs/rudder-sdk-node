# Deno example

This example uses the published `@rudderstack/rudder-sdk-node@3.0.12` package.
It sends one event with the default gzip encoding and waits for delivery.
Node.js and a separate npm install are not required.

## Run

1. Install Deno 2.9.6 or later within Deno 2.x.
2. Open a terminal in this directory.
3. Set your Node.js source write key and data plane URL:

   ```sh
   export WRITE_KEY='YOUR_WRITE_KEY'
   export DATAPLANE_URL='https://YOUR_DATA_PLANE_HOST'
   ```

4. Run the example:

   ```sh
   deno run --no-prompt --allow-env --allow-net main.js
   ```

5. Check the source's Live Events for `Deno example event`.

To restrict network access, replace `--allow-net` with
`--allow-net=YOUR_DATA_PLANE_HOST`. For a local receiver, include its port:
`--allow-net=127.0.0.1:8080`.

The first run downloads npm dependencies. The local `deno.json` uses Deno's
global package cache and prevents the repository's Node.js dependencies from
requiring a local `node_modules` installation.

Deno can warn that the optional `msgpackr-extract` build script was ignored.
The core example works without that script; no approval is needed to run it.

## Permissions and scope

- `--allow-net` permits event delivery to the data plane.
- Unrestricted `--allow-env` is required even when the write key is passed
  directly. The transitive `debug` dependency enumerates `process.env` during
  import. A list such as `--allow-env=WRITE_KEY,DATAPLANE_URL,DEBUG` is insufficient.
- The example does not require `--allow-read`, `--allow-write`, `--allow-run`,
  `--allow-ffi`, or npm lifecycle script approval.
- Core in-memory delivery has been verified with Deno 2.9.6 and SDK 3.0.12.
- Bull/Redis persistence is not fully supported on Deno and is not recommended.
  Deno can resend timed-out requests, and queue recovery and shutdown have known limitations.
- `_metadata.nodeVersion` reports the Node.js compatibility version provided by
  Deno. It does not report the Deno version. This example adds `context.runtime`
  to identify Deno explicitly.

`await client.flush()` waits for this example's in-memory batch. Do not apply
that shutdown pattern to the optional persistence queue.
