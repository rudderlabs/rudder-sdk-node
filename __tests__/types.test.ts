import Analytics = require('../index');

declare const client: Analytics;

client.identify({ userId: 'user-123' });
client.track({ anonymousId: 'anonymous-123', event: 'Product Viewed' });
client.group({ userId: 'user-123', groupId: 'group-123' });
client.page({ userId: 'user-123' });
client.page({ anonymousId: 'anonymous-123', category: 'Marketing' });
client.page({ userId: 'user-123', name: 'Pricing' });
client.screen({ anonymousId: 'anonymous-123', name: 'Home' });
client.alias({ userId: 'user-123', previousId: 'anonymous-123' });

// @ts-expect-error A page event requires a userId or anonymousId.
client.page({});

// @ts-expect-error The page category must be a string.
client.page({ userId: 'user-123', category: true });

new Analytics('write-key', {
  beforeEnqueue: (event) => {
    if (event.type === 'track' && event.event === 'Noise') return null;
    event.properties = { redacted: true };
    return event;
  },
  beforeEnqueueOnError: 'drop',
});

new Analytics('write-key', {
  beforeEnqueue: (event) => {
    if (event.type === 'track') {
      const name: string = event.event;
    }
    if (event.type === 'group') {
      const groupId: string = event.groupId;
    }
    // @ts-expect-error event is a string only on track events.
    const name: string = event.event;
    // @ts-expect-error type is one of the API call types.
    if (event.type === 'batch') return null;
    return event;
  },
});

const hook: Analytics.BeforeEnqueueCallback = (event: Analytics.BeforeEnqueueEvent) => event;
new Analytics('write-key', { beforeEnqueue: hook, beforeEnqueueOnError: 'send' });

// @ts-expect-error beforeEnqueueOnError only takes 'send' or 'drop'.
new Analytics('write-key', { beforeEnqueueOnError: 'retry' });

// @ts-expect-error beforeEnqueue must return an event or null.
new Analytics('write-key', { beforeEnqueue: () => 'event' });
