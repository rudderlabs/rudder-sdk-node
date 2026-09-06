import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import Analytics from '@rudderstack/rudder-sdk-node';
import { axiosConfig } from './deno-transport.mjs';

// The same assessment runs in Deno and Node against the published package.
const mode = process.argv[2] || 'flows';
const port = Number(process.env.REDIS_PORT || 16379);
const deadline = setTimeout(() => {
  console.error('Assessment exceeded 45 seconds');
  process.exit(1);
}, 45000);

async function until(predicate) {
  const end = Date.now() + 15000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, 'condition did not become true within 15 seconds');
    await delay(20);
  }
}

const requests = [];
let status = () => 200;
let responseDelay = () => 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const body = JSON.parse(req.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes);
  requests.push({ body, headers: req.headers, path: req.url });
  const count = requests.length;
  await delay(responseDelay(count));
  res.writeHead(status(count));
  res.end();
});
await new Promise((resolve) =>
  server.listen(
    mode === 'flows' ? Number(process.env.HTTP_PORT || 0) : 18079,
    '127.0.0.1',
    resolve,
  ),
);

async function clientFor(name, options = {}) {
  const client = new Analytics('assessment-write-key', {
    dataPlaneUrl: process.env.RECEIVER_URL || `http://127.0.0.1:${server.address().port}`,
    flushAt: 20,
    flushInterval: 60000,
    retryCount: 0,
    axiosConfig,
    logLevel: 'error',
    ...options,
  });
  await new Promise((resolve, reject) =>
    client.createPersistenceQueue(
      {
        queueName: name,
        prefix: `sdk5397-${process.versions.deno ? 'deno' : 'node'}`,
        redisOpts: { host: '127.0.0.1', port },
        jobOpts: { maxAttempts: 2 },
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  return client;
}

async function close(client, remove = true) {
  if (remove) await client.pQueue.obliterate({ force: true });
  await client.pQueue.close();
  clearTimeout(client.timer);
  clearTimeout(client.flushTimer);
}

try {
  if (mode === 'seed' || mode === 'seed-active') {
    const active = mode === 'seed-active';
    const client = await clientFor(active ? 'restart-active' : 'restart');
    if (!active) await client.pQueue.pause();
    client.track({ userId: 'assessment-user', event: 'Survive process restart' }, () => {
      throw new Error('paused queue must not invoke the callback');
    });
    await client.flush();
    await until(
      async () =>
        (active ? await client.pQueue.getActiveCount() : await client.pQueue.getPausedCount()) ===
        1,
    );
    const [job] = await client.pQueue.getJobs([active ? 'active' : 'paused']);
    assert.match(job.data.eventData, /Survive process restart/);
    assert.equal(requests.length, 0);
    console.log('PASS: event stored in Redis before process exit');
    if (active) process.exit(0); // Deliberately leave an active job and its lock behind.
    await close(client, false);
  } else if (mode === 'recover' || mode === 'recover-active') {
    const client = await clientFor(mode === 'recover-active' ? 'restart-active' : 'restart');
    assert.equal(client.pCallbacksMap.size, 0);
    await client.pQueue.resume();
    await until(() => requests.length === 1);
    await until(async () => (await client.pQueue.getCompletedCount()) === 1);
    assert.equal(requests[0].body.batch[0].event, 'Survive process restart');
    assert.equal(client.pCallbacksMap.size, 0);
    console.log('PASS: new process delivers persisted event without restoring callbacks');
    await close(client);
  } else {
    assert.equal(mode, 'flows');
    for (const scenario of [
      { name: 'json', gzip: false, codes: [200], failure: false },
      { name: 'gzip', gzip: true, codes: [200], failure: false },
      { name: 'retry', gzip: true, codes: [503, 200], failure: false },
      { name: 'terminal-error', gzip: false, codes: [400], failure: true },
      { name: 'retry-exhaustion', gzip: false, codes: [503, 503], failure: true },
      { name: 'timeout-terminal', gzip: true, codes: [200], failure: true, timeout: 50 },
      { name: 'automatic-flush', gzip: true, codes: [200], failure: false, automatic: true },
    ]) {
      if (process.env.SCENARIO && process.env.SCENARIO !== scenario.name) continue;
      requests.length = 0;
      status = (count) => scenario.codes[Math.min(count - 1, scenario.codes.length - 1)];
      responseDelay = (count) => (scenario.timeout && count === 1 ? 150 : 0);
      const client = await clientFor(`${scenario.name}-${process.pid}`, {
        gzip: scenario.gzip,
        timeout: scenario.timeout,
        flushInterval: scenario.automatic ? 50 : 60000,
      });
      let callbackCount = 0;
      let callbackError;
      let flushCallbackCount = 0;
      try {
        client.track({ userId: 'assessment-user', event: scenario.name }, (error) => {
          callbackCount++;
          callbackError = error;
        });
        await client.flush(() => flushCallbackCount++);
        assert.equal(requests.length, 0, 'persistence flush resolves before HTTP delivery');
        await until(() => callbackCount === 1);
        await until(
          async () =>
            (await client.pQueue.getJobCounts())[scenario.failure ? 'failed' : 'completed'] > 0,
        );
        await delay(100);
        assert.equal(callbackCount, 1);
        assert.equal(Boolean(callbackError), scenario.failure);
        assert.equal(
          requests.length,
          scenario.codes.length,
          JSON.stringify(requests.map(({ body }) => body.batch)),
        );
        assert.equal(client.pCallbacksMap.size, 0);
        assert.equal(
          flushCallbackCount,
          1,
          'empty flush callback runs before persistence delivery',
        );
        for (const request of requests) {
          assert.equal(request.path, '/v1/batch');
          assert.equal(
            request.headers.authorization,
            `Basic ${Buffer.from('assessment-write-key:').toString('base64')}`,
          );
          assert.equal(request.headers['content-encoding'], scenario.gzip ? 'gzip' : undefined);
          assert.equal(request.body.batch[0].event, scenario.name);
        }
        if (scenario.automatic) {
          client.track({ userId: 'assessment-user', event: 'timer-triggered second event' });
          await until(() => requests.length === 2);
          assert.equal(requests[1].body.batch[0].event, 'timer-triggered second event');
          await until(async () => (await client.pQueue.getCompletedCount()) === 2);
        }
        console.log(
          `PASS: ${scenario.name}; ${requests.length} HTTP request(s); event callback once; flush returns before delivery`,
        );
      } catch (error) {
        console.error(`FAIL: ${scenario.name}: ${error.message}`);
        process.exitCode = 1;
      } finally {
        await close(client);
      }
    }
  }
} finally {
  axiosConfig?.httpAgent.destroy();
  axiosConfig?.httpsAgent.destroy();
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(deadline);
}
