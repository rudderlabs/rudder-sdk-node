/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
// import bodyParser from 'body-parser';
const express = require('express');
const auth = require('basic-auth');
const bodyParser = require('body-parser');
const { default: test } = require('ava');
const Sinon = require('sinon');
const { setTimeout } = require('node:timers/promises');
const { AssertionError } = require('assert');
const { inspect } = require('node:util');

const Analytics = require('../src/index');
const { version } = require('../package.json');

const { spy, stub } = Sinon;

const noop = () => {};

const context = {
  library: {
    name: 'analytics-node',
    version,
  },
};

const metadata = { nodeVersion: process.versions.node };
const port = 4063;
const separateAxiosClientPort = 4064;
const retryCount = 2;

let server;
// Track active timeouts to clear them during cleanup
let activeTimeouts = [];
// Track all created clients to clean up their timers
let createdClients = [];

const createClient = async (options) => {
  const newOptions = { ...options, logLevel: 'error', gzip: false };
  if (!newOptions.host && !newOptions.dataPlaneUrl) {
    newOptions.dataPlaneUrl = `http://localhost:${port}`;
  }
  const client = new Analytics('key', newOptions);
  // const client = new Analytics("key", `http://localhost:${port}`, options);

  const pify = (await import('pify')).default;
  client.flush = pify(client.flush.bind(client));
  client.flushed = true;

  // Track the client for cleanup
  createdClients.push(client);

  return client;
};

test.before((t) => {
  let count = 0;
  server = express()
    .use(express.json())
    .post('/v1/batch', (req, res) => {
      const { batch } = req.body;

      const { name: writeKey } = auth(req);
      if (!writeKey) {
        return res.status(404).json({
          error: { message: 'Not Found' },
        });
      }

      const ua = req.headers['user-agent'];
      if (ua !== `analytics-node/${version}`) {
        return res.status(400).json({
          error: { message: 'invalid user-agent' },
        });
      }

      if (batch[0] === 'error') {
        return res.status(404).json({
          error: { message: 'error' },
        });
      }

      if (batch[0] === 'timeout') {
        // Store the timeout ID so we can clear it during cleanup
        const timeoutId = globalThis.setTimeout(() => res.end(), 5000);
        activeTimeouts.push(timeoutId);
        return timeoutId;
      }

      // console.log("=== response===", JSON.stringify(req.body));
      // res.json(req.body);
      if (batch[0] === 'axios-retry') {
        count += 1;
        if (count === retryCount) return res.status(200).json({});
        return res.status(503).json({
          error: { message: 'Service Unavailable' },
        });
      }

      if (batch[0] === 'axios-retry-forever') {
        return res.status(503).json({
          error: { message: 'Service Unavailable' },
        });
      }

      return res.status(200).json({});
    })
    .listen(port, t.end);
});

test.after.always(async () => {
  // Clear any active timeouts before closing the server
  activeTimeouts.forEach((timeoutId) => {
    globalThis.clearTimeout(timeoutId);
  });
  activeTimeouts = [];

  // Clean up all Analytics clients by clearing their timers
  createdClients.forEach((client) => {
    if (client.timer) {
      clearTimeout(client.timer);
    }
    if (client.flushTimer) {
      clearTimeout(client.flushTimer);
    }
  });
  createdClients = [];

  // Properly close the server and wait for it to finish
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }

  Sinon.restore();
});

test('expose a constructor', (t) => {
  t.is(typeof Analytics, 'function');
});

test('require a write key', (t) => {
  const error = t.throws(() => new Analytics(), { instanceOf: AssertionError });
  t.is(error.message, "You must pass your RudderStack project's write key.");
});

test('create a queue', async (t) => {
  const client = await createClient();

  t.deepEqual(client.queue, []);
});

test('default options', (t) => {
  const client = new Analytics('key');

  t.is(client.writeKey, 'key');
  t.is(client.host, 'https://hosted.rudderlabs.com');
  t.is(client.flushAt, 20);
  t.is(client.flushInterval, 10000);
});

test('remove trailing slashes from `host`', (t) => {
  const client = new Analytics('key', { host: 'https://google.com///' });

  t.is(client.host, 'https://google.com');
});

test('overwrite defaults with options', (t) => {
  const client = new Analytics('key', {
    host: 'a',
    flushAt: 1,
    flushInterval: 2,
  });

  t.is(client.host, 'a');
  t.is(client.flushAt, 1);
  t.is(client.flushInterval, 2);
});

test('keep the flushAt option above zero', async (t) => {
  const client = await createClient({ flushAt: 0 });

  t.is(client.flushAt, 1);
});

test('enqueue - add a message to the queue', async (t) => {
  const client = await createClient();

  const originalTimestamp = new Date();
  client.enqueue('type', { originalTimestamp }, noop);

  t.is(client.queue.length, 1);

  const item = client.queue.pop();
  t.is(typeof item.message.messageId, 'string');
  t.regex(item.message.messageId, /[\dA-Fa-f]{8}(?:\b-[\dA-Fa-f]{4}){3}\b-[\dA-Fa-f]{12}/);
  t.deepEqual(item, {
    message: {
      originalTimestamp,
      type: 'type',
      context,
      channel: 'server',
      _metadata: metadata,
      messageId: item.message.messageId,
    },
    callback: noop,
  });
});

test('enqueue - stringify userId', async (t) => {
  const client = await createClient();

  client.track(
    {
      userId: 10,
      event: 'event',
    },
    noop,
  );

  t.is(client.queue.length, 1);

  const item = client.queue.pop();

  t.is(item.message.anonymousId, undefined);
  t.is(item.message.userId, '10');
});

