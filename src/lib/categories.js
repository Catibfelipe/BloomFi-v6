import {
  Utensils, ShoppingCart, House, Receipt, Car, HeartPulse, ShoppingBag, Film, Coffee,
  Shirt, GraduationCap, Plane, PawPrint, Gift, Ellipsis, Briefcase, Laptop, TrendingUp,
  PiggyBank, Smartphone, Dumbbell, Baby, CreditCard, ArrowDownLeft, ArrowLeftRight,
  Tag, Star, Heart, Pill, Church, Wrench, Music, BookOpen, Palette, Sprout, Bike, Bus, Fuel, Wifi, Zap, Droplets,
  Scissors, Gamepad2, Beer, Pizza, Cake, Stethoscope, HandCoins, Wallet, Building2, Hammer, Sofa, Glasses,
} from 'lucide-react';

export const EXPENSE_CATEGORIES = [
  { key: 'food', icon: Utensils, color: '#fb923c' },
  { key: 'groceries', icon: ShoppingCart, color: '#facc15' },
  { key: 'housing', icon: House, color: '#34d399' },
  { key: 'bills', icon: Receipt, color: '#38bdf8' },
  { key: 'transport', icon: Car, color: '#22d3ee' },
  { key: 'health', icon: HeartPulse, color: '#f472b6' },
  { key: 'shopping', icon: ShoppingBag, color: '#a78bfa' },
  { key: 'entertainment', icon: Film, color: '#60a5fa' },
  { key: 'coffee', icon: Coffee, color: '#f59e0b' },
  { key: 'personal', icon: Shirt, color: '#e879f9' },
  { key: 'education', icon: GraduationCap, color: '#818cf8' },
  { key: 'travel', icon: Plane, color: '#2dd4bf' },
  { key: 'pets', icon: PawPrint, color: '#fdba74' },
  { key: 'gifts', icon: Gift, color: '#fb7185' },
  { key: 'phone', icon: Smartphone, color: '#93c5fd' },
  { key: 'fitness', icon: Dumbbell, color: '#86efac' },
  { key: 'kids', icon: Baby, color: '#fda4af' },
  { key: 'debt', icon: CreditCard, color: '#f87171' },
  { key: 'other', icon: Ellipsis, color: '#94a3b8' },
];

export const INCOME_CATEGORIES = [
  { key: 'salary', icon: Briefcase, color: '#0bf28b' },
  { key: 'freelance', icon: Laptop, color: '#4ade80' },
  { key: 'investments', icon: TrendingUp, color: '#22d3ee' },
  { key: 'savings_back', icon: PiggyBank, color: '#a3e635' },
  { key: 'gift_in', icon: Gift, color: '#f0abfc' },
  { key: 'other_income', icon: Ellipsis, color: '#94a3b8' },
];

// Money moved between the account and investments (not spending, not income).
export const INVEST_CATEGORIES = [
  { key: 'invest', icon: TrendingUp, color: '#38bdf8' },
  { key: 'goal_save', icon: PiggyBank, color: '#a3e635' },
  { key: 'redeem', icon: ArrowDownLeft, color: '#2dd4bf' },
];

// Moving money between your own accounts / paying a card invoice.
export const TRANSFER_CATEGORY = { key: 'transfer', icon: ArrowLeftRight, color: '#94a3b8' };

const ALL = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES, ...INVEST_CATEGORIES, TRANSFER_CATEGORY];
const MAP = Object.fromEntries(ALL.map((c) => [c.key, c]));

// ---- categories the user creates ----
export const CUSTOM_ICONS = {
  tag: Tag, star: Star, heart: Heart, pill: Pill, church: Church, wrench: Wrench, music: Music, book: BookOpen,
  palette: Palette, sprout: Sprout, bike: Bike, bus: Bus, fuel: Fuel, wifi: Wifi, zap: Zap, water: Droplets,
  scissors: Scissors, game: Gamepad2, beer: Beer, pizza: Pizza, cake: Cake, doctor: Stethoscope, coins: HandCoins,
  wallet: Wallet, building: Building2, tools: Hammer, sofa: Sofa, glasses: Glasses, gift: Gift, pet: PawPrint,
  car: Car, house: House, school: GraduationCap, phone: Smartphone, baby: Baby, plane: Plane,
};
export const CUSTOM_COLORS = ['#fb923c', '#facc15', '#34d399', '#38bdf8', '#a78bfa', '#f472b6', '#f87171', '#2dd4bf', '#818cf8', '#a3e635', '#94a3b8'];
const CUSTOM = new Map();
/** Called by the store whenever the user's categories change. */
export function setCustomCategories(list = []) {
  CUSTOM.clear();
  for (const c of list) {
    if (c.archived) continue;
    CUSTOM.set(c.key, { key: c.key, icon: CUSTOM_ICONS[c.icon] || Tag, color: c.color || '#94a3b8', custom: true, name: c.name, type: c.type });
  }
}
const customOf = (type) => [...CUSTOM.values()].filter((c) => c.type === type);

export const getCategory = (key) => MAP[key] || CUSTOM.get(key) || MAP.other;
export const categoriesFor = (type) => (type === 'income' ? [...INCOME_CATEGORIES, ...customOf('income')]
  : type === 'expense' ? [...EXPENSE_CATEGORIES, ...customOf('expense')] : INVEST_CATEGORIES);
export const isInvestType = (type) => type === 'invest' || type === 'redeem';

