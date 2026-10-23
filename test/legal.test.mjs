// Terms, Privacy and the site footer: the owner's details are filled in at build time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fillLegal, fillSeller } from '../scripts/legal-pages.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; };
const terms = fs.readFileSync(new URL('../legal/termos.html', import.meta.url), 'utf8');
const privacy = fs.readFileSync(new URL('../legal/privacidade.html', import.meta.url), 'utf8');
const site = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const env = { LEGAL_NAME: 'Maria <Exemplo>', LEGAL_ID: '123.456.789-00', LEGAL_ADDRESS: 'Rua das Flores, 100 - São Paulo - SP', SUPPORT_EMAIL: 'suporte@exemplo.com.br' };

ok('missing details keep the highlighted fields and the note', () => {
  const r = fillLegal(terms, {});
  assert.ok(r.missing.includes('ENDEREÇO') && r.missing.includes('CPF/CNPJ'));
  assert.match(r.html, /class="note"/);
});
ok('all details: nothing highlighted, no note, address in both pages, names escaped', () => {
  for (const page of [terms, privacy]) {
    const r = fillLegal(page, env);
    assert.deepEqual(r.missing, []);
    assert.doesNotMatch(r.html, /class="note"|<mark>/);
    assert.match(r.html, /Rua das Flores, 100/);
    assert.match(r.html, /Maria &lt;Exemplo&gt;/);
  }
});
ok('footer: empty until name and CPF/CNPJ exist, then name · CPF/CNPJ · address', () => {
  assert.ok(site.includes('<!--bloomfi:seller-->'));
  const none = fillSeller(site, { LEGAL_NAME: 'Maria' });
  assert.ok(!none.includes('bloomfi:seller') && !none.includes('class="seller"'));
  const full = fillSeller(site, env);
  assert.match(full, /<small class="seller">Maria &lt;Exemplo&gt; · CPF\/CNPJ 123\.456\.789-00 · Rua das Flores, 100 - São Paulo - SP<\/small>/);
});
console.log(`${n} checks passed`);