test('enqueue - stringify anonymousId', async (t) => {
  const client = await createClient();

  client.screen(
    {
      anonymousId: 157963456373,
      name: 'screen name',
    },
    noop,
  );

  t.is(client.queue.length, 1);

  const item = client.queue.pop();

  t.is(item.message.userId, undefined);
  // v8 will lose precision for big numbers.
  t.is(item.message.anonymousId, '157963456373');
});

test('enqueue - stringify ids handles strings', async (t) => {
  const client = await createClient();

  client.screen(
    {
      anonymousId: '15796345',
      // We're explicitly testing the behaviour of the library if a customer
      // uses a String constructor.
      userId: String('prateek'),
      name: 'screen name',
    },
    noop,
  );

  t.is(client.queue.length, 1);

  const item = client.queue.pop();

  t.is(item.message.anonymousId, '15796345');
  t.is(item.message.userId.toString(), 'prateek');
});

test("enqueue - don't modify the original message", async (t) => {
  const client = await createClient();
  const message = { event: 'test' };

  client.enqueue('type', message);

  t.deepEqual(message, { event: 'test' });
});

test('enqueue - flush on first message', async (t) => {
  const client = await createClient({ flushAt: 2 });
  client.flushed = false;
  spy(client, 'flush');

  client.enqueue('type', {});
  t.true(client.flush.calledOnce);

  client.enqueue('type', {});
  t.true(client.flush.calledOnce);

  client.enqueue('type', {});
  t.true(client.flush.calledTwice);
});

test('enqueue - flush the queue if it hits the max length', async (t) => {
  const client = await createClient({
    flushAt: 1,
    flushInterval: null,
  });

  stub(client, 'flush');

  client.enqueue('type', {});

  t.true(client.flush.calledOnce);
});

test('enqueue - flush after a period of time', async (t) => {
  const client = await createClient({ flushInterval: 10 });
  stub(client, 'flush');

  client.enqueue('type', {});

  t.false(client.flush.called);
  await setTimeout(20);

  t.true(client.flush.calledOnce);
});

test("enqueue - don't reset an existing timer", async (t) => {
  const client = await createClient({ flushInterval: 10 });
  stub(client, 'flush');

  client.enqueue('type', {});
  await setTimeout(5);
  client.enqueue('type', {});
  await setTimeout(5);

  t.true(client.flush.calledOnce);
});
test('enqueue - prevent flushing through time interval when already flushed by flushAt', async (t) => {
  const client = await createClient({ flushAt: 2, flushInterval: 10 });
  client.flushed = false;
  spy(client, 'flush');

  client.enqueue('type', {});
  t.true(client.flush.calledOnce);

  client.enqueue('type', {});
  client.enqueue('type', {});
  t.true(client.flush.calledTwice);

  await setTimeout(10);
  t.true(client.flush.calledTwice);
});

test('enqueue - extend context', async (t) => {
  const client = await createClient();

  client.enqueue(
    'type',
    {
      event: 'test',
      context: { name: 'travis' },
    },
    noop,
  );

  const actualContext = client.queue[0].message.context;
  const expectedContext = { ...context, name: 'travis' };

  t.deepEqual(actualContext, expectedContext);
});

test('enqueue - skip when client is disabled', async (t) => {
  const client = await createClient({ enable: false });
  stub(client, 'flush');

  const callback = spy();
  client.enqueue('type', {}, callback);
  await setTimeout(5);

  t.true(callback.calledOnce);
  t.false(client.flush.called);
});

test("flush - don't fail when queue is empty", async (t) => {
  const client = await createClient();

  await t.notThrows(() => client.flush());
});

test('flush - send messages', async (t) => {
  const client = await createClient({ flushAt: 2, gzip: false });
  const post = Sinon.spy(client.axiosInstance, 'post');

  const callbackA = spy();
  const callbackB = spy();
  const callbackC = spy();

  client.queue = [
    {
      message: 'a',
      callback: callbackA,
    },
    {
      message: 'b',
      callback: callbackB,
    },
    {
      message: 'c',
      callback: callbackC,
    },
  ];

  // every queued message is sent, in batches of flushAt; resolves with the last batch
  const data = await client.flush();
  t.deepEqual(
    post.getCalls().map((call) => call.args[1].batch),
    [['a', 'b'], ['c']],
  );
  t.deepEqual(Object.keys(data), ['batch', 'timestamp', 'sentAt']);
  t.deepEqual(data.batch, ['c']);
  t.true(data.timestamp instanceof Date);
  t.true(data.sentAt instanceof Date);
  t.is(client.queue.length, 0);
  t.true(callbackA.calledOnce);
  t.true(callbackB.calledOnce);
  t.true(callbackC.calledOnce);
});

test('flush - respond with an error', async (t) => {
  const client = await createClient({ path: '/v1/dummy' });
  const callback = spy();

  client.queue = [
    {
      message: 'error',
      callback,
    },
  ];

  t.is(await client.flush(), undefined);
  await setTimeout(5);
  t.is(callback.firstCall.firstArg.message, 'Not Found');
});

test.skip('flush - do not throw on axios failure if errorHandler option is specified', async (t) => {
  const errorHandler = spy();
  const client = await createClient({ errorHandler });
  const callback = spy();

  client.queue = [
    {
      message: 'error',
      callback,
    },
  ];

  await t.notThrows(() => client.flush());
  t.true(errorHandler.calledOnce);
});

