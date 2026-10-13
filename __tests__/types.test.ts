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
