// Phone automations (iPhone Shortcuts, Android MacroDroid) post each payment here.
import { handle } from '../../server/handler.js';

export default (req, context) => handle(req, context);

export const config = {
  path: ['/api/wallet/in/*'],
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
