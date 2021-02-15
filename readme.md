# What is RudderStack?

[RudderStack](https://rudderstack.com/) is a **customer data pipeline** tool for collecting, routing and processing data from your websites, apps, cloud tools, and data warehouse.

More information on RudderStack can be found [here](https://github.com/rudderlabs/rudder-server).

# RudderStack Node.js SDK

RudderStack’s Node.js SDK allows you to track your customer event data from your Node.js code. Once enabled, the event requests hit the RudderStack servers. RudderStack then routes the events to the specified destination platforms as configured by you.

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

## Contact Us

If you come across any issues while configuring or using the RudderStack Node.js SDK, please feel free to [contact us](https://rudderstack.com/contact/) or start a conversation on our [Slack](https://resources.rudderstack.com/join-rudderstack-slack) channel. We will be happy to help you.