test('flush - evoke callback when errorHandler option is specified', async (t) => {
  const errorHandler = spy();
  const client = await createClient({ errorHandler });
  const callback = spy();

  client.queue = [
    {
      message: 'error',
      callback,
    },
  ];

  await t.notThrows(() => client.flush());
  await setTimeout(5);
  t.true(callback.calledOnce);
});

const unreachableWriteKey = 'unreachable-sentinel-write-key';
const createUnreachableClient = (options) => {
  const client = new Analytics(unreachableWriteKey, {
    dataPlaneUrl: 'http://127.0.0.1:1',
    flushInterval: 60_000,
    logLevel: 'none',
    retryCount: 0,
    ...options,
  });
  createdClients.push(client);
  return client;
};
const recordUnhandledRejections = () => {
  const rejections = [];
  const listener = (reason) => rejections.push(reason);
  process.on('unhandledRejection', listener);
  return { rejections, stop: () => process.removeListener('unhandledRejection', listener) };
};

test('flush - redact the write key from transport errors without changing their shape', async (t) => {
  const errorHandler = spy();
  const client = createUnreachableClient({ errorHandler });
  client.flushed = true;
  const eventCallback = spy();
  client.track({ event: 'unreachable', userId: 'user-1' }, eventCallback);

  await client.flush();
  await setTimeout(5);

  const error = errorHandler.firstCall.firstArg;
  t.is(eventCallback.firstCall.firstArg, error);
  t.true(error.isAxiosError);
  t.is(error.code, 'ECONNREFUSED');
  t.truthy(error.request);
  t.is(error.config.auth, undefined);

  const basicAuth = Buffer.from(`${unreachableWriteKey}:`).toString('base64');
  for (const output of [inspect(error, { depth: Infinity }), JSON.stringify(error)]) {
    t.false(output.includes(unreachableWriteKey));
    t.false(output.includes(basicAuth));
  }
});

for (const path of ['/missing', '/v1/batch']) {
  test(`flush - redact HTTP errors and retry hook snapshots at ${path}`, async (t) => {
    const snapshots = [];
    const errorHandler = spy();
    const client = createUnreachableClient({
      dataPlaneUrl: `http://127.0.0.1:${port}`,
      path,
      gzip: false,
      retryCount: 1,
      errorHandler,
      axiosRetryConfig: {
        retryDelay: (count, error) => {
          snapshots.push(error);
          return 0;
        },
        onRetry: (count, error, config) => {
          snapshots.push(error, config);
          t.is(config.auth, undefined);
        },
        onMaxRetryTimesExceeded: (error) => snapshots.push(error),
        validateResponse: (response) => {
          snapshots.push(response);
          return false;
        },
      },
    });
    client.flushed = true;
    const callback = spy();
    client.queue = [{ message: 'axios-retry-forever', callback }];
    await client.flush();
    await setTimeout(5);
    const error = errorHandler.firstCall.firstArg;
    t.is(error.response.status, path === '/missing' ? 404 : 503);
    t.is(callback.firstCall.firstArg, error);
    t.true(snapshots.length >= (path === '/missing' ? 1 : 5));
    const token = Buffer.from(`${unreachableWriteKey}:`).toString('base64');
    for (const value of [...snapshots, error, error.response]) {
      const output = `${inspect(value, { depth: Infinity })}${JSON.stringify(value)}`;
      t.false(output.includes(unreachableWriteKey));
      t.false(output.includes(token));
    }
  });
}

test('flush - failures of unawaited flushes do not cause unhandled rejections', async (t) => {
  const unhandled = recordUnhandledRejections();
  try {
    const client = createUnreachableClient();
    const eventCallback = spy();
    // The first event triggers an internal flush that nothing awaits.
    client.track({ event: 'unreachable', userId: 'user-1' }, eventCallback);

    const flushError = await new Promise((resolve) => {
      client.flush(resolve);
    });
    await setTimeout(20);

    t.is(flushError, undefined);
    t.is(eventCallback.firstCall.firstArg.code, 'ECONNREFUSED');
    t.deepEqual(unhandled.rejections, []);
  } finally {
    unhandled.stop();
  }
});

test('flush - awaited flush reports failures through event callbacks', async (t) => {
  const client = createUnreachableClient();
  client.flushed = true;
  const callback = spy();
  client.track({ event: 'unreachable', userId: 'user-1' }, callback);

  t.is(await client.flush(), undefined);
  await setTimeout(5);
  t.is(callback.firstCall.firstArg.code, 'ECONNREFUSED');
});

test('flush - persistent queue push failure requeues events without an unhandled rejection', async (t) => {
  const unhandled = recordUnhandledRejections();
  try {
    const client = createUnreachableClient();
    client.flushed = true;
    client.pQueue = { add: () => Promise.reject(new Error('redis down')) };
    client.pQueueInitialized = true;
    const item = { message: 'a', callback: noop };
    client.queue = [item];

    await client.flush();
    await setTimeout(20);

    t.deepEqual(client.queue, [item]);
    t.deepEqual(unhandled.rejections, []);
  } finally {
    unhandled.stop();
  }
});

test('flush - time out if configured', async (t) => {
  const client = await createClient({ timeout: 50, retryCount: 0 });
  const callback = spy();

  client.queue = [
    {
      message: 'timeout',
      callback,
    },
  ];

  t.is(await client.flush(), undefined);
  await setTimeout(5);
  t.is(callback.firstCall.firstArg.message, 'timeout of 50ms exceeded');
});

test('flush - skip when client is disabled', async (t) => {
  const client = await createClient({ enable: false });
  const callback = spy();

  client.queue = [
    {
      message: 'test',
      callback,
    },
  ];

  await client.flush();

  t.false(callback.called);
});

