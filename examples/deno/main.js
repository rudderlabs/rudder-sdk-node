// Keep the npm import explicit so this example can be copied into another project.
// deno-lint-ignore no-import-prefix
import Analytics from 'npm:@rudderstack/rudder-sdk-node@3.0.12';

const writeKey = Deno.env.get('WRITE_KEY');
const dataPlaneUrl = Deno.env.get('DATAPLANE_URL');

if (!writeKey || !dataPlaneUrl) {
  throw new Error('Set WRITE_KEY and DATAPLANE_URL before running this example.');
}

const client = new Analytics(writeKey, { dataPlaneUrl });

client.track({
  userId: 'deno-example-user',
  event: 'Deno example event',
  context: { runtime: 'deno' },
});

// Wait for this in-memory batch to finish before the script exits.
await client.flush();
console.log('Event delivered.');
