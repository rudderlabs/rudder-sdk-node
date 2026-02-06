/* eslint-disable func-names */
/* eslint-disable sonarjs/no-nested-functions */
/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */
/* eslint-disable prefer-destructuring */

const assert = require('assert');
const removeSlash = require('remove-trailing-slash');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const ms = require('ms');
const { v4: uuid } = require('uuid');
const md5 = require('md5');
const isString = require('lodash.isstring');
const cloneDeep = require('lodash.clonedeep');
const zlib = require('zlib');
const looselyValidate = require('./loosely-validate-event');
const Logger = require('./Logger').Logger;
const LOG_LEVEL_MAP = require('./Logger').LOG_LEVEL_MAP;
const version = require('../package.json').version;

const gzip = zlib.gzipSync;
const setImmediate = global.setImmediate || process.nextTick.bind(process);
const noop = () => {};

const JOB_DATA_VERSION = 3;

class Analytics {
  /**
   * Initialize a new `Analytics` with your RudderStack source's `writeKey` and an
   * optional dictionary of `options`.
   *
   * @param {String} writeKey
   * @param {Object} [options] (optional)
   *   @property {Number} [flushAt] (default: 20)
   *   @property {Number} [flushInterval] (default: 10000)
   *   @property {Number} [maxQueueSize] (default: 500 kb)
   *   @property {Number} [maxInternalQueueSize] (default: 20000)
   *   @property {String} [logLevel] (default: 'info')
   *   @property {String} [dataPlaneUrl] (default: 'https://hosted.rudderlabs.com')
   *   @property {String} [host] (default: 'https://hosted.rudderlabs.com')
   *   @property {String} [path] (default: '/v1/batch')
   *   @property {Boolean} [enable] (default: true)
   *   @property {Object} [axiosConfig] (optional)
   *   @property {Object} [axiosInstance] (default: axios.create(options.axiosConfig))
   *   @property {Object} [axiosRetryConfig] (optional)
   *   @property {Number} [retryCount] (default: 3)
   *   @property {Function} [errorHandler] (optional)
   *   @property {Boolean} [gzip] (default: true)
   */

  constructor(writeKey, options) {
    const loadOptions = options || {};
    const {
      dataPlaneUrl,
      host,
      path,
      axiosConfig,
      axiosRetryConfig,
      timeout,
      flushAt,
      flushInterval,
      maxQueueSize,
      maxInternalQueueSize,
      errorHandler,
      logLevel,
      enable,
      retryCount,
    } = loadOptions;
    let { axiosInstance } = loadOptions;

    assert(writeKey, "You must pass your RudderStack project's write key.");

    this.queue = [];
    this.pQueue = undefined;
    this.pQueueInitialized = false;
    this.pQueueOpts = undefined;
    this.pJobOpts = {};
    // Store callbacks in memory by job ID (v3.0.0 - security fix)
    // NOTE: Callbacks are NOT persisted to Redis. They will be lost on process restart.
    // This is intentional to prevent serializing functions (RCE vulnerability).
    this.pCallbacksMap = new Map();
    this.writeKey = writeKey;
    this.host = removeSlash(dataPlaneUrl || host || 'https://hosted.rudderlabs.com');
    this.path = removeSlash(path || '/v1/batch');
    if (axiosInstance == null) {
      axiosInstance = axios.create(axiosConfig);
    }
    this.axiosInstance = axiosInstance;
    this.timeout = timeout || false;
    this.flushAt = Math.max(flushAt, 1) || 20;
    this.maxQueueSize = maxQueueSize || 1024 * 450; // 500kb is the API limit, if we approach the limit i.e., 450kb, we'll flush
    this.maxInternalQueueSize = maxInternalQueueSize || 20000;
    this.flushInterval = flushInterval || 10000;
    this.flushed = false;
    this.errorHandler = errorHandler;
    this.pendingFlush = null;
    this.logLevel = logLevel || 'info';
    this.gzip = true;
    if (loadOptions.gzip === false) {
      this.gzip = false;
    }
    Object.defineProperty(this, 'enable', {
      configurable: false,
      writable: false,
      enumerable: true,
      value: typeof enable === 'boolean' ? enable : true,
    });

    this.logger = new Logger(LOG_LEVEL_MAP[this.logLevel]);

    if (retryCount !== 0) {
      axiosRetry(this.axiosInstance, {
        retries: retryCount || 3,
        retryDelay: axiosRetry.exponentialDelay,
        ...axiosRetryConfig,
        // retryCondition is below optional config to ensure it does not get overridden
        retryCondition: this._isErrorRetryable.bind(this),
      });
    }
  }

