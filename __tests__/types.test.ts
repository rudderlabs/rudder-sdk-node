import Analytics = require('../index');

declare const client: Analytics;

client.page({ userId: 'user-123' });
client.page({ anonymousId: 'anonymous-123', category: 'Marketing' });
client.page({ userId: 'user-123', name: 'Pricing' });

// @ts-expect-error A page event requires a userId or anonymousId.
client.page({});

// @ts-expect-error The page category must be a string.
client.page({ userId: 'user-123', category: true });
