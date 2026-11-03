/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
const { default: test } = require('ava');
const { spy, stub, useFakeTimers } = require('sinon');
const { setImmediate: nextTurn } = require('node:timers/promises');
const Analytics = require('../src');

// Node runner for rudder-specs/sdk-architecture/sdks/llds/before-enqueue/fixtures/conformance.json.
const SIZE_WARNING =
  'Your message must be < 32kb. This is currently surfaced as a warning. Please update your code';
const input = () => ({
  userId: 7,
  event: 'Order',
  messageId: 'm1',
  properties: { total: 42 },
  context: { custom: true },
});
const wireClient = (t, options = {}, retry = false) => {
  const requests = [];
  const errorHandler = spy();
  const client = new Analytics('key', {
    dataPlaneUrl: 'http://localhost:4065',
    gzip: false,
    flushInterval: 60000,
    retryCount: retry ? 1 : 0,
    axiosRetryConfig: { retryDelay: () => 0 },
    axiosConfig: {
      adapter: async (config) => {
        requests.push({ method: config.method, url: config.url, body: config.data });
        if (retry && requests.length === 1)
          throw Object.assign(new Error('retry'), { config, response: { status: 503 } });
        return { status: 200, data: {}, headers: {}, config };
      },
    },
    errorHandler,
    ...options,
  });
  client.flushed = true;
  for (const level of ['debug', 'info', 'warn', 'error']) stub(client.logger, level);
  t.teardown(() => {
    clearTimeout(client.flushTimer);
    clearTimeout(client.timer);
  });
  return { client, requests, errorHandler };
};
const edit = (fn) => (e) => {
  fn(e);
  return e;
};
const fail = () => {
  throw new Error('boom');
};
const removeEvent = edit((e) => delete e.event);
const setTotal = (e) => (e.properties.total = 99);
const grow = (e) => (e.properties.blob = 'x'.repeat(33 * 1024));
const cases = [
  ['enriched_input', (e) => e, { enriched: true }],
  ['edit_reaches_wire', edit(setTotal), { expected: setTotal }],
  ['null_drop', () => null, { none: true, level: 'debug' }],
  ['throw_send_original', fail, { level: 'error', thrown: true }],
  ['throw_drop_none', fail, { policy: 'drop', none: true, level: 'error', thrown: true }],
  [
    'mutate_then_throw_isolated',
    (e) => {
      e.properties.total = 99;
      e.context.custom = false;
      fail();
    },
    { level: 'error', thrown: true },
  ],
  ['non_object_hook_error', () => 42, { level: 'error' }],
  ['required_field_hook_error', removeEvent, { level: 'error' }],
  ['required_field_hook_error_drop', removeEvent, { policy: 'drop', none: true, level: 'error' }],
  ['hook_fixes_invalid_call', edit((e) => (e.event = 'Order')), { invalidCall: true }],
  ['restore_channel', edit((e) => (e.channel = 'web')), { level: 'warn' }],
  ['restore_context_library', edit((e) => (e.context.library = {})), { level: 'warn' }],
  [
    'keep_messageid_change',
    edit((e) => (e.messageId = 'm2')),
    {
      expected: (e) => (e.messageId = 'm2'),
    },
  ],
  ['restore_removed_messageid', edit((e) => delete e.messageId)],
  ['post_hook_oversize_warns', edit(grow), { expected: grow, level: 'info' }],
  ['cyclic_output_hook_error', edit((e) => (e.properties.self = e)), { level: 'error' }],
  ['once_across_retries', (e) => e, { retry: true }],
  ['no_hook_unchanged'],
  ['invalid_hook_config', undefined, { config: { beforeEnqueue: 42 } }],
  ['invalid_policy_config', undefined, { config: { beforeEnqueueOnError: 'retry' } }],
];

for (const [id, hookFunction, settings] of cases) {
  const scenario = { id, hook: hookFunction, ...settings };
  test(`conformance: ${scenario.id}`, async (t) => {
    if (scenario.config) {
      t.throws(() => new Analytics('key', scenario.config), { name: 'AssertionError' });
      return;
    }
    const clock = useFakeTimers({ now: Date.parse('2026-10-23T10:00:00Z'), toFake: ['Date'] });
    t.teardown(() => clock.restore());
    const baseline = wireClient(t);
    baseline.client.track(input());
    const enriched = JSON.parse(JSON.stringify(baseline.client.queue[0].message));
    await baseline.client.flush();
    const expected = JSON.parse(baseline.requests[0].body);
    if (scenario.expected) scenario.expected(expected.batch[0]);
    const hook =
      scenario.hook &&
      spy((e) => {
        if (scenario.enriched) {
          t.deepEqual(JSON.parse(JSON.stringify(e)), enriched);
          t.true(e.originalTimestamp instanceof Date);
          t.is(e.userId, '7');
          t.deepEqual(e._metadata, { nodeVersion: process.versions.node });
        }
        return scenario.hook(e);
      });
    const actual = wireClient(
      t,
      {
        beforeEnqueue: hook,
        beforeEnqueueOnError: scenario.policy,
      },
      scenario.retry,
    );
    const fields = input();
    if (scenario.invalidCall) delete fields.event;
    const snapshot = JSON.parse(JSON.stringify(fields));
    const callback = spy();
    t.is(actual.client.track(fields, callback), actual.client);
    const queued = actual.client.queue[0]?.message;
    await actual.client.flush();
    await nextTurn();
    t.is(hook ? hook.callCount : 0, hook ? 1 : 0);
    t.deepEqual(fields, snapshot);
    t.false(actual.errorHandler.called);
    t.true(callback.calledOnce);
    t.is(actual.requests.length, scenario.none ? 0 : scenario.retry ? 2 : 1);
    if (scenario.none) t.true(callback.calledOnceWithExactly());
    for (const request of actual.requests) {
      t.is(request.method, baseline.requests[0].method);
      t.is(request.url, baseline.requests[0].url);
      t.deepEqual(JSON.parse(request.body), expected);
    }
    if (scenario.id === 'no_hook_unchanged')
      t.is(actual.requests[0].body, baseline.requests[0].body);
    for (const level of ['debug', 'info', 'warn', 'error']) {
      const logs = actual.client.logger[level]
        .getCalls()
        .filter(
          (call) => !['debug', 'error'].includes(level) || call.args[0].startsWith('beforeEnqueue'),
        );
      t.is(logs.length, level === scenario.level ? 1 : 0);
    }
    if (scenario.level === 'debug')
      t.true(actual.client.logger.debug.calledWithExactly('beforeEnqueue dropped track event m1'));
    if (scenario.level === 'warn')
      t.true(
        actual.client.logger.warn.calledOnceWithExactly(
          'beforeEnqueue changed channel or context.library; they were restored.',
        ),
      );
    if (scenario.level === 'info')
      t.true(actual.client.logger.info.calledOnceWithExactly(SIZE_WARNING, queued));
    if (scenario.level === 'error') {
      const outcome = scenario.none ? 'dropping the event' : 'sending the original event';
      const prefix = `beforeEnqueue failed for track event m1, ${outcome}. `;
      t.true(actual.client.logger.error.firstCall.args[0].startsWith(prefix));
      if (scenario.thrown)
        t.is(actual.client.logger.error.firstCall.args[0], `${prefix}Error: boom`);
    }
  });
}
