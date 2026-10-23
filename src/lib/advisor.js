/**
 * Wally — the money owl. A local, private advisor: it reads the user's real
 * numbers from the on-device database and answers with simple rules.
 * No internet, no data leaves the device.
 */
import { goalInfo } from './finance.js';
import { portfolio } from './investments.js';

const has = (s, ...words) => words.some((w) => s.includes(w));
const clean = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function advisorPrompts(lang) {
  return lang === 'pt'
    ? ['Quanto vai sobrar no fim do mês?',
       'Como está a fatura do meu cartão?',
       'Vivo no aperto até o próximo salário — por onde começo?',
       'Tenho dívida no cartão de crédito. Como saio dessa?',
       'Como economizar quando quase não sobra nada?',
       'O que é a regra 50/30/20 e ela serve pra mim?',
       'Para onde foi meu dinheiro este mês?',
       'Como estão minhas metas?',
       'Como está minha carteira de investimentos?']
    : ['How much will be left at the end of the month?',
       'How is my credit card statement looking?',
       'I’m living paycheck to paycheck — where do I start?',
       'I have credit card debt. Help me get out.',
       'How do I save money when I have almost nothing left?',
       'What’s the 50/30/20 rule and does it work for me?',
       'Where did my money go this month?',
       'How are my goals doing?',
       'How is my investment portfolio doing?'];
}

