export = Analytics;
declare class Analytics {
    /**
     * Initialize a new `Analytics` with your Segment project's `writeKey` and an
     * optional dictionary of `options`.
     *
     * @param {String} writeKey
     * @param {Object} [options] (optional)
     *   @property {Number} flushAt (default: 20)
     *   @property {Number} flushInterval (default: 10000)
     *   @property {String} host (default: required)
     *   @property {Boolean} enable (default: true)
     */
    constructor(writeKey: string, dataPlaneURL: any, options?: any);
    queue: any[];
    pQueue: any;
    pQueueInitialized: boolean;
    pQueueOpts: any;
    pJobOpts: {};
    state: string;
    writeKey: string;
    host: any;
    timeout: any;
    flushAt: number;
    flushInterval: any;
    maxInternalQueueSize: any;
    logLevel: any;
    flushed: boolean;
    logger: any;
    addPersistentQueueProcessor(): void;
    /**
     *
     * @param {*} queueOpts
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
    createPersistenceQueue(queueOpts: any, callback: any): void;
    _validate(message: any, type: any): void;
    /**
     * Send an identify `message`.
     *
     * @param {Object} message
     * @param {Function} [callback] (optional)
     * @return {Analytics}
     */
    identify(message: any, callback?: Function): Analytics;
    /**
     * Send a group `message`.
     *
     * @param {Object} message
     * @param {Function} [callback] (optional)
     * @return {Analytics}
     */
    group(message: any, callback?: Function): Analytics;
    /**
     * Send a track `message`.
     *
     * @param {Object} message
     * @param {Function} [callback] (optional)
     * @return {Analytics}
     */
    track(message: any, callback?: Function): Analytics;
    /**
     * Send a page `message`.
     *
     * @param {Object} message
     * @param {Function} [callback] (optional)
     * @return {Analytics}
     */
    page(message: any, callback?: Function): Analytics;
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
     * @param {Function} [callback] (optional)
     * @return {Analytics}
     */
    alias(message: any, callback?: Function): Analytics;
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
    flushTimer: number;
    /**
     * Flush the current queue
     *
     * @param {Function} [callback] (optional)
     * @return {Analytics}
     */
    flush(callback?: Function): Analytics;
    timer: number;
    _isErrorRetryable(error: any): boolean;
}
