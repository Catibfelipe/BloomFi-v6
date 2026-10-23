/**
 * Fake Stripe + Pluggy + Resend for local testing. Nothing here talks to
 * the real services. Used by scripts/servidor-local.mjs when FAKE=1.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

const sha1 = (t) => createHash('sha1').update(t).digest('hex').toUpperCase();
/** Passwords the fake "Have I Been Pwned" says were leaked. */
export const PWNED_TEST_PASSWORDS = ['vazada-de-teste-123', 'Senha@Vazada2026'];

const rid = (p) => `${p}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`;
const nowS = () => Math.floor(Date.now() / 1000);

export function createFakeState() {
  return {
    sessions: new Map(), customers: new Map(), subs: new Map(),
    connectTokens: new Map(), items: new Map(), accounts: new Map(), lastCodes: new Map(),
    pushes: [], pushGone: new Set(), emails: [], patched: [], canceled: [], allSubs: [], cancelParams: [], subUpdates: [], cardDeclined: false,
    pwned: new Map(PWNED_TEST_PASSWORDS.map((p) => [sha1(p), 1234])),
  };
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  req.rawBody = Buffer.concat(chunks);
  const raw = req.rawBody.toString();
  if (!raw) return {};
  if (!/json|form/.test(req.headers['content-type'] || '')) return {};
  if ((req.headers['content-type'] || '').includes('application/json')) return JSON.parse(raw);
  // Stripe form encoding -> flat map
  return Object.fromEntries(new URLSearchParams(raw));
}

function customerFor(state, email) {
  for (const c of state.customers.values()) if (c.email === email) return c;
  const c = { id: rid('cus_'), email };
  state.customers.set(c.id, c);
  return c;
}

function demoTransactions(accountId, kind) {
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString();
  if (kind === 'CREDIT') {
    return [
      { id: rid('tx_'), accountId, description: 'IFOOD *RESTAURANTE', amount: 58.9, date: d(2), type: 'DEBIT', category: 'Food and drinks', status: 'POSTED' },
      { id: rid('tx_'), accountId, description: 'UBER *TRIP', amount: 23.4, date: d(3), type: 'DEBIT', category: 'Transportation', status: 'POSTED' },
      { id: rid('tx_'), accountId, description: 'NETFLIX.COM', amount: 55.9, date: d(6), type: 'DEBIT', category: 'Entertainment', status: 'POSTED' },
      { id: rid('tx_'), accountId, description: 'Pagamento recebido', amount: -812.3, date: d(8), type: 'CREDIT', category: 'Credit card payment', status: 'POSTED' },
    ];
  }
  return [
    { id: rid('tx_'), accountId, description: 'Salario EMPRESA XPTO', amount: 5200, date: d(4), type: 'CREDIT', category: 'Salary', status: 'POSTED' },
    { id: rid('tx_'), accountId, description: 'Aplicacao RDB', amount: -800, date: d(4), type: 'DEBIT', category: 'Investments', status: 'POSTED' },
    { id: rid('tx_'), accountId, description: 'Pagamento de fatura', amount: -812.3, date: d(8), type: 'DEBIT', category: 'Credit card payment', status: 'POSTED' },
    { id: rid('tx_'), accountId, description: 'Supermercado Pao de Acucar', amount: -287.45, date: d(5), type: 'DEBIT', category: 'Groceries', status: 'POSTED' },
    { id: rid('tx_'), accountId, description: 'Conta de luz ENEL', amount: -189.9, date: d(7), type: 'DEBIT', category: 'Utilities', status: 'POSTED' },
    { id: rid('tx_'), accountId, description: 'Resgate RDB', amount: 150, date: d(1), type: 'CREDIT', category: 'Investments', status: 'POSTED' },
  ];
}

