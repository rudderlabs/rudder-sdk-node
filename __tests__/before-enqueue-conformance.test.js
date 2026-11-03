/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
const { default: test } = require('ava');
const { spy, stub, useFakeTimers } = require('sinon');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { inspect } = require('node:util');
const Analytics = require('../src');
const { version } = require('../package.json');

// Node bindings of rudder-specs/sdk-architecture/sdks/llds/before-enqueue/fixtures/conformance.json.
// Compare the complete axios-serialized request against the same no-hook call. Only the
// fixture's explicit edits change that baseline; SDK envelope/metadata fields stay intact.
const MARKER = 'BE_PAYLOAD_MARKER_5704';
const INPUT_TIME = '2026-10-23T10:00:00.000Z';
const SEND_TIME = '2026-10-23T10:00:01.000Z';
const library = { name: 'analytics-node', version };
const levels = ['debug', 'info', 'warn', 'error'];
const input = () => ({
  userId: 'user-1',
  event: 'Order Completed',
  properties: { marker: MARKER, total: 42 },
  context: {
    library: { name: 'fixture-sdk', version: '1.0.0' },
    wrapperLibrary: { name: 'fixture-wrapper' },
  },
  channel: 'server',
  messageId: 'm1',
  timestamp: new Date(INPUT_TIME),
});

const wireClient = (t, options = {}, responses = [200]) => {
  const requests = [];
  const errorHandler = spy();
  const client = new Analytics('key', {
    dataPlaneUrl: 'http://localhost:4065',
    flushInterval: 60000,
    gzip: false,
    retryCount: 0,
    axiosRetryConfig: { retryDelay: () => 0 },
    axiosConfig: {
      adapter: async (config) => {
        // This is the final HTTP body, after axios transformRequest, also on retries.
        requests.push({ method: config.method, url: config.url, body: config.data });
        const status = responses[Math.min(requests.length - 1, responses.length - 1)];
        const response = { data: {}, status, statusText: String(status), headers: {}, config };
        if (status !== 200) {
          const error = new Error('Service Unavailable');
          error.config = config;
          error.response = response;
          throw error;
        }
        return response;
      },
    },
    errorHandler,
    ...options,
  });
  client.flushed = true;
  for (const level of levels) stub(client.logger, level);
  t.teardown(() => {
    clearTimeout(client.flushTimer);
    clearTimeout(client.timer);
  });
  return { client, requests, errorHandler };
};

const clockFor = (t) => {
  const clock = useFakeTimers({ now: Date.parse(INPUT_TIME), toFake: ['Date'] });
  t.teardown(() => clock.restore());
  return clock;
};

const assertSafeLogs = (t, client) => {
  for (const level of levels) {
    for (const call of client.logger[level].getCalls()) {
      t.false(inspect(call.args).includes(MARKER), `${level}: no payload in any argument`);
    }
  }
};

const assertRequest = (t, actual, expected) => {
  t.is(actual.method, expected.method);
  t.is(actual.url, expected.url);
  t.is(typeof actual.body, 'string');
  t.deepEqual(JSON.parse(actual.body), JSON.parse(expected.body));
};

const baselineFor = async (t, clock, calls) => {
  clock.setSystemTime(Date.parse(INPUT_TIME));
  const plain = wireClient(t);
  for (const [type, fields] of calls) t.is(plain.client[type](fields), plain.client);
  clock.setSystemTime(Date.parse(SEND_TIME));
  await plain.client.flush();
  t.is(plain.requests.length, 1);
  t.is(plain.requests[0].method, 'post');
  t.is(plain.requests[0].url, 'http://localhost:4065/v1/batch');
  assertSafeLogs(t, plain.client);
  return plain.requests[0];
};

