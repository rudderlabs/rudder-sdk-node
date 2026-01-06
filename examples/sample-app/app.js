const Rudderanalytics = require('@rudderstack/rudder-sdk-node');
require('dotenv').config({ path: '../../.env' });

const writeKey = process.env.WRITE_KEY;
const dataPlaneUrl = process.env.DATAPLANE_URL;

const client = new Rudderanalytics(writeKey, {
  dataPlaneUrl,
  flushAt: 1,
  logLevel: 'debug',
});

// console.log('Initializing persistence queue...');

// // Enable persistence (this starts the worker that reads from Redis)
// client.createPersistenceQueue(
//   {
//     queueName: 'rudderEventsQueue',
//     redisOpts: {
//         host: 'localhost',
//         port: 6379
//     }
//   },
//   (err) => {
//     if (err) console.error('Queue Error:', err);
//     else console.log('Queue is ready and listening...');
//   }
// );

/**
 * Sample function to send 3 rudder events[identify,track,track] and make sure events are flowing
 */
function test() {
  client.identify(
    {
      userId: 'Test user 1',
      traits: {
        name: 'Name Username',
        email: 'name@website.com',
        plan: 'Free',
        friends: 21,
      },
    },
    () => {
      console.log('In identify call');
    },
  );

  client.track(
    {
      userId: 'Test user 1',
      event: 'Item Purchased',
      properties: {
        revenue: 19.95,
        shippingMethod: 'Premium',
      },
    },
    () => {
      console.log('In track call');
    },
  );
  client.track(
    {
      userId: 'Test user 2',
      event: 'Item Viewed',
      properties: {
        price: 45,
        currency: 'USD',
        productId: 'Product-12345',
      },
    },
    () => {
      console.log('In track call 2');
    },
  );

  // await client.flush();
}

try {
  test();
} catch (e) {
  console.log(e.message);
}

// Keep process alive to process the job
setInterval(() => {}, 1000);

exports.Rudderanalytics = Rudderanalytics;

// run this file with the command "node app"
