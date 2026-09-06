import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import Analytics from '@rudderstack/rudder-sdk-node';
import { axiosConfig } from './deno-transport.mjs';

// Optional local certificate and key enable the same probe over HTTPS.
const [certPath, keyPath] = process.argv.slice(2);
assert.equal(Boolean(certPath), Boolean(keyPath), 'provide both certificate and key');
const cert = certPath ? readFileSync(certPath) : undefined;
const tlsAgent = cert
  ? new https.Agent({ ca: cert, keepAlive: axiosConfig?.httpsAgent.options.keepAlive ?? true })
  : undefined;
const requests = [];
const receive = async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const event = JSON.parse(Buffer.concat(chunks)).batch[0].event;
  requests.push(event);
  if (event === 'timeout') await delay(300);
  response.end('ok');
};
const server = cert
  ? https.createServer({ cert, key: readFileSync(keyPath) }, receive)
  : http.createServer(receive);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const deadline = setTimeout(() => {
  console.error('Transport regression exceeded 10 seconds');
  process.exit(1);
}, 10000);

try {
  const client = new Analytics('local-test-key', {
    dataPlaneUrl: `${cert ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    gzip: false,
    retryCount: 0,
    flushAt: 1,
    timeout: 100,
    axiosConfig: tlsAgent ? { ...axiosConfig, httpsAgent: tlsAgent } : axiosConfig,
    // Handle automatic flush rejection through the SDK's public error handler.
    errorHandler: () => {},
  });
  const send = async (event) => {
    const result = new Promise((resolve) => {
      client.track({ userId: 'test-user', event }, (error) => resolve(error));
    });
    await client.flush();
    return result;
  };

  assert.equal(await send('warmup'), undefined);
  assert.equal((await send('timeout')).code, 'ECONNABORTED');
  await delay(400);
  assert.deepEqual(requests, ['warmup', 'timeout']);
  console.log(`PASS: ${cert ? 'HTTPS' : 'HTTP'} warm connection then timeout sends one event`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  axiosConfig?.httpAgent.destroy();
  axiosConfig?.httpsAgent.destroy();
  tlsAgent?.destroy();
  http.globalAgent.destroy();
  https.globalAgent.destroy();
  clearTimeout(deadline);
}
