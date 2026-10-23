// Cria um código de acesso gratuito (para família e amigos).
// Uso: npm run acesso -- email@exemplo.com 365 [essencial|plus|premium]
// (o plano decide quantos bancos a pessoa conecta: 0, até 3 ou até 6 — e você paga a Pluggy por eles)
// (lê o APP_SECRET do arquivo .env; também aceita APP_SECRET=... na linha de comando)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signHS, now } from '../server/crypto.js';

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (!process.env.APP_SECRET && fs.existsSync(envFile)) {
  const m = fs.readFileSync(envFile, 'utf8').match(/^\s*APP_SECRET\s*=\s*(.*)\s*$/m);
  if (m) process.env.APP_SECRET = m[1].replace(/^['"]|['"]$/g, '');
}

const [email, days = '365', plan = 'essencial'] = process.argv.slice(2);
if (!email || !process.env.APP_SECRET || !['essencial', 'plus', 'premium'].includes(plan)) {
  console.log('Uso: npm run acesso -- email@exemplo.com [dias] [essencial|plus|premium]   (precisa do APP_SECRET no .env)');
  process.exit(1);
}
const until = now() + Number(days) * 86400;
const token = await signHS({ typ: 'account', kind: 'gift', sub: `gift:${email.toLowerCase()}`, email: email.toLowerCase(), until, iat: now(), plan }, process.env.APP_SECRET);
console.log(`\nCódigo de acesso para ${email} (plano ${plan}, válido por ${days} dias):\n\n${token}\n\nNo app: Assinatura → "Tenho um código de acesso" → colar.\n`);