export function startFakeServices(port, state = createFakeState()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    const body = await readBody(req).catch(() => ({}));

    // ---------- test helpers ----------
    if (p === '/__last_code') return send(res, 200, { code: state.lastCodes.get(url.searchParams.get('email')) || null });
    if (p === '/__emails') {
      const to = url.searchParams.get('to');
      return send(res, 200, { emails: state.emails.filter((e) => !to || e.to === to).map(({ to: t, subject, text, at }) => ({ to: t, subject, text, at })) });
    }
    // ---------- Have I Been Pwned ----------
    const hm = p.match(/^\/range\/([0-9A-F]{5})$/);
    if (hm) {
      const lines = [...state.pwned.entries()].filter(([h]) => h.startsWith(hm[1])).map(([h, n]) => `${h.slice(5)}:${n}`);
      lines.push('0000000000000000000000000000000000A:0'); // padding line, like the real API
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(lines.join('\r\n'));
    }
    // Fake browser push service: keeps what it receives so tests can decrypt and check it.
    const pm = p.match(/^\/push\/([\w-]+)$/);
    if (pm && req.method === 'POST') {
      if (state.pushGone.has(pm[1])) { res.writeHead(410); return res.end(); }
      state.pushes.push({ id: pm[1], headers: req.headers, body: (req.rawBody || Buffer.alloc(0)).toString('base64'), at: Date.now() });
      res.writeHead(201); return res.end();
    }
    if (p === '/__pushes' && req.method === 'GET') return send(res, 200, { pushes: state.pushes.map((x) => ({ id: x.id, auth: x.headers.authorization, encoding: x.headers['content-encoding'], ttl: x.headers.ttl, body: x.body })) });
    if (p === '/__set_sub' && req.method === 'POST') {
      const sub = [...state.subs.values()].find((s) => s.customer === body.customer);
      if (sub) Object.assign(sub, body.patch);
      return send(res, 200, sub || {});
    }
    if (p === '/__create_item' && req.method === 'POST') {
      const clientUserId = state.connectTokens.get(body.connectToken);
      if (!clientUserId) return send(res, 400, { message: 'bad token' });
      const item = {
        id: rid('item-'), clientUserId, status: 'UPDATED', executionStatus: 'SUCCESS', createdAt: body.createdAt || new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(), connector: { id: 0, name: 'Pluggy Bank (sandbox)', primaryColor: 'ef294b', imageUrl: '', ...(body.sandbox ? { isSandbox: true } : {}) },
      };
      state.items.set(item.id, item);
      const bank = { id: rid('acc-'), itemId: item.id, type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta corrente', number: '1234-5', balance: 3120.5, currencyCode: 'BRL' };
      const card = {
        id: rid('acc-'), itemId: item.id, type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Cartão Gold', number: '4321', balance: 137.2, currencyCode: 'BRL',
        creditData: { creditLimit: 8000, availableCreditLimit: 7862.8, brand: 'MASTERCARD', balanceCloseDate: '2026-10-28T00:00:00.000Z', balanceDueDate: '2026-11-07T00:00:00.000Z' },
      };
      bank.txs = demoTransactions(bank.id, 'BANK');
      card.txs = demoTransactions(card.id, 'CREDIT');
      state.accounts.set(bank.id, bank);
      state.accounts.set(card.id, card);
      return send(res, 200, { item });
    }

    // ---------- Stripe ----------
    if (p.startsWith('/v1/')) {
      if (!String(req.headers.authorization || '').startsWith('Bearer sk_')) return send(res, 401, { error: { message: 'bad key' } });
      if (p === '/v1/checkout/sessions' && req.method === 'POST') {
        const email = body.customer_email || state.customers.get(body.customer)?.email || 'cliente@exemplo.com';
        const customer = body.customer ? state.customers.get(body.customer) : customerFor(state, email);
        const id = rid('cs_test_');
        const trialEnd = Number(body['subscription_data[trial_end]'] || 0);
        // Simulate the person paying: create the subscription (the latest one is what __set_sub changes).
        const end = nowS() + 30 * 86400;
        const sub = {
          id: rid('sub_'), customer: customer.id, status: trialEnd ? 'trialing' : 'active', cancel_at_period_end: false,
          items: { data: [{ current_period_end: trialEnd || end }] }, created: nowS(),
          metadata: { plan: body['subscription_data[metadata][plan]'] || undefined },
        };
        state.subs.set(customer.id, sub);
        state.allSubs.unshift(sub);
        const s = { id, status: 'complete', customer: customer.id, customer_details: { email }, client_reference_id: body.client_reference_id || null, trialEnd, params: body, subscription: sub.id };
        state.sessions.set(id, s);
        return send(res, 200, { id, url: body.success_url.replace('{CHECKOUT_SESSION_ID}', id) });
      }
      const sm = p.match(/^\/v1\/checkout\/sessions\/(.+)$/);
      if (sm) return state.sessions.has(sm[1]) ? send(res, 200, state.sessions.get(sm[1])) : send(res, 404, { error: { message: 'no session' } });
      if (p === '/v1/subscriptions') {
        const c = url.searchParams.get('customer');
        const list = state.allSubs.filter((x) => x.customer === c);
        const latest = state.subs.get(c); // tests may set it directly
        if (latest && !list.includes(latest)) list.unshift(latest);
        return send(res, 200, { data: list });
      }
      if (p === '/v1/customers' && req.method === 'POST') {
        const c = { id: rid('cus_'), email: body.email || null, metadata: { userId: body['metadata[userId]'] || null } };
        state.customers.set(c.id, c);
        return send(res, 200, c);
      }
      if (p === '/v1/customers') {
        const email = url.searchParams.get('email');
        return send(res, 200, { data: [...state.customers.values()].filter((c) => c.email === email) });
      }
      const dm = p.match(/^\/v1\/subscriptions\/(.+)$/);
      if (dm && req.method === 'POST') {
        const sub = state.allSubs.find((x) => x.id === dm[1]) || [...state.subs.values()].find((x) => x.id === dm[1]);
        if (!sub) return send(res, 404, { error: { message: 'No such subscription' } });
        state.subUpdates.push({ id: sub.id, ...body });
        if (body.trial_end === 'now') {
          if (state.cardDeclined) return send(res, 402, { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } });
          Object.assign(sub, { status: 'active', items: { data: [{ current_period_end: nowS() + 30 * 86400 }] } });
        }
        return send(res, 200, sub);
      }
      if (dm && req.method === 'DELETE') {
        const sub = state.allSubs.find((x) => x.id === dm[1]) || [...state.subs.values()].find((x) => x.id === dm[1]);
        if (sub) { sub.status = 'canceled'; state.canceled.push(sub.id); state.cancelParams.push({ id: sub.id, ...body }); }
        return send(res, 200, sub || { id: dm[1], status: 'canceled' });
      }
      if (p === '/v1/billing_portal/sessions') {
        if (state.noPortal) return send(res, 400, { error: { message: 'No configuration provided and your test mode default configuration has not been created. Provide a configuration or create your default by saving your customer portal settings in test mode at https://dashboard.stripe.com/test/settings/billing/portal.' } });
        return send(res, 200, { url: `${body.return_url}?portal=fake` });
      }
      return send(res, 404, { error: { message: 'unknown stripe path' } });
    }

    // ---------- Resend ----------
    if (p === '/emails' && req.method === 'POST') {
      if (state.emailDown) return send(res, 500, { message: 'down' });
      const code = (body.subject || '').match(/(\d{6})/)?.[1];
      if (code) state.lastCodes.set(body.to?.[0], code);
      state.emails.push({ to: body.to?.[0], subject: body.subject, text: body.text, html: body.html, at: Date.now() });
      return send(res, 200, { id: rid('em_') });
    }

    // ---------- Pluggy ----------
    if (p === '/auth' && req.method === 'POST') {
      return body.clientId === 'fake-id' ? send(res, 200, { apiKey: 'pk_fake' }) : send(res, 401, { message: 'bad credentials' });
    }
    if (req.headers['x-api-key'] !== 'pk_fake') return send(res, 401, { message: 'no api key' });
    if (p === '/connect_token' && req.method === 'POST') {
      const token = rid('ct_');
      state.connectTokens.set(token, body.options?.clientUserId);
      state.lastConnectOptions = body.options || {};
      return send(res, 200, { accessToken: token });
    }
    const im = p.match(/^\/items\/(.+)$/);
    if (im) {
      const item = state.items.get(im[1]);
      if (!item) return send(res, 404, { message: 'not found' });
      if (req.method === 'DELETE') { state.items.delete(im[1]); res.writeHead(204); return res.end(); }
      if (req.method === 'PATCH') { state.patched.push(im[1]); item.status = 'UPDATING'; return send(res, 200, item); }
      return send(res, 200, item);
    }
    if (p === '/accounts') {
      const itemId = url.searchParams.get('itemId');
      return send(res, 200, { results: [...state.accounts.values()].filter((a) => a.itemId === itemId).map(({ txs, ...a }) => a) });
    }
    const am = p.match(/^\/accounts\/(.+)$/);
    if (am) {
      const a = state.accounts.get(am[1]);
      if (!a) return send(res, 404, { message: 'not found' });
      const { txs, ...rest } = a;
      return send(res, 200, rest);
    }
    if (p === '/v2/transactions') {
      const a = state.accounts.get(url.searchParams.get('accountId'));
      const all = a?.txs || [];
      // two pages, to exercise the cursor
      const after = url.searchParams.get('after');
      if (!after) return send(res, 200, { results: all.slice(0, 3), next: all.length > 3 ? `?accountId=${a.id}&after=3` : null });
      return send(res, 200, { results: all.slice(Number(after)), next: null });
    }
    if (p === '/investments') {
      const itemId = url.searchParams.get('itemId');
      if (!state.items.has(itemId)) return send(res, 200, { results: [] });
      return send(res, 200, {
        results: [
          { id: `${itemId}-inv1`, itemId, name: 'Tesouro Selic 2029', type: 'FIXED_INCOME', subtype: 'TREASURY', balance: 10450.32, amount: 10500, amountOriginal: 10000, amountProfit: 450.32, date: new Date().toISOString(), status: 'ACTIVE' },
          { id: `${itemId}-inv2`, itemId, name: 'CDB Banco X 110% CDI', type: 'FIXED_INCOME', subtype: 'CDB', balance: 5320.1, amount: 5400, amountOriginal: 5000, amountProfit: 320.1, date: new Date().toISOString(), status: 'ACTIVE' },
          { id: `${itemId}-inv3`, itemId, name: 'MXRF11', type: 'EQUITY', subtype: 'REAL_ESTATE_FUND', balance: 1980, amount: 1980, amountOriginal: 2100, amountProfit: -120, date: new Date().toISOString(), status: 'ACTIVE' },
        ],
      });
    }
    return send(res, 404, { message: `unknown path ${p}` });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, state })));
}
