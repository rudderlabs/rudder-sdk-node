/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
const { default: test } = require('ava');
const Sinon = require('sinon');
const { setTimeout } = require('node:timers/promises');
const { AssertionError } = require('assert');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const Analytics = require('../src/index');
const { version } = require('../package.json');

const { spy, stub } = Sinon;

const library = { name: 'analytics-node', version };
const SIZE_WARNING =
  'Your message must be < 32kb. This is currently surfaced as a warning. Please update your code';

const createClient = (options) => {
  const client = new Analytics('key', {
    dataPlaneUrl: 'http://localhost:4065',
    logLevel: 'error',
    gzip: false,
    flushInterval: 60000,
    ...options,
  });
  // enqueue() would flush on the first event; tests flush explicitly
  client.flushed = true;
  stub(client.logger, 'debug');
  stub(client.logger, 'info');
  stub(client.logger, 'warn');
  stub(client.logger, 'error');
  const post = stub(client.axiosInstance, 'post').resolves({ status: 200 });
  return { client, post };
};

const sentBatches = (post) => post.getCalls().map((call) => call.args[1].batch);

const cleanup = (client) => {
  clearTimeout(client.flushTimer);
  clearTimeout(client.timer);
};

// Keep the hook and error policy verbatim from the README example.
const readmeHookOptions = {
  beforeEnqueue: (event) => {
    // Drop events from internal test accounts
    if (typeof event.userId === 'string' && event.userId.startsWith('test-')) return null;
    // Strip the email before it leaves the process
    for (const traits of [event.traits, event.context?.traits]) {
      if (traits && typeof traits === 'object') delete traits.email;
    }
    return event;
  },
  // The hook redacts PII, so never fall back to the unredacted original
  beforeEnqueueOnError: 'drop',
};

test('README hook: numeric zero userId with an anonymousId is kept', async (t) => {
  const readme = readFileSync(require.resolve('../README.md'), 'utf8');
  const hook = readme.match(/beforeEnqueue: (\(event\) => \{[\s\S]*?\n {2}\}),/)[1];
  const { client, post } = createClient({
    beforeEnqueue: new Function(`return ${hook}`)(),
    beforeEnqueueOnError: 'drop',
  });
  t.teardown(() => cleanup(client));

  client.track({ userId: 0, anonymousId: 'a1', event: 'Kept' });
  await client.flush();

  t.true(post.calledOnce);
  t.like(sentBatches(post)[0][0], { userId: 0, anonymousId: 'a1', event: 'Kept' });
  t.false(client.logger.error.called);
});