test('flush - flush when reaches max payload size', async (t) => {
  const client = await createClient({ flushAt: 1000 });
  client.flush = spy();

  // each of these messages when stringified to json has 220-ish bytes
  // to satisfy our default limit of 1024*500 bytes we need less than 2600 of those messages
  const event = {
    userId: 1,
    event: 'event',
  };
  for (let i = 0; i < 1001; i += 1) {
    client.track(event);
  }

  t.true(client.flush.called);
});

test('flush - wont flush when no flush condition has meet', async (t) => {
  const client = await createClient({ flushAt: 1000, maxQueueSize: 1024 * 1000 });
  client.flush = spy();

  const event = {
    userId: 1,
    event: 'event',
  };
  for (let i = 0; i < 150; i += 1) {
    client.track(event);
  }

  t.false(client.flush.called);
});

const utf8Bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('enqueue - keeps a running byte total of the queue', async (t) => {
  const client = await createClient({ flushAt: 1000 });

  client.enqueue('track', { event: 'a', userId: 'user-1' }, noop);
  client.enqueue('track', { event: 'é', userId: 'user-2' }, noop);

  // each event as sent: its JSON, the `,"sentAt":...` flush() adds, and a separating comma
  const sentAtBytes = Buffer.byteLength(`,"sentAt":${JSON.stringify(new Date(0))}`) + 1;
  const expectedBytes = client.queue.reduce(
    (acc, item) => acc + utf8Bytes(item.message) + sentAtBytes,
    0,
  );
  t.is(client.queueBytes, expectedBytes);

  await client.flush();

  t.is(client.queue.length, 0);
  t.is(client.queueBytes, 0);
});

test('enqueue - does not re-serialize the queued items', async (t) => {
  const client = await createClient({ flushAt: 1000 });
  for (let i = 0; i < 200; i += 1) {
    client.enqueue('track', { event: 'event', userId: `user-${i}` }, noop);
  }

  const stringify = Sinon.spy(JSON, 'stringify');
  try {
    client.enqueue('track', { event: 'event', userId: 'user-last' }, noop);
    t.true(stringify.callCount < 5);
  } finally {
    stringify.restore();
  }
});

test('flush - sends every queued event in batches of at most maxQueueSize bytes', async (t) => {
  const client = await createClient({ flushAt: 1000, maxQueueSize: 1000 });
  const post = Sinon.spy(client.axiosInstance, 'post');
  const callbacks = Array.from({ length: 10 }, () => spy());
  client.queue = callbacks.map((callback, i) => ({
    message: { event: 'e'.repeat(200), index: i },
    callback,
  }));

  await client.flush();
  await setTimeout(5); // event callbacks run on setImmediate

  const batches = post.getCalls().map((call) => call.args[1]);
  t.true(batches.length > 1);
  t.true(batches.every((data) => utf8Bytes(data) <= 1000));
  // each batch is as large as the limit allows: the next event would not have fit
  const [first, second] = batches;
  const withNext = { ...first, batch: [...first.batch, second.batch[0]] };
  t.true(utf8Bytes(withNext) > 1000);
  t.is(
    batches.reduce((acc, data) => acc + data.batch.length, 0),
    10,
  );
  t.is(client.queue.length, 0);
  t.true(callbacks.every((callback) => callback.calledOnce));
});

test('flush - counts multi-byte characters as UTF-8 bytes', async (t) => {
  const client = await createClient({ flushAt: 1000, maxQueueSize: 1000 });
  const post = Sinon.spy(client.axiosInstance, 'post');
  client.queue = Array.from({ length: 10 }, (_, i) => ({
    // 100 characters, 300 UTF-8 bytes
    message: { event: '日本'.repeat(50), index: i },
    callback: noop,
  }));

  await client.flush();

  t.true(post.getCalls().every((call) => utf8Bytes(call.args[1]) <= 1000));
});

test('flush - stops at the events queued when it was called', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000 });
  const lateEvent = { message: 'late', callback: noop };
  const post = Sinon.stub(client.axiosInstance, 'post').callsFake(async () => {
    // keeps adding events while flush() runs; it must still settle
    client.queue.push(lateEvent);
  });
  client.queue = [
    { message: 'a', callback: noop },
    { message: 'b', callback: noop },
  ];

  await client.flush();

  t.deepEqual(
    post.getCalls().map((call) => call.args[1].batch),
    [['a'], ['b']],
  );
  t.true(client.queue.length > 0);
  t.true(client.queue.every((item) => item === lateEvent));
  // the events added meanwhile are left to the flush timer
  t.truthy(client.flushTimer);
});

test('flush - waits for another flush that sends its last queued event', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000, retryCount: 0 });
  const releases = [];
  let flushSettled = false;
  const post = Sinon.stub(client.axiosInstance, 'post').callsFake(() => {
    // eslint-disable-next-line compat/compat
    return new Promise((resolve) => {
      releases.push(() => resolve());
    });
  });
  client.queue = [
    { message: 'first', callback: noop },
    { message: 'second', callback: noop },
  ];

  const flushPromise = client.flush();
  flushPromise.then(
    () => {
      flushSettled = true;
    },
    () => {},
  );
  await setTimeout(0);
  const overlappingFlushPromise = client.flush();
  await setTimeout(0);

  t.is(post.callCount, 1);
  releases[0]();
  await setTimeout(0);
  await setTimeout(0);

  t.is(post.callCount, 2);
  t.false(flushSettled);

  releases[1]();
  await flushPromise;
  await overlappingFlushPromise;
  t.true(flushSettled);
  t.is(client.queue.length, 0);
});