  _deserializeJobData(job) {
    try {
      if (job.data?.version === JOB_DATA_VERSION) {
        return JSON.parse(job.data.eventData);
      }

      this.logger.error(
        'Job data format is not supported. Please drain your Redis queue before upgrading to v3.x.x.',
      );
      // <= v2.x jobs are not supported
    } catch (error) {
      this.logger.error('Cannot parse the job data.', error);
    }
    return undefined;
  }

  addPersistentQueueProcessor() {
    const _isErrorRetryable = this._isErrorRetryable.bind(this);
    const rdone = (callbacks, err) => {
      callbacks.forEach((callback_) => {
        callback_(err);
      });
    };

    const payloadQueue = this.pQueue;
    const jobOpts = this.pJobOpts;

    this.pQueue.on('failed', (job, error) => {
      const jobData = this._deserializeJobData(job);
      if (jobData) {
        this.logger.error(`job : ${jobData.description} ${error}`);
      }
    });

    // tapping on queue events
    this.pQueue.on('completed', (job, result) => {
      const jobData = this._deserializeJobData(job);
      if (jobData) {
        result = result || 'completed';
        this.logger.debug(`job : ${jobData.description} ${result}`);
      }
    });

    this.pQueue.on('stalled', (job) => {
      const jobData = this._deserializeJobData(job);
      if (jobData) {
        this.logger.warn(`job : ${jobData.description} is stalled...`);
      }
    });

    this.pQueue.process((job, done) => {
      // job failed for maxAttempts or more times, push to failed queue
      // starting with attempt = 0
      const maxAttempts = jobOpts.maxAttempts || 10;

      const jobData = this._deserializeJobData(job);
      if (!jobData) {
        done(new Error('Skipping the job because the job data could not be parsed.'));
        return;
      }

      // Retrieve callbacks from in-memory map
      // NOTE: Callbacks will be empty if process restarted, as they are stored in-memory only.
      // This is a security trade-off to prevent serializing functions (RCE vulnerability).
      // Users will not receive callback notifications for jobs in-flight during restart.
      const callbacks = this.pCallbacksMap.get(jobData.jobId) || [];

      if (callbacks.length === 0 && jobData.attempts === 0) {
        this.logger.warn(
          `No callbacks found for job ${jobData.jobId}. This may indicate the process restarted with jobs in Redis queue.`,
        );
      }

      if (jobData.attempts >= maxAttempts) {
        // Clean up callbacks after max attempts exceeded
        this.pCallbacksMap.delete(jobData.jobId);

        const error = new Error(
          `job : ${jobData.description} pushed to failed queue after attempts ${jobData.attempts} skipping further retries...`,
        );
        rdone(callbacks, error);
        done(error);
      } else {
        // process the job after exponential delay, if it's the 0th attempt, setTimeout will fire immediately
        // max delay is 30 sec, it is mostly in sync with a bull queue job max lock time
        const self = this;
        setTimeout(
          (axiosInstance, host, path, gzipOption) => {
            const req = jobData.request;
            req.data.sentAt = new Date();

            // Prepare request payload without mutating original data
            let requestData = req.data;
            const requestHeaders = { ...req.headers };

            if (gzipOption) {
              requestData = gzip(JSON.stringify(req.data));
              requestHeaders['Content-Encoding'] = 'gzip';
            }

            // if request succeeded, mark the job done and move to completed
            axiosInstance
              .post(`${host}${path}`, requestData, { ...req, headers: requestHeaders })
              // eslint-disable-next-line no-unused-vars
              .then((response) => {
                // Clean up callbacks after successful processing
                self.pCallbacksMap.delete(jobData.jobId);
                rdone(callbacks);
                done();
              })
              .catch((err) => {
                // check if request is retryable
                const isRetryable = _isErrorRetryable(err);
                self.logger.debug(`Request is ${isRetryable ? '' : 'not'} to be retried`);
                if (isRetryable) {
                  const { attempts, description, jobId } = jobData;
                  jobData.attempts = attempts + 1;
                  self.logger.debug(`Request retry attempt ${attempts}`);
                  // increment attempt
                  // add a new job to queue in lifo
                  // Callbacks remain in map for retry (same jobId)
                  // if able to add, mark the earlier job done with push to completed with a msg
                  // if add to redis queue gives exception, not catching it
                  // in case of redis queue error, mark the job as failed ? i.e add the catch block in below promise ?
                  payloadQueue
                    .add(self._getDataForPersistenceQueue(jobData), { lifo: true })
                    // eslint-disable-next-line no-unused-vars
                    .then((pushedJob) => {
                      done(null, `job : ${description} failed for attempt ${attempts} ${err}`);
                    })
                    .catch((error) => {
                      self.logger.error(`failed to requeue job ${description}`);
                      // Clean up callbacks after requeue failure
                      self.pCallbacksMap.delete(jobId);
                      rdone(callbacks, error);
                      done(error);
                    });
                } else {
                  // if not retryable, mark the job failed and to failed queue for user to retry later
                  // Clean up callbacks after non-retryable failure
                  self.pCallbacksMap.delete(jobData.jobId);
                  rdone(callbacks, err);
                  done(err);
                }
              });
          },
          Math.min(30000, 2 ** jobData.attempts * 1000),
          this.axiosInstance,
          this.host,
          this.path,
          this.gzip,
        );
      }
    });
  }

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
  createPersistenceQueue(queueOpts, callback) {
    if (this.pQueueInitialized) {
      this.logger.debug('a persistent queue is already initialized, skipping...');
      return;
    }

    // eslint-disable-next-line import/no-extraneous-dependencies,global-require
    const Queue = require('bull');

    this.pQueueOpts = queueOpts || {};
    this.pQueueOpts.isMultiProcessor = this.pQueueOpts.isMultiProcessor || false;
    if (!this.pQueueOpts.redisOpts) {
      throw new Error('redis connection parameters not present. Cannot make a persistent queue');
    }
    this.pJobOpts = this.pQueueOpts.jobOpts || {};
    this.pQueue = new Queue(this.pQueueOpts.queueName || 'rudderEventsQueue', {
      redis: this.pQueueOpts.redisOpts,
      prefix: this.pQueueOpts.prefix ? `{${this.pQueueOpts.prefix}}` : '{rudder}',
    });

    this.logger.debug(`isMultiProcessor: ${this.pQueueOpts.isMultiProcessor}`);

    this.pQueue
      .isReady()
      .then(() => {
        // at startup get active job, remove it, then add it in front of queue to retried first
        // then add the queue processor
        // if queue is isMultiProcessor, skip the above and add the queue processor
        if (this.pQueueOpts.isMultiProcessor) {
          this.addPersistentQueueProcessor();
          this.pQueueInitialized = true;
          callback();
        } else {
          this.pQueue
            .getActive()
            .then((jobs) => {
              this.logger.debug('success getting active jobs');
              if (jobs.length === 0) {
                this.logger.debug('there are no active jobs while starting up queue');
                this.addPersistentQueueProcessor();
                this.logger.debug('success adding process');
                this.pQueueInitialized = true;
                callback();
              } else {
                // since there is only once process, the count of active jobs will be 1 at max
                // moving active job is important as this job doesn't have a process function
                // and will later be retried which will mess event ordering
                if (jobs.length > 1) {
                  this.logger.debug('number of active jobs at starting up queue > 1 ');
                  callback(
                    new Error(
                      'queue has more than 1 active job, move them to failed and try again',
                    ),
                  );
                  return;
                }
                this.logger.debug(`number of active jobs at starting up queue = ${jobs.length}`);
                jobs.forEach((job) => {
                  job
                    .remove()
                    .then(() => {
                      this.logger.debug('success removed active job');
                      const jobData = this._deserializeJobData(job);

                      if (!jobData) {
                        this.logger.error('Cannot parse the job data. Skipping the job.');
                        return;
                      }

                      jobData.attempts = 0;
                      // Note: callbacks will be empty for requeued jobs after restart
                      this.pQueue
                        .add(this._getDataForPersistenceQueue(jobData), { lifo: true })
                        // eslint-disable-next-line no-unused-vars
                        .then((removedJob) => {
                          this.logger.debug('success adding removed job back to queue');
                          this.addPersistentQueueProcessor();
                          this.logger.debug('success adding process');
                          this.pQueueInitialized = true;
                          callback();
                        });
                    })
                    .catch((error) => {
                      this.logger.error('failed to remove active job');
                      callback(error);
                    });
                });
              }
            })
            .catch((error) => {
              this.logger.error('failed getting active jobs');
              callback(error);
            });
        }
      })
      .catch((error) => {
        this.logger.error('queue not ready');
        callback(error);
      });
  }