for (const beforeEnqueueOnError of ['send', 'drop']) {
  for (const scenario of ['async rejection', 'cyclic prototype', 'unbounded prototype']) {
    test(`containment: ${scenario} stays inside the SDK ('${beforeEnqueueOnError}')`, (t) => {
      const result = spawnSync(
        process.execPath,
        [
          '--unhandled-rejections=strict',
          '-e',
          `
        const assert = require('node:assert/strict');
        const Analytics = require(${JSON.stringify(require.resolve('../src/index'))});
        let unhandled = 0;
        process.on('unhandledRejection', () => { unhandled += 1; });
        const cyclic = new Proxy({}, { getPrototypeOf: () => cyclic });
        const endless = () => new Proxy({}, { getPrototypeOf: endless });
        const hook = ${JSON.stringify(scenario)} === 'async rejection'
          ? async () => { throw new Error('secret-pii-value'); }
          : () => { throw ${JSON.stringify(scenario)} === 'cyclic prototype' ? cyclic : endless(); };
        const client = new Analytics('key', {
          beforeEnqueue: hook, beforeEnqueueOnError: ${JSON.stringify(beforeEnqueueOnError)},
          flushInterval: 60000,
        });
        client.flushed = true;
        const logs = [];
        client.logger.error = (line) => logs.push(line);
        client.track({ userId: 'u1', event: 'Kept' });
        clearTimeout(client.flushTimer);
        clearTimeout(client.timer);
        assert.equal(client.queue.length, ${beforeEnqueueOnError === 'send' ? 1 : 0});
        assert.equal(logs.length, 1);
        assert.ok(!logs[0].includes('secret-pii-value'));
        if (${JSON.stringify(scenario)} !== 'async rejection') assert.ok(logs[0].endsWith('. [object Object]'));
        setImmediate(() => {
          assert.equal(unhandled, 0);
          console.log('contained');
        });
      `,
        ],
        { encoding: 'utf8', timeout: 3000 },
      );

      t.is(result.error, undefined);
      t.is(result.status, 0, result.stderr);
      t.is(result.stdout.trim(), 'contained');
    });
  }

  for (const value of [NaN, Infinity, -Infinity]) {
    test(`wire form: non-finite ${value} is a hook error ('${beforeEnqueueOnError}')`, async (t) => {
      let reads = 0;
      const { client, post } = createClient({
        beforeEnqueueOnError,
        beforeEnqueue: (event) => ({
          ...event,
          properties: {
            nested: [
              {
                get value() {
                  reads += 1;
                  return value;
                },
              },
            ],
          },
        }),
      });
      t.teardown(() => cleanup(client));

      client.track({ userId: 'u1', event: 'Kept', properties: { original: true } });
      await client.flush();

      t.is(reads, 1);
      t.true(client.logger.error.calledOnce);
      if (beforeEnqueueOnError === 'drop') {
        t.false(post.called);
      } else {
        t.deepEqual(sentBatches(post)[0][0].properties, { original: true });
      }
    });
  }

  for (const outcome of ['drop', 'error']) {
    for (const coercion of ['payload', 'throw']) {
      test(`logging: object messageId with ${coercion} coercion is safe on ${outcome} ('${beforeEnqueueOnError}')`, async (t) => {
        const toString = spy(() => {
          if (coercion === 'throw') throw new Error('secret-pii-value');
          return 'secret-pii-value';
        });
        const { client, post } = createClient({
          beforeEnqueueOnError,
          beforeEnqueue: () => {
            if (outcome === 'error') throw new Error('hook error');
            return null;
          },
        });
        t.teardown(() => cleanup(client));

        t.notThrows(() => client.track({ userId: 'u1', event: 'Kept', messageId: { toString } }));
        await client.flush();

        t.false(toString.called);
        t.false(loggedArgs(client).some((line) => line.includes('secret-pii-value')));
        const logger = outcome === 'drop' ? client.logger.debug : client.logger.error;
        const lines = logger
          .getCalls()
          .map((call) => call.args[0])
          .filter((line) => line.startsWith('beforeEnqueue'));
        t.is(lines.length, 1);
        t.true(lines[0].includes('event [unknown]'));
        t.is(post.called, outcome === 'error' && beforeEnqueueOnError === 'send');
      });
    }
  }
}

for (const type of ['identify', 'group']) {
  test(`README hook: ${type} redacts email from both trait locations in the complete request`, async (t) => {
    const clock = Sinon.useFakeTimers({
      now: Date.parse('2026-10-23T10:00:00.000Z'),
      toFake: ['Date'],
    });
    t.teardown(() => clock.restore());
    const { client, post } = createClient(readmeHookOptions);
    const { client: plain, post: baselinePost } = createClient();
    t.teardown(() => {
      cleanup(client);
      cleanup(plain);
    });
    const email = 'readme-redaction@example.com';
    const inputs = [
      { traits: { email, name: 'Ada', plan: 'pro' } },
      { context: { traits: { email, name: 'Grace', plan: 'pro' } } },
      {
        traits: { email, name: 'Ada', plan: 'pro' },
        context: { traits: { email, name: 'Grace', plan: 'pro' } },
      },
    ];

    for (const input of inputs) {
      const fields = {
        userId: 'u1',
        groupId: 'g1',
        messageId: `m${inputs.indexOf(input)}`,
        ...input,
      };
      client[type](fields);
      plain[type](fields);
    }
    await client.flush();

    t.true(post.calledOnce);
    await plain.flush();
    const expected = JSON.parse(JSON.stringify(baselinePost.firstCall.args[1]));
    for (const event of expected.batch) {
      for (const traits of [event.traits, event.context?.traits]) {
        if (traits && typeof traits === 'object') delete traits.email;
      }
    }
    const request = JSON.parse(JSON.stringify(post.firstCall.args[1]));
    t.is(post.firstCall.args[0], baselinePost.firstCall.args[0]);
    t.deepEqual(request, expected);
    t.false(loggedArgs(client).some((arg) => arg?.includes(email)));
    t.false(JSON.stringify(request).includes(email));
    t.is(request.batch.length, inputs.length);
    for (const [index, input] of inputs.entries()) {
      const sent = request.batch[index];
      t.is(sent.type, type);
      t.deepEqual(sent.traits, input.traits ? { name: 'Ada', plan: 'pro' } : undefined);
      const name = type === 'identify' && input.traits ? 'Ada' : input.context?.traits.name;
      t.deepEqual(sent.context.traits, name ? { name, plan: 'pro' } : undefined);
    }
    t.false(client.logger.error.called);
  });

  test(`README hook: ${type} keeps events with missing or scalar traits without hook errors`, async (t) => {
    const clock = Sinon.useFakeTimers({
      now: Date.parse('2026-10-23T10:00:00.000Z'),
      toFake: ['Date'],
    });
    t.teardown(() => clock.restore());
    const { client, post } = createClient(readmeHookOptions);
    const { client: plain, post: baselinePost } = createClient();
    t.teardown(() => {
      cleanup(client);
      cleanup(plain);
    });
    const values = [null, 'scalar', 42, true, 0, false, [], {}];
    const inputs = [
      {},
      { context: null },
      { context: 0 },
      { context: false },
      ...values.map((traits) => ({ traits })),
      ...values.map((traits) => ({ context: { traits } })),
    ];

    for (const input of inputs) {
      const fields = {
        userId: 'u1',
        groupId: 'g1',
        messageId: `m${inputs.indexOf(input)}`,
        ...input,
      };
      t.notThrows(() => client[type](fields));
      plain[type](fields);
    }
    await client.flush();

    await plain.flush();
    const requests = post
      .getCalls()
      .map((call) => ({ url: call.args[0], body: JSON.parse(JSON.stringify(call.args[1])) }));
    const expected = baselinePost
      .getCalls()
      .map((call) => ({ url: call.args[0], body: JSON.parse(JSON.stringify(call.args[1])) }));
    t.deepEqual(requests, expected);
    const batch = requests.flatMap((request) => request.body.batch);
    t.is(batch.length, inputs.length);
    for (const [index, input] of inputs.entries()) {
      t.is(batch[index].type, type);
      t.deepEqual(batch[index].traits, input.traits);
      const traits = type === 'identify' && input.traits ? input.traits : input.context?.traits;
      t.deepEqual(batch[index].context.traits, traits);
    }
    t.false(client.logger.error.called);
  });
}