const throwMarker = () => {
  throw new TypeError(MARKER);
};
const mutate = (edit) => (event) => {
  edit(event);
  return event;
};
const oversize = mutate((event) => {
  event.properties.blob = MARKER.repeat(2000);
});
const cases = [
  { id: 'enriched_input', hook: (event) => event },
  {
    id: 'enriched_input_identify',
    type: 'identify',
    fields: () => ({
      ...input(),
      userId: undefined,
      anonymousId: 7,
      event: undefined,
      traits: { marker: MARKER, plan: 'pro' },
    }),
    hook: (event) => event,
  },
  {
    id: 'isolation_non_plain_values',
    fields: () => ({
      ...input(),
      properties: {
        marker: MARKER,
        fn: () => MARKER,
        error: new Error(MARKER),
        weakMap: new WeakMap(),
      },
    }),
    hook: (event) => event,
  },
  { id: 'identity_semantically_equal', hook: (event) => event },
  { id: 'no_hook_unchanged' },
  { id: 'sent_at_ownership', hook: (event) => event },
  { id: 'no_payload_in_logs', hook: (event) => event },
  {
    id: 'edit_reaches_wire',
    hook: mutate((e) => {
      e.properties.total = 99;
    }),
    expected: (e) => {
      e.properties.total = 99;
    },
  },
  { id: 'null_drop_accepted', hook: () => null, none: true, level: 'debug' },
  { id: 'throw_send_original', hook: throwMarker, level: 'error' },
  { id: 'throw_drop_none', hook: throwMarker, policy: 'drop', none: true, level: 'error' },
  {
    id: 'mutate_then_throw_isolated',
    hook: (e) => {
      e.properties.total = 99;
      e.context.wrapperLibrary.name = MARKER;
      throwMarker();
    },
    level: 'error',
  },
  { id: 'wrong_shape_hook_error', hook: () => 42, level: 'error' },
  {
    id: 'type_change_hook_error',
    hook: mutate((e) => {
      e.type = MARKER;
    }),
    level: 'error',
  },
  ...['messageId', 'channel', 'context.library'].flatMap((field) =>
    ['change', 'remove'].map((operation) => ({
      id: `restore_${operation === 'remove' ? 'removed_' : ''}${field === 'messageId' ? 'messageid' : field.replace('.', '_')}`,
      hook: mutate((e) => {
        const object = field === 'context.library' ? e.context : e;
        const key = field === 'context.library' ? 'library' : field;
        if (operation === 'remove') delete object[key];
        else object[key] = MARKER;
      }),
      level: 'warn',
      field,
    })),
  ),
  {
    id: 'removed_context_recreated',
    hook: mutate((e) => {
      delete e.context;
    }),
    expected: (e) => {
      e.context = { library };
    },
    level: 'warn',
    field: 'context.library',
  },
  {
    id: 'identity_fields_revalidated',
    hook: mutate((e) => {
      delete e.userId;
      delete e.anonymousId;
    }),
    level: 'error',
  },
  {
    id: 'required_track_field',
    hook: mutate((e) => {
      delete e.event;
    }),
    level: 'error',
  },
  {
    id: 'required_group_field',
    type: 'group',
    fields: () => ({
      ...input(),
      event: undefined,
      groupId: 'required-value',
      properties: {},
      traits: { marker: MARKER },
    }),
    hook: mutate((e) => {
      delete e.groupId;
    }),
    level: 'error',
  },
  {
    id: 'required_alias_field',
    type: 'alias',
    fields: () => ({
      ...input(),
      userId: 'user-2',
      event: undefined,
      previousId: 'required-value',
      properties: {},
      traits: {},
    }),
    hook: mutate((e) => {
      delete e.previousId;
    }),
    level: 'error',
  },
  { id: 'post_hook_oversize', hook: oversize, level: 'error' },
  { id: 'post_hook_oversize_drop', hook: oversize, policy: 'drop', none: true, level: 'error' },
  {
    id: 'unserialisable_output',
    hook: mutate((e) => {
      e.properties.bad = BigInt(1);
    }),
    level: 'error',
  },
  {
    id: 'container_type_violation',
    hook: mutate((e) => {
      e.context = MARKER;
    }),
    level: 'error',
  },
  {
    id: 'exception_text_not_logged',
    hook: () => {
      throw Object.assign(new TypeError(MARKER), { name: MARKER });
    },
    level: 'error',
  },
  {
    id: 'output_normalisation',
    hook: mutate((e) => {
      e.userId = 42;
      e.anonymousId = 7;
    }),
    expected: (e) => {
      e.userId = '42';
      e.anonymousId = '7';
    },
  },
  {
    id: 'shared_acyclic_input',
    fields: () => {
      const fields = input();
      const shared = { marker: MARKER };
      fields.properties.a = shared;
      fields.properties.b = shared;
      return fields;
    },
    hook: (e) => e,
  },
];

