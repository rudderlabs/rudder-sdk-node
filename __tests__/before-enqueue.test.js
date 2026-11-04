/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
const { default: test } = require('ava');
const { spy, stub, useFakeTimers } = require('sinon');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { spawnSync } = require('node:child_process');
const Analytics = require('../src');
const { version } = require('../package.json');

const library = { name: 'analytics-node', version };
const SIZE_WARNING =
  'Your message must be < 32kb. This is currently surfaced as a warning. Please update your code';
const input = () => ({ userId: 'u1', event: 'Order', messageId: 'm1', properties: { total: 42 } });
const createClient = (t, options = {}) => {
  const errorHandler = spy();
  const client = new Analytics('key', {
    dataPlaneUrl: 'http://localhost:4065',
    gzip: false,
    flushInterval: 60000,
    retryCount: 0,
    errorHandler,
    ...options,
  });
  client.flushed = true;
  for (const level of ['debug', 'info', 'warn', 'error']) stub(client.logger, level);
  const post = stub(client.axiosInstance, 'post').resolves({ status: 200 });
  t.teardown(() => {
    clearTimeout(client.flushTimer);
    clearTimeout(client.timer);
  });
  return { client, post, errorHandler };
};
const sent = (post) => post.firstCall.args[1].batch[0];

test('edit reaches the wire', async (t) => {
  const { client, post } = createClient(t, {
    beforeEnqueue: (e) => ({ ...e, properties: { total: 99 } }),
  });
  client.track(input());
  await client.flush();
  t.true(post.calledOnce);
  t.is(sent(post).properties.total, 99);
});

for (const policy of ['send', 'drop']) {
  test(`event-shaped thenable is a hook error under ${policy} policy`, async (t) => {
    const { client, post } = createClient(t, {
      beforeEnqueueOnError: policy,
      beforeEnqueue: (e) => ({ ...e, properties: { total: 99 }, then: (resolve) => resolve() }),
    });
    client.track(input());
    await client.flush();
    t.is(post.callCount, policy === 'send' ? 1 : 0);
    if (policy === 'send') t.is(sent(post).properties.total, 42);
    t.true(client.logger.error.calledOnce);
  });
}

test('null drops the event and calls the callback without an error', async (t) => {
  const { client, post, errorHandler } = createClient(t, { beforeEnqueue: () => null });
  const callback = spy();
  t.is(client.track(input(), callback), client);
  await client.flush();
  await nextTurn();
  t.false(post.called);
  t.true(callback.calledOnceWithExactly());
  t.true(client.logger.debug.calledWithExactly('beforeEnqueue dropped track event m1'));
  t.false(errorHandler.called);
});

for (const policy of ['send', 'drop']) {
  test(`throw follows ${policy} policy`, async (t) => {
    const { client, post, errorHandler } = createClient(t, {
      beforeEnqueueOnError: policy,
      beforeEnqueue: () => {
        throw new Error('boom');
      },
    });
    const callback = spy();
    client.track(input(), callback);
    await client.flush();
    await nextTurn();
    t.is(post.callCount, policy === 'send' ? 1 : 0);
    if (policy === 'send') t.like(sent(post), input());
    else t.true(callback.calledOnceWithExactly());
    const outcome = policy === 'send' ? 'sending the original event' : 'dropping the event';
    t.true(
      client.logger.error.calledOnceWithExactly(
        `beforeEnqueue failed for track event m1, ${outcome}. Error: boom`,
      ),
    );
    t.false(errorHandler.called);
  });
}

test('non-object result is a hook error', async (t) => {
  const { client, post, errorHandler } = createClient(t, { beforeEnqueue: () => 42 });
  client.track(input());
  await client.flush();
  t.like(sent(post), input());
  t.true(client.logger.error.calledOnce);
  t.false(errorHandler.called);
});

test('validation failure follows send and drop policies', async (t) => {
  for (const policy of ['send', 'drop']) {
    const { client, post, errorHandler } = createClient(t, {
      beforeEnqueueOnError: policy,
      beforeEnqueue: (e) => {
        delete e.event;
        return e;
      },
    });
    client.track(input());
    await client.flush();
    t.is(post.callCount, policy === 'send' ? 1 : 0);
    if (policy === 'send') t.like(sent(post), input());
    t.true(client.logger.error.calledOnce);
    t.false(errorHandler.called);
  }
});

test('a changed type is validated by its own rules', async (t) => {
  const { client, post } = createClient(t, { beforeEnqueue: (e) => ({ ...e, type: 'track' }) });
  client.page({ userId: 'u1', name: 'Home' });
  await client.flush();
  t.is(sent(post).type, 'page');
  t.true(client.logger.error.calledOnce);
});

