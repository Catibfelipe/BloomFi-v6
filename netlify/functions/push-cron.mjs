// Sends due bill reminders once an hour.
import { runPushCron } from '../../server/handler.js';

export default async () => {
  const r = await runPushCron();
  console.log('[push-cron]', JSON.stringify(r));
  return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '@hourly' };
