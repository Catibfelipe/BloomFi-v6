/**
 * Account e-mails (Resend). Short, plain, in the user's language, never with
 * financial data. E-mail is required online: every account confirms its e-mail
 * with a code. Only the local server (your computer) works without RESEND_API_KEY:
 * the codes then appear in the Terminal window.
 */
import { HttpError } from './services.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml, foot) {
  return `<!doctype html><html><body style="margin:0;background:#0a0d12;padding:24px 12px">
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:460px;margin:auto;padding:26px 22px;background:#14161b;color:#f6f8fb;border-radius:18px;border:1px solid #303540">
    <p style="margin:0 0 14px;font-size:18px;font-weight:800">🦉 BloomFi</p>
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.25">${esc(title)}</h1>
    ${bodyHtml}
    <p style="color:#8d95a4;font-size:12px;margin:22px 0 0;line-height:1.5">${foot}</p>
  </div></body></html>`;
}
const p = (t) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px;color:#dfe5ee">${t}</p>`;
const code = (c) => `<p style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0bf28b;margin:8px 0 16px">${esc(c)}</p>`;
const box = (rows) => `<div style="background:#1b1f27;border:1px solid #303540;border-radius:12px;padding:12px 14px;margin:6px 0 14px;font-size:14px;line-height:1.6;color:#dfe5ee">${rows}</div>`;