for (const scenario of cases) {
  test(`conformance: ${scenario.id}`, async (t) => {
    const clock = clockFor(t);
    const fields = (scenario.fields || input)();
    const callerSnapshot = inspect(fields);
    const type = scenario.type || 'track';
    const baseline = await baselineFor(t, clock, [[type, fields]]);
    const expected = JSON.parse(baseline.body);
    if (scenario.expected) scenario.expected(expected.batch[0]);
    clock.setSystemTime(Date.parse(INPUT_TIME));
    const hook =
      scenario.hook &&
      spy((event) => {
        if (scenario.id.startsWith('enriched_input')) {
          const enriched = JSON.parse(baseline.body).batch[0];
          delete enriched.sentAt;
          t.deepEqual(JSON.parse(JSON.stringify(event)), enriched);
          t.true(event.originalTimestamp instanceof Date);
          t.false('sentAt' in event);
        }
        if (scenario.id === 'isolation_non_plain_values') {
          t.not(event.properties, fields.properties);
          for (const field of ['fn', 'error', 'weakMap'])
            t.is(event.properties[field], fields.properties[field]);
        }
        if (scenario.id === 'shared_acyclic_input') {
          t.is(event.properties.a, event.properties.b);
          t.not(event.properties.a, fields.properties.a);
        }
        return scenario.hook(event);
      });
    const actual = wireClient(t, { beforeEnqueue: hook, beforeEnqueueOnError: scenario.policy });
    const callback = spy();
    t.is(actual.client[type](fields, callback), actual.client);
    clock.setSystemTime(Date.parse(SEND_TIME));
    await actual.client.flush();
    await nextTurn();
    t.is(hook ? hook.callCount : 0, hook ? 1 : 0);
    t.is(inspect(fields), callerSnapshot);
    t.false(actual.errorHandler.called);
    t.true(callback.calledOnce);
    if (scenario.none) {
      t.deepEqual(actual.requests, []);
      t.deepEqual(callback.firstCall.args, []);
    } else {
      t.is(actual.requests.length, 1);
      assertRequest(t, actual.requests[0], { ...baseline, body: JSON.stringify(expected) });
      if (scenario.id === 'no_hook_unchanged') t.is(actual.requests[0].body, baseline.body);
    }
    for (const level of levels) {
      t.is(
        actual.client.logger[level]
          .getCalls()
          .filter((call) => level !== 'debug' || call.args[0].startsWith('beforeEnqueue')).length,
        level === scenario.level ? 1 : 0,
      );
    }
    if (scenario.field)
      t.true(
        actual.client.logger.warn.calledOnceWithExactly(
          `beforeEnqueue changed the reserved field "${scenario.field}"; it was restored.`,
        ),
      );
    assertSafeLogs(t, actual.client);
  });
}

// NODE-BE-46: the public validator rejects a caller cycle before enqueue. The shared
// fixture requires a separate cycle assertion at the enriched-input copy boundary.
test('conformance: cyclic_input_hook_error (NODE-BE-46)', async (t) => {
  clockFor(t);
  const callerCycle = input();
  callerCycle.properties.self = callerCycle.properties;
  const actual = wireClient(t, { beforeEnqueueOnError: 'drop', beforeEnqueue: (e) => e });
  const callback = spy();
  t.throws(() => actual.client.track(callerCycle, callback), { instanceOf: TypeError });
  t.false(callback.called);
  const originalBeforeEnqueue = actual.client._beforeEnqueue.bind(actual.client);
  stub(actual.client, '_beforeEnqueue').callsFake((type, enriched) => {
    enriched.properties.self = enriched.properties;
    return originalBeforeEnqueue(type, enriched);
  });
  const fields = input();
  const callerSnapshot = inspect(fields);
  const hook = spy((e) => {
    t.is(e.properties.self, e.properties);
    t.not(e.properties, fields.properties);
    return e;
  });
  actual.client.beforeEnqueue = hook;
  t.is(actual.client.track(fields, callback), actual.client);
  await actual.client.flush();
  await nextTurn();
  t.deepEqual(actual.requests, []);
  t.true(hook.calledOnce);
  t.true(callback.calledOnceWithExactly());
  t.false(actual.errorHandler.called);
  t.is(inspect(fields), callerSnapshot);
  t.is(callerCycle.properties.self, callerCycle.properties);
  t.true(
    actual.client.logger.error.calledOnceWithExactly(
      'beforeEnqueue failed for track event m1 (TypeError), dropping the event.',
    ),
  );
  assertSafeLogs(t, actual.client);
});

