# analytics-node 


## Installation

```bash
$ npm install analytics-node
```


## Usage

```js
const Analytics = require('analytics-node');

const client = new Analytics('write key', 'data-plane-uri');

client.track({
  event: 'event name',
  userId: 'user id'
});
```


## Documentation

Documentation is available at [https://segment.com/libraries/node](https://segment.com/libraries/node).