const T = {
  pt: {
    foot: 'Você recebeu este e-mail porque ele está ligado a uma conta BloomFi. Nunca pedimos sua senha por e-mail.',
    verify: (c) => ({
      subject: `Seu código BloomFi: ${c}`,
      title: 'Confirme seu e-mail',
      html: p('Use este código para confirmar seu e-mail e terminar de criar sua conta:') + code(c) + p('Ele vale por 15 minutos. Se não foi você, ignore este e-mail.'),
      text: `Seu código BloomFi: ${c}\nVale por 15 minutos. Se não foi você, ignore este e-mail.`,
    }),
    reset: (c) => ({
      subject: `Código para redefinir a senha: ${c}`,
      title: 'Redefinir sua senha',
      html: p('Recebemos um pedido para redefinir a senha da sua conta. Use este código:') + code(c) + p('Vale por 15 minutos. <b>Se não foi você, ignore</b>: sua senha continua a mesma.'),
      text: `Código para redefinir a senha do BloomFi: ${c}\nVale por 15 minutos. Se não foi você, ignore.`,
    }),
    emailChange: (c) => ({
      subject: `Confirme seu novo e-mail: ${c}`,
      title: 'Confirme seu novo e-mail',
      html: p('Use este código para confirmar o novo e-mail da sua conta BloomFi:') + code(c) + p('Vale por 15 minutos.'),
      text: `Código para confirmar o novo e-mail do BloomFi: ${c}`,
    }),
    exists: () => ({
      subject: 'Tentativa de criar conta com seu e-mail',
      title: 'Você já tem uma conta',
      html: p('Alguém (talvez você) tentou criar uma nova conta BloomFi com este e-mail.') + p('Se foi você, é só <b>entrar</b> com sua senha. Se esqueceu, use <b>“Esqueci minha senha”</b> na tela de entrada.') + p('Se não foi você, não precisa fazer nada: sua conta continua protegida.'),
      text: 'Alguém tentou criar uma conta BloomFi com este e-mail. Se foi você, entre com sua senha ou use "Esqueci minha senha". Se não foi você, ignore.',
    }),
    newLogin: (d) => ({
      subject: 'Novo acesso à sua conta BloomFi',
      title: 'Novo acesso à sua conta',
      html: p('Sua conta foi acessada em um aparelho novo:') + box(`<b>${esc(d.device)}</b><br>${esc(d.where)}<br>${esc(d.when)}`)
        + p('Se foi você, tudo certo. <b>Se não foi</b>, abra o BloomFi em Ajustes › Segurança › Aparelhos conectados, toque em <b>“Sair dos outros”</b> e troque sua senha.'),
      text: `Novo acesso à sua conta BloomFi: ${d.device}, ${d.where}, ${d.when}. Se não foi você, saia de todos os aparelhos e troque sua senha.`,
    }),
    passwordChanged: (d) => ({
      subject: 'Sua senha do BloomFi foi alterada',
      title: 'Senha alterada',
      html: p(`A senha da sua conta foi ${d.reset ? 'redefinida' : 'alterada'} em ${esc(d.when)} (${esc(d.device)}).`) + p('Se não foi você, redefina a senha agora pela tela de entrada (“Esqueci minha senha”) e fale com o suporte.'),
      text: `A senha da sua conta BloomFi foi ${d.reset ? 'redefinida' : 'alterada'} em ${d.when}. Se não foi você, redefina agora.`,
    }),
    twoFactor: (d) => ({
      subject: d.on ? 'Verificação em duas etapas ativada' : 'Verificação em duas etapas desativada',
      title: d.on ? 'Verificação em duas etapas ativada ✓' : 'Verificação em duas etapas desativada',
      html: p(d.on ? 'Agora, além da senha, o BloomFi vai pedir o código do seu aplicativo autenticador ao entrar em um aparelho novo.' : 'Sua conta voltou a pedir só a senha. Recomendamos manter a verificação em duas etapas ligada.') + p('Se não foi você, troque sua senha agora.'),
      text: d.on ? 'Verificação em duas etapas ativada na sua conta BloomFi.' : 'Verificação em duas etapas desativada na sua conta BloomFi. Se não foi você, troque sua senha.',
    }),
    suspicious: (d) => ({
      subject: 'Bloqueamos um acesso suspeito à sua conta',
      title: 'Acesso suspeito bloqueado',
      html: p('Detectamos o uso de uma sessão antiga da sua conta (pode indicar que alguém copiou os dados de um aparelho). Por segurança, encerramos essa sessão:') + box(`<b>${esc(d.device)}</b><br>${esc(d.when)}`) + p('Recomendamos trocar sua senha e revisar os aparelhos conectados em Ajustes › Segurança.'),
      text: `Bloqueamos o uso suspeito de uma sessão da sua conta BloomFi (${d.device}, ${d.when}). Troque sua senha e revise os aparelhos conectados.`,
    }),
    loginCode: (c) => ({
      subject: `Código para entrar no BloomFi: ${c}`,
      title: 'Confirme que é você',
      html: p('Houve muitas tentativas de senha errada na sua conta, então pedimos também um código para entrar em um aparelho novo:') + code(c) + p('Vale por 15 minutos. <b>Se não foi você tentando entrar</b>, não passe este código a ninguém e troque sua senha.'),
      text: `Código para entrar no BloomFi: ${c}\nVale por 15 minutos. Se não foi você, não passe este código a ninguém e troque sua senha.`,
    }),
    emailChanged: (d) => ({
      subject: 'O e-mail da sua conta BloomFi foi trocado',
      title: 'E-mail da conta trocado',
      html: p(`O e-mail da sua conta foi trocado para <b>${esc(d.to)}</b> em ${esc(d.when)} (${esc(d.device)}).`) + p('Se não foi você, entre no BloomFi, troque sua senha e saia de todos os aparelhos, ou responda a este e-mail pedindo ajuda.'),
      text: `O e-mail da sua conta BloomFi foi trocado para ${d.to} em ${d.when}. Se não foi você, troque sua senha e saia de todos os aparelhos.`,
    }),
    emailInUse: () => ({
      subject: 'Tentativa de usar seu e-mail no BloomFi',
      title: 'Este e-mail já tem uma conta',
      html: p('Alguém (talvez você) tentou trocar o e-mail de uma conta BloomFi para este endereço, mas ele já pertence a uma conta. Nada foi alterado.') + p('Se não foi você, não precisa fazer nada.'),
      text: 'Alguém tentou trocar o e-mail de uma conta BloomFi para este endereço, que já tem uma conta. Nada foi alterado.',
    }),
    deleted: () => ({
      subject: 'Sua conta BloomFi foi excluída',
      title: 'Conta excluída',
      html: p('Sua conta e os dados guardados no servidor (cópia criptografada, aparelhos, conexões com bancos) foram apagados. A assinatura foi cancelada.') + p('Obrigado por ter usado o BloomFi. 🦉'),
      text: 'Sua conta BloomFi e os dados no servidor foram apagados. A assinatura foi cancelada.',
    }),
  },
  en: {
    foot: 'You got this e-mail because it is linked to a BloomFi account. We never ask for your password by e-mail.',
    verify: (c) => ({
      subject: `Your BloomFi code: ${c}`,
      title: 'Confirm your e-mail',
      html: p('Use this code to confirm your e-mail and finish creating your account:') + code(c) + p('It is valid for 15 minutes. If this wasn’t you, ignore this e-mail.'),
      text: `Your BloomFi code: ${c}\nValid for 15 minutes. If this wasn't you, ignore this e-mail.`,
    }),
    reset: (c) => ({
      subject: `Password reset code: ${c}`,
      title: 'Reset your password',
      html: p('We got a request to reset your account password. Use this code:') + code(c) + p('Valid for 15 minutes. <b>If this wasn’t you, ignore it</b>: your password stays the same.'),
      text: `BloomFi password reset code: ${c}\nValid for 15 minutes. If this wasn't you, ignore it.`,
    }),
    emailChange: (c) => ({
      subject: `Confirm your new e-mail: ${c}`, title: 'Confirm your new e-mail',
      html: p('Use this code to confirm the new e-mail of your BloomFi account:') + code(c), text: `BloomFi new e-mail code: ${c}`,
    }),
    exists: () => ({
      subject: 'Someone tried to sign up with your e-mail', title: 'You already have an account',
      html: p('Someone (maybe you) tried to create a new BloomFi account with this e-mail.') + p('If it was you, just <b>sign in</b>. Forgot the password? Use <b>“Forgot password”</b>.') + p('If it wasn’t you, there is nothing to do.'),
      text: 'Someone tried to create a BloomFi account with this e-mail. If it was you, sign in or use "Forgot password".',
    }),
    newLogin: (d) => ({
      subject: 'New sign-in to your BloomFi account', title: 'New sign-in',
      html: p('Your account was accessed from a new device:') + box(`<b>${esc(d.device)}</b><br>${esc(d.where)}<br>${esc(d.when)}`) + p('If it wasn’t you, open BloomFi › Settings › Security › Signed-in devices, tap <b>“Sign out others”</b> and change your password.'),
      text: `New sign-in to your BloomFi account: ${d.device}, ${d.where}, ${d.when}.`,
    }),
    passwordChanged: (d) => ({
      subject: 'Your BloomFi password was changed', title: 'Password changed',
      html: p(`Your password was ${d.reset ? 'reset' : 'changed'} on ${esc(d.when)} (${esc(d.device)}).`) + p('If this wasn’t you, reset it now from the sign-in screen.'),
      text: `Your BloomFi password was ${d.reset ? 'reset' : 'changed'} on ${d.when}.`,
    }),
    twoFactor: (d) => ({
      subject: d.on ? 'Two-step verification turned on' : 'Two-step verification turned off',
      title: d.on ? 'Two-step verification on ✓' : 'Two-step verification off',
      html: p(d.on ? 'BloomFi will now ask for a code from your authenticator app when signing in on a new device.' : 'Your account asks only for the password again.') + p('If this wasn’t you, change your password now.'),
      text: d.on ? 'Two-step verification turned on.' : 'Two-step verification turned off. If this wasn’t you, change your password.',
    }),
    suspicious: (d) => ({
      subject: 'We blocked a suspicious sign-in', title: 'Suspicious session blocked',
      html: p('An old session of your account was used again (someone may have copied data from a device). We ended it:') + box(`<b>${esc(d.device)}</b><br>${esc(d.when)}`) + p('Please change your password and review your devices.'),
      text: `We blocked a suspicious session of your BloomFi account (${d.device}, ${d.when}).`,
    }),
    loginCode: (c) => ({
      subject: `Code to sign in to BloomFi: ${c}`, title: 'Confirm it’s you',
      html: p('There were many wrong password attempts on your account, so signing in on a new device also needs a code:') + code(c) + p('Valid for 15 minutes. <b>If this wasn’t you</b>, never share this code and change your password.'),
      text: `Code to sign in to BloomFi: ${c}\nValid for 15 minutes. If this wasn't you, never share it and change your password.`,
    }),
    emailChanged: (d) => ({
      subject: 'Your BloomFi e-mail was changed', title: 'Account e-mail changed',
      html: p(`Your account e-mail was changed to <b>${esc(d.to)}</b> on ${esc(d.when)} (${esc(d.device)}).`) + p('If this wasn’t you, open BloomFi, change your password and sign out everywhere, or reply to this e-mail for help.'),
      text: `Your BloomFi e-mail was changed to ${d.to} on ${d.when}. If this wasn't you, change your password and sign out everywhere.`,
    }),
    emailInUse: () => ({
      subject: 'Someone tried to use your e-mail on BloomFi', title: 'This e-mail already has an account',
      html: p('Someone (maybe you) tried to change a BloomFi account’s e-mail to this address, but it already belongs to an account. Nothing was changed.'), text: 'Someone tried to move a BloomFi account to this e-mail, which already has an account. Nothing was changed.',
    }),
    deleted: () => ({
      subject: 'Your BloomFi account was deleted', title: 'Account deleted',
      html: p('Your account and the data kept on our server were deleted, and the subscription was canceled.'), text: 'Your BloomFi account was deleted.',
    }),
  },
};