test('edit: a changed property arrives at the data plane', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      event.properties.plan = 'redacted';
      return event;
    },
  });

  client.track({ userId: 'u1', event: 'Signed Up', properties: { plan: 'pro' } });
  await client.flush();

  const [[sent]] = sentBatches(post);
  t.is(sent.properties.plan, 'redacted');
  t.is(sent.type, 'track');
  t.deepEqual(sent.context.library, library);
  cleanup(client);
});

test('input: the hook gets the enriched event', (t) => {
  const beforeEnqueue = spy((event) => event);
  const { client } = createClient({ beforeEnqueue });

  client.identify({ anonymousId: 7, traits: { name: 'Ada' } });

  const [event] = beforeEnqueue.firstCall.args;
  t.is(event.type, 'identify');
  t.is(event.channel, 'server');
  t.is(event.anonymousId, '7');
  t.is(typeof event.messageId, 'string');
  t.true(event.originalTimestamp instanceof Date);
  t.deepEqual(event.context, { traits: { name: 'Ada' }, library });
  t.deepEqual(event._metadata, { nodeVersion: process.versions.node });
  cleanup(client);
});

test('drop: nothing is sent, the call returns the client and the callback fires without an error', async (t) => {
  const errorHandler = spy();
  const { client, post } = createClient({ beforeEnqueue: () => null, errorHandler });
  const callback = spy();

  const returned = client.track({ userId: 'u1', event: 'Noise' }, callback);
  await setTimeout(5);
  await client.flush();

  t.is(returned, client);
  t.is(client.queue.length, 0);
  t.false(post.called);
  t.true(callback.calledOnce);
  t.is(callback.firstCall.args.length, 0);
  t.false(errorHandler.called);
  t.false(client.logger.error.called);
  t.true(
    client.logger.debug.calledWith(Sinon.match(/^beforeEnqueue dropped track event [\da-f-]{36}$/)),
  );
  cleanup(client);
});

test("hook error: a throwing hook sends the original event with 'send' (default)", async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: () => {
      throw new Error('boom');
    },
  });

  t.notThrows(() => client.track({ userId: 'u1', event: 'Kept', properties: { a: 1 } }));
  await client.flush();

  const [[sent]] = sentBatches(post);
  t.is(sent.event, 'Kept');
  t.deepEqual(sent.properties, { a: 1 });
  t.true(client.logger.error.calledOnce);
  t.deepEqual(client.logger.error.firstCall.args.length, 1);
  t.regex(
    client.logger.error.firstCall.args[0],
    /^beforeEnqueue failed for track event [\da-f-]{36}, sending the original event\. Error: boom$/,
  );
  cleanup(client);
});

