/**
 * Terms of Use and Privacy Policy (legal/*.html) with the owner's details filled in at build time,
 * from the same environment variables as the server (Netlify → Environment variables, or .env):
 *
 *   LEGAL_NAME     your name or company name (razão social)
 *   LEGAL_ID       CPF or CNPJ
 *   LEGAL_ADDRESS  street address (Brazil's e-commerce decree asks sites to show it; also in the site footer)
 *   SUPPORT_EMAIL  support e-mail (also shown in the app)
 *   DPO_NAME / DPO_EMAIL  optional: the data protection officer (encarregado); defaults to the two above
 *
 * While something is missing, the page keeps the highlighted field and the "fill in" note, and the build
 * prints a warning. Nothing here is secret: it is what the pages show to everyone.
 */
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

export function fillLegal(html, env) {
  const name = (env.LEGAL_NAME || '').trim();
  const id = (env.LEGAL_ID || '').trim();
  const address = (env.LEGAL_ADDRESS || '').trim();
  const support = (env.SUPPORT_EMAIL || '').trim();
  const dpoName = (env.DPO_NAME || '').trim() || name;
  const dpoEmail = (env.DPO_EMAIL || '').trim() || support;
  const fields = {
    'SEU NOME OU RAZÃO SOCIAL': name,
    'CPF/CNPJ': id,
    'ENDEREÇO': address,
    'E-MAIL DE SUPORTE': support,
    NOME: dpoName,
    'E-MAIL': dpoEmail,
    'E-MAIL DO ENCARREGADO': dpoEmail,
  };
  let out = html.replace(/<mark>\[([^\]]+)\]<\/mark>/g, (all, key) => {
    const v = fields[key];
    if (!v) return all;
    return EMAIL.test(v) ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v);
  });
  const missing = [...new Set([...out.matchAll(/<mark>\[([^\]]+)\]<\/mark>/g)].map((m) => m[1]))];
  if (!missing.length) out = out.replace(/<p class="note">[\s\S]*?<\/p>\n?/, '');
  return { html: out, missing };
}

/** Site footer: who sells (name, CPF/CNPJ, address), shown once the details exist. */
export function fillSeller(html, env) {
  const name = (env.LEGAL_NAME || '').trim();
  const id = (env.LEGAL_ID || '').trim();
  const address = (env.LEGAL_ADDRESS || '').trim();
  const line = name && id ? `<small class="seller">${[name, `CPF/CNPJ ${id}`, address].filter(Boolean).map(esc).join(' · ')}</small>` : '';
  return html.replace('<!--bloomfi:seller-->', line);
}

/** Vite plugin: emits termos.html and privacidade.html (filled) next to the site pages, and fills the site footer. */
export default function legalPages(env, { dir = 'legal' } = {}) {
  return {
    name: 'bloomfi-legal-pages',
    transformIndexHtml(html) {
      return html.includes('<!--bloomfi:seller-->') ? fillSeller(html, env) : html;
    },
    // npm run dev: the same pages, filled the same way.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = (req.url || '').split('?')[0].slice(1);
        if (file !== 'termos.html' && file !== 'privacidade.html') return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(fillLegal(fs.readFileSync(path.resolve(dir, file), 'utf8'), env).html);
      });
    },
    generateBundle() {
      const warn = [];
      for (const file of ['termos.html', 'privacidade.html']) {
        const src = path.resolve(dir, file);
        if (!fs.existsSync(src)) continue;
        const { html, missing } = fillLegal(fs.readFileSync(src, 'utf8'), env);
        if (missing.length) warn.push(`${file}: ${missing.join(', ')}`);
        this.emitFile({ type: 'asset', fileName: file, source: html });
      }
      if (warn.length) {
        console.warn(`\n⚠️  Termos e Privacidade ainda com campos em branco (${warn.join(' · ')}).\n   Cadastre LEGAL_NAME, LEGAL_ID, LEGAL_ADDRESS e SUPPORT_EMAIL nas variáveis do Netlify e publique de novo.\n`);
      }
    },
  };
}
