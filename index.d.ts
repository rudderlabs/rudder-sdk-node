export default Analytics;

/**
 * Represents a generic object in the APIs
 * Use for parameters like context, traits etc.
 */
export interface apiObject {
  [index: string]:
    | string
    | number
    | boolean
    | undefined
    | apiObject
    | (string | number | boolean | apiObject)[];
}

/**
 * Represents the integration options object
 * Example usages:
 * integrationOptions { All: false, "Google Analytics": true, "Braze": true}
 * integrationOptions { All: true, "Chartbeat": false, "Customer.io": false}
 */
export interface integrationOptions {
  // Defaults to true
  // If set to false, specific integration should be set to true to send the event
  All?: boolean;
  // Destination name: true/false/integration specific information
  [index: string]: boolean | apiObject | undefined;
}

/**
 * Represents the constructor options object
 * Example usages:
 * constructorOptions { flushAt: 20, "flushInterval": 20000, "enable": true, "maxInternalQueueSize":20000, "logLevel": "info"/"debug"/"error"/"silly"}
 */
export interface constructorOptions {
  flushAt?: number;
  flushInterval?: number;
  enable?: boolean;
  maxInternalQueueSize?: number;
  logLevel?: string;
}

/**
 * Represents the callback in the APIs
 */
export type apiCallback = () => void;
declare class Analytics {
  /**
   * Initialize a new `Analytics` with your Segment project's `writeKey` and an
   * optional dictionary of `options`.
   *
   * @param {String} writeKey
   * @param {String} dataPlaneURL
   * @param {Object=} options (optional)
   * @param {Number=20} options.flushAt (default: 20)
   * @param {Number=20000} options.flushInterval (default: 20000)
   * @param {Boolean=true} options.enable (default: true)
   * @param {Number=20000} options.maxInternalQueueSize
   */
  constructor(
    writeKey: string,
    dataPlaneURL: string,
    options?: constructorOptions
  );

  /**
   *
   * @param {Object} queueOpts
   * @param {String=} queueOpts.queueName
   * @param {String=} queueOpts.prefix
   * @param {Boolean=} queueOpts.isMultiProcessor
   * @param {Object} queueOpts.redisOpts
   * @param {Number=} queueOpts.redisOpts.port
   * @param {String=} queueOpts.redisOpts.host
   * @param {Number=} queueOpts.redisOpts.db
   * @param {String=} queueOpts.redisOpts.password
   * @param {Object=} queueOpts.jobOpts
   * @param {Number} queueOpts.jobOpts.maxAttempts
   * {
   *    queueName: string = rudderEventsQueue,
   *    prefix: string = rudder
   *    isMultiProcessor: booloean = false
   *    redisOpts: {
   *      port?: number = 6379;
   *      host?: string = localhost;
   *      db?: number = 0;
   *      password?: string;
   *    },
   *    jobOpts: {
   *      maxAttempts: number = 10
   *    }
   * }
   * @param {*} callback
   *  All error paths from redis and queue will give exception, so they are non-retryable from SDK perspective
   *  The queue may not function for unhandled promise rejections
   *  this error callback is called when the SDK wants the user to retry
   */
  createPersistenceQueue(
    queueOpts: {
      queueName?: string;
      prefix?: string;
      isMultiProcessor?: boolean;
      redisOpts: {
        port?: number;
        host?: string;
        db?: number;
        password?: string;
      };
      jobOpts?: {
        maxAttempts?: number;
      };
    },
    callback: apiCallback
  ): void;

  /**
   * Send an identify `message`.
   *
   * @param {Object} message
   * @param {String=} message.userId (optional)
   * @param {String=} message.anonymousId (optional)
   * @param {Object=} message.context (optional)
   * @param {Object=} message.traits (optional)
   * @param {Object=} message.integrations (optional)
   * @param {Date=} message.timestamp (optional)
   * @param {Function=} callback (optional)
   * @return {Analytics}
   */
  identify(
    message: {
      userId?: string;
      anonymousId?: string;
      context?: apiObject;
      traits?: apiObject;
      integrations?: integrationOptions;
      timestamp?: Date;
    },
    callback?: apiCallback
  ): Analytics;
  /**
   * Send a group `message`.
   *
   * @param {Object} message
   * @param {String} message.groupId
   * @param {String=} message.userId (optional)
   * @param {String=} message.anonymousId (optional)
   * @param {Object=} message.context (optional)
   * @param {Object=} message.traits (optional)
   * @param {Object=} message.integrations (optional)
   * @param {Date=} message.timestamp (optional)
   * @param {Function=} callback (optional)
   * @return {Analytics}
   */
  group(
    message: {
      groupId: string;
      userId?: string;
      anonymousId?: string;
      context?: apiObject;
      traits?: apiObject;
      integrations?: integrationOptions;
      timestamp?: Date;
    },
    callback?: apiCallback
  ): Analytics;
  /**
   * Send a track `message`.
   *
   * @param {Object} message
   * @param {String} message.event
   * @param {String=} message.userId (optional)
   * @param {String=} message.anonymousId (optional)
   * @param {Object=} message.context (optional)
   * @param {Object=} message.properties (optional)
   * @param {Object=} message.integrations (optional)
   * @param {Date=} message.timestamp (optional)
   * @param {Function=} callback (optional)
   * @return {Analytics}
   */
  track(
    message: {
      event: string;
      userId?: string;
      anonymousId?: string;
      context?: apiObject;
      properties?: apiObject;
      integrations?: integrationOptions;
      timestamp?: Date;
    },
    callback?: apiCallback
  ): Analytics;
  /**
   * Send a page `message`.
   *
   * @param {Object} message
   * @param {String} message.name
   * @param {String=} message.userId (optional)
   * @param {String=} message.anonymousId (optional)
   * @param {Object=} message.context (optional)
   * @param {Object=} message.properties (optional)
   * @param {Object=} message.integrations (optional)
   * @param {Date=} message.timestamp (optional)
   * @param {Function=} callback (optional)
   * @return {Analytics}
   */
  page(
    message: {
      name: string;
      userId?: string;
      anonymousId?: string;
      context?: apiObject;
      properties?: apiObject;
      integrations?: integrationOptions;
      timestamp?: Date;
    },
    callback?: apiCallback
  ): Analytics;

  /**
   * Send an alias `message`.
   *
   * @param {Object} message
   * @param {String} message.previousId
   * @param {String=} message.userId (optional)
   * @param {String=} message.anonymousId (optional)
   * @param {Object=} message.context (optional)
   * @param {Object=} message.properties (optional)
   * @param {Object=} message.integrations (optional)
   * @param {Date=} message.timestamp (optional)
   * @param {Function=} callback (optional)
   * @return {Analytics}
   */
  alias(
    message: {
      previousId: string;
      userId?: string;
      anonymousId?: string;
      context?: apiObject;
      properties?: apiObject;
      integrations?: integrationOptions;
      timestamp?: Date;
    },
    callback?: apiCallback
  ): Analytics;

  /**
   * Flush the current queue
   *
   * @param {Function} [callback] (optional)
   * @return {Analytics}
   */
  flush(callback?: Function): Analytics;
}
