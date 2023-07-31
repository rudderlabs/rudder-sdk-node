const LOG_MSG_PREFIX = 'Rudder';
const LOG_LEVEL_MAP = {
  log: 0,
  info: 1,
  debug: 2,
  warn: 3,
  error: 4,
  none: 5,
};

/**
 * Service to log messages/data to output provider, default is console
 */
class Logger {
  constructor(minLogLevel = 4) {
    this.minLogLevel = minLogLevel;
    this.logProvider = console;
  }

  log(...data) {
    this.outputLog('log', data);
  }

  info(...data) {
    this.outputLog('info', data);
  }

  debug(...data) {
    this.outputLog('debug', data);
  }

  warn(...data) {
    this.outputLog('warn', data);
  }

  error(...data) {
    this.outputLog('error', data);
  }

  outputLog(logMethod, data) {
    if (this.minLogLevel <= LOG_LEVEL_MAP[logMethod]) {
      this.logProvider[logMethod.toLowerCase()](...this.formatLogData(logMethod, data));
    }
  }

  /**
   * Formats the console message
   */
  // eslint-disable-next-line class-methods-use-this
  formatLogData(level, data) {
    if (Array.isArray(data) && data.length > 0) {
      // trim whitespaces for original message
      const originalMsg = typeof data[0] === 'string' ? data[0].trim() : '';

      // prepare the final message
      const timestamp = new Date().toISOString();
      const msg = `${timestamp} [${LOG_MSG_PREFIX}] ${level}: ${originalMsg}`;

      const styledLogArgs = [msg];

      // add first it if it was not a string msg
      if (typeof data[0] !== 'string') {
        styledLogArgs.push(data[0]);
      }

      // append rest of the original arguments
      styledLogArgs.push(...data.slice(1));
      return styledLogArgs;
    }

    return data;
  }
}

module.exports = {
  Logger,
  LOG_LEVEL_MAP,
};
