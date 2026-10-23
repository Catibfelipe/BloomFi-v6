// Phone captures: parsing bank alerts, picking the card/account, avoiding duplicates. Run: node test/capture.test.mjs
import assert from 'node:assert/strict';
import {
  parseCapture, parseMoney, resolveDestination, findDuplicate, linkBankRows, categoryFor, similarity, ruleKeys, capturesToTxs, captureTxId, rulesMap,
} from '../src/lib/capture.js';

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const at = new Date('2026-10-05T15:30:00-03:00').getTime();
const cap = (data, platform = 'ios') => parseCapture({ id: 'x', at, platform, data });

// money
assert.equal(parseMoney('R$ 1.234,56'), 1234.56);
assert.equal(parseMoney('R$23,90'), 23.9);
assert.equal(parseMoney('23.90'), 23.9);
assert.equal(parseMoney(23.9), 23.9);
assert.equal(parseMoney('BRL 1,234.50'), 1234.5);
assert.equal(parseMoney('R$ 5'), 5);
assert.equal(parseMoney('R$ 1.000'), 1000);
assert.equal(parseMoney('sem valor'), null);
ok('amounts in Brazilian and US formats');

// Apple Pay (Shortcuts "Transaction")
let p = cap({ valor: 'R$ 23,90', local: 'Padaria Real', cartao: 'Nubank Ultravioleta' });
assert.equal(p.kind, 'expense'); assert.equal(p.amount, 23.9); assert.equal(p.merchant, 'Padaria Real');
assert.equal(p.card.name, 'Nubank Ultravioleta'); assert.equal(p.bank, 'nubank'); assert.equal(p.source, 'applepay');
p = cap({ amount: 12.5, merchant: 'Starbucks', card: 'Itaú Visa •••• 4821' });
assert.equal(p.amount, 12.5); assert.equal(p.card.last4, '4821'); assert.equal(p.bank, 'itau');
ok('Apple Pay taps (Shortcuts “Transação”)');

// bank notifications (Android MacroDroid / iOS 27 notification trigger)
const cases = [
  [{ app: 'Nubank', titulo: 'Compra aprovada', texto: 'Compra de R$ 45,90 APROVADA em MERCADO BOM para o cartão com final 1234.' }, { kind: 'expense', amount: 45.9, merchant: 'MERCADO BOM', last4: '1234', bank: 'nubank' }],
  [{ app: 'Itaú', titulo: 'Itaú Cartões', texto: 'Compra aprovada no cartão final 9876 de R$ 120,00 em 05/10 às 14:32, POSTO SHELL.' }, { kind: 'expense', amount: 120, last4: '9876', bank: 'itau' }],
  [{ app: 'Inter', titulo: 'Compra no débito', texto: 'Compra de R$ 8,50 no cartão final 1111 em PADARIA PAO QUENTE foi aprovada.' }, { kind: 'expense', amount: 8.5, merchant: 'PADARIA PAO QUENTE', last4: '1111', method: 'debit' }],
  [{ app: 'C6 Bank', titulo: 'Compra aprovada', texto: 'Compra aprovada: R$ 59,90 em NETFLIX.COM no cartão final 2222' }, { kind: 'expense', amount: 59.9, merchant: 'NETFLIX.COM', last4: '2222' }],
  [{ app: 'Mercado Pago', titulo: 'Pagamento aprovado', texto: 'Você pagou R$ 32,00 para Lanchonete da Esquina.' }, { kind: 'expense', amount: 32, merchant: 'Lanchonete da Esquina' }],
  [{ app: 'Nubank', titulo: 'Pix enviado', texto: 'Você enviou um Pix de R$ 150,00 para JOAO DA SILVA.' }, { kind: 'expense', amount: 150, merchant: 'JOAO DA SILVA', method: 'pix' }],
  [{ app: 'Nubank', titulo: 'Pix recebido', texto: 'Você recebeu um Pix de R$ 200,00 de MARIA SOUZA.' }, { kind: 'income', amount: 200, method: 'pix' }],
  [{ app: 'Google Carteira', titulo: 'Padaria Real', texto: 'R$ 23,90 com Nubank •••• 1234' }, { kind: 'expense', amount: 23.9, last4: '1234' }],
  [{ app: 'Bradesco', titulo: 'BRADESCO CARTOES', texto: 'BRADESCO CARTOES: COMPRA APROVADA NO CARTAO FINAL 3333 DE R$ 1.299,00 EM 05/10/2026 14:32 MAGAZINE LUIZA.' }, { kind: 'expense', amount: 1299, last4: '3333' }],
  [{ app: 'Nubank', titulo: 'Estorno', texto: 'Estorno de R$ 30,00 da compra em LOJA X foi creditado no seu cartão.' }, { kind: 'income', amount: 30 }],
];
for (const [data, want] of cases) {
  const r = cap(data, 'android');
  for (const [k, v] of Object.entries(want)) {
    const got = k === 'last4' ? r.card?.last4 : r[k];
    assert.equal(got, v, `${data.texto} -> ${k}`);
  }
}
ok(`bank alerts from ${cases.length} different formats (amount, place, card digits, debit/Pix/income)`);