test('hook can fix an invalid call', async (t) => {
  const { client, post } = createClient(t, { beforeEnqueue: (e) => ({ ...e, event: 'Fixed' }) });
  t.notThrows(() => client.track({ userId: 'u1' }));
  await client.flush();
  t.is(sent(post).event, 'Fixed');
  t.false(client.logger.error.called);
});

test('channel and context.library are restored with one warning', async (t) => {
  const { client, post } = createClient(t, {
    beforeEnqueue: (e) => ({ ...e, channel: 'web', context: { library: {}, custom: true } }),
  });
  client.track(input());
  await client.flush();
  t.is(sent(post).channel, 'server');
  t.deepEqual(sent(post).context, { library, custom: true });
  t.true(
    client.logger.warn.calledOnceWithExactly(
      'beforeEnqueue changed channel or context.library; they were restored.',
    ),
  );
});

test('changed messageId is kept; missing or empty messageId is restored silently', async (t) => {
  for (const value of ['m2', undefined, '']) {
    const { client, post } = createClient(t, {
      beforeEnqueue: (e) => {
        if (value === undefined) delete e.messageId;
        else e.messageId = value;
        return e;
      },
    });
    client.track(input());
    await client.flush();
    t.is(sent(post).messageId, value || 'm1');
    t.false(client.logger.warn.called);
    t.false(client.logger.error.called);
  }
});

test('oversized result is sent with the usual size warning and message', async (t) => {
  const { client, post } = createClient(t, {
    beforeEnqueue: (e) => ({ ...e, properties: { blob: 'x'.repeat(33 * 1024) } }),
  });
  client.track(input());
  const queued = client.queue[0].message;
  t.true(client.logger.info.calledOnceWithExactly(SIZE_WARNING, queued));
  await client.flush();
  t.is(sent(post).properties.blob.length, 33 * 1024);
  t.false(client.logger.error.called);
});

test('hook runs once across HTTP retries', async (t) => {
  const hook = spy((e) => e);
  const { client, post } = createClient(t, {
    beforeEnqueue: hook,
    retryCount: 1,
    axiosRetryConfig: { retryDelay: () => 0 },
  });
  post.restore();
  const requests = [];
  client.axiosInstance.defaults.adapter = async (config) => {
    requests.push(config.data);
    if (requests.length === 1)
      throw Object.assign(new Error('retry'), { config, response: { status: 503 } });
    return { status: 200, data: {}, headers: {}, config };
  };
  client.track(input());
  await client.flush();
  t.is(requests.length, 2);
  t.is(requests[0], requests[1]);
  t.true(hook.calledOnce);
});

test('async rejection is contained under strict unhandled rejection handling', (t) => {
  const result = spawnSync(
    process.execPath,
    [
      '--unhandled-rejections=strict',
      '-e',
      `
    const assert = require('node:assert/strict');
    const Analytics = require(${JSON.stringify(require.resolve('../src'))});
    const client = new Analytics('key', { beforeEnqueue: async () => { throw Error('async'); } });
    client.flushed = true;
    client.logger.error = () => {};
    client.track({ userId: 'u1', event: 'Order' });
    clearTimeout(client.flushTimer);
    clearTimeout(client.timer);
    assert.equal(client.queue.length, 1);
    setImmediate(() => console.log('contained'));
  `,
    ],
    { encoding: 'utf8', timeout: 3000 },
  );
  t.is(result.error, undefined);
  t.is(result.status, 0, result.stderr);
  t.is(result.stdout.trim(), 'contained');
});

test('option validation', (t) => {
  for (const beforeEnqueue of [42, 'hook', {}])
    t.throws(() => new Analytics('key', { beforeEnqueue }), { name: 'AssertionError' });
  t.throws(() => new Analytics('key', { beforeEnqueueOnError: 'retry' }), {
    name: 'AssertionError',
  });
  for (const beforeEnqueue of [undefined, null, (e) => e])
    t.notThrows(() => createClient(t, { beforeEnqueue }));
});

test('without a hook, validation and delivery are unchanged', async (t) => {
  const clock = useFakeTimers({ toFake: ['Date'] });
  t.teardown(() => clock.restore());
  const plain = createClient(t);
  const hooked = createClient(t, { beforeEnqueue: (e) => e });
  t.throws(() => plain.client.track({ userId: 'u1' }), { message: 'You must pass an "event".' });
  plain.client.track(input());
  hooked.client.track(input());
  await plain.client.flush();
  await hooked.client.flush();
  t.deepEqual(plain.post.firstCall.args, hooked.post.firstCall.args);
});