test("hook error: a throwing hook drops the event with 'drop'", async (t) => {
  const errorHandler = spy();
  const { client, post } = createClient({
    beforeEnqueue: () => {
      throw new Error('boom');
    },
    beforeEnqueueOnError: 'drop',
    errorHandler,
  });
  const callback = spy();

  t.notThrows(() => client.track({ userId: 'u1', event: 'Gone' }, callback));
  await setTimeout(5);
  await client.flush();

  t.false(post.called);
  t.true(callback.calledOnce);
  t.is(callback.firstCall.args.length, 0);
  t.false(errorHandler.called);
  t.true(
    client.logger.error.calledWith(
      Sinon.match(
        /^beforeEnqueue failed for track event [\da-f-]{36}, dropping the event\. Error: boom$/,
      ),
    ),
  );
  cleanup(client);
});

test('hook error: non-event return values are hook errors', async (t) => {
  const returns = [undefined, 'event', 42, [], true];
  for (const value of returns) {
    const { client, post } = createClient({ beforeEnqueue: () => value });
    client.track({ userId: 'u1', event: 'Kept' });
    await client.flush();
    t.is(sentBatches(post)[0][0].event, 'Kept', `return value ${String(value)}`);
    t.true(client.logger.error.calledOnce);
    cleanup(client);
  }
});

test('hook error: a thrown non-Error value is logged, not raised', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: () => {
      throw Object.create(null);
    },
  });

  t.notThrows(() => client.track({ userId: 'u1', event: 'Kept' }));
  await client.flush();

  t.is(sentBatches(post)[0][0].event, 'Kept');
  t.true(client.logger.error.calledOnce);
  cleanup(client);
});

test('hook error: an unserializable return value sends the original event', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      event.properties.big = BigInt(1);
      return event;
    },
  });

  t.notThrows(() => client.track({ userId: 'u1', event: 'Kept', properties: {} }));
  await client.flush();

  t.deepEqual(sentBatches(post)[0][0].properties, {});
  t.true(client.logger.error.calledOnce);
  cleanup(client);
});

test('mutate then fail: the pre-hook event is sent without the partial edits', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      event.properties.email = 'redacted';
      event.context.tenant = 'leaked';
      delete event.userId;
      throw new Error('late failure');
    },
  });
  const input = { userId: 'u1', event: 'Kept', properties: { email: 'a@b.c' } };

  client.track(input);
  await client.flush();

  const [[sent]] = sentBatches(post);
  t.is(sent.userId, 'u1');
  t.is(sent.properties.email, 'a@b.c');
  t.deepEqual(sent.context, { library });
  t.deepEqual(input, { userId: 'u1', event: 'Kept', properties: { email: 'a@b.c' } });
  cleanup(client);
});

test('reserved fields: changes to channel and context.library are overwritten and warned', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      event.channel = 'web';
      event.context.library = { name: 'spoofed', version: '0.0.0' };
      event.context.tenant = 'acme';
      return event;
    },
  });

  client.track({ userId: 'u1', event: 'Kept' });
  await client.flush();

  const [[sent]] = sentBatches(post);
  t.is(sent.channel, 'server');
  t.deepEqual(sent.context, { tenant: 'acme', library });
  t.true(
    client.logger.warn.calledOnceWithExactly(
      'beforeEnqueue changed reserved fields (channel, context.library); they were restored.',
    ),
  );
  t.false(client.logger.error.called);
  cleanup(client);
});

test('reserved fields: a hook that removes context gets context.library back', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      delete event.context;
      return event;
    },
  });

  client.track({ userId: 'u1', event: 'Kept' });
  await client.flush();

  t.deepEqual(sentBatches(post)[0][0].context, { library });
  t.true(
    client.logger.warn.calledOnceWithExactly(
      'beforeEnqueue changed reserved fields (context.library); they were restored.',
    ),
  );
  cleanup(client);
});

const invalidEdits = [
  ['track', { userId: 'u1', event: 'E' }, (e) => delete e.userId],
  ['track', { userId: 'u1', event: 'E' }, (e) => delete e.event],
  ['identify', { anonymousId: 'a1' }, (e) => delete e.anonymousId],
  ['group', { userId: 'u1', groupId: 'g1' }, (e) => delete e.groupId],
  ['alias', { userId: 'u1', previousId: 'p1' }, (e) => delete e.previousId],
  ['page', { userId: 'u1' }, (e) => (e.context = 'not an object')],
];