// iOS 27 Apple Wallet notification: title = card, subtitle = place, body = amount
p = cap({ app: 'Carteira', titulo: 'Nubank Ultravioleta', subtitulo: 'Padaria Real', texto: 'R$ 23,90' });
assert.equal(p.kind, 'expense'); assert.equal(p.merchant, 'Padaria Real'); assert.equal(p.card.name, 'Nubank Ultravioleta');
ok('Apple Wallet notification (iOS 27)');

// things that must NOT become transactions
const ignored = [
  { app: 'Nubank', titulo: 'Compra recusada', texto: 'Sua compra de R$ 89,90 em LOJA Y foi recusada por saldo insuficiente.' },
  { app: 'Itaú', titulo: 'Fatura fechada', texto: 'A fatura do seu cartão fechou: R$ 1.540,22. Vence em 15/10.' },
  { app: 'Banco', titulo: 'Código de verificação', texto: 'Seu código é 482913. Não compartilhe.' },
  { app: 'Nubank', titulo: 'Limite', texto: 'Seu limite disponível agora é R$ 3.000,00.' },
  { app: 'Inter', titulo: 'Oferta', texto: 'Empréstimo pré-aprovado de R$ 10.000,00 para você!' },
  { app: 'WhatsApp', titulo: 'Mãe', texto: 'Comprei pão' },
  { app: 'Nubank', titulo: 'Pix agendado', texto: 'Pix de R$ 50,00 agendado para amanhã.' },
];
for (const data of ignored) assert.equal(cap(data, 'android').kind, 'ignore', data.texto);
ok('declined purchases, bills, codes, limits, offers and chats are ignored');
assert.equal(cap({ teste: '1', valor: '1,00' }).kind, 'test');
ok('a test capture is recognised');

// destination
const accounts = [{ id: 'main', name: 'Conta principal' }, { id: 'nuacc', name: 'Conta Nubank', institution: 'Nubank', last4: '5555' }];
const cards = [{ id: 'nucard', name: 'Nubank Ultravioleta', institution: 'Nubank', last4: '1234' }, { id: 'itcard', name: 'Itaú Click', number: '**** 9876' }];
let d = resolveDestination(cap({ app: 'Nubank', titulo: 'Compra aprovada', texto: 'Compra de R$ 10,00 APROVADA em X para o cartão com final 1234.' }, 'android'), { accounts, cards });
assert.deepEqual(d, { cardId: 'nucard', sure: true });
d = resolveDestination(cap({ app: 'Itaú', texto: 'Compra aprovada no cartão final 9876 de R$ 5,00 em Y.' }, 'android'), { accounts, cards });
assert.equal(d.cardId, 'itcard');
d = resolveDestination(cap({ app: 'Nubank', titulo: 'Pix enviado', texto: 'Você enviou um Pix de R$ 15,00 para Z.' }, 'android'), { accounts, cards });
assert.equal(d.accountId, 'nuacc');
d = resolveDestination(cap({ valor: '9,90', local: 'Café', cartao: 'Nubank Ultravioleta' }), { accounts, cards });
assert.equal(d.cardId, 'nucard');
d = resolveDestination(cap({ valor: '9,90', local: 'Café', cartao: 'Cartão Desconhecido' }), { accounts, cards: [] });
assert.deepEqual(d, { accountId: 'main', sure: false });
const pr = cap({ valor: '9,90', local: 'Café', cartao: 'Cartão Desconhecido' });
const rules = { [ruleKeys(pr)[0]]: 'card:itcard' };
assert.deepEqual(resolveDestination(pr, { accounts, cards, rules }), { cardId: 'itcard', sure: true });
ok('picks the right card/account: last digits, card name, bank, learned rules, safe fallback');

