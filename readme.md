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

## Initialization for persistence

```
const client = new Analytics(
  "write_key",
  "server_url/v1/batch",
  {
    flushAt: <number> = 20,
    flushInterval: <ms> = 20000
    maxInternalQueueSize: <number> = 20000 // the max number of elements that the SDK can hold in memory,
                                                                // this is different than the Redis list created when persistence is enabled
  }
);
client.createPersistenceQueue({ redisOpts: { host: "localhost" } }, err => {})
```

Adding a method **createPersistenceQueue** which takes as input two params **queueOpts** and a **callback**

```
QueueOpts {
  queueName ?: string = rudderEventsQueue,
  isMultiProcessor ? : boolean = false
  prefix ? : string = {rudder},  // pass a value without the {}
  redisOpts : RedisOpts,
  jobOpts ?: JobOpts
}

https://github.com/OptimalBits/bull/blob/develop/REFERENCE.md#queue
RedisOpts {
 port?: number = 6379;
 host?: string = localhost;
 db?: number = 0;
 password?: string;
}

JobOpts {
  maxAttempts ? : number = 10
}

callback: function(error) || function() // createPersistenceQueue calls this with error or nothing(in case of success), user
                                                                // should retry in case of error

```

The **createPersistenceQueue** method will initialize a Redis list by calling [Bull's](https://github.com/OptimalBits/bull) utility methods. It will also add a single job processor for processing(making requests to Rudder server) jobs that are pushed into the list. Before adding a processor, the SDK will remove the last active job(should be at max 1 active) if any and push it to be processed again in order. Error in doing this will lead to calling the **callback with error parameter**. Retry calling **createPersistenceQueue** with backoff.

If the **createPersistenceQueue** method is not called after initialising the SDK by the user, the SDK will work with no persistence and the behaviour will be same as at present.

### Flow

- Calling SDK apis like track, page, identify etc will push the events to an in-memory array
- the events from the array are flushed as a batch to Redis persistence based on the **flushAt** and **flushInterval** setting. Since, there is a communication to a separate process, tune the flushAt/flushInterval setting to slow down the hit to Redis. The in-memory array has a max size of **maxInternalQueueSize**, after which events won't be accepted if not drained at the other side (cases where Redis connection is slow etc)
- The processor will take the batch formed in the above step from Redis list and make a request to Rudder server. If succeeded, the job will be pushed to completed queue in Redis (Bull npm package terminology). In case of notRetryable error(4xx mainly), the job will be moved to failed queue (Bull npm package terminology). These queues are persistent and can be inspected directly in Redis or using an queue viewer [like](https://github.com/vcapretz/bull-board).
- In case of retryable errors, the job is pushed to completed queue and a new instance of job with the same batch data is created and pushed to front of the queue (to maintain order), so that the next job to be processed is the same (this is the retry functionality). This will go upto **JobOpts.maxAttempts** time with exponential backoff of power 2.
- If the job failed even after **JobOpts.maxAttempts**, it is moved to failed queue( explained above ).
- If the node process dies with jobs still in active state (not completed nor failed but in the process of sending/retrying), the **next time the SDK is initialised and createPersistenceQueue** is called, it will be removed and a new instance with the same batch data is pushed in front of the queue to picked up first by the processor.

### Important Parameters

- flushAt
- flushInterval
- maxInternalQueueSize
- JobOpts.maxAttempts

### Notes

- **isMultiProcessor** flag determines whether to handle previously active jobs, if false => the active job handling from previous processor is applied else Bull handles it by moving it to back of waiting queue.

### Limitation

https://gitter.im/OptimalBits/bull/archives/2018/04/17
**Details**: https://redis.io/topics/cluster-tutorial#redis-cluster-data-sharding
**Workaround**: https://gitter.im/OptimalBits/bull/archives/2018/04/17, we are passing a prefix with default {rudder}

## Documentation

Documentation is available [here](https://docs.rudderstack.com/rudderstack-sdk-integration-guides/rudderstack-node-sdk).

## Contact Us

If you come across any issues while configuring or using the RudderStack Node.js SDK, please feel free to [contact us](https://rudderstack.com/contact/) or start a conversation on our [Slack](https://resources.rudderstack.com/join-rudderstack-slack) channel. We will be happy to help you.