for (const id of [
  'retained_result_distinct_ids',
  'frozen_result_unchanged',
  'once_across_retries',
  'original_oversize_usual_handling',
]) {
  test(`conformance: ${id}`, async (t) => {
    const clock = clockFor(t);
    const fields = input();
    if (id === 'original_oversize_usual_handling') {
      // Smallest N exceeding Node's complete enriched 32KB size measure.
      const enriched = {
        ...fields,
        type: 'track',
        context: { ...fields.context, library },
        _metadata: { nodeVersion: process.versions.node },
        originalTimestamp: new Date(INPUT_TIME),
      };
      enriched.properties = { ...fields.properties, blob: '' };
      const bytes = Buffer.byteLength(JSON.stringify(enriched));
      fields.properties.blob = MARKER.repeat(Math.floor((32768 - bytes) / MARKER.length) + 1);
    }
    const calls = [['track', fields]];
    if (id === 'retained_result_distinct_ids')
      calls.push(['track', { ...fields, messageId: 'm2' }]);
    const baseline = await baselineFor(t, clock, calls);
    const expected = JSON.parse(baseline.body);
    if (id === 'once_across_retries') expected.batch[0].properties.total = 99;
    clock.setSystemTime(Date.parse(INPUT_TIME));
    let retained;
    const hook = spy((e) => {
      if (id === 'original_oversize_usual_handling') throwMarker();
      if (id === 'once_across_retries') {
        e.properties.total = 99;
        return e;
      }
      if (id === 'frozen_result_unchanged') {
        e.channel = 'web';
        Object.freeze(e.context);
        retained = Object.freeze(e);
        return retained;
      }
      retained = retained || e;
      return retained;
    });
    const actual = wireClient(
      t,
      { beforeEnqueue: hook, retryCount: id === 'once_across_retries' ? 2 : 0 },
      id === 'once_across_retries' ? [503, 200] : [200],
    );
    for (const [type, call] of calls) t.is(actual.client[type](call), actual.client);
    const retainedSnapshot = inspect(retained);
    clock.setSystemTime(Date.parse(SEND_TIME));
    await actual.client.flush();
    t.is(actual.requests.length, id === 'once_across_retries' ? 2 : 1);
    for (const request of actual.requests)
      assertRequest(t, request, { ...baseline, body: JSON.stringify(expected) });
    t.is(hook.callCount, calls.length);
    t.is(inspect(retained), retainedSnapshot);
    if (id === 'retained_result_distinct_ids') t.is(retained.messageId, 'm1');
    if (id === 'frozen_result_unchanged') t.is(retained.channel, 'web');
    if (id === 'original_oversize_usual_handling') {
      t.true(actual.client.logger.error.calledOnce);
      t.true(actual.client.logger.info.calledOnce);
    } else if (id !== 'once_across_retries') t.true(actual.client.logger.warn.calledOnce);
    t.false(actual.errorHandler.called);
    assertSafeLogs(t, actual.client);
  });
}

for (const option of ['beforeEnqueue', 'beforeEnqueueOnError']) {
  test(`conformance: invalid_${option === 'beforeEnqueue' ? 'hook' : 'policy'}_config`, (t) => {
    const requests = [];
    t.throws(
      () =>
        new Analytics('key', {
          [option]: MARKER,
          axiosConfig: {
            adapter: (config) => {
              requests.push(config);
            },
          },
        }),
      { name: 'AssertionError' },
    );
    t.deepEqual(requests, []);
  });
}

for (const beforeEnqueue of [undefined, (event) => event]) {
  test(`logging: delivery diagnostics never contain payload (${beforeEnqueue ? 'hook' : 'no hook'})`, async (t) => {
    const clock = clockFor(t);
    const fields = input();
    const baseline = await baselineFor(t, clock, [['track', fields]]);
    clock.setSystemTime(Date.parse(INPUT_TIME));
    const actual = wireClient(t, { beforeEnqueue, retryCount: 1 });
    const requests = [];
    actual.client.axiosInstance.defaults.adapter = async (config) => {
      requests.push({ method: config.method, url: config.url, body: config.data });
      const error = Object.assign(new TypeError(MARKER), {
        config,
        code: MARKER,
        response: { status: 400, statusText: MARKER, config, headers: {} },
      });
      throw error;
    };
    actual.client.track(fields);
    clock.setSystemTime(Date.parse(SEND_TIME));
    await actual.client.flush();
    t.is(requests.length, 1);
    assertRequest(t, requests[0], baseline);
    t.true(actual.errorHandler.calledOnce);
    assertSafeLogs(t, actual.client);

    const events = {};
    actual.client.pQueue = {
      on: (event, fn) => {
        events[event] = fn;
      },
      process: () => {},
    };
    actual.client.addPersistentQueueProcessor();
    const job = {
      data: actual.client._getDataForPersistenceQueue({
        description: 'node-fixed-job',
        request: JSON.parse(baseline.body),
      }),
    };
    events.failed(job, new TypeError(MARKER));
    events.completed(job, MARKER);
    actual.client._deserializeJobData({ data: { version: 3, eventData: MARKER } });
    assertSafeLogs(t, actual.client);
  });
}