// categories (keyword guess + learned)
assert.equal(categoryFor({ merchant: 'Padaria Real', kind: 'expense' }).category, 'food');
assert.equal(categoryFor({ merchant: 'POSTO SHELL', kind: 'expense' }).category, 'transport');
assert.equal(categoryFor({ merchant: 'Padaria Real', kind: 'expense' }, { 'cat:padaria real': 'coffee' }).category, 'coffee');
ok('category: keyword guess, or what the user taught for that place');

// duplicates
const base = { type: 'expense', amount: 23.9, date: '2026-10-05', description: 'Padaria Real', cardId: 'nucard', at };
const saved = [{ id: 'cap_1', type: 'expense', amount: 23.9, date: '2026-10-05', description: 'Padaria Real', cardId: 'nucard', source: 'capture', capture: { at: at - 60000 } }];
assert.ok(findDuplicate(base, saved), 'same tap from Apple Pay and the bank alert');
assert.equal(findDuplicate({ ...base, at: at + 3 * 3600000 }, saved), null, 'a second coffee three hours later is a new purchase');
assert.ok(findDuplicate(base, [{ id: 'm1', type: 'expense', amount: 23.9, date: '2026-10-05', description: 'padaria', source: 'manual' }]), 'already typed in by hand');
assert.equal(findDuplicate({ ...base, amount: 24.9 }, saved), null);
ok('the same purchase from two alerts (or typed by hand) is not counted twice');

// Open Finance rows linked to captures
const txs = [
  { id: 'cap_a', type: 'expense', amount: 23.9, date: '2026-10-05', description: 'Padaria Real', cardId: 'nucard', source: 'capture', capture: {} },
  { id: 'cap_b', type: 'expense', amount: 59.9, date: '2026-10-04', description: 'NETFLIX.COM', cardId: 'nucard', source: 'capture', capture: {} },
];
const rows = [
  { importId: 'of:1', type: 'expense', amount: 23.9, date: '2026-10-06', description: 'PADARIA REAL LTDA', cardId: 'of:card' },
  { importId: 'of:2', type: 'expense', amount: 59.9, date: '2026-10-04', description: 'NETFLIX.COM', cardId: 'of:card' },
  { importId: 'of:3', type: 'expense', amount: 23.9, date: '2026-10-20', description: 'PADARIA REAL LTDA', cardId: 'of:card' },
  { importId: 'of:4', type: 'expense', amount: 10, date: '2026-10-05', description: 'UBER *TRIP', cardId: 'of:card' },
];
const { links, rest } = linkBankRows(rows, txs);
assert.deepEqual(links.map((l) => [l.captureId, l.row.importId]), [['cap_a', 'of:1'], ['cap_b', 'of:2']]);
assert.deepEqual(rest.map((r) => r.importId), ['of:3', 'of:4']);
ok('bank statement rows match the phone captures (no double counting), the rest is imported');
assert.ok(similarity('PADARIA REAL LTDA', 'Padaria Real') >= 0.99);
assert.ok(similarity('UBER *TRIP', 'Padaria Real') < 0.5);
ok('place-name similarity');

