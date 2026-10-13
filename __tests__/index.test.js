/* eslint-disable no-underscore-dangle */
// import bodyParser from 'body-parser';
const express = require('express');
const auth = require('basic-auth');
const bodyParser = require('body-parser');
// eslint-disable-next-line import/no-unresolved
const { default: test } = require('ava');
const Sinon = require('sinon');
const { setTimeout } = require('node:timers/promises');
const { AssertionError } = require('assert');

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
      userId: String('prateek'), // eslint-disable-line no-new-wrappers
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

  const data = await client.flush();
  t.deepEqual(Object.keys(data), ['batch', 'timestamp', 'sentAt']);
  t.deepEqual(data.batch, ['a', 'b']);
  t.true(data.timestamp instanceof Date);
  t.true(data.sentAt instanceof Date);
  setImmediate(() => {
    t.true(callbackA.calledOnce);
    t.true(callbackB.calledOnce);
    t.false(callbackC.called);
  });
});

test.skip('flush - respond with an error', async (t) => {
  const client = await createClient({ path: '/v1/dummy' });
  const callback = spy();

  client.queue = [
    {
      message: 'error',
      callback,
    },
  ];

  const error = await t.throwsAsync(client.flush(), { instanceOf: AssertionError });
  t.is(error.message, 'Not Found');
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

test('flush - sanitize transport failures and clear pending flush state', async (t) => {
  const writeKey = 'distinctive-write-key';
  const authorization = `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}`;
  const rawError = Object.assign(
    new Error(`connect ECONNREFUSED using ${writeKey} and ${authorization}`),
    {
      name: `AxiosError ${writeKey} ${authorization}`,
      code: 'ECONNREFUSED',
      config: {
        auth: { username: writeKey },
        headers: { Authorization: authorization },
      },
      request: { secret: writeKey },
    },
  );
  const axiosInstance = { post: stub().rejects(rawError) };
  const errorHandler = spy();
  const eventCallback = spy();
  const flushCallback = spy();
  const log = spy();
  const client = new Analytics(writeKey, {
    axiosInstance,
    errorHandler,
    flushAt: 1,
    gzip: false,
    logLevel: 'error',
    retryCount: 0,
  });
  client.logger.logProvider = { error: log };
  client.flushed = true;
  client.queue = [{ message: 'event', callback: eventCallback }];

  await t.notThrowsAsync(client.flush(flushCallback));

  t.true(eventCallback.calledOnce);
  t.true(flushCallback.calledOnce);
  t.true(errorHandler.calledOnce);
  t.is(client.pendingFlush, null);

  const notifiedErrors = [
    eventCallback.firstCall.firstArg,
    flushCallback.firstCall.firstArg,
    errorHandler.firstCall.firstArg,
  ];
  for (const error of notifiedErrors) {
    t.is(error.name, 'Error');
    t.is(error.code, 'ECONNREFUSED');
    t.false('config' in error);
    t.false('request' in error);
    t.false(error.message.includes(writeKey));
    t.false(error.message.includes(authorization));
  }

  const output = JSON.stringify(log.args);
  t.false(output.includes(writeKey));
  t.false(output.includes(authorization));
});

test('persistent queue jobs do not store the write key and are bound to their source', async (t) => {
  const writeKey = 'persistent-secret-key';
  const addedJobs = [];
  const client = new Analytics(writeKey, {
    flushAt: 1,
    flushInterval: 60_000,
    gzip: false,
    logLevel: 'none',
    retryCount: 0,
  });
  client.flushed = true;
  client.pQueueInitialized = true;
  client.pQueue = {
    add: (job) => {
      addedJobs.push(job);
      return Promise.resolve();
    },
  };
  client.queue = [{ message: 'event', callback: noop }];

  await client.flush();
  await setTimeout(5);

  t.is(addedJobs.length, 1);
  t.is(addedJobs[0].version, 4);
  t.truthy(addedJobs[0].writeKeyBinding);
  t.truthy(addedJobs[0].eventDataSignature);
  t.false(addedJobs[0].eventData.includes(writeKey));

  const restoredJobData = client._deserializeJobData({ data: addedJobs[0] });
  t.truthy(restoredJobData);
  t.deepEqual(restoredJobData.request.auth, undefined);

  const otherClient = new Analytics('different-write-key', { logLevel: 'none', retryCount: 0 });
  t.is(otherClient._deserializeJobData({ data: addedJobs[0] }), undefined);
  clearTimeout(client.timer);
});

test('legacy persistent queue jobs are scrubbed before being requeued', (t) => {
  const writeKey = 'legacy-persistent-secret-key';
  const authorization = `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}`;
  const legacyJobData = {
    jobId: 'legacy-job',
    description: 'legacy job',
    request: {
      auth: { username: writeKey },
      headers: { Authorization: authorization, 'user-agent': 'analytics-node/test' },
      data: { batch: ['event'] },
    },
    attempts: 0,
  };
  const client = new Analytics(writeKey, { logLevel: 'none', retryCount: 0 });

  const deserialized = client._deserializeJobData({
    data: { version: 3, eventData: JSON.stringify(legacyJobData) },
  });
  t.truthy(deserialized);
  t.deepEqual(deserialized.request.auth, undefined);
  t.deepEqual(deserialized.request.headers.Authorization, undefined);

  const requeued = client._getDataForPersistenceQueue(deserialized);
  t.is(requeued.version, 4);
  t.false(requeued.eventData.includes(writeKey));
  t.truthy(client._deserializeJobData({ data: requeued }));

  const wrongKeyJob = new Analytics('other-key', {
    logLevel: 'none',
    retryCount: 0,
  })._deserializeJobData({
    data: { version: 3, eventData: JSON.stringify(legacyJobData) },
  });
  t.is(wrongKeyJob, undefined);
});

test('automatic flush failures do not cause an unhandled rejection', async (t) => {
  const axiosInstance = {
    post: stub().rejects(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })),
  };
  const client = new Analytics('automatic-flush-key', {
    axiosInstance,
    flushAt: 1,
    gzip: false,
    logLevel: 'none',
    retryCount: 0,
  });
  const unhandledRejection = spy();
  process.on('unhandledRejection', unhandledRejection);

  try {
    client.track({ event: 'automatic flush', userId: 'user-1' });
    await setTimeout(20);
    t.false(unhandledRejection.called);
    t.is(client.pendingFlush, null);
  } finally {
    process.removeListener('unhandledRejection', unhandledRejection);
    if (client.flushTimer) {
      clearTimeout(client.flushTimer);
    }
  }
});