test('flush - keeps burst-triggered direct sends single-flight', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000, retryCount: 0 });
  let activePosts = 0;
  let peakActivePosts = 0;
  const post = Sinon.stub(client.axiosInstance, 'post').callsFake(async () => {
    activePosts += 1;
    peakActivePosts = Math.max(peakActivePosts, activePosts);
    await setTimeout(10);
    activePosts -= 1;
  });
  const eventCount = 20;

  for (let index = 0; index < eventCount; index += 1) {
    client.track({ event: `burst-${index}`, userId: `user-${index}` }, noop);
  }

  const drainDeadline = Date.now() + 3000;
  while ((post.callCount < eventCount || activePosts > 0) && Date.now() < drainDeadline) {
    await setTimeout(5);
  }

  t.true(
    post.callCount >= eventCount && activePosts === 0,
    `timed out waiting for burst drain: post.callCount=${post.callCount}, activePosts=${activePosts}, queue.length=${client.queue.length}`,
  );
  t.is(post.callCount, eventCount);
  t.is(client.queue.length, 0);
  t.is(peakActivePosts, 1);
});

// Stubs post() with requests that stay in flight until released, counting the peak in flight.
const holdPosts = (client) => {
  const held = [];
  const stats = { active: 0, peak: 0 };
  const post = Sinon.stub(client.axiosInstance, 'post').callsFake(
    () =>
      // eslint-disable-next-line compat/compat
      new Promise((resolve) => {
        stats.active += 1;
        stats.peak = Math.max(stats.peak, stats.active);
        held.push(() => {
          stats.active -= 1;
          resolve();
        });
      }),
  );
  const releaseAll = async () => {
    while (held.length > 0 || stats.active > 0) {
      held.splice(0).forEach((release) => release());
      await setTimeout(1);
    }
  };
  return { post, stats, releaseAll };
};

test('flush - enqueues during an in-flight request do not pile up flushes', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000 });
  const { post, stats, releaseAll } = holdPosts(client);
  const drain = Sinon.spy(client, '_drain');
  const eventCount = 1000;

  for (let index = 0; index < eventCount; index += 1) {
    client.track({ event: `burst-${index}`, userId: `user-${index}` }, noop);
  }
  await setTimeout(5);

  t.is(post.callCount, 1);
  // the drain in flight, plus one shared by every enqueue that arrived meanwhile
  t.true(drain.callCount <= 2, `drains started: ${drain.callCount}`);

  await releaseAll();

  t.is(post.callCount, eventCount);
  t.is(stats.peak, 1);
  t.true(drain.callCount <= 2, `drains started: ${drain.callCount}`);
  t.is(client.queue.length, 0);
});

test('flush - events enqueued during a drain go out without waiting for the flush timer', async (t) => {
  const client = await createClient({ flushAt: 2, flushInterval: 10000 });
  const { post, releaseAll } = holdPosts(client);
  const callbacks = Array.from({ length: 6 }, () => spy());

  client.track({ event: 'a', userId: 'u' }, callbacks[0]);
  client.track({ event: 'b', userId: 'u' }, callbacks[1]);
  // a sender pausing on backpressure enqueues nothing more after these
  callbacks
    .slice(2)
    .forEach((callback, i) => client.track({ event: `c${i}`, userId: 'u' }, callback));

  await releaseAll();
  await setTimeout(5); // event callbacks run on setImmediate

  t.is(post.callCount, 3);
  t.true(callbacks.every((callback) => callback.calledOnce));
  t.is(client.queue.length, 0);
});

test('flush - settles while events keep arriving', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000 });
  let keepSending = true;
  let sent = 0;
  Sinon.stub(client.axiosInstance, 'post').callsFake(async () => {
    sent += 1;
    await setTimeout(1);
    if (keepSending) {
      client.track({ event: 'more', userId: 'u' }, noop);
    }
  });
  client.queue = [
    { message: 'a', callback: noop },
    { message: 'b', callback: noop },
  ];

  await client.flush();
  t.true(sent >= 2);

  keepSending = false;
  await client.flush();
  t.is(client.queue.length, 0);
});

test('flush - concurrent flush() calls all settle after their events are sent', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000 });
  const { post, stats, releaseAll } = holdPosts(client);
  const settled = [];
  client.queue = [{ message: 'a', callback: noop }];
  const first = client.flush().then(() => settled.push('first'));
  client.queue.push({ message: 'b', callback: noop });
  const second = client.flush().then(() => settled.push('second'));
  const third = client.flush().then(() => settled.push('third'));
  await setTimeout(5);

  t.is(post.callCount, 1);
  t.deepEqual(settled, []);

  await releaseAll();
  // eslint-disable-next-line compat/compat
  await Promise.all([first, second, third]);

  t.deepEqual(
    post.getCalls().map((call) => call.args[1].batch),
    [['a'], ['b']],
  );
  t.is(stats.peak, 1);
  t.is(client.queue.length, 0);
});

test('flush - a flush on an empty queue waits for the drain in flight', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000 });
  const { releaseAll } = holdPosts(client);
  let settled = false;
  client.queue = [{ message: 'a', callback: noop }];
  const first = client.flush();
  await setTimeout(1);

  const second = client.flush().then(() => {
    settled = true;
  });
  await setTimeout(5);
  t.false(settled);

  await releaseAll();
  // eslint-disable-next-line compat/compat
  await Promise.all([first, second]);
  t.true(settled);
});