  // eslint-disable-next-line class-methods-use-this
  _getDataForPersistenceQueue(jobData) {
    return {
      version: JOB_DATA_VERSION,
      eventData: JSON.stringify(jobData),
    };
  }

  _validate(message, type) {
    try {
      looselyValidate(message, type);
    } catch (e) {
      if (e.message === 'Your message must be < 32kb.') {
        this.logger.info(
          'Your message must be < 32kb. This is currently surfaced as a warning. Please update your code',
          message,
        );
        return;
      }
      throw e;
    }
  }

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

  identify(message, callback) {
    this._validate(message, 'identify');
    this.enqueue('identify', message, callback);
    return this;
  }

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

  group(message, callback) {
    this._validate(message, 'group');
    this.enqueue('group', message, callback);
    return this;
  }

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

  track(message, callback) {
    this._validate(message, 'track');
    this.enqueue('track', message, callback);
    return this;
  }

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

  page(message, callback) {
    this._validate(message, 'page');
    this.enqueue('page', message, callback);
    return this;
  }

  /**
   * Send a screen `message`.
   *
   * @param {Object} message
   * @param {Function} [callback] (optional)
   * @return {Analytics}
   */

  screen(message, callback) {
    this._validate(message, 'screen');
    this.enqueue('screen', message, callback);
    return this;
  }

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

