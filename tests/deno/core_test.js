/* eslint-disable compat/compat, unicorn/filename-case */
/* global Deno */
import assert from 'node:assert/strict';
// The generated Deno import map resolves this package to the extracted artifact.
// eslint-disable-next-line import-x/no-unresolved
import Analytics from '@rudderstack/rudder-sdk-node';

const WRITE_KEY = 'deno-test-write-key';

function decodeBody(request) {
  if (request.headers.get('content-encoding') !== 'gzip') {
    return request.json();
  }

  return new Response(request.body.pipeThrough(new DecompressionStream('gzip'))).json();
}

function createReceiver(respond = () => new Response(null, { status: 200 })) {
  const requests = [];
  const server = Deno.serve(
    {
      hostname: '127.0.0.1',
      onListen: () => {},
      port: 0,
    },
    async (request) => {
      const body = await decodeBody(request);
      requests.push({ body, headers: request.headers, url: new URL(request.url) });
      return respond(requests.length, body);
    },
  );

  return {
    requests,
    url: `http://${server.addr.hostname}:${server.addr.port}`,
    async close() {
      await server.shutdown();
    },
  };
}

function callbackResult(invoke) {
  return new Promise((resolve) => {
    invoke((error, data) => resolve({ data, error }));
  });
}

function createClient(receiver, options = {}) {
  return new Analytics(WRITE_KEY, {
    dataPlaneUrl: receiver.url,
    flushAt: 5,
    flushInterval: 50,
    logLevel: 'error',
    retryCount: 0,
    ...options,
  });
}

async function verifyCoreMethods(gzip) {
  const receiver = createReceiver();
  try {
    const client = createClient(receiver, { gzip });
    const results = await Promise.all([
      callbackResult((callback) => client.identify({ userId: 'user-1' }, callback)),
      callbackResult((callback) =>
        client.group({ groupId: 'group-1', userId: 'user-1' }, callback),
      ),
      callbackResult((callback) =>
        client.track({ event: 'Deno compatibility', userId: 'user-1' }, callback),
      ),
      callbackResult((callback) => client.page({ name: 'Home', userId: 'user-1' }, callback)),
      callbackResult((callback) =>
        client.screen({ name: 'Dashboard', userId: 'user-1' }, callback),
      ),
      callbackResult((callback) =>
        client.alias({ previousId: 'anonymous-1', userId: 'user-1' }, callback),
      ),
    ]);

    assert.equal(
      results.every(({ error }) => error === undefined),
      true,
    );
    assert.equal(receiver.requests.length, 2);

    const events = receiver.requests.flatMap(({ body }) => body.batch);
    assert.deepEqual(events.map(({ type }) => type).sort(), [
      'alias',
      'group',
      'identify',
      'page',
      'screen',
      'track',
    ]);
    assert.equal(
      events.every(({ channel }) => channel === 'server'),
      true,
    );
    assert.equal(
      events.every(({ context }) => context.library.name === 'analytics-node'),
      true,
    );
    assert.equal(
      events.every(({ _metadata }) => typeof _metadata.nodeVersion === 'string'),
      true,
    );

    for (const request of receiver.requests) {
      assert.equal(request.url.pathname, '/v1/batch');
      assert.equal(request.headers.get('authorization'), `Basic ${btoa(`${WRITE_KEY}:`)}`);
      assert.match(request.headers.get('user-agent'), /^analytics-node\/\d+\.\d+\.\d+$/);
      assert.equal(request.headers.get('content-encoding'), gzip ? 'gzip' : null);
    }
  } finally {
    await receiver.close();
  }
}

Deno.test('the packaged SDK delivers all core event types as plain JSON', async () => {
  await verifyCoreMethods(false);
});

Deno.test('the packaged SDK delivers all core event types with gzip', async () => {
  await verifyCoreMethods(true);
});

Deno.test('successful requests invoke the event callback without an error', async () => {
  const receiver = createReceiver();
  try {
    const client = createClient(receiver, { gzip: false });
    const result = await callbackResult((callback) =>
      client.track({ event: 'Callback success', userId: 'user-1' }, callback),
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.data.batch.map(({ event }) => event),
      ['Callback success'],
    );
  } finally {
    await receiver.close();
  }
});

Deno.test('retryable responses are retried before the callback succeeds', async () => {
  const receiver = createReceiver(
    (requestNumber) => new Response(null, { status: requestNumber < 3 ? 503 : 200 }),
  );
  try {
    const client = createClient(receiver, {
      axiosRetryConfig: { retryDelay: () => 1 },
      gzip: false,
      retryCount: 2,
    });
    const result = await callbackResult((callback) =>
      client.track({ event: 'Retry success', userId: 'user-1' }, callback),
    );

    assert.equal(result.error, undefined);
    assert.equal(receiver.requests.length, 3);
  } finally {
    await receiver.close();
  }
});

Deno.test('failed requests invoke the event callback and error handler', async () => {
  const receiver = createReceiver(() => new Response('invalid request', { status: 400 }));
  let handledError;
  try {
    const client = createClient(receiver, {
      errorHandler: (error) => {
        handledError = error;
      },
      gzip: false,
    });
    client.flushed = true;

    const callback = callbackResult((done) =>
      client.track({ event: 'Callback failure', userId: 'user-1' }, done),
    );
    await client.flush();
    const result = await callback;

    assert.equal(result.error.response.status, 400);
    assert.equal(handledError.response.status, 400);
    assert.equal(receiver.requests.length, 1);
  } finally {
    await receiver.close();
  }
});

Deno.test('configured request timeouts reach the event callback', async () => {
  const receiver = createReceiver(
    () => new Promise((resolve) => setTimeout(() => resolve(new Response()), 200)),
  );
  try {
    const client = createClient(receiver, { gzip: false, timeout: 20 });
    client.flushed = true;

    const callback = callbackResult((done) =>
      client.track({ event: 'Timeout failure', userId: 'user-1' }, done),
    );
    await assert.rejects(client.flush(), /timeout of 20ms exceeded/);
    const result = await callback;

    assert.match(result.error.message, /timeout of 20ms exceeded/);
  } finally {
    await receiver.close();
  }
});

Deno.test('the flush timer delivers queued events', async () => {
  const receiver = createReceiver();
  try {
    const client = createClient(receiver, { flushAt: 10, flushInterval: 20, gzip: false });

    const first = await callbackResult((callback) =>
      client.track({ event: 'Immediate flush', userId: 'user-1' }, callback),
    );
    assert.equal(first.error, undefined);

    const second = await callbackResult((callback) =>
      client.track({ event: 'Timer flush', userId: 'user-1' }, callback),
    );
    assert.equal(second.error, undefined);
    assert.equal(receiver.requests.length, 2);
    assert.equal(receiver.requests[1].body.batch[0].event, 'Timer flush');
  } finally {
    await receiver.close();
  }
});