// whole inbox -> transactions
const inbox = [
  { id: 'e1', at, platform: 'ios', data: { valor: 'R$ 23,90', local: 'Padaria Real', cartao: 'Nubank Ultravioleta' } },
  { id: 'e2', at: at + 60000, platform: 'android', data: { app: 'Nubank', titulo: 'Compra aprovada', texto: 'Compra de R$ 23,90 APROVADA em PADARIA REAL para o cartão com final 1234.' } },
  { id: 'e3', at: at + 120000, platform: 'android', data: { app: 'Nubank', titulo: 'Fatura fechada', texto: 'Sua fatura de R$ 900,00 fechou.' } },
  { id: 'e4', at: at + 180000, platform: 'ios', data: { teste: '1' } },
  { id: 'e5', at: at + 240000, platform: 'android', data: { app: 'Nubank', titulo: 'Pix recebido', texto: 'Você recebeu um Pix de R$ 200,00 de MARIA SOUZA.' } },
  { id: 'e6', bad: true, at },
];
const res = capturesToTxs(inbox, { txs: [], accounts, cards, rules: rulesMap([{ kind: 'cat', key: 'padaria real', category: 'coffee' }]) });
assert.equal(res.added.length, 2);
assert.equal(res.added[0].id, captureTxId('e1')); assert.equal(res.added[0].cardId, 'nucard'); assert.equal(res.added[0].category, 'coffee');
assert.equal(res.added[1].type, 'income'); assert.equal(res.added[1].accountId, 'nuacc');
assert.deepEqual(res.log.map((l) => l.status).sort(), ['added', 'added', 'duplicate', 'ignored', 'test', 'unreadable']);
assert.equal(res.tests, 1);
const again = capturesToTxs(inbox.slice(0, 1), { txs: res.added, accounts, cards });
assert.equal(again.added.length, 0, 'an entry opened by two devices becomes one transaction');
ok('inbox → transactions: Apple Pay + bank alert of the same tap = 1 purchase; ignored, test and broken entries logged');

// what the server keeps from each automation's request body
const { parseIngestBody } = await import('../server/wallet.js');
const body = (text, type) => parseIngestBody(new Request('http://x/', { method: 'POST', body: text, headers: type ? { 'Content-Type': type } : {} }));
let b = await body(JSON.stringify({ valor: 'R$ 23,90', local: 'Padaria Real', cartao: 'Nubank', extra: { nested: 1 } }), 'application/json');
assert.deepEqual(b, { valor: 'R$ 23,90', local: 'Padaria Real', cartao: 'Nubank' });
b = await body('valor: R$ 23,90\nlocal: Padaria Real\ncartao: Nubank Ultravioleta', 'text/plain');
assert.deepEqual(b, { valor: 'R$ 23,90', local: 'Padaria Real', cartao: 'Nubank Ultravioleta' });
assert.equal(parseCapture({ id: 'k', at, platform: 'ios', data: b }).amount, 23.9);
b = await body('Nubank\nCompra aprovada\nCompra de R$ 45,50 APROVADA em POSTO SHELL: final 1234', 'text/plain');
assert.deepEqual(b, { app: 'Nubank', titulo: 'Compra aprovada', texto: 'Compra de R$ 45,50 APROVADA em POSTO SHELL: final 1234' });
b = await body('valor=12%2C50&local=Cafe', 'application/x-www-form-urlencoded');
assert.deepEqual(b, { valor: '12,50', local: 'Cafe' });
b = await body('Você pagou R$ 10,00 na Padaria');
assert.deepEqual(b, { texto: 'Você pagou R$ 10,00 na Padaria' });
await assert.rejects(body('x'.repeat(9000), 'text/plain'), (e) => e.code === 'body_too_large');
ok('request bodies: JSON (iPhone), "key: value" text, MacroDroid lines, forms; nested data dropped, size limited');