test('post-hook validation: an event failing per-type rules is a hook error', async (t) => {
  for (const [type, input, edit] of invalidEdits) {
    const { client, post } = createClient({
      beforeEnqueue: (event) => {
        edit(event);
        return event;
      },
    });
    client[type](input);
    await client.flush();
    const [[sent]] = sentBatches(post);
    t.like(sent, { ...input, type }, `${type}: original sent`);
    t.true(client.logger.error.calledOnce, `${type}: error logged`);
    cleanup(client);
  }
});

test('post-hook validation: with drop, an invalid event is dropped', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      delete event.userId;
      return event;
    },
    beforeEnqueueOnError: 'drop',
  });

  client.track({ userId: 'u1', event: 'E' });
  await client.flush();

  t.false(post.called);
  t.true(client.logger.error.calledOnce);
  cleanup(client);
});

test('type change: returning another type is a hook error and the original goes out as track', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => ({ ...event, type: 'identify' }),
  });

  client.track({ userId: 'u1', event: 'Kept' });
  await client.flush();

  t.is(sentBatches(post)[0][0].type, 'track');
  t.true(client.logger.error.calledOnce);
  cleanup(client);
});

test("size: a hook that grows the event past 32KB is a hook error; 'send' sends the original", async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      event.properties.blob = 'a'.repeat(33 * 1024);
      return event;
    },
  });

  client.track({ userId: 'u1', event: 'Big', properties: {} });
  await client.flush();

  t.deepEqual(sentBatches(post)[0][0].properties, {});
  t.true(client.logger.error.calledOnce);
  t.regex(
    client.logger.error.firstCall.args[0],
    /, sending the original event\. AssertionError \[ERR_ASSERTION\]: Your message must be < 32kb\.$/,
  );
  t.false(client.logger.info.called);
  cleanup(client);
});

test("size: a hook that grows the event past 32KB drops it with 'drop'", async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      event.properties.blob = 'a'.repeat(33 * 1024);
      return event;
    },
    beforeEnqueueOnError: 'drop',
  });

  client.track({ userId: 'u1', event: 'Big', properties: {} });
  await client.flush();

  t.false(post.called);
  t.true(client.logger.error.calledOnce);
  cleanup(client);
});

test('size: an oversized event passed through unchanged falls back to the usual handling', async (t) => {
  const { client, post } = createClient({ beforeEnqueue: (event) => event });

  client.track({ userId: 'u1', event: 'Big', properties: { blob: 'a'.repeat(33 * 1024) } });
  await client.flush();

  t.is(sentBatches(post)[0][0].properties.blob.length, 33 * 1024);
  t.true(client.logger.error.calledOnce);
  t.true(client.logger.info.calledOnceWithExactly(SIZE_WARNING));
  cleanup(client);
});

test('size: an oversized input trimmed by the hook is not warned about', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      delete event.properties.blob;
      return event;
    },
  });

  client.track({ userId: 'u1', event: 'Big', properties: { blob: 'a'.repeat(33 * 1024) } });
  await client.flush();

  t.deepEqual(sentBatches(post)[0][0].properties, {});
  t.false(client.logger.info.called);
  cleanup(client);
});

test('size: an oversized original sent after a hook error is warned about', async (t) => {
  const { client } = createClient({
    beforeEnqueue: () => {
      throw new Error('boom');
    },
  });

  client.track({ userId: 'u1', event: 'Big', properties: { blob: 'a'.repeat(33 * 1024) } });

  t.true(client.logger.info.calledOnceWithExactly(SIZE_WARNING));
  t.is(client.queue.length, 1);
  cleanup(client);
});

test('once per event: a retried request does not call the hook again', async (t) => {
  let attempts = 0;
  const beforeEnqueue = spy((event) => event);
  const client = new Analytics('key', {
    dataPlaneUrl: 'http://localhost:4065',
    logLevel: 'none',
    gzip: false,
    retryCount: 2,
    axiosRetryConfig: { retryDelay: () => 0 },
    axiosConfig: {
      adapter: async (config) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('Service Unavailable');
          error.config = config;
          error.response = { status: 503, statusText: 'Service Unavailable', config, headers: {} };
          throw error;
        }
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      },
    },
    beforeEnqueue,
  });
  client.flushed = true;

  client.track({ userId: 'u1', event: 'Retried' });
  await client.flush();

  t.is(attempts, 2);
  t.true(beforeEnqueue.calledOnce);
  cleanup(client);
});

