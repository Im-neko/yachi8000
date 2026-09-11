import pino from 'pino';
import { env } from '../config/env.ts';

export const logger = pino({
  level: env.DEBUG_MODE ? 'debug' : 'info',
});
