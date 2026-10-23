// All BloomFi API routes except sign-in (auth.mjs) and phone captures (wallet-in.mjs).
// Every new route must be listed here too (test/netlify-paths.test.mjs checks it).
import { handle } from '../../server/handler.js';

export default (req, context) => handle(req, context);

export const config = {
  path: [
    '/api/config', '/api/license', '/api/billing/*', '/api/of/*', '/api/push', '/api/push/*', '/api/sync',
    '/api/account/*', '/api/wallet/tokens', '/api/wallet/inbox', '/api/wallet/ack',
    // v6: Wally with AI and the shared spaces (Family & couple)
    '/api/ai/*', '/api/spaces', '/api/spaces/*',
  ],
  rateLimit: { windowLimit: 180, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
