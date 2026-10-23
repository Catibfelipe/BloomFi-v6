// Gera as chaves secretas do servidor. Rode uma vez: npm run chaves
import { generateLicenseKeys, randomId } from '../server/crypto.js';

const { priv } = await generateLicenseKeys();
const { priv: vapid } = await generateLicenseKeys(); // chave dos lembretes (notificações)
const secret = randomId(48);
console.log('\nCopie estas variáveis para o Netlify (Site configuration → Environment variables):\n');
console.log(`APP_SECRET=${secret}`);
console.log(`LICENSE_PRIVATE_JWK=${JSON.stringify(priv)}`);
console.log(`VAPID_PRIVATE_JWK=${JSON.stringify(vapid)}`);
console.log('\nGuarde-as em lugar seguro e faça uma cópia. NUNCA troque o APP_SECRET depois do lançamento: ele protege as contas.');
console.log('Se trocar LICENSE_PRIVATE_JWK, o app pede uma licença nova sozinho. Se trocar VAPID_PRIVATE_JWK, cada pessoa liga os lembretes de novo.\n');
