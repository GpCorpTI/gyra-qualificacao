// backend/logger.js
import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // hide secrets automatically from any logs/requests
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.gyra-client-secret',
      'headers.authorization',
      'gyraClientSecret',
      'password',
      'env.GYRA_CLIENT_SECRET',
    ],
    censor: '[REDACTED]',
  },
  ...(isProd
    ? {} // raw JSON in prod (better for log aggregation)
    : {
        // pretty logs in dev
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' },
        },
      }),
});

export default logger;
