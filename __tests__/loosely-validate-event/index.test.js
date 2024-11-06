// eslint-disable-next-line import/no-unresolved
const test = require('ava');
const { AssertionError } = require('assert');
const validate = require('../../src/loosely-validate-event');

test('requires "anonymousId" to be a string or number', (t) => {
  const event = {
    type: 'track',
    anonymousId: { foo: 'bar' },
  };
  const error = t.throws(
    () => {
      validate(event);
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error.message, '"anonymousId" must be a string or number.');
});

test('requires "category" to be a string', (t) => {
  const event = {
    type: 'track',
    category: true,
  };

  const error = t.throws(
    () => {
      validate(event);
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error.message, '"category" must be a string.');
});

test('requires "integrations" to be an object', (t) => {
  const event = {
    type: 'track',
    integrations: true,
  };

  const error = t.throws(
    () => {
      validate(event);
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error.message, '"integrations" must be an object.');
});

test('requires an event type', (t) => {
  t.throws(
    () => {
      validate({});
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.throws(
    () => {
      validate({ type: '' }, null);
    },
    {
      instanceOf: AssertionError,
    },
  );
});

test('requires a valid event type', (t) => {
  const error = t.throws(
    () => {
      validate({ type: 'banana' });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error.message, 'Invalid event type: "banana"');
});

test('requires anonymousId or userId on track events', (t) => {
  const error1 = t.throws(
    () => {
      validate({
        type: 'track',
        event: 'Did Something',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error1.message, 'You must pass either an "anonymousId" or a "userId".');

  const error2 = t.throws(
    () => {
      validate({
        type: 'track',
        event: 'Did Something',
        fooId: 'banana',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  t.notThrows(() => {
    validate(
      {
        event: 'Did Something',
        anonymousId: 'banana',
      },
      'track',
    );
  });

  t.notThrows(() => {
    validate({
      type: 'track',
      event: 'Did Something',
      userId: 'banana',
    });
  });
});

test('requires event on track events', (t) => {
  const error = t.throws(
    () => {
      validate({
        type: 'track',
        userId: 'banana',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error.message, 'You must pass an "event".');

  t.notThrows(() => {
    validate({
      type: 'track',
      event: 'Did Something',
      userId: 'banana',
    });
  });
});

test('requires anonymousId or userId on group events', (t) => {
  const error1 = t.throws(
    () => {
      validate({
        type: 'group',
        groupId: 'foo',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error1.message, 'You must pass either an "anonymousId" or a "userId".');

  const error2 = t.throws(
    () => {
      validate({
        type: 'group',
        groupId: 'foo',
        fooId: 'banana',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  t.notThrows(() => {
    validate({
      type: 'group',
      groupId: 'foo',
      anonymousId: 'banana',
    });
  });

  t.notThrows(() => {
    validate({
      type: 'group',
      groupId: 'foo',
      userId: 'banana',
    });
  });
});

test('requires groupId on group events', (t) => {
  const error = t.throws(
    () => {
      validate({
        type: 'group',
        userId: 'banana',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error.message, 'You must pass a "groupId".');

  t.notThrows(() => {
    validate({
      type: 'group',
      groupId: 'foo',
      userId: 'banana',
    });
  });
});

test('requires anonymousId or userId on identify events', (t) => {
  const error1 = t.throws(
    () => {
      validate({
        type: 'identify',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error1.message, 'You must pass either an "anonymousId" or a "userId".');

  const error2 = t.throws(
    () => {
      validate({
        type: 'identify',
        fooId: 'banana',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  t.notThrows(() => {
    validate({
      type: 'identify',
      anonymousId: 'banana',
    });
  });

  t.notThrows(() => {
    validate({
      type: 'identify',
      userId: 'banana',
    });
  });
});

test('requires anonymousId or userId on page events', (t) => {
  const error1 = t.throws(
    () => {
      validate({
        type: 'page',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error1.message, 'You must pass either an "anonymousId" or a "userId".');

  const error2 = t.throws(
    () => {
      validate({
        type: 'page',
        fooId: 'banana',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  t.notThrows(() => {
    validate({
      type: 'page',
      anonymousId: 'banana',
    });
  });

  t.notThrows(() => {
    validate({
      type: 'page',
      userId: 'banana',
    });
  });
});

test('requires anonymousId or userId on screen events', (t) => {
  const error1 = t.throws(
    () => {
      validate({
        type: 'screen',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error1.message, 'You must pass either an "anonymousId" or a "userId".');

  const error2 = t.throws(
    () => {
      validate({
        type: 'screen',
        fooId: 'banana',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error2.message, 'You must pass either an "anonymousId" or a "userId".');

  t.notThrows(() => {
    validate({
      type: 'screen',
      anonymousId: 'banana',
    });
  });

  t.notThrows(() => {
    validate({
      type: 'screen',
      userId: 'banana',
    });
  });
});

test('requires userId on alias events', (t) => {
  const error1 = t.throws(
    () => {
      validate({
        type: 'alias',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error1.message, 'You must pass a "userId".');

  const error2 = t.throws(
    () => {
      validate({
        type: 'alias',
        fooId: 'banana',
      });
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error2.message, 'You must pass a "userId".');

  t.notThrows(() => {
    validate({
      type: 'alias',
      userId: 'banana',
      previousId: 'apple',
    });
  });
});

test('requires events to be < 32kb', (t) => {
  const error = t.throws(
    () => {
      const event = {
        type: 'track',
        event: 'Did Something',
        userId: 'banana',
        properties: {},
      };
      for (let i = 0; i < 10000; i += 1) {
        event.properties[i] = 'a';
      }
      validate(event);
    },
    {
      instanceOf: AssertionError,
    },
  );

  t.is(error.message, 'Your message must be < 32kb.');

  t.notThrows(() => {
    validate({
      type: 'track',
      event: 'Did Something',
      userId: 'banana',
    });
  });
});