// Keyword based auto-categorisation used by the statement importer.
const RULES = [
  ['food', /ifood|rappi|restaur|lanch|pizz|burger|mcdonald|bk |subway|padaria|bakery|sushi|churrasc|bar |boteco|delivery|doordash|uber ?eats|grubhub|diner|cafe da manha/i],
  ['groceries', /mercado|supermerc|atacad|assai|carrefour|extra |p[aã]o de a[cç]|hortifruti|walmart|costco|kroger|aldi|whole foods|trader joe|grocery|a[cç]ougue/i],
  ['coffee', /starbucks|coffee|cafeteria|caf[eé]\b/i],
  ['transport', /uber|99 ?(app|pop|taxi)|lyft|taxi|combust|posto|shell|ipiranga|petrobras|br mania|gas station|estacion|parking|ped[aá]gio|sem parar|metr[oô]|onibus|ônibus|bilhete|recarga (bom|top)|chevron|exxon/i],
  ['bills', /luz|energia|enel|cemig|copel|light s|cpfl|[aá]gua|sabesp|sanepar|internet|vivo|claro|tim |oi |net |g[aá]s|comg[aá]s|condom|iptu|ipva|seguro|insurance|electric|utility|comcast|verizon|at&t|t-mobile/i],
  ['housing', /aluguel|rent|imobili|financiamento habit|mortgage/i],
  ['health', /farm[aá]cia|drogaria|droga ?raia|drogasil|pague menos|hospital|cl[ií]nica|m[eé]dic|dentist|laborat|unimed|amil|hapvida|sulam[eé]rica|pharmacy|cvs|walgreens|doctor/i],
  ['entertainment', /netflix|spotify|disney|hbo|max\b|prime video|amazon prime|youtube|deezer|cinema|ingresso|steam|playstation|xbox|nintendo|show|teatro|apple\.com\/bill|globoplay|paramount/i],
  ['shopping', /amazon|mercado ?livre|magalu|magazine luiza|americanas|shopee|shein|aliexpress|renner|riachuelo|c&a|zara|centauro|netshoes|casas bahia|kabum|target|best buy|ebay|etsy|nike|adidas/i],
  ['education', /escola|faculdade|universidade|curso|udemy|alura|coursera|livraria|school|college|tuition/i],
  ['travel', /hotel|airbnb|booking|decolar|latam|gol |azul |passagem|airline|delta|united|american air|expedia/i],
  ['pets', /pet|petz|cobasi|veterin/i],
  ['phone', /celular|telefone|phone/i],
  ['fitness', /academia|smart ?fit|gym|bodytech|crossfit|gympass|wellhub/i],
  ['personal', /sal[aã]o|barbear|cabeleire|haircut|barber|manicure|est[eé]tica|perfum|botic[aá]rio|natura|sephora/i],
  ['debt', /fatura|cart[aã]o de cr[eé]dito|empr[eé]stimo|juros|loan|credit card payment/i],
];
const INCOME_RULES = [
  ['salary', /sal[aá]rio|salario|folha|pagamento de sal|payroll|direct dep|pr[oó]-labore|adiantamento/i],
  ['investments', /rendimento|dividend|juros sobre|jcp|resgate|cdb|tesouro|interest|yield/i],
  ['freelance', /freela|servi[cç]o prestado|invoice|nota fiscal/i],
];

export function guessCategory(description = '', type = 'expense') {
  const rules = type === 'income' ? INCOME_RULES : RULES;
  for (const [key, re] of rules) if (re.test(description)) return key;
  return type === 'income' ? 'other_income' : 'other';
}

// ---- investment movements in bank statements ----
const INVEST_OUT = /aplica[cç][aã]o|\baplic\b|\binvest|tesouro|\bcdb\b|\brdb\b|\blci\b|\blca\b|\bcri\b|\bcra\b|corretora|poupan[cç]a|caixinha|cofrinho|porquinho|dinheiro guardado|\bguardad[oa]\b|nuinvest|xp invest|btg pactual|rico invest|clear corretora|compra de (a[cç][oõ]es|fii|cotas)|\baporte\b|previd[eê]ncia|\bpgbl\b|\bvgbl\b|brokerage|investment/i;
const REDEEM_IN = /resgate|resgatad|\bresg\b|retirada (da|do) (caixinha|cofrinho|poupan)|venda de (a[cç][oõ]es|fii|cotas)|withdrawal from (savings|investment)/i;
const YIELD_IN = /rendimento|dividendo|juros sobre capital|\bjcp\b|proventos|dividend|interest earned/i;
export const BILL_PAYMENT = /pagamento (de )?fatura|pgto\.? fatura|pag\.? fatura|fatura (do )?cart[aã]o|credit card payment|pagamento recebido/i;

/**
 * Decides what a bank movement is. `amount` is signed from the account's
 * point of view (negative = money left the account).
 * Money sent to an investment is a DEBIT (type "invest"), never income.
 */
export function classifyMovement(description = '', amount = 0) {
  const d = String(description);
  if (amount < 0) {
    if (INVEST_OUT.test(d) && !REDEEM_IN.test(d)) return { type: 'invest', category: 'invest' };
    return { type: 'expense', category: guessCategory(d, 'expense') };
  }
  if (REDEEM_IN.test(d)) return { type: 'redeem', category: 'redeem' };
  if (YIELD_IN.test(d)) return { type: 'income', category: 'investments' };
  return { type: 'income', category: guessCategory(d, 'income') };
}