export function wallyReply(input, ctx) {
  const { a, goals, money, lang, name, t, assets = [], txs = [], ledger = null, projection = null } = ctx;
  const pt = lang === 'pt';
  const L = (p, e) => (pt ? p : e);
  const q = clean(input);
  const s = a.sum;
  const hi = name ? `${name}, ` : '';
  const hasData = s.count > 0;
  const catName = (k) => t(`cat.${k}`);
  const top3 = s.byCategory.slice(0, 3).map((c) => `• ${catName(c.key)}: ${money(c.amount)} (${Math.round(c.pct)}%)`).join('\n');
  const needData = L(
    'Ainda não tenho números deste mês pra analisar. Registre seus gastos e sua renda (botão +) ou importe o extrato do banco, e eu te digo exatamente onde agir.',
    'I don’t have numbers for this month yet. Log your spending and income (the + button) or import a bank statement, and I’ll tell you exactly where to act.'
  );

  // ---- intents ----
  if (has(q, 'obrigad', 'valeu', 'thank', 'thx')) {
    return L('Disponha. Coruja sábia não cobra consultoria. 🦉', 'Anytime. Wise owls don’t charge consulting fees. 🦉');
  }

  if (has(q, '50/30/20', '50 30 20', '503020', 'regra')) {
    if (!s.income) return L(
      'A regra 50/30/20 divide a renda em: 50% necessidades (moradia, contas, mercado), 30% desejos (lazer, compras) e 20% poupança/dívidas. Registre sua renda que eu calculo quanto seria cada parte pra você.',
      'The 50/30/20 rule splits income into: 50% needs (housing, bills, groceries), 30% wants (fun, shopping) and 20% savings/debt. Log your income and I’ll calculate each slice for you.'
    );
    const needsKeys = ['housing', 'bills', 'groceries', 'transport', 'health', 'education', 'kids', 'phone'];
    const needs = s.byCategory.filter((c) => needsKeys.includes(c.key)).reduce((x, c) => x + c.amount, 0);
    const wants = s.expense - needs;
    const saved = Math.max(s.saved, 0);
    const p = (v) => Math.round((v / s.income) * 100);
    return L(
      `Com renda de ${money(s.income)} este mês, o ideal seria:\n• Necessidades (50%): ${money(s.income * 0.5)} — você está em ${money(needs)} (${p(needs)}%)\n• Desejos (30%): ${money(s.income * 0.3)} — você está em ${money(wants)} (${p(wants)}%)\n• Poupança (20%): ${money(s.income * 0.2)} — você está em ${money(saved)} (${p(saved)}%)\n\n${p(needs) > 60 ? 'Suas necessidades passam de 60%. Nesse caso a regra 60/20/20 é mais realista — e vale olhar se dá pra renegociar aluguel, planos ou contas.' : p(saved) >= 20 ? 'Você já está dentro da regra. Bonito de ver.' : 'O ajuste mais fácil geralmente é nos desejos: corte um pouco lá e mande direto pra poupança no dia do pagamento.'}`,
      `With ${money(s.income)} of income this month, the ideal split is:\n• Needs (50%): ${money(s.income * 0.5)} — you’re at ${money(needs)} (${p(needs)}%)\n• Wants (30%): ${money(s.income * 0.3)} — you’re at ${money(wants)} (${p(wants)}%)\n• Savings (20%): ${money(s.income * 0.2)} — you’re at ${money(saved)} (${p(saved)}%)\n\n${p(needs) > 60 ? 'Your needs are above 60%. A 60/20/20 split is more realistic for you — and it’s worth renegotiating rent, plans or bills.' : p(saved) >= 20 ? 'You’re already within the rule. Beautiful.' : 'The easiest fix is usually in wants: trim a bit there and send it to savings on payday.'}`
    );
  }

  const day = (iso) => new Intl.DateTimeFormat(pt ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00`));

  // End of month: today's balances, what's still due and what's coming in.
  if (projection && has(q, 'fim do mes', 'sobrar', 'sobra no', 'previs', 'end of the month', 'end of month', 'left at the end', 'month end')) {
    const due = (ledger?.agenda || []).filter((i) => i.date <= projection.endOfMonth && i.type !== 'income' && i.type !== 'redeem').slice(0, 4);
    const list = due.map((i) => `• ${day(i.date)} — ${i.kind === 'invoice' ? L(`fatura ${i.description}`, `${i.description} statement`) : i.description || catName(i.category)}: ${money(i.amount)}`).join('\n');
    return L(
      `${hi}hoje você tem ${money(projection.cash)} nas contas. Até o fim do mês ainda saem ${money(projection.toPay)} e entram ${money(projection.toReceive)}, então devem sobrar ${money(projection.projected)}.${list ? `\n\nO que ainda vence:\n${list}` : ''}${projection.projected < 0 ? '\n\nVai faltar dinheiro: segure os gastos flexíveis agora e veja se dá para adiar algum pagamento sem juros.' : projection.projected < projection.toPay * 0.2 ? '\n\nA margem está apertada. Evite compras novas no cartão até o salário cair.' : '\n\nSe nada mudar, você fecha o mês no azul. Que tal mandar uma parte para uma meta?'}`,
      `${hi}you have ${money(projection.cash)} in your accounts today. Until month end ${money(projection.toPay)} still goes out and ${money(projection.toReceive)} comes in, so about ${money(projection.projected)} should be left.${list ? `\n\nStill due:\n${list}` : ''}${projection.projected < 0 ? '\n\nYou’ll run short: hold flexible spending now and see if any payment can be moved without interest.' : '\n\nIf nothing changes you end the month in the green. How about sending part of it to a goal?'}`
    );
  }

  // Card statements (when the user has cards registered)
  if (ledger?.cardRows?.length && has(q, 'fatura', 'limite', 'statement', 'credit limit') ) {
    const lines = ledger.cardRows.map(({ card, open, toPay, usage }) => (pt
      ? `• ${card.name}: fatura atual ${money(open.total)} (fecha ${day(open.closing)})${toPay ? `; a pagar ${money(toPay.remaining)} até ${day(toPay.due)}` : ''}; limite disponível ${money(usage.available)}.`
      : `• ${card.name}: current statement ${money(open.total)} (closes ${day(open.closing)})${toPay ? `; ${money(toPay.remaining)} due ${day(toPay.due)}` : ''}; available ${money(usage.available)}.`)).join('\n');
    const high = ledger.cardRows.some((r) => r.usage.pct > 70);
    return L(
      `${hi}seus cartões:\n${lines}${high ? '\n\nVocê já usa mais de 70% do limite em algum cartão. Parcelas futuras também ocupam o limite: segure compras parceladas por enquanto.' : '\n\nUso do limite tranquilo. Pague sempre a fatura inteira: o rotativo é o juro mais caro do país.'}`,
      `${hi}your cards:\n${lines}${high ? '\n\nYou’re using over 70% of a card’s limit. Future installments hold the limit too: pause split purchases for now.' : '\n\nLimit usage looks fine. Always pay the full statement: revolving credit is the most expensive debt there is.'}`
    );
  }

  if (has(q, 'divida', 'debt', 'cartao', 'credit card', 'juros', 'emprestimo', 'loan', 'fatura')) {
    const debtGoals = goals.filter((g) => /cart|d[ií]vid|debt|card|loan|empr/i.test(g.title));
    const spare = Math.max(s.net, 0);
    return L(
      `${hi}dívida de cartão é a mais cara que existe (no Brasil os juros do rotativo passam de 400% ao ano). Plano direto:\n1. Pare de usar o cartão enquanto a dívida existir — use débito/Pix.\n2. Liste as dívidas e ataque primeiro a de maior juros (método avalanche). Se precisar de motivação, quite a menor primeiro (bola de neve).\n3. Ligue pro banco e peça parcelamento ou troque por um empréstimo pessoal/consignado com juros menores.\n4. ${spare > 0 ? `Este mês sobraram ${money(spare)} — mande pelo menos metade (${money(spare / 2)}) pra dívida.` : 'Este mês ainda não sobrou dinheiro — o primeiro passo é cortar um gasto flexível pra liberar um valor fixo pra dívida.'}\n${debtGoals.length ? `\nSua meta "${debtGoals[0].title}" está em ${Math.round(goalInfo(debtGoals[0]).pct)}%. Continue alimentando ela.` : '\nDica: crie uma meta "Quitar cartão" na aba Metas pra acompanhar o progresso.'}`,
      `${hi}credit card debt is the most expensive debt there is. Straight plan:\n1. Stop using the card while the debt exists — use debit.\n2. List your debts and attack the highest interest first (avalanche). If you need motivation, kill the smallest first (snowball).\n3. Call the bank and ask for a lower rate or a payment plan, or consolidate into a cheaper personal loan.\n4. ${spare > 0 ? `You have ${money(spare)} left this month — send at least half (${money(spare / 2)}) to the debt.` : 'Nothing left over this month yet — step one is cutting one flexible expense to free a fixed amount for the debt.'}\n${debtGoals.length ? `\nYour goal "${debtGoals[0].title}" is at ${Math.round(goalInfo(debtGoals[0]).pct)}%. Keep feeding it.` : '\nTip: create a “Credit Card Payoff” goal in Goals to track progress.'}`
    );
  }

  if (has(q, 'para onde', 'onde gastei', 'onde foi', 'where did', 'where my money', 'went', 'gastos', 'gastei', 'spending', 'spent')) {
    if (!hasData) return needData;
    const change = a.expenseChange;
    return L(
      `Este mês você gastou ${money(s.expense)}${s.income ? ` de ${money(s.income)} que entraram` : ''}. As maiores categorias:\n${top3}\n\n${change !== null ? `Comparado ao mês passado: ${change > 0 ? `+${Math.round(change)}% de gastos 👀` : `${Math.round(change)}% — gastando menos, boa!`}\n` : ''}Gastos flexíveis (comida fora, compras, lazer, café) somam ${Math.round(a.flexPct)}% do total. ${a.flexPct > 40 ? 'É aí que mora a economia fácil.' : 'Está sob controle.'}`,
      `This month you spent ${money(s.expense)}${s.income ? ` out of ${money(s.income)} that came in` : ''}. Biggest categories:\n${top3}\n\n${change !== null ? `Versus last month: ${change > 0 ? `+${Math.round(change)}% spending 👀` : `${Math.round(change)}% — spending less, nice!`}\n` : ''}Flexible spending (eating out, shopping, fun, coffee) is ${Math.round(a.flexPct)}% of the total. ${a.flexPct > 40 ? 'That’s where the easy savings live.' : 'That’s under control.'}`
    );
  }

  if (has(q, 'meta', 'goal', 'objetivo', 'viagem', 'vacation', 'sonho')) {
    if (!goals.length) return L(
      'Você ainda não tem metas. Crie uma na aba Metas — com valor e prazo eu calculo quanto guardar por mês. Sugestão pra começar: reserva de emergência de 3 a 6 meses dos seus gastos.',
      'You don’t have goals yet. Create one in Goals — with an amount and deadline I’ll calculate how much to save each month. A good first one: an emergency fund of 3–6 months of expenses.'
    );
    const lines = goals.map((g) => {
      const gi = goalInfo(g);
      if (gi.done) return L(`• ${g.emoji} ${g.title}: concluída! 🎉`, `• ${g.emoji} ${g.title}: done! 🎉`);
      return L(
        `• ${g.emoji} ${g.title}: ${Math.round(gi.pct)}% — faltam ${money(gi.remaining)}${gi.daysLeft !== null ? (gi.overdue ? ' (prazo vencido)' : `, guarde ~${money(gi.perMonth)}/mês`) : ''}`,
        `• ${g.emoji} ${g.title}: ${Math.round(gi.pct)}% — ${money(gi.remaining)} to go${gi.daysLeft !== null ? (gi.overdue ? ' (past deadline)' : `, save ~${money(gi.perMonth)}/month`) : ''}`
      );
    }).join('\n');
    const need = goals.reduce((x, g) => { const gi = goalInfo(g); return x + (gi.done ? 0 : gi.perMonth); }, 0);
    return L(
      `Suas metas:\n${lines}\n\nNo total, você precisa guardar ~${money(need)} por mês pra cumprir todos os prazos.${s.income ? ` Isso é ${Math.round((need / s.income) * 100)}% da sua renda.` : ''}`,
      `Your goals:\n${lines}\n\nIn total you need to save ~${money(need)} a month to hit every deadline.${s.income ? ` That’s ${Math.round((need / s.income) * 100)}% of your income.` : ''}`
    );
  }

  if (has(q, 'reserva', 'emergencia', 'emergency')) {
    const monthly = s.expense || a.prev.expense;
    return L(
      `Reserva de emergência = 3 a 6 meses dos seus gastos.${monthly ? ` Pelos seus números, isso é entre ${money(monthly * 3)} e ${money(monthly * 6)}.` : ''}\nDeixe num lugar seguro e com liquidez diária (Tesouro Selic ou CDB de liquidez diária com 100% do CDI). Não é investimento pra render muito — é pra você dormir tranquilo.`,
      `Emergency fund = 3 to 6 months of expenses.${monthly ? ` By your numbers, that’s ${money(monthly * 3)} to ${money(monthly * 6)}.` : ''}\nKeep it somewhere safe and instantly accessible (a high-yield savings account). It’s not there to grow — it’s there so you sleep well.`
    );
  }

  if (assets.length && has(q, 'carteira', 'meus investimentos', 'patrimonio', 'portfolio', 'my investments', 'rendendo', 'rendimento', 'investido')) {
    const pf = portfolio(assets, txs);
    const kinds = pf.byKind.slice(0, 4).map((k) => `• ${t(`kind.${k.key}`)}: ${money(k.amount)} (${Math.round(k.pct)}%)`).join('\n');
    const top = pf.byKind[0];
    return L(
      `Sua carteira hoje vale ${money(pf.value)}. Você aportou ${money(pf.invested)} e ${pf.profit >= 0 ? `ganhou ${money(pf.profit)}` : `está ${money(-pf.profit)} abaixo`} (${pf.pct >= 0 ? '+' : ''}${pf.pct.toFixed(1)}%).\n\nDistribuição:\n${kinds}\n\n${top && top.pct > 70 ? `Mais de 70% está em ${t(`kind.${top.key}`)}. Diversificar reduz o risco — mas só depois da reserva de emergência pronta.` : 'A distribuição está equilibrada. Continue com aportes mensais, mesmo pequenos — constância vence valor.'}${s.netInvested > 0 ? `\n\nEste mês você já aportou ${money(s.netInvested)}. 👏` : ''}`,
      `Your portfolio is worth ${money(pf.value)}. You put in ${money(pf.invested)} and ${pf.profit >= 0 ? `gained ${money(pf.profit)}` : `are ${money(-pf.profit)} down`} (${pf.pct >= 0 ? '+' : ''}${pf.pct.toFixed(1)}%).\n\nAllocation:\n${kinds}\n\n${top && top.pct > 70 ? `Over 70% is in ${t(`kind.${top.key}`)}. Diversifying lowers risk — but only after your emergency fund is done.` : 'Allocation looks balanced. Keep monthly contributions, even small — consistency beats size.'}${s.netInvested > 0 ? `\n\nYou already invested ${money(s.netInvested)} this month. 👏` : ''}`
    );
  }

  if (has(q, 'invest', 'tesouro', 'cdb', 'acoes', 'stocks', 'bolsa', 'render')) {
    return L(
      'Ordem que eu recomendo:\n1. Quitar dívidas caras (cartão, cheque especial).\n2. Montar a reserva de emergência.\n3. Só então investir pensando no longo prazo, com diversificação.\nNão sou consultor financeiro certificado — pra escolher produtos específicos, converse com um profissional. Mas pular os passos 1 e 2 é o erro mais comum que eu vejo daqui do galho. 🦉',
      'The order I recommend:\n1. Kill expensive debt (credit cards).\n2. Build the emergency fund.\n3. Only then invest for the long term, diversified.\nI’m not a certified financial advisor — for specific products, talk to a professional. But skipping steps 1 and 2 is the most common mistake I see from my branch. 🦉'
    );
  }

  if (has(q, 'orcamento', 'budget', 'limite')) {
    if (!a.bs.length) return L(
      `Você ainda não definiu orçamentos. Comece pelas 3 categorias onde mais gasta${s.byCategory.length ? `: ${s.byCategory.slice(0, 3).map((c) => catName(c.key)).join(', ')}` : ''}. Coloque um limite ~10% menor do que gastou no mês passado — é desafiador, mas possível.`,
      `You haven’t set any budgets yet. Start with your top 3 categories${s.byCategory.length ? `: ${s.byCategory.slice(0, 3).map((c) => catName(c.key)).join(', ')}` : ''}. Set a limit ~10% below last month — challenging but doable.`
    );
    const lines = a.bs.map((b) => `• ${catName(b.category)}: ${money(b.spent)} / ${money(b.limit)} (${Math.round(b.pct)}%)${b.spent > b.limit ? ' 🔴' : b.pct >= 80 ? ' 🟡' : ' 🟢'}`).join('\n');
    return L(`Seus orçamentos este mês:\n${lines}\n\n${a.over.length ? `Estourou em ${a.over.map((b) => catName(b.category)).join(', ')}. Segura essas categorias até o fim do mês.` : 'Tudo dentro do limite até agora. Continue assim.'}`,
      `Your budgets this month:\n${lines}\n\n${a.over.length ? `Over in ${a.over.map((b) => catName(b.category)).join(', ')}. Freeze those until month end.` : 'Everything within limits so far. Keep it up.'}`);
  }

  if (has(q, 'aperto', 'salario', 'paycheck', 'fim do mes', 'nao sobra', 'por onde comec', 'where do i start', 'comeco', 'start')) {
    if (!hasData) return L(
      'Por onde começar:\n1. Anote TODOS os gastos por 7 dias — sem julgamento. Só observar já muda o comportamento.\n2. No dia do pagamento, separe um valor pequeno (mesmo que seja R$ 25) pra poupança antes de gastar.\n3. Escolha UMA categoria pra congelar por uma semana (delivery é a campeã).\nRegistre seus números aqui que eu te dou um plano sob medida.',
      'Where to start:\n1. Log EVERY expense for 7 days — no judgment. Just watching changes behavior.\n2. On payday, move a small amount (even $25) to savings before spending.\n3. Pick ONE category to freeze for a week (delivery is the usual champion).\nLog your numbers here and I’ll give you a tailored plan.'
    );
    const t1 = s.byCategory[0];
    return L(
      `${hi}olhando seus números:\n• Entrou ${money(s.income)}, saiu ${money(s.expense)}.\n${a.shortDays ? `• No ritmo atual, o dinheiro acaba ~${a.shortDays} dias antes do fim do mês.\n` : ''}• Sua maior categoria é ${t1 ? `${catName(t1.key)} (${money(t1.amount)})` : '—'}.\n\nPlano de 3 passos:\n1. Congele ${t1 ? catName(t1.key).toLowerCase() : 'um gasto flexível'} por 7 dias.\n2. ${a.cutPerDay > 0 ? `Corte ${money(a.cutPerDay)}/dia até o fim do mês pra chegar em 20% de poupança.` : 'Mantenha o ritmo — você já está no caminho dos 20%.'}\n3. No próximo salário, transfira 10% pra poupança no mesmo dia.`,
      `${hi}looking at your numbers:\n• ${money(s.income)} came in, ${money(s.expense)} went out.\n${a.shortDays ? `• At this pace, money runs out ~${a.shortDays} days before month end.\n` : ''}• Your biggest category is ${t1 ? `${catName(t1.key)} (${money(t1.amount)})` : '—'}.\n\n3-step plan:\n1. Freeze ${t1 ? catName(t1.key).toLowerCase() : 'one flexible expense'} for 7 days.\n2. ${a.cutPerDay > 0 ? `Cut ${money(a.cutPerDay)}/day until month end to reach a 20% savings rate.` : 'Keep the pace — you’re already on track for 20%.'}\n3. Next payday, move 10% to savings the same day.`
    );
  }

  if (has(q, 'economiz', 'poupar', 'guardar', 'save', 'saving', 'cortar', 'cut', 'reduz', 'sobrar')) {
    if (!hasData) return needData;
    const flexTop = s.byCategory.filter((c) => ['food', 'shopping', 'entertainment', 'coffee', 'personal'].includes(c.key)).slice(0, 2);
    const ideas = flexTop.map((c) => L(`• ${catName(c.key)}: cortar 25% libera ${money(c.amount * 0.25)} por mês`, `• ${catName(c.key)}: cutting 25% frees ${money(c.amount * 0.25)} a month`)).join('\n');
    return L(
      `Quando quase nada sobra, o segredo é automatizar o pouco:\n• Guarde primeiro, gaste depois — mesmo 5% da renda${s.income ? ` (${money(s.income * 0.05)})` : ''}.\n${ideas || '• Revise assinaturas que você não usa há 30 dias.'}\n• Regra das 48h: vontade de comprar algo não essencial? Espere 2 dias.\n\nSua taxa de poupança agora: ${Math.round(s.savingsRate)}%. Meta: 20%.`,
      `When almost nothing is left, the trick is automating the little you have:\n• Pay yourself first — even 5% of income${s.income ? ` (${money(s.income * 0.05)})` : ''}.\n${ideas || '• Review subscriptions you haven’t used in 30 days.'}\n• 48-hour rule: want something non-essential? Wait 2 days.\n\nYour savings rate right now: ${Math.round(s.savingsRate)}%. Target: 20%.`
    );
  }

  if (/\b(oi|ola|opa|bom dia|boa tarde|boa noite|hello|hi|hey|e ai)\b/.test(q)) {
    return L(`Olá${name ? `, ${name}` : ''}! Pergunte sobre seus gastos, dívidas, metas, orçamento ou a regra 50/30/20.`, `Hey${name ? `, ${name}` : ''}! Ask me about your spending, debt, goals, budgets or the 50/30/20 rule.`);
  }

  // fallback: status summary
  if (!hasData) return needData;
  return L(
    `Resumo rápido do mês:\n• Entradas: ${money(s.income)}\n• Gastos: ${money(s.expense)}\n${s.netInvested ? `• Investido: ${money(s.netInvested)}\n` : ''}• Saldo em conta: ${money(s.net)} (${Math.round(s.savingsRate)}% poupado)\n${a.over.length ? `• Orçamento estourado em: ${a.over.map((b) => catName(b.category)).join(', ')}\n` : ''}\nPode me perguntar coisas como "para onde foi meu dinheiro", "como sair da dívida", "como economizar" ou "como estão minhas metas".`,
    `Quick month summary:\n• Income: ${money(s.income)}\n• Spent: ${money(s.expense)}\n${s.netInvested ? `• Invested: ${money(s.netInvested)}\n` : ''}• Cash left: ${money(s.net)} (${Math.round(s.savingsRate)}% saved)\n${a.over.length ? `• Over budget in: ${a.over.map((b) => catName(b.category)).join(', ')}\n` : ''}\nTry asking “where did my money go”, “how do I get out of debt”, “how do I save” or “how are my goals”.`
  );
}

/** The one-liner Wally says on the dashboard. */
export function wallyLine(a, mood, lang) {
  const pt = lang === 'pt';
  const s = a.sum;
  const pick = {
    sleep: pt ? ['Tô de olho, mas ainda sem números.', 'Registre um gasto ou sua renda e eu acordo de vez.'] : ['I’m watching, but there are no numbers yet.', 'Log an expense or your income and I’ll wake right up.'],
    celebrate: pt ? ['Você está guardando dinheiro de verdade.', `${Math.round(s.savingsRate)}% da renda poupada. Tô orgulhoso — e eu não digo isso sempre.`] : ['You’re actually saving money.', `${Math.round(s.savingsRate)}% of income saved. I’m proud of you — and I don’t say that often.`],
    worried: pt ? ['Opa, hora de prestar atenção.', a.over.length ? 'Tem orçamento estourado. Vamos segurar as pontas até o fim do mês.' : 'No ritmo atual o mês fica apertado. Bora ajustar juntos.'] : ['Heads up — time to pay attention.', a.over.length ? 'A budget is over its limit. Let’s hold tight until month end.' : 'At this pace the month gets tight. Let’s adjust together.'],
    thinking: pt ? ['Nada mal, mas dá pra melhorar.', 'Tente guardar pelo menos 10% — um gasto pequeno a menos por dia já resolve.'] : ['Not bad, but there’s room to improve.', 'Try saving at least 10% — one small daily expense less does it.'],
    happy: pt ? ['Nada mal. Você está no controle.', 'Continue registrando — consistência vence talento.'] : ['Not bad. You’re in control.', 'Keep logging — consistency beats talent.'],
  };
  return pick[mood];
}