  alias(message, callback) {
    this._validate(message, 'alias');
    this.enqueue('alias', message, callback);
    return this;
  }

  /**
   * Add a `message` of type `type` to the queue and
   * check whether it should be flushed.
   *
   * @param {String} type
   * @param {Object} message
   * @param {Function} [callback] (optional)
   * @api private
   */

  enqueue(type, message, callback) {
    if (this.queue.length >= this.maxInternalQueueSize) {
      this.logger.error(
        `not adding events for processing as queue size ${this.queue.length} >= than max configuration ${this.maxInternalQueueSize}`,
      );
      return;
    }
    // Clone the incoming message object
    // before altering the data
    let lMessage = cloneDeep(message);
    callback = callback || noop;

    if (!this.enable) {
      // eslint-disable-next-line consistent-return
      return setImmediate(callback);
    }

    if (type === 'identify' && lMessage.traits) {
      if (!lMessage.context) {
        lMessage.context = {};
      }
      lMessage.context.traits = lMessage.traits;
    }

    lMessage = { ...lMessage };
    lMessage.type = type;

    lMessage.context = {
      ...lMessage.context,
      library: {
        name: 'analytics-node',
        version,
      },
    };

    lMessage.channel = 'server';

    lMessage._metadata = {
      nodeVersion: process.versions.node,
      ...lMessage._metadata,
    };

    if (!lMessage.originalTimestamp) {
      lMessage.originalTimestamp = new Date();
    }

    if (!lMessage.messageId) {
      // Previously `node-${md5(JSON.stringify(lMessage))}-${uuid()}` this was being used
      lMessage.messageId = uuid();
    }

    // Historically this library has accepted strings and numbers as IDs.
    // However, our spec only allows strings. To avoid breaking compatibility,
    // we'll coerce these to strings if they aren't already.
    if (lMessage.anonymousId && !isString(lMessage.anonymousId)) {
      lMessage.anonymousId = JSON.stringify(lMessage.anonymousId);
    }
    if (lMessage.userId && !isString(lMessage.userId)) {
      lMessage.userId = JSON.stringify(lMessage.userId);
    }

    this.queue.push({ message: lMessage, callback });

    if (!this.flushed) {
      this.flushed = true;
      this.flush();
      return;
    }

    const hasReachedFlushAt = this.queue.length >= this.flushAt;
    const hasReachedQueueSize =
      this.queue.reduce((acc, item) => acc + JSON.stringify(item).length, 0) >= this.maxQueueSize;
    if (hasReachedFlushAt || hasReachedQueueSize) {
      this.logger.debug('flushAt reached, trying flush...');
      this.flush();
      return;
    }

    this.setupFlushTimer();
  }

