const LEVEL_PRIORITY = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const ACTIVE_LEVEL = LEVEL_PRIORITY[process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')] ?? LEVEL_PRIORITY.info;

const shouldLog = (level) => LEVEL_PRIORITY[level] <= ACTIVE_LEVEL;

const write = (level, message, meta) => {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const payload = meta ? [message, meta] : [message];
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log';
  console[method](`[${ts}] [${level.toUpperCase()}]`, ...payload);
};

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};
