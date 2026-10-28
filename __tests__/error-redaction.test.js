/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
const { default: test } = require('ava');
const http = require('node:http');
const { inspect } = require('node:util');
const { gunzipSync } = require('node:zlib');
const axios = require('axios');
const Analytics = require('../src/index');

const writeKey = 'redaction-regression-write-key';
const token = Buffer.from(`${writeKey}:`).toString('base64');

async function receiver(t, respond) {
  const server = http.createServer(respond);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.teardown(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function client(t, url, options = {}) {
  const analytics = new Analytics(writeKey, {
    dataPlaneUrl: url,
    logLevel: 'none',
    retryCount: 0,
    ...options,
  });
  analytics.flushed = true;
  t.teardown(() => {
    clearTimeout(analytics.timer);
    clearTimeout(analytics.flushTimer);
  });
  return analytics;
}

function safeDump(t, value) {
  for (const output of [inspect(value, { depth: Infinity }), JSON.stringify(value)]) {
    t.false(output.includes(writeKey), 'dump must not contain the write key');
    t.false(output.includes(token), 'dump must not contain the Basic token');
  }
}

test('redaction omits shared agents from terminal errors and retry snapshots', async (t) => {
  let releaseHeld;
  let heldReceived;
  const heldReady = new Promise((resolve) => {
    heldReceived = resolve;
  });
  const url = await receiver(t, (req, res) => {
    req.resume();
    if (req.url === '/hold') {
      releaseHeld = () => res.end();
      heldReceived();
      return;
    }
    res.writeHead(503).end('unavailable');
  });
  const agent = new http.Agent({ keepAlive: true });
  t.teardown(() => agent.destroy());
  const held = axios.get(`${url}/hold`, { httpAgent: agent, auth: { username: writeKey } });
  await heldReady;
  const dumps = [];
  const analytics = client(t, url, {
    axiosConfig: { httpAgent: agent },
    retryCount: 1,
    errorHandler: (error) => {
      dumps.push(error);
    },
    axiosRetryConfig: {
      retryDelay: (count, error) => {
        dumps.push(error);
        return 0;
      },
      onRetry: (count, error, config) => {
        dumps.push(error, config);
      },
      onMaxRetryTimesExceeded: (error) => dumps.push(error),
      validateResponse: (response) => {
        dumps.push(response);
        return false;
      },
    },
  });
  try {
    analytics.track({ event: 'agent redaction', userId: 'user' });
    await analytics.flush();
    t.is(dumps.length, 7);
    for (const value of dumps) safeDump(t, value);
    t.is(analytics.axiosInstance.defaults.httpAgent, agent);
  } finally {
    releaseHeld();
    await held;
  }
});

for (const mutation of ['gzip payload', 'retry state']) {
  test(`retry hook mutations cannot change the ${mutation}`, async (t) => {
    const bodies = [];
    const url = await receiver(t, (req, res) => {
      t.is(req.headers.authorization, `Basic ${token}`);
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks));
        res.writeHead(bodies.length < 3 ? 503 : 200).end();
      });
    });
    const analytics = client(t, url, {
      retryCount: 2,
      axiosRetryConfig: {
        retryDelay: () => 0,
        onRetry: (count, error, config) => {
          if (mutation === 'gzip payload') config.data.fill(0);
          else config['axios-retry'].retries = 0;
        },
      },
    });
    analytics.track({ event: 'unchanged payload', userId: 'user' });
    await analytics.flush();
    t.is(bodies.length, 3, 'both configured retries must still run');
    for (const body of bodies) t.deepEqual(body, bodies[0]);
    t.is(JSON.parse(gunzipSync(bodies[0])).batch[0].event, 'unchanged payload');
  });
}

test('persistent processor redacts terminal errors before both callback boundaries', async (t) => {
  const url = await receiver(t, (req, res) => {
    req.resume();
    res.writeHead(400).end();
  });
  const analytics = client(t, url);
  let processJob;
  analytics.pQueue = {
    on() {},
    process(handler) {
      processJob = handler;
    },
  };
  const errors = [];
  analytics.pCallbacksMap.set('job-1', [(error) => errors.push(error)]);
  analytics.addPersistentQueueProcessor();
  const data = analytics._getDataForPersistenceQueue({
    jobId: 'job-1',
    description: 'redaction-test',
    attempts: 0,
    request: { auth: { username: writeKey }, headers: {}, data: { batch: [] } },
  });
  await new Promise((resolve) => {
    processJob({ data }, (error) => {
      errors.push(error);
      resolve();
    });
  });
  t.is(errors.length, 2);
  t.is(errors[0], errors[1]);
  t.is(errors[0].response.status, 400);
  safeDump(t, errors[0]);
});