test('flush - a flush() overlapping a failed batch resolves once the queue is drained', async (t) => {
  // `timeout` makes the test server's 404 a real failure (see isDuringTestExecution)
  const client = await createClient({ flushAt: 1, flushInterval: 10000, timeout: 1000 });
  const flush = Analytics.prototype.flush.bind(client);
  const callbackB = spy();
  const callbackC = spy();
  client.queue = [
    { message: 'a', callback: noop },
    { message: 'error', callback: callbackB },
  ];

  const first = flush();
  client.queue.push({ message: 'c', callback: callbackC });
  const overlapping = flush();

  await t.notThrowsAsync(first);
  await t.notThrowsAsync(overlapping);
  await setTimeout(5); // event callbacks run on setImmediate
  t.true(callbackB.firstCall.args[0] instanceof Error);
  t.true(callbackC.calledOnce);
  t.falsy(callbackC.firstCall.args[0]);
  t.is(client.queue.length, 0);
});

test('flush - an empty-queue flush() waiting on a failing send resolves', async (t) => {
  // `timeout` makes the test server's 404 a real failure (see isDuringTestExecution)
  const client = await createClient({ flushAt: 1, flushInterval: 10000, timeout: 1000 });
  const flush = Analytics.prototype.flush.bind(client);
  const callback = spy();
  client.queue = [{ message: 'error', callback }];

  const first = flush();
  const waiting = flush();

  await t.notThrowsAsync(first);
  await t.notThrowsAsync(waiting);
  await setTimeout(5);
  t.true(callback.firstCall.args[0] instanceof Error);
});

test('flush - persistent queue pushes batches one at a time', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000 });
  const stats = { active: 0, peak: 0 };
  client.pQueue = {
    add: async () => {
      stats.active += 1;
      stats.peak = Math.max(stats.peak, stats.active);
      await setTimeout(2);
      stats.active -= 1;
    },
  };
  client.pQueueInitialized = true;
  client.queue = ['a', 'b', 'c'].map((message) => ({ message, callback: noop }));

  // eslint-disable-next-line compat/compat
  await Promise.all([client.flush(), client.flush(), client.flush()]);
  clearTimeout(client.timer);

  t.is(stats.peak, 1);
  t.is(client.queue.length, 0);
});

test('flush - a flush() from inside a send does not start a second request', async (t) => {
  const client = await createClient({ flushAt: 1, flushInterval: 10000 });
  const stats = { active: 0, peak: 0 };
  let reentered = false;
  Sinon.stub(client.axiosInstance, 'post').callsFake(() => {
    stats.active += 1;
    stats.peak = Math.max(stats.peak, stats.active);
    if (!reentered) {
      // like a synchronous axios request hook that enqueues and flushes
      reentered = true;
      client.queue.push({ message: 'nested', callback: noop });
      client.flush();
    }
    // eslint-disable-next-line compat/compat
    return new Promise((resolve) => {
      globalThis.setTimeout(() => {
        stats.active -= 1;
        resolve();
      }, 5);
    });
  });
  client.queue = [{ message: 'a', callback: noop }];

  await client.flush();
  await setTimeout(30);

  t.is(stats.peak, 1);
  t.is(client.queue.length, 0);
});

test('flush - stops when a failed persistent push leaves the batch queued', async (t) => {
  const client = await createClient({
    flushAt: 10,
    flushInterval: 10000,
    errorHandler: () => {
      throw new Error('errorHandler failed');
    },
  });
  const add = Sinon.stub().rejects(new Error('redis unavailable'));
  client.pQueue = { add };
  client.pQueueInitialized = true;
  client.queue = [{ message: 'a', callback: noop }];

  await t.notThrowsAsync(Analytics.prototype.flush.call(client));
  clearTimeout(client.timer);
  clearTimeout(client.flushTimer);

  t.is(add.callCount, 1);
  t.is(client.queue.length, 1);
});

test('flush - re-queues each item when the persistent queue rejects a batch', async (t) => {
  const errorHandler = spy();
  const client = await createClient({ flushAt: 10, errorHandler });
  const callbackA = spy();
  const callbackB = spy();
  client.enqueue('track', { event: 'a', userId: 'user-1' }, callbackA);
  client.enqueue('track', { event: 'b', userId: 'user-2' }, callbackB);
  const queuedItems = [...client.queue];
  const queuedBytes = client.queueBytes;

  const redisError = new Error('redis unavailable');
  client.pQueue = {
    add: async () => {
      throw redisError;
    },
  };
  client.pQueueInitialized = true;

  // A rejection left unhandled here would fail the test run.
  await Analytics.prototype.flush.call(client);
  await setTimeout(10);
  clearTimeout(client.timer);
  clearTimeout(client.flushTimer);

  t.deepEqual(client.queue, queuedItems);
  t.true(client.queue.every((item, i) => item === queuedItems[i]));
  t.is(client.queueBytes, queuedBytes);
  t.false(callbackA.called);
  t.false(callbackB.called);
  t.true(errorHandler.calledOnceWithExactly(redisError));
});

test('flush - carries on past a failed batch', async (t) => {
  // `timeout` makes the test server's 404 a real failure (see isDuringTestExecution)
  const client = await createClient({ flushAt: 1, flushInterval: 10000, timeout: 1000 });
  const callbackA = spy();
  const callbackC = spy();
  client.queue = [
    { message: 'error', callback: callbackA },
    { message: 'c', callback: callbackC },
  ];

  // The real flush(), not the callback wrapper from createClient(), so a rejection would show.
  await t.notThrowsAsync(Analytics.prototype.flush.call(client));
  await setTimeout(5);

  t.true(callbackA.firstCall.args[0] instanceof Error);
  t.true(callbackC.calledOnce);
  t.falsy(callbackC.firstCall.args[0]);
  t.is(client.queue.length, 0);
});

