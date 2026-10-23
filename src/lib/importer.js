/**
 * Bank statement importer. Works fully offline with the files that
 * practically every bank lets you download: OFX (Money/extrato) and CSV.
 */
import { parseAmount } from './format.js';
import { classifyMovement } from './categories.js';

const pad = (n) => String(n).padStart(2, '0');

export function parseDate(raw) {
  const s = String(raw || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`; // OFX 20240115...
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    let [, a, b, y] = m;
    if (y.length === 2) y = `20${y}`;
    // dd/mm/yyyy by default; switch to mm/dd when the first part can't be a month-day combo
    let d = Number(a), mo = Number(b);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------- OFX ----------
function ofxField(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

export function parseOFX(text) {
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]);
  return blocks.map((b) => {
    const amount = parseFloat(ofxField(b, 'TRNAMT').replace(',', '.'));
    const date = parseDate(ofxField(b, 'DTPOSTED'));
    const description = ofxField(b, 'MEMO') || ofxField(b, 'NAME') || ofxField(b, 'PAYEE') || '—';
    const fitid = ofxField(b, 'FITID');
    return { amount, date, description, importId: fitid ? `ofx:${fitid}:${date}:${amount}` : null };
  }).filter((r) => r.date && !Number.isNaN(r.amount));
}

// ---------- CSV ----------
function splitCSVLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === delim && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export function parseCSV(text, lang = 'pt') {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], error: 'empty' };
  const first = lines[0];
  const delim = [';', ',', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];

  // find header row (some banks put a title above it)
  let hIdx = lines.findIndex((l) => /data|date/i.test(l) && /(valor|amount|value|quantia|montante)/i.test(l));
  if (hIdx < 0) hIdx = 0;
  const headers = splitCSVLine(lines[hIdx], delim).map(norm);
  const find = (...names) => {
    for (const n of names) { const i = headers.findIndex((h) => h === n); if (i >= 0) return i; }
    for (const n of names) { const i = headers.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
    return -1;
  };

  const iDate = find('data', 'date', 'dt');
  const iAmount = find('valor', 'amount', 'value', 'quantia', 'montante');
  const iCredit = find('credito', 'credit', 'entrada');
  const iDebit = find('debito', 'debit', 'saida');
  const iDesc = find('descricao', 'description', 'historico', 'title', 'titulo', 'estabelecimento', 'memo', 'lancamento', 'detalhe', 'name', 'payee');
  if (iDate < 0 || (iAmount < 0 && iCredit < 0 && iDebit < 0)) return { rows: [], error: 'columns' };

  const rows = [];
  for (const line of lines.slice(hIdx + 1)) {
    const c = splitCSVLine(line, delim);
    const date = parseDate(c[iDate]);
    if (!date) continue;
    let amount;
    if (iAmount >= 0 && c[iAmount] !== undefined && c[iAmount] !== '') amount = parseAmount(c[iAmount], lang);
    else {
      const cr = iCredit >= 0 ? parseAmount(c[iCredit], lang) : NaN;
      const db = iDebit >= 0 ? parseAmount(c[iDebit], lang) : NaN;
      amount = (Number.isNaN(cr) ? 0 : Math.abs(cr)) - (Number.isNaN(db) ? 0 : Math.abs(db));
    }
    if (Number.isNaN(amount) || amount === 0) continue;
    const description = (iDesc >= 0 ? c[iDesc] : '') || '—';
    rows.push({ amount, date, description, importId: `csv:${hash(`${date}|${amount}|${description}`)}` });
  }
  return { rows, error: rows.length ? null : 'empty' };
}

/** Turns raw rows into transactions ready for preview. */
export function toTransactions(rows, { positiveIsExpense = false } = {}) {
  const seen = {};
  return rows.map((r) => {
    const amt = positiveIsExpense ? -r.amount : r.amount;
    // Money sent to investments is a debit ("invest"), redemptions come back ("redeem").
    const { type, category } = classifyMovement(r.description, amt);
    // identical rows on the same day (two coffees) get distinct ids
    const base = r.importId || `row:${hash(`${r.date}|${r.amount}|${r.description}`)}`;
    seen[base] = (seen[base] || 0) + 1;
    return {
      type, amount: Math.abs(amt), date: r.date, description: r.description.replace(/\s+/g, ' ').slice(0, 80),
      category, importId: seen[base] > 1 ? `${base}#${seen[base]}` : base,
      selected: true,
    };
  });
}

export function parseStatement(text, filename, lang) {
  if (/<OFX>|<STMTTRN>/i.test(text) || /\.ofx$|\.qfx$/i.test(filename)) {
    const rows = parseOFX(text);
    return { rows, kind: 'ofx', error: rows.length ? null : 'empty' };
  }
  return { ...parseCSV(text, lang), kind: 'csv' };
}

/** Reads a File trying UTF-8 first and falling back to Windows-1252 (common in BR bank files). */
export async function readFileText(file) {
  const buf = await file.arrayBuffer();
  const utf = new TextDecoder('utf-8').decode(buf);
  if (!utf.includes('�')) return utf;
  try { return new TextDecoder('windows-1252').decode(buf); } catch { return utf; }
}
