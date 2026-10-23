// Sign-up, sign-in, codes and password reset: a much stricter rate limit stops guessing
// (the server also keeps its own per-account limits and lockouts).
import { handle } from '../../server/handler.js';

export default (req, context) => handle(req, context);

export const config = {
  path: ['/api/auth/*'],
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
