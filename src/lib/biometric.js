/**
 * Face ID / Touch ID / fingerprint unlock using WebAuthn with the PRF
 * extension. PRF gives a secret that only the device's secure hardware can
 * produce after the user's biometric check; that secret unwraps the data
 * key. Devices without PRF can't use biometrics (we never fake it).
 */
import { rand } from './vault.js';

const toBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

export async function biometricAvailable() {
  try {
    if (!window.PublicKeyCredential || !window.isSecureContext) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function evaluate(credId, prfSalt) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: toBuf(rand(32)),
      allowCredentials: [{ type: 'public-key', id: toBuf(credId) }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: toBuf(prfSalt) } } },
    },
  });
  const out = cred?.getClientExtensionResults?.().prf?.results?.first;
  if (!out) throw Object.assign(new Error('prf-unsupported'), { code: 'prf-unsupported' });
  return new Uint8Array(out);
}

/** Creates a passkey on this device and returns what the vault needs. */
export async function registerBiometric(userName = 'BloomFi') {
  const prfSalt = rand(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'BloomFi' },
      user: { id: toBuf(rand(16)), name: userName, displayName: userName },
      challenge: toBuf(rand(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
      extensions: { prf: { eval: { first: toBuf(prfSalt) } } },
    },
  });
  const ext = cred.getClientExtensionResults?.() || {};
  if (ext.prf?.enabled === false) throw Object.assign(new Error('prf-unsupported'), { code: 'prf-unsupported' });
  const credId = new Uint8Array(cred.rawId);
  let secret = ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : null;
  if (!secret) secret = await evaluate(credId, prfSalt); // some platforms only answer on get()
  return { credId, prfSalt, secret };
}

export async function biometricSecret({ credId, prfSalt }) {
  return evaluate(credId, prfSalt);
}