test('async error handler rejections are contained and sanitized', async (t) => {
  const writeKey = 'async-handler-secret-key';
  const authorization = `Basic ${Buffer.from(`${writeKey}:`).toString('base64')}`;
  const axiosInstance = {
    post: stub().rejects(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })),
  };
  const unhandledRejection = spy();
  const log = spy();
  const client = new Analytics(writeKey, {
    axiosInstance,
    errorHandler: () => Promise.reject(new Error(`handler failed ${writeKey} ${authorization}`)),
    flushAt: 1,
    gzip: false,
    logLevel: 'error',
    retryCount: 0,
  });
  client.logger.logProvider = { error: log };
  client.flushed = true;
  client.queue = [{ message: 'event', callback: noop }];
  process.on('unhandledRejection', unhandledRejection);

  try {
    await client.flush();
    await setTimeout(5);
    t.false(unhandledRejection.called);
    const output = JSON.stringify(log.args);
    t.false(output.includes(writeKey));
    t.false(output.includes(authorization));
  } finally {
    process.removeListener('unhandledRejection', unhandledRejection);
  }
});

test('callbacks attached to an in-flight failed flush receive the failure', async (t) => {
  const rawError = Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
  const axiosInstance = { post: stub().rejects(rawError) };
  const eventCallback = spy();
  const flushCallback = spy();
  const lateFlushCallback = spy();
  const client = new Analytics('late-flush-key', {
    axiosInstance,
    flushAt: 1,
    gzip: false,
    logLevel: 'none',
    retryCount: 0,
  });
  client.flushed = true;
  client.queue = [{ message: 'event', callback: eventCallback }];

  const firstFlush = client.flush(flushCallback);
  const lateFlush = client.flush(lateFlushCallback);
  await firstFlush;
  await lateFlush;

  t.true(eventCallback.calledOnce);
  t.true(flushCallback.calledOnce);
  t.true(lateFlushCallback.calledOnce);
  t.is(eventCallback.firstCall.firstArg.code, 'ECONNREFUSED');
  t.is(flushCallback.firstCall.firstArg.code, 'ECONNREFUSED');
  t.is(lateFlushCallback.firstCall.firstArg.code, 'ECONNREFUSED');
});

test.skip('flush - time out if configured', async (t) => {
  const client = await createClient({ timeout: 50 });
  const callback = spy();

  client.queue = [
    {
      message: 'timeout',
      callback,
    },
  ];

  const error = await t.throwsAsync(client.flush(), { instanceOf: AssertionError });
  t.is(error.message, 'timeout of 50ms exceeded');
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