test('once per event: a persistent-queue replay does not call the hook again', async (t) => {
  const beforeEnqueue = spy((event) => {
    event.properties.edited = true;
    return event;
  });
  const { client, post } = createClient({ beforeEnqueue });
  const jobs = [];
  let processor;
  client.pQueue = {
    add: async (job) => {
      jobs.push(job);
    },
    on: () => {},
    process: (fn) => {
      processor = fn;
    },
  };
  client.pQueueInitialized = true;
  client.addPersistentQueueProcessor();

  client.track({ userId: 'u1', event: 'Persisted', properties: {} });
  await client.flush();
  t.is(jobs.length, 1);
  t.false(post.called);

  // The bull worker replays the stored request without touching the hook
  const done = spy();
  processor({ data: jobs[0] }, done);
  await setTimeout(1100);

  t.true(done.calledOnce);
  t.true(beforeEnqueue.calledOnce);
  const [[sent]] = sentBatches(post);
  t.true(sent.properties.edited);
  cleanup(client);
});

test('no hook: the queued event matches what an identity hook produces', (t) => {
  const input = {
    userId: 'u1',
    event: 'Same',
    messageId: 'm1',
    originalTimestamp: new Date(0),
    timestamp: new Date(1000),
    properties: { a: 1 },
  };
  const { client: plain } = createClient();
  const { client: hooked } = createClient({ beforeEnqueue: (event) => event });
  t.teardown(() => {
    cleanup(plain);
    cleanup(hooked);
  });

  plain.track(input);
  hooked.track(input);

  // The JSON round-trip preserves the wire JSON.
  t.is(JSON.stringify(hooked.queue[0].message), JSON.stringify(plain.queue[0].message));
  t.false(hooked.logger.warn.called);
  t.false(hooked.logger.error.called);
  cleanup(plain);
  cleanup(hooked);
});

test('ids: numeric userId and anonymousId set by the hook are sent as strings, as without a hook', async (t) => {
  const { client, post } = createClient({
    beforeEnqueue: (event) => ({ ...event, userId: 42, anonymousId: 7 }),
  });
  const { client: plain } = createClient();

  client.track({ userId: 'u1', event: 'E' });
  plain.track({ userId: 42, anonymousId: 7, event: 'E' });
  await client.flush();

  const [[sent]] = sentBatches(post);
  t.is(sent.userId, '42');
  t.is(sent.anonymousId, '7');
  t.is(sent.userId, plain.queue[0].message.userId);
  t.is(sent.anonymousId, plain.queue[0].message.anonymousId);
  t.false(client.logger.error.called);
  cleanup(client);
  cleanup(plain);
});

test('no hook: an oversized event logs the existing warning without the message', (t) => {
  const { client } = createClient();
  const input = { userId: 'u1', event: 'Big', properties: { blob: 'a'.repeat(33 * 1024) } };

  client.track(input);

  t.true(client.logger.info.calledOnceWithExactly(SIZE_WARNING));
  t.is(client.queue.length, 1);
  cleanup(client);
});

test('disabled client: the hook is not called', (t) => {
  const beforeEnqueue = spy((event) => event);
  const { client } = createClient({ beforeEnqueue, enable: false });

  client.track({ userId: 'u1', event: 'Off' });

  t.false(beforeEnqueue.called);
  cleanup(client);
});

test('full internal queue: the event is dropped before the hook runs', (t) => {
  const beforeEnqueue = spy((event) => event);
  const { client } = createClient({ beforeEnqueue, maxInternalQueueSize: 1 });

  client.track({ userId: 'u1', event: 'First' });
  client.track({ userId: 'u1', event: 'Second' });

  t.true(beforeEnqueue.calledOnce);
  t.is(client.queue.length, 1);
  cleanup(client);
});

test('options: an unknown beforeEnqueueOnError value fails at construction', (t) => {
  const error = t.throws(
    () => new Analytics('key', { beforeEnqueue: (event) => event, beforeEnqueueOnError: 'Drop' }),
    { instanceOf: AssertionError },
  );
  t.is(error.message, "beforeEnqueueOnError must be 'send' or 'drop'.");
});

test('options: a non-function beforeEnqueue fails at construction', (t) => {
  const error = t.throws(() => new Analytics('key', { beforeEnqueue: 'nope' }), {
    instanceOf: AssertionError,
  });
  t.is(error.message, 'beforeEnqueue must be a function.');
});

test('options: a null beforeEnqueue means no hook', (t) => {
  const { client } = createClient({ beforeEnqueue: null, beforeEnqueueOnError: null });
  t.is(client.beforeEnqueue, undefined);
  t.is(client.beforeEnqueueOnError, 'send');
  cleanup(client);
});

