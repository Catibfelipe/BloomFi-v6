// Shared helpers for server tests: a "device" with its own cookie jar, and account creation.
import assert from 'node:assert/strict';
// Account e-mails answer after a fixed minimum time on the real site; the tests don't wait (auth.test checks it).
process.env.EMAIL_MIN_MS ??= '0';
import { deriveMaster, authKeyOf, createAccountKeys, b64u, rand } from '../src/lib/keys.js';

// The weakest settings the server accepts (Argon2id, 64 MiB, 3 passes).
export const FAST_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };
export const UAS = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  thief: 'curl/8.0',
};

export function makeDevice(handle, origin = 'https://app.test') {
  return function device(kind) {
    const cookies = {};
    const call = async (method, p, body, extra = {}) => {
      const headers = { 'Content-Type': 'application/json', 'X-BloomFi': '1', Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'User-Agent': UAS[kind] || kind, ...extra };
      const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar && !('cookie' in extra)) headers.cookie = jar;
      for (const [k, v] of Object.entries(headers)) if (v == null) delete headers[k];
      const r = await handle(new Request(`${origin}/api/${p}`, { method, headers, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));
      await handle.lastBackground; // e-mails are sent in the background: wait for them like a person would
      for (const sc of r.headers.getSetCookie()) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (/Max-Age=0/.test(sc) || !v) delete cookies[k]; else cookies[k] = v;
      }
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, data, headers: r.headers };
    };
    return { call, cookies, kind };
  };
}

/** Everything a real device does to create an account (e-mail code read from the fake Resend). */
export async function signup(dev, state, { name, email, password, legacy } = {}) {
  const kdf = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
  const master = await deriveMaster(password, kdf);
  let r = await dev.call('POST', 'auth/signup', { name, email, kdf, authKey: await authKeyOf(master), lang: 'pt' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (r.data.verify) {
    r = await dev.call('POST', 'auth/signup/verify', { challengeId: r.data.challengeId, code: state.lastCodes.get(email) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const bundle = await createAccountKeys(master, r.data.share);
  r = await dev.call('POST', 'auth/signup/finish', { ticket: r.data.ticket, keys: bundle.keys, device: { name: `Teste ${dev.kind}`, platform: 'ios' }, legacy });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { master, kdf, bundle, login: r.data };
}