// The shop's name is written by the shop: it must not decide the kind of message or the amount.
p = cap({ valor: 'R$ 50,00', local: 'Reembolso Facil', cartao: 'Nubank' });
assert.equal(p.kind, 'expense', 'a shop called "Reembolso" is still a purchase');
p = cap({ valor: '-R$ 50,00', local: 'Loja Boa', cartao: 'Nubank' });
assert.equal(p.kind, 'income', 'a negative amount is a refund');
p = cap({ app: 'Nubank', titulo: 'Compra aprovada', texto: 'Compra de R$ 30,00 APROVADA em LOJA DEVOLUCAO para o cartão com final 1234.' }, 'android');
assert.equal(p.kind, 'expense'); assert.equal(p.amount, 30); assert.equal(p.merchant, 'LOJA DEVOLUCAO');
p = cap({ app: 'Itaú', titulo: 'Compra aprovada', texto: 'Compra de R$ 80,00 aprovada em PORTO SEGURO no cartão final 9999.' }, 'android');
assert.equal(p.kind, 'expense', 'a shop called "Porto Seguro" is not an insurance offer'); assert.equal(p.amount, 80);
p = cap({ app: 'Carteira', titulo: 'Nubank', subtitulo: 'LOJA R$ 9.999,99', texto: 'R$ 12,90' });
assert.equal(p.amount, 12.9, 'Apple Wallet alert: the amount is the body, never the shop name');
p = cap({ app: 'Banco', titulo: 'Compra', texto: 'Compra aprovada em LOJA R$ 9.999,99 no valor de R$ 12,90 no cartão final 1234' }, 'android');
assert.equal(p.amount, 12.9, 'the amount the bank names as the value wins');
p = cap({ app: 'Nubank', titulo: 'Pix recebido', texto: 'Você recebeu um Pix de R$ 200,00 de MARIA SILVA.' }, 'android');
assert.equal(p.kind, 'income'); assert.equal(p.amount, 200);
p = cap({ app: 'Nubank', titulo: 'Compra recusada', texto: 'Compra de R$ 20,00 recusada em PADARIA BOA.' }, 'android');
assert.equal(p.kind, 'ignore', 'the bank saying "recusada" still ignores it');
ok('words and amounts inside a shop name never change what a notification means');

{
  const entry = { id: 'entrada-apagada-1', at, platform: 'ios', data: { valor: 'R$ 9,90', local: 'Café', cartao: 'Nubank' } };
  const id = captureTxId(entry.id);
  const r = capturesToTxs([entry], { txs: [], accounts: [{ id: 'main', name: 'Conta' }], cards: [], deleted: new Set([id]) });
  assert.equal(r.added.length, 0);
  ok('a capture delivered again doesn’t bring back a purchase the user deleted');
}

// Google Wallet alerts (the shop is the title) and shop names with tricky words
p = cap({ app: 'Google Wallet', titulo: 'REEMBOLSO SHOP', texto: 'R$ 15,00 com Visa •••• 1234' }, 'android');
assert.equal(p.kind, 'expense'); assert.equal(p.merchant, 'REEMBOLSO SHOP'); assert.equal(p.amount, 15);
p = cap({ app: 'Carteira', titulo: 'LOJA R$ 9.999,99', texto: 'R$ 12,90 com Mastercard •••• 5555' }, 'android');
assert.equal(p.amount, 12.9);
p = cap({ app: 'Google Wallet', titulo: 'PAGSEGURO*PADARIA', texto: 'R$ 8,50 com Visa •••• 1234' }, 'android');
assert.equal(p.kind, 'expense', 'PagSeguro shops are purchases, not insurance offers'); assert.equal(p.amount, 8.5);
p = cap({ app: 'Banco', titulo: 'Compra aprovada', texto: 'Compra de R$ 20,00 aprovada em LOJA, REEMBOLSO no cartão final 1234' }, 'android');
assert.equal(p.doubt, true, 'mixed signals are flagged');
{
  const r = capturesToTxs([{ id: 'duvida-1', at, platform: 'android', data: { app: 'Banco', titulo: 'Compra aprovada', texto: 'Compra de R$ 20,00 aprovada em LOJA, REEMBOLSO no cartão final 1234' } }], { txs: [], accounts: [{ id: 'main', name: 'Conta' }], cards: [] });
  assert.equal(r.added[0].capture.review, true, 'and go to review');
}
ok('Google Wallet alerts take the shop from the title; mixed signals go to review');

console.log(`\n${passed} checks passed`);