test('flush - reports failed batches to their callbacks, not to the flush callback', async (t) => {
  // `timeout` makes the test server's 404 a real failure (see isDuringTestExecution)
  const client = await createClient({ flushAt: 1, flushInterval: 10000, timeout: 1000 });
  const callbacks = [spy(), spy()];
  client.queue = callbacks.map((callback) => ({ message: 'error', callback }));
  const flushCallback = spy();

  await t.notThrowsAsync(Analytics.prototype.flush.call(client, flushCallback));
  await setTimeout(5);

  t.true(callbacks.every((callback) => callback.firstCall.args[0] instanceof Error));
  t.true(flushCallback.calledOnce);
  t.falsy(flushCallback.firstCall.args[0]);
  t.is(client.queue.length, 0);
});

test('flush - keeps events queued while the persistent queue is not ready', async (t) => {
  const client = await createClient({ flushAt: 10, flushInterval: 10000 });
  const callback = spy();
  client.queue = [{ message: 'a', callback }];
  client.pQueue = { add: spy() };
  client.pQueueInitialized = false;

  await t.notThrowsAsync(Analytics.prototype.flush.call(client));
  clearTimeout(client.flushTimer);

  t.is(client.queue.length, 1);
  t.false(client.pQueue.add.called);
  t.false(callback.called);
});

test('flush - sends an item larger than maxQueueSize on its own', async (t) => {
  const client = await createClient({ flushAt: 10, maxQueueSize: 100 });
  const post = Sinon.spy(client.axiosInstance, 'post');
  client.queue = [
    { message: { event: 'x'.repeat(500) }, callback: noop },
    { message: { event: 'y' }, callback: noop },
  ];

  await client.flush();

  t.deepEqual(
    post.getCalls().map((call) => call.args[1].batch.map((message) => message.event)),
    [['x'.repeat(500)], ['y']],
  );
  t.is(client.queue.length, 0);
});

test('identify - enqueue a message', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const message = { userId: 'id' };
  client.identify(message, noop);

  t.true(client.enqueue.calledOnce);
  t.deepEqual(client.enqueue.firstCall.args, ['identify', message, noop]);
});

test('identify - require a userId or anonymousId', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const error1 = t.throws(() => client.identify(), { instanceOf: AssertionError });
  t.is(error1.message, 'You must pass a message object.');

  const error2 = t.throws(() => client.identify({}), { instanceOf: AssertionError });
  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  t.notThrows(() => client.identify({ userId: 'id' }));
  t.notThrows(() => client.identify({ anonymousId: 'id' }));
});

test('group - enqueue a message', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const message = {
    groupId: 'id',
    userId: 'id',
  };

  client.group(message, noop);

  t.true(client.enqueue.calledOnce);
  t.deepEqual(client.enqueue.firstCall.args, ['group', message, noop]);
});

test('group - require a groupId and either userId or anonymousId', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const error1 = t.throws(() => client.group(), { instanceOf: AssertionError });
  t.is(error1.message, 'You must pass a message object.');

  const error2 = t.throws(() => client.group({}), { instanceOf: AssertionError });
  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  const error3 = t.throws(() => client.group({ userId: 'id' }), { instanceOf: AssertionError });
  t.is(error3.message, 'You must pass a "groupId".');

  const error4 = t.throws(() => client.group({ anonymousId: 'id' }), {
    instanceOf: AssertionError,
  });
  t.is(error4.message, 'You must pass a "groupId".');

  t.notThrows(() => {
    client.group({
      groupId: 'id',
      userId: 'id',
    });
  });

  t.notThrows(() => {
    client.group({
      groupId: 'id',
      anonymousId: 'id',
    });
  });
});

test('track - enqueue a message', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const message = {
    userId: 1,
    event: 'event',
  };

  client.track(message, noop);

  t.true(client.enqueue.calledOnce);
  t.deepEqual(client.enqueue.firstCall.args, ['track', message, noop]);
});

test('track - require event and either userId or anonymousId', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const error1 = t.throws(() => client.track(), { instanceOf: AssertionError });
  t.is(error1.message, 'You must pass a message object.');

  const error2 = t.throws(() => client.track({}), { instanceOf: AssertionError });
  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  const error3 = t.throws(() => client.track({ userId: 'id' }), { instanceOf: AssertionError });
  t.is(error3.message, 'You must pass an "event".');

  const error4 = t.throws(() => client.track({ anonymousId: 'id' }), {
    instanceOf: AssertionError,
  });
  t.is(error4.message, 'You must pass an "event".');

  t.notThrows(() => {
    client.track({
      userId: 'id',
      event: 'event',
    });
  });

  t.notThrows(() => {
    client.track({
      anonymousId: 'id',
      event: 'event',
    });
  });
});

test('page - enqueue a message', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const message = { userId: 'id' };
  client.page(message, noop);

  t.true(client.enqueue.calledOnce);
  t.deepEqual(client.enqueue.firstCall.args, ['page', message, noop]);
});

test('page - require either userId or anonymousId', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const error1 = t.throws(() => client.page(), { instanceOf: AssertionError });
  t.is(error1.message, 'You must pass a message object.');

  const error2 = t.throws(() => client.page({}), { instanceOf: AssertionError });
  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  t.notThrows(() => client.page({ userId: 'id' }));
  t.notThrows(() => client.page({ anonymousId: 'id' }));
});

test('screen - enqueue a message', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const message = { userId: 'id' };
  client.screen(message, noop);

  t.true(client.enqueue.calledOnce);
  t.deepEqual(client.enqueue.firstCall.args, ['screen', message, noop]);
});