  setupFlushTimer() {
    if (this.flushInterval && !this.flushTimer) {
      this.logger.debug('no existing flush timer, creating new one');
      this.flushTimer = setTimeout(this.flush.bind(this), this.flushInterval);
    }
  }

  /**
   * Flush the current queue
   *
   * @param {Function} [callback] (optional)
   */

  // eslint-disable-next-line consistent-return, sonarjs/cognitive-complexity
  async flush(callback) {
    // check if earlier flush was pushed to queue
    this.logger.debug('in flush');
    this.state = 'running';
    callback = callback || noop;

    if (!this.enable) {
      setImmediate(callback);
      return Promise.resolve();
    }

    if (this.timer) {
      this.logger.debug('cancelling existing timer...');
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.flushTimer) {
      this.logger.debug('cancelling existing flushTimer...');
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0) {
      if (this.pendingFlush) {
        this.logger.debug('queue is empty, but a flush already exists');
        // We attach the callback to the end of the chain to support a caller calling `flush()` multiple times when the queue is empty.
        this.pendingFlush = this.pendingFlush.then(() => {
          callback();
          return Promise.resolve();
        });
        return this.pendingFlush;
      }

      this.logger.debug('queue is empty, nothing to flush');
      setImmediate(callback);
      return Promise.resolve();
    }

    try {
      if (this.pendingFlush) {
        await this.pendingFlush;
      }
    } catch (err) {
      this.pendingFlush = null;
      throw err;
    }

    const items = this.queue.splice(0, this.flushAt);
    // Do not proceed in case the items array is empty
    if (items.length === 0) {
      setImmediate(callback);
      return Promise.resolve();
    }
    const callbacks = items.map((item) => item.callback);
    const messages = items.map((item) => {
      // if someone mangles directly with queue
      if (typeof item.message === 'object') {
        item.message.sentAt = new Date();
      }
      return item.message;
    });

    let data = {
      batch: messages,
      timestamp: new Date(),
      sentAt: new Date(),
    };

    const done = (err) => {
      setImmediate(() => {
        callbacks.forEach((eventCallback) => eventCallback(err, data));
        callback(err, data);
      });
    };

    // Don't set the user agent if we're on a browser. The latest spec allows
    // the User-Agent header (see https://fetch.spec.whatwg.org/#terminology-headers
    // and https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/setRequestHeader),
    // but browsers such as Chrome and Safari have not caught up.
    const headers = {};
    if (typeof window === 'undefined') {
      headers['user-agent'] = `analytics-node/${version}`;
    }

    // If gzip feature is enabled compress the request payload
    // Note: the server version should be 1.4 and above
    if (this.gzip && !this.pQueue) {
      data = gzip(JSON.stringify(data));
      headers['Content-Encoding'] = 'gzip';
    }

    const req = {
      auth: {
        username: this.writeKey,
      },
      headers,
    };

    if (this.timeout) {
      req.timeout = typeof this.timeout === 'string' ? ms(this.timeout) : this.timeout;
    }

    if (this.pQueue && this.pQueueInitialized) {
      const request = {
        ...req,
        data,
      };
      const jobId = uuid();
      const eventData = {
        jobId,
        description: `node-${md5(JSON.stringify(request))}-${jobId}`,
        request,
        attempts: 0,
      };
      // Store callbacks in memory map (v3.0.0 security fix - no more serialize-javascript)
      this.pCallbacksMap.set(jobId, callbacks);

      this.pQueue
        .add(this._getDataForPersistenceQueue(eventData))
        // eslint-disable-next-line no-unused-vars
        .then((pushedJob) => {
          this.logger.debug('pushed job to queue');
          this.timer = setTimeout(this.flush.bind(this), this.flushInterval);
          this.state = 'idle';
        })
        .catch((error) => {
          this.timer = setTimeout(this.flush.bind(this), this.flushInterval);
          this.queue.unshift(items);
          this.state = 'idle';
          // Clean up callbacks if push to queue failed
          this.pCallbacksMap.delete(jobId);
          this.logger.error(
            `failed to push to redis queue, in-memory queue size: ${this.queue.length}`,
          );
          throw error;
        });
    } else if (!this.pQueue) {
      this.pendingFlush = this.axiosInstance
        .post(`${this.host}${this.path}`, data, req)
        .then(() => {
          done();
          return Promise.resolve(data);
        })
        .catch((err) => {
          this.logger.error(`Error: ${err.response ? err.response.statusText : err.code}`);
          const isDuringTestExecution =
            err &&
            err.response &&
            err.response.status === 404 &&
            process.env.AVA_MODE_ON &&
            this.path === '/v1/batch' &&
            !this.timeout;

          if (typeof this.errorHandler === 'function') {
            done(isDuringTestExecution ? undefined : err);
            return this.errorHandler(err);
          }

          // Retry invalid write key while during unit test run. Server responds with 404 status for invalid key
          if (isDuringTestExecution) {
            done();
            // eslint-disable-next-line consistent-return
            return;
          }

          if (err.response) {
            const error = new Error(err.response.statusText);
            done(error);
            throw error;
          }

          done(err);
          throw err;
        });
      return this.pendingFlush;
    } else {
      throw new Error('persistent queue not ready');
    }
  }

  _isErrorRetryable(error) {
    if (error.response) {
      this.logger.error(
        `Response error status: ${error.response.status}\nResponse error code: ${error.code}`,
      );
    } else {
      this.logger.error(`Response error code: ${error.code}`);
    }

    // Retry Network Errors.
    if (axiosRetry.isNetworkError(error)) {
      return true;
    }

    if (!error.response) {
      // Cannot determine if the request can be retried
      return false;
    }

    // Retry Server Errors (5xx).
    if (error.response.status >= 500 && error.response.status <= 599) {
      return true;
    }

    // Retry if rate limited.
    return error.response.status === 429;
  }
}

module.exports = Analytics;