test('messageId: a changed or removed messageId is kept without a warning', async (t) => {
  for (const [edit, expected] of [
    [(e) => (e.messageId = 'spoofed'), 'spoofed'],
    [(e) => delete e.messageId, undefined],
  ]) {
    const { client, post } = createClient({
      beforeEnqueue: (event) => {
        edit(event);
        return event;
      },
    });
    t.teardown(() => cleanup(client));
    client.track({ userId: 'u1', event: 'Kept', messageId: 'm1' });
    await client.flush();
    const [[sent]] = sentBatches(post);
    t.is(sent.messageId, expected);
    t.is('messageId' in sent, expected !== undefined);
    t.false(client.logger.warn.called);
    t.false(client.logger.error.called);
    cleanup(client);
  }
});

for (const beforeEnqueueOnError of ['send', 'drop']) {
  test(`wire form: a toJSON that serializes to another event is a hook error ('${beforeEnqueueOnError}')`, async (t) => {
    const { client, post } = createClient({
      beforeEnqueueOnError,
      beforeEnqueue: (event) => ({
        ...event,
        toJSON: () => ({ type: 'identify', messageId: 'other', channel: 'web' }),
      }),
    });

    client.track({ userId: 'u1', event: 'Kept', messageId: 'm1' });
    await client.flush();

    t.true(client.logger.error.calledOnce);
    if (beforeEnqueueOnError === 'drop') {
      t.false(post.called);
    } else {
      const [[sent]] = sentBatches(post);
      t.like(sent, {
        type: 'track',
        event: 'Kept',
        userId: 'u1',
        messageId: 'm1',
        channel: 'server',
      });
    }
    cleanup(client);
  });
}

test('wire form: the hook result is serialized once and its messageId is kept', async (t) => {
  const toJSON = spy(function toJSON() {
    return {
      type: this.type,
      userId: this.userId,
      event: this.event,
      messageId: 'other',
      channel: this.channel,
      context: this.context,
      properties: { edited: true },
    };
  });
  const { client, post } = createClient({ beforeEnqueue: (event) => ({ ...event, toJSON }) });

  client.track({ userId: 'u1', event: 'Kept', messageId: 'm1' });
  await client.flush();

  const [[sent]] = sentBatches(post);
  t.like(sent, { messageId: 'other', properties: { edited: true } });
  t.true(toJSON.calledOnce);
  t.false(client.logger.warn.called);
  cleanup(client);
});

for (const beforeEnqueueOnError of ['send', 'drop']) {
  test(`wire form: a timestamp getter is read once and sent as its ISO string ('${beforeEnqueueOnError}')`, async (t) => {
    let reads = 0;
    const { client, post } = createClient({
      beforeEnqueueOnError,
      beforeEnqueue: (event) =>
        Object.defineProperty({ ...event }, 'timestamp', {
          enumerable: true,
          get: () => {
            reads += 1;
            return reads === 1 ? new Date(1000) : 'not a date';
          },
        }),
    });

    client.track({ userId: 'u1', event: 'Kept', messageId: 'm1' });
    await client.flush();

    t.is(reads, 1);
    t.false(client.logger.error.called);
    const [[sent]] = sentBatches(post);
    t.is(sent.timestamp, new Date(1000).toISOString());
    cleanup(client);
  });
}

const SECRET = 'secret-pii-value';
test('messageId: a reused hook result keeps its ID without changing an event already queued', async (t) => {
  let first;
  const { client, post } = createClient({
    beforeEnqueue: (event) => {
      first = first || event;
      return first;
    },
  });

  client.track({ userId: 'u1', event: 'Kept', messageId: 'm1' });
  const firstQueued = client.queue[0].message;
  client.track({ userId: 'u1', event: 'Kept', messageId: 'm2' });
  t.is(client.queue[0].message, firstQueued);
  t.not(client.queue[1].message, firstQueued);
  await client.flush();

  t.deepEqual(
    sentBatches(post)[0].map((sent) => sent.messageId),
    ['m1', 'm1'],
  );
  t.is(first.messageId, 'm1');
  t.false(client.logger.warn.called);
  cleanup(client);
});