/** Online, e-mail must be configured; the local server (your computer) shows the codes in the Terminal instead. */
export const emailEnabled = (env) => !!env.resendKey || !!env.localHttp;
const CODE_KINDS = ['verify', 'reset', 'emailChange', 'loginCode'];
const masked = (to) => String(to).replace(/^(.).*?(@.).*$/, '$1•••$2•••');

/** Sends one account e-mail. kind: verify | reset | emailChange | loginCode | exists | emailInUse | newLogin | passwordChanged | emailChanged | twoFactor | suspicious | deleted */
export async function sendAccountEmail(env, to, kind, data = {}, lang = 'pt') {
  // On your computer (local server) the codes also show in the Terminal: testing works even when the e-mail
  // service only delivers to its owner's address (Resend before a domain is verified).
  if (env.localHttp && env.resendKey && CODE_KINDS.includes(kind)) console.log(`[e-mail ${kind}] para ${masked(to)} · código ${data.code}`);
  if (!env.resendKey) {
    if (env.localHttp) {
      if (!env.quiet || CODE_KINDS.includes(kind)) console.log(`[e-mail ${kind}] para ${masked(to)}${CODE_KINDS.includes(kind) ? ` · código ${data.code}` : ''}`);
      return true;
    }
    if (CODE_KINDS.includes(kind)) throw new HttpError(503, 'email_not_configured');
    return false;
  }
  const L = T[lang] || T.pt;
  const m = L[kind](data.code ?? data, data.name);
  const res = await fetch(`${env.resendBase}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.emailFrom, to: [to], subject: m.subject, html: layout(m.title, m.html, L.foot), text: m.text, headers: { 'X-Entity-Ref-ID': `${kind}-${Date.now()}` } }),
  }).catch(() => null);
  if (!res?.ok) {
    // Shows in the Netlify function log (addresses hidden): usually the sending domain isn't verified at Resend
    // yet, and then only the Resend account's own address receives anything.
    const why = res ? String((await res.json().catch(() => ({})))?.message || '').replace(/[^\s@<>()]+@[^\s@<>()]+/g, '•••').slice(0, 200) : '';
    const hint = res?.status === 403 || /domain|verify|testing emails/i.test(why) ? ' — verifique o domínio no Resend e use um remetente dele em EMAIL_FROM' : '';
    if (!env.quiet) console.error(`[e-mail] não enviado (${kind}): ${res ? `Resend respondeu ${res.status}${why ? ` (${why})` : ''}${hint}` : 'sem conexão com o Resend'}`);
    // On your computer the code is already in the Terminal (above): carry on even with an old or invalid key.
    if (env.localHttp && CODE_KINDS.includes(kind)) return true;
    if (CODE_KINDS.includes(kind)) throw new HttpError(502, 'email_failed');
    return false;
  }
  return true;
}