test('screen - require either userId or anonymousId', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const error1 = t.throws(() => client.screen(), { instanceOf: AssertionError });
  t.is(error1.message, 'You must pass a message object.');

  const error2 = t.throws(() => client.screen({}), { instanceOf: AssertionError });
  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  t.notThrows(() => client.screen({ userId: 'id' }));
  t.notThrows(() => client.screen({ anonymousId: 'id' }));
});

test('alias - enqueue a message', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const message = {
    userId: 'id',
    previousId: 'id',
  };

  client.alias(message, noop);

  t.true(client.enqueue.calledOnce);
  t.deepEqual(client.enqueue.firstCall.args, ['alias', message, noop]);
});

test('alias - require previousId and userId', async (t) => {
  const client = await createClient();
  stub(client, 'enqueue');

  const error1 = t.throws(() => client.alias(), { instanceOf: AssertionError });
  t.is(error1.message, 'You must pass a message object.');

  const error2 = t.throws(() => client.alias({}), { instanceOf: AssertionError });
  t.is(error2.message, 'You must pass a "userId".');

  const error3 = t.throws(() => client.alias({ userId: 'id' }), { instanceOf: AssertionError });
  t.is(error3.message, 'You must pass a "previousId".');

  t.notThrows(() => {
    client.alias({
      userId: 'id',
      previousId: 'id',
    });
  });
});

test('isErrorRetryable', async (t) => {
  const client = await createClient();

  t.false(client._isErrorRetryable({}));

  // ETIMEDOUT is retryable as per `is-retry-allowed` (used by axios-retry in `isNetworkError`).
  t.true(client._isErrorRetryable({ code: 'ETIMEDOUT' }));

  // ECONNABORTED is not retryable as per `is-retry-allowed` (used by axios-retry in `isNetworkError`).
  t.false(client._isErrorRetryable({ code: 'ECONNABORTED' }));

  t.true(client._isErrorRetryable({ response: { status: 500 } }));
  t.true(client._isErrorRetryable({ response: { status: 429 } }));

  t.false(client._isErrorRetryable({ response: { status: 200 } }));
});

test('dont throw an error if messages > 32kb', async (t) => {
  const client = await createClient();

  const event = {
    userId: 1,
    event: 'event',
    properties: {},
  };
  for (let i = 0; i < 10000; i += 1) {
    event.properties[i] = 'a';
  }

  t.notThrows(() => {
    client.track(event, noop);
  });
});

test('ensure that failed requests are retried', async (t) => {
  const client = await createClient({ retryCount });
  const callback = spy();

  client.queue = [
    {
      message: 'axios-retry',
      callback,
    },
  ];

  await t.notThrows(() => client.flush());
});

test.skip('ensure that failed requests are not retried forever', async (t) => {
  const client = await createClient({ path: '/v1/dummy' });
  const callback = spy();

  client.queue = [
    {
      message: 'axios-retry-forever',
      callback,
    },
  ];

  await t.throws(client.flush(), { instanceOf: AssertionError });
});

test('ensure we can pass our own axios instance', async (t) => {
  const axios = (await import('axios')).default;
  const myAxiosInstance = axios.create();
  const stubAxiosPost = stub(myAxiosInstance, 'post').resolves();
  const client = await createClient({
    axiosInstance: myAxiosInstance,
    host: 'https://my-dummy-host.com',
    path: '/test/path',
  });

  const callback = spy();
  client.queue = [
    {
      message: 'something',
      callback,
    },
  ];

  client.flush();
  t.true(stubAxiosPost.called);
  t.true(stubAxiosPost.alwaysCalledWith('https://my-dummy-host.com/test/path'));
});

test('ensure other axios clients are not impacted by axios-retry', async (t) => {
  let client = await createClient(); // eslint-disable-line
  const axios = (await import('axios')).default;

  let callCounter = 0;

  // Client will return a successful response for any requests beyond the first
  const localServer = express()
    .use(bodyParser.json())
    .get('/v1/anotherEndpoint', (req, res) => {
      if (callCounter > 0) {
        res.status(200).send('Ok');
      } else {
        callCounter += 1;
        res.status(503).send('Service down');
      }
    })
    .listen(separateAxiosClientPort);

  await axios
    .get(`http://localhost:${separateAxiosClientPort}/v1/anotherEndpoint`)
    .then(() => {
      t.fail();
    })
    .catch((error) => {
      if (error) {
        t.pass();
      }
    });

  localServer.close();
});

test('ensure library information not overridden if provided in context object', async (t) => {
  const client = await createClient();
  const customContext = {
    library: {
      name: 'random-sdk',
      version: '1234',
    },
  };

  client.enqueue(
    'type',
    {
      event: 'test',
      context: customContext,
    },
    noop,
  );

  const actualContext = client.queue[0].message.context;

  t.deepEqual(actualContext.library, context.library);
});

test('ensure library information not overridden if provided null in context object', async (t) => {
  const client = await createClient();
  const customContext = null;

  client.enqueue(
    'type',
    {
      event: 'test',
      context: customContext,
    },
    noop,
  );

  const actualContext = client.queue[0].message.context;

  t.deepEqual(actualContext.library, context.library);
});

test('ensure library information not overridden if provided undefined in context object', async (t) => {
  const client = await createClient();
  const customContext = undefined;

  client.enqueue(
    'type',
    {
      event: 'test',
      context: customContext,
    },
    noop,
  );

  const actualContext = client.queue[0].message.context;

  t.deepEqual(actualContext.library, context.library);
});
