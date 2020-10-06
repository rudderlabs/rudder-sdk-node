# analytics-node

## Installation

```bash
$ npm install @rudderstack/rudder-sdk-node
```

## Usage

```js
const Analytics = require("@rudderstack/rudder-sdk-node");

// we need the batch endpoint of the Rudder server you are running
const client = new Analytics("write key", "<data-plane-uri>/v1/batch"); 

client.track({
  event: "event name",
  userId: "user id"
});
```

## Documentation

Documentation is available [here](https://docs.rudderstack.com/rudderstack-sdk-integration-guides/rudderstack-node-sdk).
