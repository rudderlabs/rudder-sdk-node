const Rudderanalytics = require('@rudderstack/rudder-sdk-node'); // use version 2.x.x

const writeKey = 'WRITE_KEY'; // replace with your write-key
const dataPlaneUrl = 'DATAPLANE_URL'; // replace with your data plane url

const client = new Rudderanalytics(writeKey, {
  dataPlaneUrl,
  flushAt: 2,
  logLevel: 'debug',
});
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

exports.Rudderanalytics = Rudderanalytics;

// run this file with the command "node app"
