# analytics-node

## Installation

```bash
$ npm install @rudderlabs/rudder-analytics-node
```

## Usage

```js
const Analytics = require("@rudderlabs/rudder-analytics-node");

const client = new Analytics("write key", "data-plane-uri");
// const client = new Analytics("1S2kNlbkMrWLBO79H2eNuEST27I", "http://localhost:8080/v1/batch");

client.track({
  event: "event name",
  userId: "user id"
});
```

## Documentation

Documentation is available at [https://segment.com/libraries/node](https://segment.com/libraries/node).
