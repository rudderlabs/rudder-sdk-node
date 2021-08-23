export = Analytics;
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
    constructor(writeKey: string, dataPlaneURL: string, options?: any | undefined);
    queue: any[];
    pQueue: any;
    pQueueInitialized: boolean;
    pQueueOpts: {};
    pJobOpts: {};
    state: string;
    writeKey: string;
    host: string;
    timeout: any;
    flushAt: number;
    flushInterval: any;
    maxInternalQueueSize: any;
    logLevel: any;
    flushed: boolean;
    logger: winston.Logger;
    addPersistentQueueProcessor(): void;
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
    createPersistenceQueue(queueOpts: {
        queueName?: string | undefined;
        prefix?: string | undefined;
        isMultiProcessor?: boolean | undefined;
        redisOpts: {
            port?: number | undefined;
            host?: string | undefined;
            db?: number | undefined;
            password?: string | undefined;
        };
        jobOpts?: any | undefined;
    }, callback: any): void;
    _validate(message: any, type: any): void;
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
    identify(message: {
        userId?: string | undefined;
        anonymousId?: string | undefined;
        context?: any | undefined;
        traits?: any | undefined;
        integrations?: any | undefined;
        timestamp?: Date | undefined;
    }, callback?: Function | undefined): Analytics;
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
    group(message: {
        groupId: string;
        userId?: string | undefined;
        anonymousId?: string | undefined;
        context?: any | undefined;
        traits?: any | undefined;
        integrations?: any | undefined;
        timestamp?: Date | undefined;
    }, callback?: Function | undefined): Analytics;
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
    track(message: {
        event: string;
        userId?: string | undefined;
        anonymousId?: string | undefined;
        context?: any | undefined;
        properties?: any | undefined;
        integrations?: any | undefined;
        timestamp?: Date | undefined;
    }, callback?: Function | undefined): Analytics;
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
    page(message: {
        name: string;
        userId?: string | undefined;
        anonymousId?: string | undefined;
        context?: any | undefined;
        properties?: any | undefined;
        integrations?: any | undefined;
        timestamp?: Date | undefined;
    }, callback?: Function | undefined): Analytics;
    /**
     * Send a screen `message`.
     *
     * @param {Object} message
     * @param {Function} fn (optional)
     * @return {Analytics}
     */
    screen(message: any, callback: any): Analytics;
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
    alias(message: {
        previousId: string;
        userId?: string | undefined;
        anonymousId?: string | undefined;
        context?: any | undefined;
        properties?: any | undefined;
        integrations?: any | undefined;
        timestamp?: Date | undefined;
    }, callback?: Function | undefined): Analytics;
    /**
     * Add a `message` of type `type` to the queue and
     * check whether it should be flushed.
     *
     * @param {String} type
     * @param {Object} message
     * @param {Function} [callback] (optional)
     * @api private
     */
    enqueue(type: string, message: any, callback?: Function): any;
    flushTimer: NodeJS.Timeout;
    /**
     * Flush the current queue
     *
     * @param {Function} [callback] (optional)
     * @return {Analytics}
     */
    flush(callback?: Function): Analytics;
    timer: NodeJS.Timeout;
    _isErrorRetryable(error: any): boolean;
}
import winston = require("winston");