for (const beforeEnqueueOnError of ['send', 'drop']) {
  test(`reserved fields: a frozen redacted result without context is sent with context.library ('${beforeEnqueueOnError}')`, async (t) => {
    const clock = Sinon.useFakeTimers({
      now: Date.parse('2026-10-23T10:00:00.000Z'),
      toFake: ['Date'],
    });
    t.teardown(() => clock.restore());
    const { client, post } = createClient({
      beforeEnqueueOnError,
      beforeEnqueue: (event) => {
        delete event.context;
        return Object.freeze({ ...event, properties: Object.freeze({}) });
      },
    });

    const { client: plain, post: baselinePost } = createClient();
    t.teardown(() => {
      cleanup(client);
      cleanup(plain);
    });
    const fields = { userId: 'u1', event: 'Kept', messageId: 'm1', properties: { email: SECRET } };
    client.track(fields);
    plain.track(fields);
    await client.flush();
    await plain.flush();

    const expected = JSON.parse(JSON.stringify(baselinePost.firstCall.args[1]));
    expected.batch[0].context = { library };
    expected.batch[0].properties = {};
    const request = JSON.parse(JSON.stringify(post.firstCall.args[1]));
    t.true(post.calledOnce);
    t.is(post.firstCall.args[0], baselinePost.firstCall.args[0]);
    t.deepEqual(request, expected);
    t.false(JSON.stringify(request).includes(SECRET));

    const [[sent]] = sentBatches(post);
    t.deepEqual(sent.context, { library });
    t.deepEqual(sent.properties, {});
    t.truthy(sent.sentAt);
    t.false(client.logger.error.called);
  });
}

const loggedArgs = (client) =>
  ['debug', 'info', 'warn', 'error']
    .flatMap((level) => client.logger[level].getCalls())
    .flatMap((call) => call.args)
    .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : JSON.stringify(arg)));

test('logging: a hook error message appears in the log as thrown', (t) => {
  for (const thrown of [new TypeError('bad hook value'), 'raw hook failure']) {
    for (const beforeEnqueueOnError of ['send', 'drop']) {
      const { client } = createClient({
        beforeEnqueueOnError,
        beforeEnqueue: () => {
          throw thrown;
        },
      });
      t.teardown(() => cleanup(client));
      client.track({ userId: 'u1', event: 'E', messageId: 'm1' });
      const outcome =
        beforeEnqueueOnError === 'send' ? 'sending the original event' : 'dropping the event';
      t.true(
        client.logger.error.calledOnceWithExactly(
          `beforeEnqueue failed for track event m1, ${outcome}. ${thrown}`,
        ),
      );
    }
  }
});

test('logging: a hook throwing a value whose toString throws stays inside the SDK', async (t) => {
  const toString = spy(() => {
    throw new Error('cannot stringify');
  });
  const values = [
    { toString },
    new Proxy(
      {},
      {
        get() {
          throw new Error('get trap');
        },
      },
    ),
    Object.create(null),
  ];
  for (const thrown of values) {
    for (const beforeEnqueueOnError of ['send', 'drop']) {
      const { client, post } = createClient({
        beforeEnqueueOnError,
        beforeEnqueue: () => {
          throw thrown;
        },
      });
      t.teardown(() => cleanup(client));
      const callback = spy();
      t.notThrows(() => client.track({ userId: 'u1', event: 'Kept', messageId: 'm1' }, callback));
      await client.flush();
      await setTimeout(5);
      const outcome =
        beforeEnqueueOnError === 'send' ? 'sending the original event' : 'dropping the event';
      t.true(
        client.logger.error.calledOnceWithExactly(
          `beforeEnqueue failed for track event m1, ${outcome}. object`,
        ),
      );
      t.true(callback.calledOnce);
      if (beforeEnqueueOnError === 'send') {
        t.is(callback.firstCall.args[0], undefined);
        t.is(sentBatches(post)[0][0].event, 'Kept');
      } else {
        t.deepEqual(callback.firstCall.args, []);
        t.false(post.called);
      }
    }
  }
  t.is(toString.callCount, 2);
});

test('logging: SDK beforeEnqueue lines never carry the event payload', async (t) => {
  const big = 'a'.repeat(33 * 1024);
  const hooks = [
    () => null,
    () => {
      throw new Error('boom');
    },
    (event) => ({ ...event, channel: 'web', messageId: 'x', context: {} }),
    (event) => {
      delete event.userId;
      return event;
    },
    (event) => event,
  ];
  for (const [i, beforeEnqueue] of hooks.entries()) {
    for (const beforeEnqueueOnError of ['send', 'drop']) {
      const { client } = createClient({ beforeEnqueue, beforeEnqueueOnError });
      client.track({ userId: 'u1', event: 'E', properties: { email: SECRET, big } });
      client.identify({ userId: 'u1', traits: { email: SECRET } });
      await client.flush();
      const leaks = loggedArgs(client)
        .filter((arg) => arg?.includes('beforeEnqueue'))
        .filter((arg) => arg.includes(SECRET) || arg.includes(big));
      t.deepEqual(leaks, [], `hook ${i}, ${beforeEnqueueOnError}`);
      cleanup(client);
    }
  }
});
