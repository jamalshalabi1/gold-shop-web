'use strict';
/* =========================================================
   إدارة محل الذهب — النسخة الرابعة (الشراء بسعر حر + الأرشفة وبدء فترة جديدة)
   التخزين: IndexedDB (قاعدة بيانات دائمة داخل الجهاز)
   ========================================================= */

// ---------------- قاعدة البيانات ----------------
const DB_NAME = 'goldshop';
const DB_VER = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');                                   // إعدادات
      d.createObjectStore('days', { keyPath: 'date' });           // رصيد افتتاح كل يوم
      const tx = d.createObjectStore('tx', { keyPath: 'id', autoIncrement: true });
      tx.createIndex('date', 'date');                              // سجل العمليات
      d.createObjectStore('agents', { keyPath: 'id', autoIncrement: true });
      const am = d.createObjectStore('agentMoves', { keyPath: 'id', autoIncrement: true });
      am.createIndex('agentId', 'agentId');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// كل عملية كتابة تنتظر اكتمال المعاملة (commit) قبل اعتبارها محفوظة
function write(storeName, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    let result;
    const s = t.objectStore(storeName);
    const req = fn(s);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}
function read(storeName, fn) {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(storeName, 'readonly').objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const kvGet = (k) => read('kv', s => s.get(k));
const kvSet = (k, v) => write('kv', s => s.put(v, k));
const getAll = (st) => read(st, s => s.getAll());
const add = (st, v) => write(st, s => s.add(v));
const put = (st, v) => write(st, s => s.put(v));

// ---------------- الحالة ----------------
const MAIN_KARATS = [21, 18, 24];
const MINOR_KARATS = [14, 9];
const ALL_KARATS = [...MAIN_KARATS, ...MINOR_KARATS];
const emptyPrices = () => Object.fromEntries(ALL_KARATS.map(k => [k, { sell: 0, buy: 0 }]));
const DEFAULT_SETTINGS = {
  prices: emptyPrices(),   // تسعيرة النقابة: سعر بيع وشراء الغرام لكل عيار
  ref: 875,
  rates: { buy: { 21: 885, 18: 790 }, sell: { 21: 870, 18: 740 } },
};
const TYPE_NAMES = {
  sale: 'بيع', purchase: 'شراء', cash_in: 'إدخال كاش', cash_out: 'إخراج كاش',
  opening: 'رصيد افتتاح', price: 'التسعيرة', agent_fee: 'أجور مندوب', close: 'إغلاق اليوم', return: 'إرجاع',
};

const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  today: null,        // مفتاح يوم العمل المفتوح حالياً (أو null إذا لا يوجد يوم مفتوح)
  day: null,          // {date, opening, status:'open'|'closed', openedAt, closedAt, expected, actual, diff}
  txToday: [],
  mode: 'sale',
  karat: 21,
  gramManual: false,
  agents: [],
  moves: [],
  agentId: null,
  amode: 'buy',
  akarat: 21,
  rateManual: false,
  cart: [],           // قطع فاتورة البيع الحالية
  pastDay: null,      // اليوم المفتوح للمراجعة في «الأيام الماضية»
  exchange: null,     // وضع التبديل: {returnId, amount, item, customer}
};
// العمليات التي يمكن تعديلها
const EDITABLE = ['sale', 'purchase', 'cash_in', 'cash_out'];

// ---------------- أدوات ----------------
const $ = (id) => document.getElementById(id);
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function num(v) {
  if (v == null) return 0;
  // دعم الأرقام العربية/الفارسية والفاصلة العربية
  const s = String(v).trim()
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٫,]/g, '.').replace(/[^\d.\-]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}
const fmtMoney = (n) => Math.round(n).toLocaleString('en-US');
const fmtW = (n, d = 3) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts) => new Date(ts).toLocaleDateString('ar', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

// ---------------- تحميل البيانات ----------------
async function loadSettings() {
  const s = await kvGet('settings');
  if (!s) return;
  const prices = emptyPrices();
  for (const k of ALL_KARATS) if (s.prices && s.prices[k]) prices[k] = { ...prices[k], ...s.prices[k] };
  if (!s.prices && s.unionPrice) prices[21] = { sell: s.unionPrice, buy: s.unionPrice }; // ترقية من النسخة الأولى
  state.settings = { ...structuredClone(DEFAULT_SETTINGS), ...s, prices, rates: { ...DEFAULT_SETTINGS.rates, ...(s.rates || {}) } };
  delete state.settings.unionPrice;
}
// يوم العمل لا يتغيّر تلقائياً مع الساعة؛ يبدأ بـ«فتح يوم جديد» وينتهي بـ«إغلاق اليوم»
async function loadToday() {
  let key = await kvGet('currentDay');
  if (key === undefined) { // ترقية من النسخة السابقة: اعتبر يوم اليوم (إن وُجد) هو اليوم المفتوح
    const legacy = await read('days', s => s.get(todayKey()));
    key = legacy ? legacy.date : null;
    if (legacy && !legacy.status) { legacy.status = 'open'; legacy.openedAt = legacy.ts; await put('days', legacy); }
    await kvSet('currentDay', key);
  }
  let day = key ? await read('days', s => s.get(key)) : null;
  if (day && day.status === 'closed') day = null;
  state.day = day || null;
  state.today = state.day ? state.day.date : null;
  state.txToday = state.today ? await read('tx', s => s.index('date').getAll(state.today)) : [];
}
function dayLabel(d) {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?$/.exec(d.date);
  const ts = d.openedAt || (m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : Date.now());
  return fmtDate(ts) + (m && m[4] ? ` (الدورة ${m[4]})` : '');
}
function requireDay() {
  if (state.day) return true;
  toast('لا يوجد يوم مفتوح — افتح يوماً جديداً أولاً', true);
  openDayDialog();
  return false;
}
async function loadAgents() {
  state.agents = await getAll('agents');
  state.moves = await getAll('agentMoves');
}

// ---------------- الكاش ----------------
function cashNow() {
  const opening = state.day ? state.day.opening : 0;
  return opening + state.txToday.filter(t => !t.void).reduce((a, t) => a + (t.cash || 0), 0);
}
function renderHeader() {
  const c = cashNow();
  const el = $('cashNow');
  el.textContent = fmtMoney(c);
  el.classList.toggle('neg', c < 0);
  $('cashSub').textContent = state.day
    ? `افتتاح الصباح: ${fmtMoney(state.day.opening)}` + (state.day.date.slice(0, 10) !== todayKey() ? ' · ⚠ اليوم المفتوح من تاريخ سابق — أغلقه' : '')
    : '🔒 لا يوجد يوم مفتوح — افتح يوماً جديداً من «الكاش اليومي»';
  const P = state.settings.prices;
  if (!hasPrices()) { $('priceNow').innerHTML = '<div class="empty-p">أدخل التسعيرة</div>'; return; }
  $('priceNow').innerHTML = MAIN_KARATS.map(k => `
    <div class="k">عيار ${k}</div>
    <div class="v ${k === 21 ? 'main' : ''}"><small>بيع</small> ${fmtMoney(P[k].sell)}</div>
    <div class="v ${k === 21 ? 'main' : ''}"><small>شراء</small> ${fmtMoney(P[k].buy)}</div>`).join('');
}

async function addTx(t) {
  const rec = { ts: Date.now(), date: state.today || todayKey(), void: false, ...t };
  rec.id = await add('tx', rec);
  if (rec.date === state.today) state.txToday.push(rec);
  else await recomputeDay(rec.date);   // عملية بتاريخ يوم سابق
  refreshAll();
  return rec;
}

// ---------------- بيع / شراء ----------------
function hasPrices() { return ALL_KARATS.some(k => state.settings.prices[k].sell || state.settings.prices[k].buy); }
// سعر الغرام من التسعيرة حسب نوع العملية: بيع للزبون أو شراء منه
function karatPrice(k, mode = state.mode) {
  const p = state.settings.prices[k];
  return p ? p[mode === 'sale' ? 'sell' : 'buy'] : 0;
}
function renderKaratButtons() {
  const btn = k => `<button type="button" data-k="${k}" class="${k === state.karat ? 'active' : ''}">عيار ${k}</button>`;
  $('tradeKarat').innerHTML = MAIN_KARATS.map(btn).join('');
  $('tradeKaratMinor').innerHTML = MINOR_KARATS.map(btn).join('');
}
function setMode(m) {
  state.mode = m;
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  const sale = m === 'sale';
  $('saleFinalWrap').hidden = !sale;
  $('cartWrap').hidden = !sale;
  $('purchExtraWrap').hidden = sale;
  $('tTotalLabel').textContent = sale ? 'السعر النهائي (يدخل الصندوق)' : 'المبلغ المدفوع للزبون (يخرج من الصندوق)';
  const btn = $('tSubmit');
  btn.textContent = sale ? '✔ تأكيد عملية البيع' : '✔ تأكيد عملية الشراء';
  btn.className = 'btn-primary ' + (sale ? 'sale' : 'purchase');
  state.gramManual = false; syncGramPrice();
  calcTrade();
}
function syncGramPrice() {
  if (!state.gramManual) {
    const p = karatPrice(state.karat);
    $('tGram').value = p ? String(Math.round(p * 100) / 100) : '';
  }
}
// ---- فاتورة البيع: قطعة أو أكثر بسعر نهائي واحد ----
// القطعة المكتوبة حالياً في الخانات (إن وُجد وزن)
function entryItem() {
  const w = num($('tWeight').value), g = num($('tGram').value);
  return { item: $('tItem').value.trim(), karat: state.karat, weight: w, gramPrice: g,
    listPrice: karatPrice(state.karat), goldValue: w * g };
}
// كل قطع الفاتورة = القطع المضافة + القطعة المكتوبة حالياً
function saleItems() {
  const e = entryItem();
  return e.weight > 0 ? [...state.cart, e] : [...state.cart];
}
function addToCart() {
  const e = entryItem();
  if (e.weight <= 0) return toast('أدخل وزن القطعة', true);
  if (e.gramPrice <= 0) return toast(`أدخل سعر عيار ${e.karat} في تسعيرة النقابة`, true);
  state.cart.push(e);
  $('tWeight').value = ''; $('tItem').value = '';
  state.gramManual = false; syncGramPrice();
  renderCart(); calcTrade();
  toast(`تمت إضافة ${e.item || 'القطعة'} ✔ — أدخل القطعة التالية`);
  $('tWeight').focus();
}
function removeFromCart(i) {
  state.cart.splice(i, 1);
  renderCart(); calcTrade();
}
function renderCart() {
  const c = state.cart;
  if (!c.length) { $('cartList').innerHTML = ''; $('tFinalLabel').textContent = 'السعر النهائي (المبلغ المتفق عليه مع الزبون)'; return; }
  const w = c.reduce((a, x) => a + x.weight, 0), gv = c.reduce((a, x) => a + x.goldValue, 0);
  $('tFinalLabel').textContent = 'السعر النهائي لكل القطع معاً (المبلغ المتفق عليه مع الزبون)';
  $('cartList').innerHTML = `<div class="cart-head">قطع الفاتورة (${c.length})</div>` + c.map((x, i) => `
    <div class="cart-row">
      <span class="n">${i + 1}</span>
      <div><div class="t">${esc(x.item || 'قطعة')} — ${fmtW(x.weight)} غ عيار ${x.karat}</div>
        <div class="s">سعر الغرام ${fmtMoney(x.gramPrice)}</div></div>
      <span class="g">${fmtMoney(x.goldValue)}</span>
      <button type="button" data-cart-del="${i}" aria-label="حذف">✕</button>
    </div>`).join('') +
    `<div class="cart-total">المضاف: ${fmtW(w)} غ · قيمة الذهب ${fmtMoney(gv)}${num($('tWeight').value) > 0 ? ' — والقطعة المكتوبة حالياً ستُضاف تلقائياً عند التأكيد' : ''}</div>`;
}

// البيع: يُدخل السعر النهائي للفاتورة كاملة، وتُحسب المصنعية = السعر النهائي − مجموع قيمة الذهب
// الشراء: المبلغ = الوزن × (سعر الغرام − الخصم)
function tradeValues() {
  if (state.mode === 'sale') {
    const items = saleItems();
    const w = items.reduce((a, x) => a + x.weight, 0);
    const goldValue = items.reduce((a, x) => a + x.goldValue, 0);
    const final = num($('tFinal').value);
    const making = final - goldValue;
    const g = items.length === 1 ? items[0].gramPrice : null;
    return { items, w, g, goldValue, final, making, makingPerGram: w ? making / w : 0, total: final };
  }
  const w = num($('tWeight').value);
  const g = num($('tGram').value);
  const goldValue = w * g;
  // المبلغ المدفوع فعلياً (إذا فارغ = حسب التسعيرة) والفرق يُحسب تلقائياً
  const paidRaw = $('tPaid').value.trim();
  const paid = paidRaw ? num(paidRaw) : goldValue;
  const diff = paid - goldValue;
  return { w, g, goldValue, paid, diff, diffPerGram: w ? diff / w : 0, total: paid };
}
function purchaseBreakdownHTML(v) {
  const cls = v.diff > 0 ? 'neg' : v.diff < 0 ? 'pos' : '';
  const lbl = v.diff > 0 ? 'دفعنا زيادة عن التسعيرة' : v.diff < 0 ? 'اشترينا بأقل من التسعيرة' : 'الفرق عن التسعيرة';
  const sg = (n) => (n > 0 ? '+' : '') + fmtMoney(n);
  return sumItem('المبلغ المدفوع للزبون', fmtMoney(v.paid)) +
    sumItem(`حسب التسعيرة (${fmtW(v.w)} غ × ${fmtMoney(v.g)})`, fmtMoney(v.goldValue)) +
    `<div class="sum-item"><div class="k">${lbl}</div><div class="v ${cls}">${sg(v.diff)}</div></div>` +
    `<div class="sum-item"><div class="k">الفرق للغرام</div><div class="v ${cls}">${sg(v.diffPerGram)}</div></div>`;
}
function breakdownHTML(v) {
  const cls = v.making < 0 ? 'neg' : 'pos';
  return sumItem('السعر النهائي', fmtMoney(v.final)) +
    sumItem(v.g != null ? `قيمة الذهب (${fmtW(v.w)} غ × ${fmtMoney(v.g)})` : `قيمة الذهب (${v.n} قطع، ${fmtW(v.w)} غ)`, fmtMoney(v.goldValue)) +
    `<div class="sum-item"><div class="k">المصنعية الإجمالية</div><div class="v ${cls}">${fmtMoney(v.making)}</div></div>` +
    `<div class="sum-item"><div class="k">مصنعية الغرام</div><div class="v ${cls}">${fmtMoney(v.makingPerGram)}</div></div>`;
}
function calcTrade() {
  const v = tradeValues();
  $('tTotal').textContent = fmtMoney(v.total);
  if (state.mode === 'sale') {
    let extraHtml = v.final && v.making < 0 ? '<div class="warn">⚠ السعر النهائي أقل من قيمة الذهب — المصنعية بالسالب</div>' : '';
    if (state.exchange && v.final) {
      const net = v.final - state.exchange.amount;
      extraHtml += `<div class="exch-net">⇄ تبديل: السعر ${fmtMoney(v.final)} − المرتجع ${fmtMoney(state.exchange.amount)} = <b>${net >= 0 ? 'يدفع الزبون' : 'نردّ للزبون'} ${fmtMoney(Math.abs(net))}</b></div>`;
    }
    $('tCalc').innerHTML = extraHtml;
    $('tBreak').innerHTML = v.w || v.final ? breakdownHTML({ ...v, n: v.items.length }) : '';
    if (state.cart.length) renderCart();
  } else {
    $('tCalc').textContent = '';
    $('tBreak').innerHTML = v.w ? purchaseBreakdownHTML(v) : '';
  }
}
async function submitTrade() {
  const v = tradeValues();
  const sale = state.mode === 'sale';
  if (!sale) {
    if (!karatPrice(state.karat) && !state.gramManual) return toast(`أدخل سعر عيار ${state.karat} في تسعيرة النقابة`, true);
    if (v.w <= 0) return toast('أدخل الوزن', true);
    if (v.g <= 0) return toast('سعر الغرام غير صحيح', true);
  }
  if (sale && !v.items.length) return toast('أدخل وزن القطعة', true);
  if (sale && v.items.some(x => x.gramPrice <= 0)) return toast('في قطعة بدون سعر غرام — تأكد من التسعيرة', true);
  if (sale && v.final <= 0) return toast('أدخل السعر النهائي', true);
  if (!sale && v.paid <= 0) return toast('أدخل المبلغ المدفوع للزبون', true);
  const customer = $('tCustomer').value.trim();
  const item = sale ? v.items.map(x => x.item || 'قطعة').join('، ') : $('tItem').value.trim();
  const total = Math.round(v.total);
  const multi = sale && v.items.length > 1;
  const head = multi
    ? `بيع ${v.items.length} قطع (${fmtW(v.w)} غ):\n` + v.items.map((x, i) => `${i + 1}) ${x.item || 'قطعة'} — ${fmtW(x.weight)} غ عيار ${x.karat}`).join('\n') + (customer ? `\nالزبون: ${customer}` : '')
    : `${sale ? 'بيع' : 'شراء'} ${item || 'قطعة'} — ${fmtW(v.w)} غ عيار ${sale ? v.items[0].karat : state.karat}${customer ? `\nالزبون: ${customer}` : ''}`;
  const body = sale
    ? `\nالسعر النهائي: ${fmtMoney(v.final)}\nقيمة الذهب: ${fmtMoney(v.goldValue)}\nالمصنعية الإجمالية: ${fmtMoney(v.making)}\nمصنعية الغرام: ${fmtMoney(v.makingPerGram)}${v.making < 0 ? '\n⚠ المصنعية بالسالب!' : ''}`
    : `\nالمبلغ المدفوع: ${fmtMoney(v.paid)}\nحسب التسعيرة: ${fmtMoney(v.goldValue)}${Math.round(v.diff) ? `\nالفرق: ${v.diff > 0 ? '+' : ''}${fmtMoney(v.diff)} (للغرام ${v.diffPerGram > 0 ? '+' : ''}${fmtMoney(v.diffPerGram)})` : ''}`;
  const tgt = await resolveDF('trade');
  if (!tgt) return;
  const dateLine = tgt.manual ? `\n📅 التاريخ: ${fmtDate(tgt.ts)} ${fmtTime(tgt.ts)}` : '';
  const exch = sale && state.exchange ? state.exchange : null;
  const exchLine = exch ? `\n⇄ تبديل — المرتجع ${fmtMoney(exch.amount)} — ${total - exch.amount >= 0 ? 'يدفع الزبون' : 'نردّ للزبون'} ${fmtMoney(Math.abs(total - exch.amount))}` : '';
  if (!confirm(`${head}${body}${exchLine}${dateLine}\n\nتأكيد؟`)) return;
  const rec = {
    date: tgt.date, ts: tgt.ts,
    type: state.mode, karat: state.karat, weight: v.w, gramPrice: v.g,
    listPrice: karatPrice(state.karat), goldValue: Math.round(v.goldValue),
    amount: total, cash: sale ? total : -total, item, customer,
  };
  if (sale) {
    const ks = [...new Set(v.items.map(x => x.karat))];
    rec.karat = ks.length === 1 ? ks[0] : null;
    rec.karats = ks;
    rec.listPrice = v.items.length === 1 ? v.items[0].listPrice : null;
    rec.items = v.items.map(x => ({ ...x, goldValue: Math.round(x.goldValue) }));
    rec.making = Math.round(v.making); rec.makingPerGram = Math.round(v.makingPerGram);
  } else { rec.paidDiff = Math.round(v.diff); rec.paidDiffPerGram = Math.round(v.diffPerGram); }
  if (exch) { rec.exchangeReturnId = exch.returnId; rec.exchangeAmount = exch.amount; }
  const saved = await addTx(rec);
  if (exch) {
    const r = await read('tx', st => st.get(exch.returnId));
    if (r) { r.exchangeSaleId = saved.id; await put('tx', r); }
    state.exchange = null; renderExchange();
  }
  resetDF('trade');
  $('tWeight').value = ''; $('tPaid').value = ''; $('tFinal').value = ''; $('tItem').value = ''; $('tCustomer').value = '';
  state.cart = []; renderCart();
  state.gramManual = false; syncGramPrice(); calcTrade();
  renderLastSaved(saved);
  toast((sale ? 'تم تسجيل البيع ✔' : 'تم تسجيل الشراء ✔') + (saved.date !== state.today ? ` — في يوم ${dayLabel({ date: saved.date })}` : ''));
}
function renderLastSaved(t) {
  if (!t) { $('lastSaved').innerHTML = ''; return; }
  const sale = t.type === 'sale';
  const v = { w: t.weight, g: t.gramPrice, n: t.items ? t.items.length : 1, goldValue: t.goldValue, final: t.amount, making: t.making, makingPerGram: t.makingPerGram };
  $('lastSaved').innerHTML = `<div class="card saved-card">
    <h3>✔ تم حفظ ${sale ? 'البيع' : 'الشراء'}: ${esc(t.item || 'قطعة')} — ${fmtW(t.weight)} غ${t.karat ? ` عيار ${t.karat}` : ''}${t.customer ? ` — الزبون: ${esc(t.customer)}` : ''}</h3>
    ${t.items && t.items.length > 1 ? `<div class="hint">${esc(itemsText(t.items))}</div>` : ''}
    <div class="breakdown">${sale ? breakdownHTML(v) : purchaseBreakdownHTML({ w: t.weight, g: t.gramPrice, goldValue: t.goldValue, paid: t.amount, diff: t.paidDiff || 0, diffPerGram: t.paidDiffPerGram || 0 })}</div>
  </div>`;
}

// ---------------- عرض العمليات ----------------
const itemsText = (items) => items.map(x => `${x.item || 'قطعة'} ${fmtW(x.weight)} غ ع${x.karat} (ذهب ${fmtMoney(x.goldValue)})`).join(' + ');
function txBrief(t) {
  const when = `${new Date(t.ts).toLocaleDateString('ar')} ${fmtTime(t.ts)}`;
  if (t.type === 'sale' || t.type === 'purchase')
    return `${t.item || 'قطعة'} ${fmtW(t.weight)} غ${t.karat ? ` ع${t.karat}` : ''}${t.customer ? ` (${t.customer})` : ''} · ${fmtMoney(t.amount)}${t.making != null ? ` · مصنعية ${fmtMoney(t.making)}` : ''} · ${when}`;
  return `${t.note || TYPE_NAMES[t.type]} · ${fmtMoney(t.amount)} · ${when}`;
}
// actions: true = أزرار التعديل/الإرجاع/التبديل/الإلغاء
function txRow(t, { showDate = false, actions = false } = {}) {
  let main = '', sub = '';
  const time = (showDate ? new Date(t.ts).toLocaleDateString('ar') + ' — ' : '') + fmtTime(t.ts);
  switch (t.type) {
    case 'sale': case 'purchase':
      main = `${t.item || (t.type === 'sale' ? 'قطعة' : 'ذهب')} — ${fmtW(t.weight)} غ${t.karat ? ` عيار ${t.karat}` : ''}${t.customer ? ` — الزبون: ${t.customer}` : ''}`;
      if (t.type === 'sale' && t.items && t.items.length > 1) {
        sub = `${itemsText(t.items)} · مجموع الذهب ${fmtMoney(t.goldValue)} · المصنعية ${fmtMoney(t.making)} (للغرام ${fmtMoney(t.makingPerGram)})`;
      } else if (t.type === 'sale' && t.making !== undefined) {
        sub = `قيمة الذهب ${fmtMoney(t.goldValue)} (غرام ${fmtMoney(t.gramPrice)}) · المصنعية ${fmtMoney(t.making)} (للغرام ${fmtMoney(t.makingPerGram)})`;
      } else if (t.type === 'purchase' && t.paidDiff !== undefined) {
        sub = `حسب التسعيرة ${fmtMoney(t.goldValue)} (غرام ${fmtMoney(t.gramPrice)})${t.paidDiff ? ` · الفرق ${t.paidDiff > 0 ? '+' : ''}${fmtMoney(t.paidDiff)} (للغرام ${t.paidDiffPerGram > 0 ? '+' : ''}${fmtMoney(t.paidDiffPerGram)})` : ' · بسعر التسعيرة'}`;
      } else {
        sub = `سعر الغرام ${fmtMoney(t.gramPrice)}${t.extra ? (t.type === 'sale' ? ` + صياغة ${fmtMoney(t.extra)}` : ` − خصم ${fmtMoney(t.extra)}`) : ''}`;
      }
      if ((t.listPrice ?? t.unionPrice) && (t.listPrice ?? t.unionPrice) !== t.gramPrice) sub += ` · التسعيرة ${fmtMoney(t.listPrice ?? t.unionPrice)}`;
      if (t.exchangeReturnId) sub += ` · ⇄ تبديل: مرتجع ${fmtMoney(t.exchangeAmount || 0)} — الصافي ${fmtMoney(t.amount - (t.exchangeAmount || 0))}`;
      break;
    case 'return':
      main = `${t.exchange ? '⇄ تبديل — إرجاع' : '↩ إرجاع'}: ${t.item || 'قطعة'}${t.customer ? ` — الزبون: ${t.customer}` : ''}`;
      sub = `من ${TYPE_NAMES[t.originalType]} يوم ${dayLabel({ date: t.originalDate })}${t.weight ? ` · ${fmtW(t.weight)} غ` : ''}${t.making ? ` · مصنعية مرتجعة ${fmtMoney(t.making)}` : ''}`;
      break;
    case 'opening': main = t.note && t.note !== 'فتح يوم جديد' ? `رصيد الافتتاح (${t.note})` : 'رصيد افتتاح الصباح'; break;
    case 'close':
      main = `إغلاق اليوم — الكاش المتوقع ${fmtMoney(t.amount)}`;
      sub = t.actual != null ? `الكاش الفعلي ${fmtMoney(t.actual)} · الفرق ${t.diff > 0 ? '+' : ''}${fmtMoney(t.diff)}` : 'لم يُدخل الكاش الفعلي';
      break;
    case 'price':
      main = 'تعديل تسعيرة النقابة';
      sub = t.newPrices
        ? ALL_KARATS.filter(k => t.newPrices[k].sell || t.newPrices[k].buy).map(k => `${k}: بيع ${fmtMoney(t.newPrices[k].sell)} / شراء ${fmtMoney(t.newPrices[k].buy)}`).join(' · ')
        : `${fmtMoney(t.oldPrice || 0)} ← ${fmtMoney(t.newPrice)}`;
      break;
    default: main = t.note || TYPE_NAMES[t.type];
  }
  if (t.note && ['sale', 'purchase', 'return'].includes(t.type)) sub += ` · ${t.note}`;
  sub = `${time}${sub ? ' · ' + sub : ''}`;
  let amount = '';
  if (t.type === 'opening' || t.type === 'close') amount = `<div class="row-amount">${fmtMoney(t.amount)}</div>`;
  else if (t.type !== 'price') amount = `<div class="row-amount ${t.cash >= 0 ? 'pos' : 'neg'}">${t.cash >= 0 ? '+' : '−'}${fmtMoney(Math.abs(t.cash))}</div>`;
  else amount = '<div></div>';
  const flags = [];
  if (t.void) flags.push(`<span class="flag f-void">✕ ملغاة${t.voidReason ? ': ' + esc(t.voidReason) : ''}</span>`);
  if (t.edited) flags.push(`<span class="flag f-edit">✎ معدّلة (${t.edits.length})</span>`);
  if (t.returnedAmount) flags.push(`<span class="flag f-ret">↩ ${t.returnedAmount >= t.amount ? 'مُرتجعة بالكامل' : 'مُرتجعة جزئياً'} (${fmtMoney(t.returnedAmount)})</span>`);
  const edits = t.edits && t.edits.length ? `<details class="edits"><summary>سجل التعديلات</summary>${t.edits.map(e =>
    `<div>• ${esc(new Date(e.ts).toLocaleString('ar'))}${e.reason ? ` — السبب: ${esc(e.reason)}` : ''}<br><span class="row-sub">كانت: ${esc(txBrief(e.before))}</span></div>`).join('')}</details>` : '';
  const btns = [];
  if (actions && !t.void) {
    const open = (t.returnedAmount || 0) < t.amount;
    if (EDITABLE.includes(t.type)) btns.push(`<button type="button" data-edit="${t.id}">✎ تعديل</button>`);
    if ((t.type === 'sale' || t.type === 'purchase') && open) btns.push(`<button type="button" data-ret="${t.id}">↩ إرجاع</button>`);
    if (t.type === 'sale' && open) btns.push(`<button type="button" data-exch="${t.id}">⇄ تبديل</button>`);
    if ([...EDITABLE, 'return'].includes(t.type)) btns.push(`<button type="button" data-void="${t.id}">✕ إلغاء</button>`);
  }
  return `<div class="row ${t.void ? 'void' : ''}">
    <span class="badge b-${t.type}">${TYPE_NAMES[t.type]}</span>
    <div><div class="row-main">${esc(main)}</div><div class="row-sub">${esc(sub)}</div>${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}${edits}</div>
    ${amount}
    ${btns.length ? `<div class="row-actions">${btns.join('')}</div>` : ''}
  </div>`;
}
function renderToday() {
  const list = [...state.txToday].reverse().filter(t => ['sale', 'purchase', 'return'].includes(t.type)).slice(0, 15);
  $('todayList').innerHTML = list.length ? list.map(t => txRow(t, { actions: true })).join('') : '<div class="empty">لا توجد عمليات بيع أو شراء اليوم بعد</div>';
}
async function voidTx(id) {
  const t = await read('tx', st => st.get(id));
  if (!t || t.void) return;
  const reason = prompt(`إلغاء العملية:\n${txBrief(t)}\n\nستبقى في السجل مشطوبة ولن تُحسب. اكتب سبب الإلغاء (اختياري) ثم اضغط موافق:`, '');
  if (reason === null) return;
  t.void = true; t.voidTs = Date.now(); t.voidReason = reason.trim();
  await put('tx', t);
  if (t.type === 'return') { // إلغاء الإرجاع يعيد العملية الأصلية كما كانت
    const o = await read('tx', st => st.get(t.originalId));
    if (o) { o.returnedAmount = Math.max(0, (o.returnedAmount || 0) - t.amount); o.returns = (o.returns || []).filter(r => r.id !== t.id); await put('tx', o); }
  }
  await afterTxChange([t.date]);
  toast('تم إلغاء العملية');
}

function summarize(list) {
  const live = list.filter(t => !t.void);
  const s = { sales: 0, salesW: 0, purch: 0, purchW: 0, cin: 0, cout: 0, count: 0, feesOut: 0, feesIn: 0, making: 0, salesN: 0, purchN: 0, retSales: 0, retPurch: 0, purchDiff: 0 };
  for (const t of live) {
    if (t.type === 'sale') { s.sales += t.amount; s.salesW += t.weight; s.count++; s.salesN++; s.making += t.making || 0; }
    if (t.type === 'purchase') { s.purch += t.amount; s.purchW += t.weight; s.count++; s.purchN++; s.purchDiff += t.paidDiff || 0; }
    if (t.type === 'cash_in') s.cin += t.amount;
    if (t.type === 'cash_out') s.cout += t.amount;
    if (t.type === 'agent_fee') { if (t.cash < 0) s.feesOut += t.amount; else s.feesIn += t.amount; }
    if (t.type === 'return') {
      if (t.originalType === 'sale') { s.retSales += t.amount; s.making -= t.making || 0; } else s.retPurch += t.amount;
    }
  }
  return s;
}
const sumItem = (k, v) => `<div class="sum-item"><div class="k">${k}</div><div class="v">${v}</div></div>`;

// ---------------- الكاش اليومي ----------------
function renderCash() {
  const open = !!state.day;
  $('dayTitle').textContent = open ? `📅 يوم العمل المفتوح: ${dayLabel(state.day)}` : '🔒 لا يوجد يوم مفتوح';
  $('dayHint').textContent = open
    ? `فُتح الساعة ${fmtTime(state.day.openedAt || state.day.ts)}. في نهاية الدوام اضغط «إغلاق اليوم» لحفظ ملخصه في سجل الأيام.`
    : 'اضغط «فتح يوم جديد» وأدخل رصيد افتتاح الصباح لبدء العمل. أرصدة المندوبين والسجل السابق محفوظة.';
  $('closeDayBtn').hidden = !open;
  $('openDayBtn').hidden = open;
  document.querySelector('.day-card').classList.toggle('closed', !open);
  $('openingCard').hidden = !open;
  $('openingHint').textContent = open ? `رصيد الافتتاح المسجّل: ${fmtMoney(state.day.opening)} — يمكنك تعديله إذا أخطأت.` : '';
  if (open && document.activeElement !== $('openingInput')) $('openingInput').value = state.day.opening;
  const s = summarize(state.txToday);
  $('daySummary').innerHTML =
    sumItem('رصيد الافتتاح', fmtMoney(state.day ? state.day.opening : 0)) +
    sumItem('مبيعات (مبلغ)', fmtMoney(s.sales)) +
    sumItem('مبيعات (وزن غ)', fmtW(s.salesW)) +
    sumItem('إجمالي المصنعية', fmtMoney(s.making)) +
    sumItem('مشتريات (مبلغ)', fmtMoney(s.purch)) +
    sumItem('مشتريات (وزن غ)', fmtW(s.purchW)) +
    (s.purchDiff ? sumItem('فرق الشراء عن التسعيرة', (s.purchDiff > 0 ? '+' : '') + fmtMoney(s.purchDiff)) : '') +
    sumItem('إدخال كاش', fmtMoney(s.cin)) +
    sumItem('إخراج كاش', fmtMoney(s.cout)) +
    sumItem('أجور مدفوعة للمندوبين', fmtMoney(s.feesOut)) +
    (s.retSales ? sumItem('مرتجعات مبيعات (مدفوعة للزبائن)', fmtMoney(s.retSales)) : '') +
    (s.retPurch ? sumItem('مرتجعات مشتريات (مقبوضة)', fmtMoney(s.retPurch)) : '') +
    sumItem('الكاش الحالي', fmtMoney(cashNow()));
}
async function saveOpening() {
  if (!requireDay()) return;
  if ($('openingInput').value.trim() === '') return toast('أدخل رصيد الافتتاح', true);
  const v = num($('openingInput').value);
  const old = state.day.opening;
  if (old === v) return;
  if (!confirm(`تعديل رصيد الافتتاح من ${fmtMoney(old)} إلى ${fmtMoney(v)}؟`)) return;
  state.day.opening = v;
  await put('days', state.day);
  await addTx({ type: 'opening', amount: v, cash: 0, note: `تعديل من ${fmtMoney(old)}` });
  toast('تم تعديل رصيد الافتتاح ✔');
}

// ---------------- إغلاق اليوم / فتح يوم جديد ----------------
function closeSummaryHTML(opening, s, expected) {
  return sumItem('رصيد افتتاح الصباح', fmtMoney(opening)) +
    sumItem(`إجمالي المبيعات (${s.salesN} قطعة، ${fmtW(s.salesW)} غ)`, fmtMoney(s.sales)) +
    sumItem('المصنعية (صافي)', fmtMoney(s.making)) +
    sumItem(`إجمالي المشتريات (${s.purchN}، ${fmtW(s.purchW)} غ)`, fmtMoney(s.purch)) +
    (s.purchDiff ? sumItem('فرق الشراء عن التسعيرة', (s.purchDiff > 0 ? '+' : '') + fmtMoney(s.purchDiff)) : '') +
    sumItem('إدخال كاش', fmtMoney(s.cin)) +
    sumItem('إخراج كاش + أجور مندوبين', fmtMoney(s.cout + s.feesOut)) +
    (s.retSales ? sumItem('مرتجعات مبيعات (مدفوعة)', fmtMoney(s.retSales)) : '') +
    (s.retPurch ? sumItem('مرتجعات مشتريات (مقبوضة)', fmtMoney(s.retPurch)) : '') +
    `<div class="sum-item" style="border:2px solid var(--gold)"><div class="k">الكاش النهائي المتوقع</div><div class="v gold">${fmtMoney(expected)}</div></div>`;
}
function openCloseDialog() {
  if (!requireDay()) return;
  const s = summarize(state.txToday);
  $('cdTitle').textContent = dayLabel(state.day);
  $('cdSummary').innerHTML = closeSummaryHTML(state.day.opening, s, cashNow());
  $('cdActual').value = ''; $('cdNote').value = ''; $('cdDiff').innerHTML = '';
  $('closeDayDlg').showModal();
}
function calcCloseDiff() {
  const raw = $('cdActual').value.trim();
  if (!raw) { $('cdDiff').innerHTML = ''; return; }
  const diff = num(raw) - cashNow();
  $('cdDiff').innerHTML = Math.abs(diff) < 1
    ? '<span class="pos">✔ الكاش مطابق تماماً</span>'
    : `<span class="${diff > 0 ? 'pos' : 'neg'}">${diff > 0 ? 'زيادة' : 'نقص'} في الدرج: ${fmtMoney(Math.abs(diff))}</span>`;
}
async function closeDay() {
  if (!state.day) return;
  const s = summarize(state.txToday);
  const expected = Math.round(cashNow());
  const raw = $('cdActual').value.trim();
  const actual = raw ? Math.round(num(raw)) : null;
  const diff = actual == null ? null : actual - expected;
  const note = $('cdNote').value.trim();
  await addTx({ type: 'close', amount: expected, cash: 0, actual, diff, note });
  Object.assign(state.day, { status: 'closed', closedAt: Date.now(), summary: s, expected, actual, diff, closeNote: note });
  await put('days', state.day);
  await kvSet('currentDay', null);
  const closedLabel = dayLabel(state.day);
  state.day = null; state.today = null; state.txToday = [];
  renderLastSaved(null);
  refreshAll();
  toast(`تم إغلاق يوم ${closedLabel} ✔`);
  setTimeout(openDayDialog, 600);
}
async function lastClosedDay() {
  const days = (await getAll('days')).filter(d => d.status === 'closed' && !d.manual);
  days.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  return days[0] || null;
}
async function openDayDialog() {
  if (state.day) return;
  const last = await lastClosedDay();
  $('odDate').textContent = fmtDate(Date.now());
  if (last) {
    const carry = last.actual != null ? last.actual : last.expected;
    $('odOpening').value = carry;
    $('odHint').textContent = `تمت تعبئته تلقائياً من رصيد إغلاق يوم ${dayLabel(last)}: ${fmtMoney(carry)}${last.actual != null ? ' (الكاش الفعلي)' : ' (الكاش المتوقع)'} — يمكنك تعديله.`;
  } else {
    $('odOpening').value = '';
    $('odHint').textContent = 'أدخل المبلغ الموجود في الدرج صباحاً.';
  }
  if (!$('openDayDlg').open) { $('openDayDlg').showModal(); $('odOpening').select(); }
}
async function newDayKey() {
  const base = todayKey();
  let key = base, n = 1;
  while (await read('days', s => s.get(key))) key = `${base}-${++n}`;
  return key;
}
async function openDay() {
  if (state.day) return;
  if ($('odOpening').value.trim() === '') { toast('أدخل رصيد الافتتاح', true); return openDayDialog(); }
  const opening = num($('odOpening').value);
  const key = await newDayKey();
  state.day = { date: key, opening, status: 'open', openedAt: Date.now(), ts: Date.now() };
  await put('days', state.day);
  await kvSet('currentDay', key);
  state.today = key; state.txToday = [];
  await addTx({ type: 'opening', amount: opening, cash: 0, note: 'فتح يوم جديد' });
  toast('تم فتح يوم جديد ✔ بالتوفيق');
}

async function cashMove(dir) {
  const a = num($('cmAmount').value);
  if (a <= 0) return toast('أدخل المبلغ', true);
  const note = $('cmNote').value.trim();
  const tgt = await resolveDF('cash');
  if (!tgt) return;
  const dateLine = tgt.manual ? `\n📅 التاريخ: ${fmtDate(tgt.ts)} ${fmtTime(tgt.ts)}` : '';
  if (!confirm(`${dir > 0 ? 'إدخال' : 'إخراج'} ${fmtMoney(a)} ${note ? '(' + note + ')' : ''}${dateLine}\n\nتأكيد؟`)) return;
  const saved = await addTx({ type: dir > 0 ? 'cash_in' : 'cash_out', amount: a, cash: dir * a, note, date: tgt.date, ts: tgt.ts });
  $('cmAmount').value = ''; $('cmNote').value = '';
  resetDF('cash');
  toast('تم تسجيل الحركة ✔' + (saved.date !== state.today ? ` — في يوم ${dayLabel({ date: saved.date })}` : ''));
}

// ---------------- سعر النقابة ----------------
function openPriceDlg() {
  for (const k of ALL_KARATS) {
    const p = state.settings.prices[k];
    $(`p${k}s`).value = p.sell || '';
    $(`p${k}b`).value = p.buy || '';
  }
  $('priceDlg').showModal();
  $('p21s').select();
}
async function savePrice() {
  const prices = emptyPrices();
  for (const k of ALL_KARATS) prices[k] = { sell: num($(`p${k}s`).value), buy: num($(`p${k}b`).value) };
  const old = state.settings.prices;
  if (JSON.stringify(old) === JSON.stringify(prices)) return;
  state.settings.prices = prices;
  await kvSet('settings', state.settings);
  await addTx({ type: 'price', oldPrices: old, newPrices: prices, cash: 0 });
  state.gramManual = false; syncGramPrice(); calcTrade();
  toast('تم تحديث تسعيرة النقابة ✔');
}

// ---------------- المندوبين ----------------
// الرصيد بالوزن: موجب = للمندوب علينا (اشترينا منه) ، سالب = علي المندوب لنا (بعناه)
// carry = رصيد مرحّل من الأرشفة (موجب = له علينا)
function moveEquiv(m) { return m.type === 'carry' ? m.equiv : m.weight * m.rate / m.ref; }
const moveSign = (m) => (m.type === 'sell' ? -1 : 1);
function agentBalance(id) {
  return state.moves.filter(m => m.agentId === id && !m.void)
    .reduce((a, m) => a + moveSign(m) * moveEquiv(m), 0);
}
const refName = () => state.settings.ref === 1000 ? 'ذهب صافي' : 'عيار 21';
function balanceHTML(b) {
  if (Math.abs(b) < 0.0005) return `<span class="bal">0</span><span class="bal-label">الحساب مُسدّد</span>`;
  return b > 0
    ? `<span class="bal pos">${fmtW(b)} غ</span><span class="bal-label">له علينا (${refName()})</span>`
    : `<span class="bal neg">${fmtW(-b)} غ</span><span class="bal-label">لنا عليه (${refName()})</span>`;
}
function renderAgents() {
  const el = $('agentsList');
  if (!state.agents.length) { el.innerHTML = '<div class="empty">لا يوجد مندوبين بعد — أضف أول مندوب من الأعلى</div>'; return; }
  el.innerHTML = state.agents.map(a => `
    <button type="button" class="agent-card" data-agent="${a.id}">
      <div class="name">${esc(a.name)}</div>
      <div class="hint">${esc(a.phone || '')}</div>
      <div style="font-size:28px;margin-top:6px">${balanceHTML(agentBalance(a.id))}</div>
    </button>`).join('');
}
async function addAgent() {
  const name = $('agName').value.trim();
  if (!name) return toast('أدخل اسم المندوب', true);
  await add('agents', { name, phone: $('agPhone').value.trim(), createdAt: Date.now() });
  $('agName').value = ''; $('agPhone').value = '';
  await loadAgents(); renderAgents();
  toast('تمت إضافة المندوب ✔');
}
function openAgent(id) {
  state.agentId = id;
  $('agentsListView').hidden = true;
  $('agentDetailView').hidden = false;
  state.rateManual = false;
  setAMode('buy');
  window.scrollTo(0, 0);
}
function closeAgent() {
  state.agentId = null;
  $('agentsListView').hidden = false;
  $('agentDetailView').hidden = true;
  renderAgents();
}
function setAMode(m) {
  state.amode = m;
  document.querySelectorAll('[data-amode]').forEach(b => b.classList.toggle('active', b.dataset.amode === m));
  $('amSubmit').className = 'btn-primary ' + (m === 'buy' ? 'purchase' : 'sale');
  $('amSubmit').textContent = m === 'buy' ? '✔ تسجيل شراء من المندوب' : '✔ تسجيل بيع للمندوب';
  // الأجور فقط عند الشراء من المندوب (ندفعها له كاش)
  $('amFee').parentElement.style.visibility = m === 'buy' ? 'visible' : 'hidden';
  $('amFee').value = '';
  state.rateManual = false; syncRate(); calcAgent();
}
function syncRate() {
  if (!state.rateManual) $('amRate').value = state.settings.rates[state.amode][state.akarat];
}
function calcAgent() {
  const w = num($('amWeight').value), r = num($('amRate').value), ref = state.settings.ref;
  const e = w * r / ref;
  $('amEquiv').textContent = fmtW(e) + ' غ';
  const fee = state.amode === 'buy' ? num($('amFee').value) : 0;
  $('amCalc').textContent = w ? `${fmtW(w)} × ${r} ÷ ${ref} = ${fmtW(e)} غ ${refName()} — ${state.amode === 'buy' ? 'يُضاف لحساب المندوب (له)' : 'يُخصم من حساب المندوب (عليه)'}`
    + (fee ? ` · الأجور ${fmtMoney(fee)} تخرج من الكاش` : '') : '';
}
function renderAgentDetail() {
  const a = state.agents.find(x => x.id === state.agentId);
  if (!a) return;
  $('adName').textContent = a.name;
  $('adPhone').textContent = a.phone || '';
  $('adBalance').innerHTML = balanceHTML(agentBalance(a.id));
  const moves = state.moves.filter(m => m.agentId === a.id).sort((x, y) => x.ts - y.ts);
  let run = 0;
  const rows = moves.map(m => {
    const e = moveEquiv(m);
    if (!m.void) run += moveSign(m) * e;
    const after = run;
    if (m.type === 'carry') return `<div class="row">
      <span class="badge b-opening">رصيد مرحّل</span>
      <div><div class="row-main">${esc(m.note)}</div><div class="row-sub">${new Date(m.ts).toLocaleDateString('ar')}</div></div>
      <div class="row-amount" style="font-size:18px">الرصيد بعدها<br>${balanceHTML(after)}</div>
    </div>`;
    return `<div class="row ${m.void ? 'void' : ''}">
      <span class="badge ${m.type === 'buy' ? 'b-purchase' : 'b-sale'}">${m.type === 'buy' ? 'شراء منه' : 'بيع له'}</span>
      <div><div class="row-main">${fmtW(m.weight)} غ عيار ${m.karat} × ${m.rate} ÷ ${m.ref} = <b>${fmtW(e)} غ</b></div>
        <div class="row-sub">${new Date(m.ts).toLocaleDateString('ar')} ${fmtTime(m.ts)}${m.fee ? ` · أجور كاش ${fmtMoney(m.fee)}` : ''}${m.note ? ' · ' + esc(m.note) : ''}${m.void ? ' · (ملغاة)' : ''}</div></div>
      <div class="row-amount" style="font-size:18px">الرصيد بعدها<br>${balanceHTML(after)}</div>
      ${m.void ? '' : `<div class="row-actions"><button data-mvoid="${m.id}">إلغاء الحركة</button></div>`}
    </div>`;
  }).reverse();
  const fees = moves.filter(m => !m.void && m.fee);
  const feesOut = fees.filter(m => m.type === 'buy').reduce((a, m) => a + m.fee, 0);
  $('adPhone').textContent = [a.phone, feesOut ? `مجموع الأجور المدفوعة له: ${fmtMoney(feesOut)}` : ''].filter(Boolean).join(' · ');
  $('agentMoves').innerHTML = rows.length ? rows.join('') : '<div class="empty">لا توجد حركات لهذا المندوب بعد</div>';
}
async function submitAgentMove() {
  const w = num($('amWeight').value), r = num($('amRate').value);
  if (w <= 0) return toast('أدخل الوزن', true);
  if (r <= 0) return toast('أدخل العيار المعتمد', true);
  const fee = state.amode === 'buy' ? Math.round(num($('amFee').value)) : 0;
  if (fee < 0) return toast('الأجور غير صحيحة', true);
  const tgt = await resolveDF('agent', { needDay: fee > 0, needKey: fee > 0 });
  if (!tgt) return;
  const m = {
    agentId: state.agentId, ts: tgt.ts, type: state.amode, karat: state.akarat,
    weight: w, rate: r, ref: state.settings.ref, fee, note: $('amNote').value.trim(), void: false,
  };
  const e = moveEquiv(m);
  const feeTxt = fee ? `\nأجور للمندوب: ${fmtMoney(fee)} (تخرج من الصندوق)` : '';
  const dateLine = tgt.manual ? `\n📅 التاريخ: ${fmtDate(tgt.ts)} ${fmtTime(tgt.ts)}` : '';
  if (!confirm(`${m.type === 'buy' ? 'شراء من' : 'بيع إلى'} المندوب ${fmtW(w)} غ عيار ${m.karat}\nبعيار ${r} = ${fmtW(e)} غ ${refName()}${feeTxt}${dateLine}\n\nتأكيد؟`)) return;
  m.id = await add('agentMoves', m);
  if (fee) {
    const agent = state.agents.find(x => x.id === m.agentId);
    const t = await addTx({ type: 'agent_fee', date: tgt.date, ts: tgt.ts, amount: fee, cash: m.type === 'buy' ? -fee : fee, agentId: m.agentId, moveId: m.id,
      note: `أجور للمندوب ${agent ? agent.name : ''} — ${fmtW(w)} غ عيار ${m.karat}` });
    m.feeTxId = t.id;
    await put('agentMoves', m);
  }
  state.moves.push(m);
  $('amWeight').value = ''; $('amNote').value = ''; $('amFee').value = '';
  resetDF('agent');
  state.rateManual = false; syncRate(); calcAgent();
  renderAgentDetail();
  toast('تم تسجيل الحركة ✔');
}
async function voidMove(id) {
  const m = state.moves.find(x => x.id === id);
  if (!m || !confirm('إلغاء هذه الحركة؟ ستبقى في السجل مشطوبة ولن تُحسب في الرصيد.')) return;
  m.void = true; m.voidTs = Date.now();
  await put('agentMoves', m);
  if (m.feeTxId) { // إلغاء الأجور المرتبطة بالحركة من الكاش أيضاً
    const t = state.txToday.find(x => x.id === m.feeTxId) || await read('tx', s => s.get(m.feeTxId));
    if (t && !t.void) { t.void = true; t.voidTs = Date.now(); t.voidReason = 'إلغاء حركة المندوب'; await put('tx', t); await afterTxChange([t.date]); }
  }
  renderAgentDetail();
  toast('تم إلغاء الحركة');
}


// =====================================================================
// التاريخ: تلقائي (الآن) أو يدوي — تُحسب العملية ضمن اليوم المطابق
// =====================================================================
const pad2 = (n) => String(n).padStart(2, '0');
function toLocalInput(ts) { const d = new Date(ts); return `${todayKey(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
const dfEl = (name) => document.querySelector(`[data-df="${name}"]`);
function mountDateFields() {
  document.querySelectorAll('[data-df]').forEach(el => {
    const name = el.dataset.df;
    el.classList.add('date-field');
    el.innerHTML = `<span class="df-text"></span>
      <button type="button" class="link df-change">✎ تغيير التاريخ يدوياً</button>
      <input type="datetime-local" class="big-input small df-input" hidden>
      <button type="button" class="link df-reset" hidden>↺ رجوع للتاريخ التلقائي (الآن)</button>`;
    el.querySelector('.df-change').addEventListener('click', () => setDF(name, Date.now()));
    el.querySelector('.df-reset').addEventListener('click', () => resetDF(name));
    el.querySelector('.df-input').addEventListener('input', () => renderDF(name));
    renderDF(name);
  });
}
function setDF(name, ts) {
  const el = dfEl(name); if (!el) return;
  el.dataset.manual = '1';
  const inp = el.querySelector('.df-input');
  inp.max = toLocalInput(Date.now() + 60000);
  inp.value = toLocalInput(ts);
  renderDF(name);
}
function resetDF(name) { const el = dfEl(name); if (!el) return; delete el.dataset.manual; renderDF(name); }
function renderDF(name) {
  const el = dfEl(name); if (!el) return;
  const manual = !!el.dataset.manual, inp = el.querySelector('.df-input');
  el.classList.toggle('manual', manual);
  inp.hidden = !manual;
  el.querySelector('.df-reset').hidden = !manual;
  el.querySelector('.df-change').hidden = manual;
  if (manual) {
    const ts = new Date(inp.value).getTime();
    el.querySelector('.df-text').textContent = isFinite(ts)
      ? `⚠ تاريخ يدوي: ${fmtDate(ts)} ${fmtTime(ts)} — ستُحسب العملية ضمن ذلك اليوم`
      : '⚠ اختر التاريخ والوقت';
  } else {
    el.querySelector('.df-text').textContent = `📅 التاريخ: الآن (تلقائي)${state.day ? ' — يوم العمل المفتوح' : ''}`;
  }
}
// يرجع {ts, date(مفتاح اليوم), manual} أو null عند الإلغاء
async function resolveDF(name, { needDay = true, needKey = true } = {}) {
  const el = dfEl(name);
  if (!el || !el.dataset.manual) {
    if (needDay && !requireDay()) return null;
    return { ts: Date.now(), date: state.today, manual: false };
  }
  const ts = new Date(el.querySelector('.df-input').value).getTime();
  if (!isFinite(ts)) { toast('اختر التاريخ والوقت', true); return null; }
  if (ts > Date.now() + 60000) { toast('لا يمكن اختيار تاريخ في المستقبل', true); return null; }
  if (!needKey) return { ts, date: state.today, manual: true };
  const date = await dayKeyForDate(todayKey(new Date(ts)));
  return date ? { ts, date, manual: true } : null;
}
// يحدد يوم العمل المطابق لتاريخ (YYYY-MM-DD)، وينشئه في «الأيام الماضية» إذا لم يكن موجوداً
async function dayKeyForDate(dateStr) {
  if (dateStr > todayKey()) { toast('لا يمكن اختيار تاريخ في المستقبل', true); return null; }
  if (state.day && dateStr >= state.day.date.slice(0, 10)) return state.day.date;
  const same = (await getAll('days')).filter(d => d.date.slice(0, 10) === dateStr)
    .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  if (same.length) return same[0].date;
  const raw = prompt(`لا يوجد يوم عمل مسجّل بتاريخ ${dateStr}.\nسيتم إنشاء هذا اليوم في «الأيام الماضية».\n\nرصيد افتتاح ذلك اليوم (اتركه 0 إذا لا تعرفه):`, '0');
  if (raw === null) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const opening = num(raw);
  await put('days', {
    date: dateStr, opening, status: 'closed', manual: true, ts: Date.now(),
    openedAt: new Date(y, m - 1, d, 8, 0).getTime(), closedAt: new Date(y, m - 1, d, 23, 59).getTime(),
    expected: opening, actual: null, diff: null, summary: summarize([]),
  });
  return dateStr;
}

// =====================================================================
// إعادة حساب يوم بعد أي تعديل
// =====================================================================
const txOfDay = (key) => read('tx', st => st.index('date').getAll(key));
const dayCash = (day, list) => Math.round(day.opening + list.filter(t => !t.void).reduce((a, t) => a + (t.cash || 0), 0));
async function recomputeDay(key) {
  const day = key && await read('days', st => st.get(key));
  if (!day || day.status !== 'closed') return;       // اليوم المفتوح يُحسب مباشرة
  const list = await txOfDay(key);
  const oldExp = day.expected;
  day.summary = summarize(list);
  day.expected = dayCash(day, list);
  day.diff = day.actual == null ? null : day.actual - day.expected;
  await put('days', day);
  // إذا كان رصيد افتتاح اليوم التالي منقولاً من هذا اليوم (بدون عدّ فعلي) نعرض تحديثه
  if (oldExp == null || oldExp === day.expected || day.actual != null) return;
  const next = (await getAll('days')).filter(d => d.date !== key && (d.openedAt || 0) > (day.openedAt || 0))
    .sort((a, b) => a.openedAt - b.openedAt)[0];
  if (next && next.opening === oldExp && confirm(`الكاش النهائي ليوم ${dayLabel(day)} تغيّر من ${fmtMoney(oldExp)} إلى ${fmtMoney(day.expected)}.\nرصيد افتتاح اليوم التالي (${dayLabel(next)}) كان منقولاً منه.\n\nتحديث رصيد افتتاح اليوم التالي إلى ${fmtMoney(day.expected)}؟`)) {
    await setDayOpening(next, day.expected, `تحديث بعد تعديل يوم ${dayLabel(day)}`);
  }
}
async function setDayOpening(day, v, note) {
  const old = day.opening;
  day.opening = v;
  await put('days', day);
  await add('tx', { ts: Date.now(), date: day.date, void: false, type: 'opening', amount: v, cash: 0, note: `${note} — كان ${fmtMoney(old)}` });
  if (state.day && state.day.date === day.date) state.day.opening = v;
  await recomputeDay(day.date);
}
async function afterTxChange(keys = []) {
  for (const k of new Set(keys.filter(Boolean))) await recomputeDay(k);
  await loadToday();
  refreshAll();
  if (state.agentId) renderAgentDetail();
}

// =====================================================================
// تعديل عملية
// =====================================================================
let editing = null;
const karatOptions = (sel) => ALL_KARATS.map(k => `<option value="${k}" ${k == sel ? 'selected' : ''}>عيار ${k}</option>`).join('');
const SNAP_KEYS = ['type', 'date', 'ts', 'item', 'customer', 'items', 'weight', 'karat', 'gramPrice', 'extra', 'goldValue', 'amount', 'cash', 'making', 'makingPerGram', 'paidDiff', 'note'];
const snapshot = (t) => structuredClone(Object.fromEntries(SNAP_KEYS.filter(k => t[k] !== undefined).map(k => [k, t[k]])));
async function openEdit(id) {
  const t = await read('tx', st => st.get(id));
  if (!t || t.void) return;
  if (!EDITABLE.includes(t.type)) return toast('هذا النوع من العمليات لا يُعدّل', true);
  const items = t.type === 'sale'
    ? structuredClone(t.items || [{ item: t.item || '', karat: t.karat || 21, weight: t.weight, gramPrice: t.gramPrice, listPrice: t.listPrice }])
    : null;
  editing = { t, items };
  $('eTitle').textContent = `✎ تعديل ${TYPE_NAMES[t.type]} — يوم ${dayLabel({ date: t.date })}`;
  $('eDate').value = toLocalInput(t.ts);
  $('eDate').max = toLocalInput(Date.now() + 60000);
  $('eReason').value = '';
  renderEditBody();
  $('editDlg').showModal();
}
function renderEditBody() {
  const t = editing.t;
  let h = '';
  if (t.type === 'sale') {
    h = `<div class="cart-head">القطع</div>` + editing.items.map((x, i) => `
      <div class="edit-item" data-i="${i}">
        <input class="big-input small" data-f="item" value="${esc(x.item || '')}" placeholder="اسم القطعة">
        <input class="big-input small" data-f="weight" value="${x.weight ?? ''}" inputmode="decimal" placeholder="الوزن">
        <select class="big-input small" data-f="karat">${karatOptions(x.karat)}</select>
        <input class="big-input small" data-f="gramPrice" value="${x.gramPrice ?? ''}" inputmode="decimal" placeholder="سعر الغرام">
        <button type="button" class="del" data-edel="${i}" aria-label="حذف">✕</button>
      </div>`).join('') + `
      <div class="edit-item-head"><span>اسم القطعة</span><span>الوزن</span><span>العيار</span><span>سعر الغرام</span><span></span></div>
      <button type="button" class="link" id="eAddItem">＋ إضافة قطعة</button>
      <div class="grid2">
        <div><label class="field-label" for="eFinal">السعر النهائي</label><input id="eFinal" class="big-input" inputmode="decimal" value="${t.amount}"></div>
        <div><label class="field-label" for="eCustomer">اسم الزبون</label><input id="eCustomer" class="big-input small" value="${esc(t.customer || '')}"></div>
      </div>`;
  } else if (t.type === 'purchase') {
    h = `<div class="grid2">
      <div><label class="field-label">اسم القطعة</label><input id="eItem" class="big-input small" value="${esc(t.item || '')}"></div>
      <div><label class="field-label">اسم الزبون</label><input id="eCustomer" class="big-input small" value="${esc(t.customer || '')}"></div>
      <div><label class="field-label">الوزن</label><input id="eWeight" class="big-input small" inputmode="decimal" value="${t.weight}"></div>
      <div><label class="field-label">العيار</label><select id="eKarat" class="big-input small">${karatOptions(t.karat)}</select></div>
      <div><label class="field-label">سعر الغرام</label><input id="eGram" class="big-input small" inputmode="decimal" value="${t.gramPrice}"></div>
      <div><label class="field-label">المبلغ المدفوع للزبون</label><input id="ePaid" class="big-input small" inputmode="decimal" value="${t.amount}"></div>
    </div>`;
  } else {
    h = `<div class="grid2">
      <div><label class="field-label">المبلغ</label><input id="eAmount" class="big-input" inputmode="decimal" value="${t.amount}"></div>
      <div><label class="field-label">البيان</label><input id="eNote" class="big-input small" value="${esc(t.note || '')}"></div>
    </div>`;
  }
  $('eBody').innerHTML = h;
  calcEdit();
}
function readEditItems() {
  $('eBody').querySelectorAll('.edit-item').forEach(row => {
    const x = editing.items[row.dataset.i];
    x.item = row.querySelector('[data-f=item]').value.trim();
    x.weight = num(row.querySelector('[data-f=weight]').value);
    x.karat = Number(row.querySelector('[data-f=karat]').value);
    x.gramPrice = num(row.querySelector('[data-f=gramPrice]').value);
    x.goldValue = x.weight * x.gramPrice;
  });
}
function editValues() {
  const t = editing.t;
  if (t.type === 'sale') {
    readEditItems();
    const items = editing.items.filter(x => x.weight > 0);
    const w = items.reduce((a, x) => a + x.weight, 0);
    const goldValue = items.reduce((a, x) => a + x.goldValue, 0);
    const final = num($('eFinal').value), making = final - goldValue;
    return { items, w, goldValue, final, making, makingPerGram: w ? making / w : 0, g: items.length === 1 ? items[0].gramPrice : null, n: items.length };
  }
  if (t.type === 'purchase') {
    const w = num($('eWeight').value), g = num($('eGram').value), gv = w * g;
    const paid = $('ePaid').value.trim() ? num($('ePaid').value) : gv;
    return { w, g, goldValue: gv, paid, diff: paid - gv, diffPerGram: w ? (paid - gv) / w : 0, total: paid };
  }
  return { amount: num($('eAmount').value) };
}
function calcEdit() {
  const t = editing.t, v = editValues();
  let h = `<div class="hint">قبل التعديل: ${esc(txBrief(t))}</div>`;
  if (t.type === 'sale') h += `<div class="breakdown">${breakdownHTML(v)}</div>`;
  else if (t.type === 'purchase') h += `<div class="breakdown">${purchaseBreakdownHTML(v)}</div>`;
  else h += `<div class="total-label">المبلغ بعد التعديل</div><div class="total-value">${fmtMoney(v.amount)}</div>`;
  const ts = new Date($('eDate').value).getTime();
  if (isFinite(ts) && todayKey(new Date(ts)) !== todayKey(new Date(t.ts))) h += `<div class="warn">📅 تغيير التاريخ سينقل العملية إلى يوم ${fmtDate(ts)}</div>`;
  $('eCalc').innerHTML = h;
}
async function saveEdit() {
  const t = editing.t, v = editValues();
  const ts = new Date($('eDate').value).getTime();
  if (!isFinite(ts)) return toast('التاريخ غير صحيح', true);
  if (ts > Date.now() + 60000) return toast('لا يمكن اختيار تاريخ في المستقبل', true);
  if (t.type === 'sale') {
    if (!v.items.length) return toast('لازم قطعة وحدة على الأقل بوزن', true);
    if (v.items.some(x => x.gramPrice <= 0)) return toast('في قطعة بدون سعر غرام', true);
    if (v.final <= 0) return toast('أدخل السعر النهائي', true);
  } else if (t.type === 'purchase') {
    if (v.w <= 0 || v.g <= 0 || v.paid <= 0) return toast('الوزن أو السعر أو المبلغ غير صحيح', true);
  } else if (v.amount <= 0) return toast('أدخل المبلغ', true);

  const before = snapshot(t);
  const oldKey = t.date;
  let newKey = oldKey;
  if (todayKey(new Date(ts)) !== todayKey(new Date(t.ts))) {
    newKey = await dayKeyForDate(todayKey(new Date(ts)));
    if (!newKey) return;
  }
  if (t.type === 'sale') {
    const ks = [...new Set(v.items.map(x => x.karat))];
    Object.assign(t, {
      items: v.items.map(x => ({ ...x, goldValue: Math.round(x.goldValue) })),
      weight: v.w, goldValue: Math.round(v.goldValue), amount: Math.round(v.final), cash: Math.round(v.final),
      making: Math.round(v.making), makingPerGram: Math.round(v.makingPerGram),
      item: v.items.map(x => x.item || 'قطعة').join('، '), customer: $('eCustomer').value.trim(),
      karat: ks.length === 1 ? ks[0] : null, karats: ks, gramPrice: v.g,
      listPrice: v.items.length === 1 ? (v.items[0].listPrice ?? null) : null,
    });
  } else if (t.type === 'purchase') {
    const total = Math.round(v.total);
    Object.assign(t, {
      item: $('eItem').value.trim(), customer: $('eCustomer').value.trim(), weight: v.w,
      karat: Number($('eKarat').value), gramPrice: v.g, goldValue: Math.round(v.w * v.g),
      amount: total, cash: -total, paidDiff: Math.round(v.diff), paidDiffPerGram: Math.round(v.diffPerGram),
    });
    delete t.extra;
  } else {
    Object.assign(t, { amount: v.amount, note: $('eNote').value.trim(), cash: t.type === 'cash_in' ? v.amount : -v.amount });
  }
  t.ts = ts; t.date = newKey;
  if (JSON.stringify(snapshot(t)) === JSON.stringify(before)) { $('editDlg').close(); return toast('لم يتغيّر شيء'); }
  t.edits = [...(t.edits || []), { ts: Date.now(), reason: $('eReason').value.trim(), before }];
  t.edited = true;
  await put('tx', t);
  $('editDlg').close();
  await afterTxChange([oldKey, newKey]);
  toast(newKey !== oldKey ? `تم التعديل ✔ ونُقلت العملية إلى يوم ${dayLabel({ date: newKey })}` : 'تم حفظ التعديل ✔ وأُعيد حساب اليوم');
}

// =====================================================================
// إرجاع / تبديل
// =====================================================================
let retCtx = null;
async function openReturn(id, exchange = false) {
  const o = await read('tx', st => st.get(id));
  if (!o || o.void) return;
  const remaining = o.amount - (o.returnedAmount || 0);
  if (remaining <= 0) return toast('هذه العملية مُرتجعة بالكامل', true);
  retCtx = { o, exchange, remaining };
  const sale = o.type === 'sale';
  $('rTitle').textContent = exchange ? '⇄ تبديل قطعة' : (sale ? '↩ إرجاع قطعة من زبون' : '↩ إرجاع عملية شراء');
  $('rInfo').innerHTML = `العملية الأصلية: ${esc(txBrief(o))}<br>يوم ${esc(dayLabel({ date: o.date }))}`
    + (o.returnedAmount ? `<br>مُرتجع سابقاً: ${fmtMoney(o.returnedAmount)}` : '')
    + (exchange ? '<br><b>بعد تسجيل الإرجاع ستنتقل لشاشة البيع لتسجيل القطعة الجديدة، والفرق يُحسب تلقائياً.</b>' : '');
  $('rAmountLabel').textContent = sale ? 'المبلغ المُرجع للزبون (يخرج من الكاش)' : 'المبلغ الذي يعيده الزبون (يدخل الكاش)';
  $('rAmount').value = remaining;
  $('rReason').value = '';
  resetDF('ret');
  $('rOk').textContent = exchange ? '⇄ تسجيل الإرجاع ومتابعة التبديل' : '↩ تسجيل الإرجاع';
  $('retDlg').showModal();
}
async function doReturn() {
  const { o, exchange, remaining } = retCtx;
  const amount = Math.round(num($('rAmount').value));
  if (amount <= 0) return toast('أدخل المبلغ', true);
  if (amount > remaining) return toast(`المبلغ أكبر من المتبقي (${fmtMoney(remaining)})`, true);
  const tgt = await resolveDF('ret');
  if (!tgt) return;
  if (tgt.ts < o.ts) return toast('تاريخ الإرجاع قبل تاريخ العملية الأصلية', true);
  const ratio = amount / o.amount, sale = o.type === 'sale';
  const saved = await addTx({
    type: 'return', date: tgt.date, ts: tgt.ts, originalId: o.id, originalType: o.type, originalDate: o.date,
    item: o.item, customer: o.customer, weight: o.weight * ratio, amount, cash: sale ? -amount : amount,
    making: sale && o.making != null ? Math.round(o.making * ratio) : 0, exchange: !!exchange, note: $('rReason').value.trim(),
  });
  o.returnedAmount = (o.returnedAmount || 0) + amount;
  o.returns = [...(o.returns || []), { id: saved.id, ts: tgt.ts, amount, exchange: !!exchange }];
  await put('tx', o);
  $('retDlg').close();
  resetDF('ret');
  await afterTxChange([]);
  if (exchange) {
    state.exchange = { returnId: saved.id, amount, item: o.item, customer: o.customer };
    showTab('trade'); setMode('sale');
    $('tCustomer').value = o.customer || '';
    if (tgt.manual) setDF('trade', tgt.ts);
    renderExchange(); calcTrade();
    window.scrollTo(0, 0);
    toast('تم تسجيل الإرجاع ✔ — سجّل القطعة الجديدة الآن');
  } else toast('تم تسجيل الإرجاع ✔');
}
function renderExchange() {
  const x = state.exchange;
  $('exchBanner').hidden = !x;
  if (x) $('exchBanner').innerHTML = `⇄ <b>وضع التبديل:</b> تم إرجاع «${esc(x.item || 'قطعة')}» بمبلغ ${fmtMoney(x.amount)}${x.customer ? ` للزبون ${esc(x.customer)}` : ''}. سجّل القطعة الجديدة والسعر النهائي، وسيظهر الفرق تلقائياً.
    <button type="button" class="link" id="exchCancel">إنهاء وضع التبديل</button>`;
}

// =====================================================================
// الأيام الماضية
// =====================================================================
const pn = (k, v, signed = false) => `<span class="pn"><small>${k}</small><b class="${signed ? (v < 0 ? 'neg' : 'pos') : ''}">${signed && v > 0 ? '+' : ''}${fmtMoney(v)}</b></span>`;
async function renderPastDays() {
  const days = (await getAll('days')).sort((a, b) => (b.openedAt || b.ts || 0) - (a.openedAt || a.ts || 0));
  const by = {};
  for (const t of await getAll('tx')) (by[t.date] ||= []).push(t);
  const day = state.pastDay && days.find(d => d.date === state.pastDay);
  if (day) return renderPastDetail(day, by[day.date] || []);
  state.pastDay = null;
  $('pastDetail').hidden = true; $('pastList').hidden = false;
  $('pastList').innerHTML = days.length ? days.map(d => {
    const list = by[d.date] || [];
    const s = summarize(list), fin = dayCash(d, list), closed = d.status === 'closed';
    const n = list.filter(t => (t.type === 'sale' || t.type === 'purchase') && !t.void).length;
    return `<button type="button" class="day-row past-row" data-pday="${esc(d.date)}">
      <span class="d">${esc(dayLabel(d))}${d.manual ? ' <small>(أُضيف يدوياً)</small>' : ''}</span>
      <span class="st ${closed ? 'closed' : 'open'}">${closed ? '🔒 مغلق' : '📅 اليوم الحالي'}</span>
      <span class="past-nums">${pn('الافتتاح', d.opening)}${pn('المبيعات', s.sales)}${pn('المشتريات', s.purch)}${pn(closed ? 'الكاش النهائي' : 'الكاش الآن', fin)}${closed && d.actual != null ? pn('الفعلي', d.actual) + pn('الفرق', d.actual - fin, true) : ''}</span>
      <span class="nums">${n} عملية بيع/شراء${list.some(t => t.edited) ? ' · ✎ فيه تعديلات' : ''}${s.retSales || s.retPurch ? ' · ↩ فيه مرتجعات' : ''} — اضغط للتفاصيل ←</span>
    </button>`;
  }).join('') : '<div class="empty">لا توجد أيام بعد</div>';
}
function renderPastDetail(d, list) {
  $('pastList').hidden = true; $('pastDetail').hidden = false;
  const s = summarize(list), fin = dayCash(d, list), closed = d.status === 'closed';
  list.sort((a, b) => a.ts - b.ts);
  const diffCls = d.actual == null ? '' : d.actual - fin < 0 ? 'neg' : 'pos';
  $('pastDetail').innerHTML = `
    <button class="btn-back" id="pdBack" type="button">→ رجوع لقائمة الأيام</button>
    <div class="card">
      <h3>${closed ? '🔒' : '📅'} ${esc(dayLabel(d))}${d.manual ? ' (أُضيف يدوياً)' : ''}${closed ? '' : ' — اليوم المفتوح'}</h3>
      <div class="summary">${closeSummaryHTML(d.opening, s, fin)}
        ${closed ? sumItem('الكاش الفعلي في الدرج', d.actual != null ? fmtMoney(d.actual) : '—') +
          `<div class="sum-item"><div class="k">الفرق</div><div class="v ${diffCls}">${d.actual == null ? '—' : (d.actual - fin > 0 ? '+' : '') + fmtMoney(d.actual - fin)}</div></div>` : ''}
      </div>
      ${d.closeNote ? `<div class="hint">ملاحظة الإغلاق: ${esc(d.closeNote)}</div>` : ''}
      <div class="pd-actions">
        <button type="button" class="btn-primary outline" data-pd-opening="${esc(d.date)}">✎ تعديل رصيد الافتتاح</button>
        ${closed ? `<button type="button" class="btn-primary outline" data-pd-actual="${esc(d.date)}">✎ تعديل الكاش الفعلي</button>` : ''}
        <button type="button" class="btn-primary" data-pd-add="${esc(d.date)}">＋ تسجيل عملية بتاريخ هذا اليوم</button>
      </div>
    </div>
    <h3 class="section-title">عمليات اليوم بالترتيب (${list.length})</h3>
    <div class="list">${list.length ? list.map(t => txRow(t, { actions: true })).join('') : '<div class="empty">لا توجد عمليات في هذا اليوم</div>'}</div>`;
}
async function pastEditOpening(key) {
  const d = await read('days', st => st.get(key)); if (!d) return;
  const raw = prompt(`رصيد افتتاح يوم ${dayLabel(d)}:`, d.opening);
  if (raw === null || raw.trim() === '' || num(raw) === d.opening) return;
  await setDayOpening(d, num(raw), 'تعديل من الأيام الماضية');
  await afterTxChange([]);
  toast('تم تعديل رصيد الافتتاح ✔');
}
async function pastEditActual(key) {
  const d = await read('days', st => st.get(key)); if (!d) return;
  const raw = prompt(`الكاش الفعلي في الدرج عند إغلاق يوم ${dayLabel(d)} (اتركه فارغاً لمسحه):`, d.actual ?? '');
  if (raw === null) return;
  d.actual = raw.trim() === '' ? null : Math.round(num(raw));
  d.diff = d.actual == null ? null : d.actual - d.expected;
  await put('days', d);
  await afterTxChange([]);
  toast('تم الحفظ ✔');
}
function pastAddForDay(key) {
  const [y, m, dd] = key.slice(0, 10).split('-').map(Number);
  const noon = new Date(y, m - 1, dd, 12, 0).getTime();
  showTab('trade');
  if (state.day && key === state.day.date) resetDF('trade');
  else setDF('trade', Math.min(noon, Date.now()));
  window.scrollTo(0, 0);
  toast('سجّل العملية — التاريخ مضبوط على ذلك اليوم');
}


// =====================================================================
// الأرشفة وبدء فترة جديدة: حفظ الأيام القديمة في ملف ثم حذفها من الجهاز
// =====================================================================
let arch = null;
const csvCell = (v) => { const x = String(v ?? ''); return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
const toCSV = (rows) => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');   // BOM ليقرأ Excel العربي
function txCSV(list) {
  const rows = [['اليوم', 'التاريخ', 'الوقت', 'النوع', 'القطعة', 'الزبون', 'الوزن (غ)', 'العيار', 'سعر الغرام', 'قيمة الذهب', 'المبلغ', 'المصنعية / فرق الشراء', 'حركة الكاش', 'ملاحظة', 'الحالة']];
  for (const t of list) {
    const d = new Date(t.ts);
    const items = t.items && t.items.length > 1 ? itemsText(t.items) : (t.item || '');
    const extra = t.type === 'sale' ? (t.making ?? '') : t.type === 'purchase' ? (t.paidDiff ?? '') : '';
    const st = [t.void ? `ملغاة${t.voidReason ? ': ' + t.voidReason : ''}` : '', t.edited ? `معدّلة ${t.edits.length} مرة` : '', t.returnedAmount ? `مرتجع ${t.returnedAmount}` : ''].filter(Boolean).join(' / ');
    rows.push([t.date, d.toLocaleDateString('en-CA'), fmtTime(t.ts), TYPE_NAMES[t.type] || t.type, items, t.customer || '',
      t.weight != null ? Math.round(t.weight * 1000) / 1000 : '', t.karat || (t.karats || []).join('+'), t.gramPrice ?? '', t.goldValue ?? '',
      t.amount ?? '', extra, t.cash ?? '', t.note || '', st]);
  }
  return toCSV(rows);
}
function daysCSV(days, tx) {
  const rows = [['اليوم', 'الحالة', 'الافتتاح', 'المبيعات', 'وزن المبيعات', 'المصنعية', 'المشتريات', 'وزن المشتريات', 'فرق الشراء', 'مرتجعات مبيعات', 'إدخال كاش', 'إخراج كاش', 'أجور مندوبين', 'الكاش النهائي', 'الكاش الفعلي', 'الفرق']];
  for (const d of days) {
    const list = tx.filter(t => t.date === d.date), s = summarize(list), fin = dayCash(d, list);
    rows.push([dayLabel(d), d.status === 'closed' ? 'مغلق' : 'مفتوح', d.opening, s.sales, Math.round(s.salesW * 1000) / 1000, s.making, s.purch,
      Math.round(s.purchW * 1000) / 1000, s.purchDiff, s.retSales, s.cin, s.cout, s.feesOut, fin, d.actual ?? '', d.actual != null ? d.actual - fin : '']);
  }
  return toCSV(rows);
}
async function collectArchive(cutoff) {
  const days = (await getAll('days'))
    .filter(d => d.status === 'closed' && d.date !== state.today && d.date.slice(0, 10) <= cutoff)
    .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
  const keys = new Set(days.map(d => d.date));
  const tx = (await getAll('tx')).filter(t => keys.has(t.date)).sort((a, b) => a.ts - b.ts);
  const [y, m, d] = cutoff.split('-').map(Number);
  const cutoffTs = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  const moves = (await getAll('agentMoves')).filter(mv => mv.ts <= cutoffTs);
  return { cutoff, cutoffTs, days, tx, moves, exported: false };
}
async function openArchive() {
  const closed = (await getAll('days')).filter(d => d.status === 'closed' && d.date !== state.today).map(d => d.date.slice(0, 10)).sort();
  if (!closed.length) return toast('لا توجد أيام مغلقة للأرشفة', true);
  const now = new Date();
  const endPrevMonth = todayKey(new Date(now.getFullYear(), now.getMonth(), 0));  // آخر يوم بالشهر الماضي
  const min = closed[0], max = closed[closed.length - 1];
  $('arTo').min = min; $('arTo').max = max;
  $('arTo').value = endPrevMonth >= min && endPrevMonth <= max ? endPrevMonth : max;
  await calcArchive();
  $('archDlg').showModal();
}
async function calcArchive() {
  if (!$('arTo').value) return;
  arch = await collectArchive($('arTo').value);
  $('arPurge').disabled = true;
  $('arExportHint').textContent = '';
  const n = arch.days.length;
  $('arExport').disabled = !n;
  $('arInfo').innerHTML = n
    ? sumItem('عدد الأيام', n) + sumItem('من', dayLabel(arch.days[0])) + sumItem('إلى', dayLabel(arch.days[n - 1])) +
      sumItem('عدد العمليات', arch.tx.length) + sumItem('حركات مندوبين تُرحّل كرصيد', arch.moves.length)
    : '<div class="empty">لا توجد أيام مغلقة حتى هذا التاريخ</div>';
}
async function exportArchive() {
  const a = arch; if (!a || !a.days.length) return;
  const from = a.days[0].date.slice(0, 10), to = a.days[a.days.length - 1].date.slice(0, 10);
  const tag = `${from}_${to}`;
  const data = {
    app: 'goldshop', kind: 'archive', version: DB_VER, exportedAt: new Date().toISOString(), from, to,
    settings: state.settings, agents: state.agents, days: a.days, tx: a.tx, agentMoves: a.moves,
  };
  const ok = await saveFiles([
    { name: `goldshop-archive-${tag}.json`, text: JSON.stringify(data), type: 'application/json' },
    { name: `goldshop-archive-${tag}-operations.csv`, text: txCSV(a.tx), type: 'text/csv' },
    { name: `goldshop-archive-${tag}-days.csv`, text: daysCSV(a.days, a.tx), type: 'text/csv' },
  ], `أرشيف محل الذهب ${from} → ${to}`);
  if (!ok) return toast('لم يتم الحفظ — جرّب مرة ثانية', true);
  a.exported = true; a.from = from; a.to = to;
  $('arPurge').disabled = false;
  $('arExportHint').textContent = '✔ تم تجهيز ملفات الأرشيف. تأكد إنها انحفظت فعلاً على Drive (أو وصلتك على واتساب) قبل الخطوة 2.';
}
async function purgeArchive() {
  const a = arch;
  if (!a || !a.exported) return toast('احفظ ملف الأرشيف أولاً (الخطوة 1)', true);
  if (!confirm(`سيتم حذف ${a.days.length} يوم و ${a.tx.length} عملية من الجهاز (من ${a.from} إلى ${a.to}).\n\nأرصدة المندوبين والتسعيرة والإعدادات واليوم المفتوح تبقى.\n\nهل تأكدت إن ملف الأرشيف محفوظ على Drive؟`)) return;
  // ترحيل أرصدة المندوبين: كل الحركات المؤرشفة تصبح سطراً واحداً «رصيد مرحّل»
  const byAgent = {};
  for (const m of a.moves) if (!m.void) byAgent[m.agentId] = (byAgent[m.agentId] || 0) + moveSign(m) * moveEquiv(m);
  const carries = Object.entries(byAgent).filter(([, b]) => Math.abs(b) >= 0.0005).map(([id, b]) => ({
    agentId: Number(id), ts: a.cutoffTs, type: 'carry', equiv: b, weight: 0, karat: null, rate: 0, ref: state.settings.ref,
    fee: 0, note: `رصيد مرحّل من الأرشيف حتى ${a.to}`, void: false,
  }));
  await new Promise((resolve, reject) => {
    const t = db.transaction(['days', 'tx', 'agentMoves'], 'readwrite');
    a.days.forEach(d => t.objectStore('days').delete(d.date));
    a.tx.forEach(x => t.objectStore('tx').delete(x.id));
    a.moves.forEach(m => t.objectStore('agentMoves').delete(m.id));
    carries.forEach(c => t.objectStore('agentMoves').add(c));
    t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
  const log = (await kvGet('archives')) || [];
  log.push({ ts: Date.now(), from: a.from, to: a.to, days: a.days.length, tx: a.tx.length });
  await kvSet('archives', log);
  $('archDlg').close();
  arch = null; state.pastDay = null;
  await loadAll();
  if ($('tab-past').classList.contains('active')) renderPastDays();
  toast(`تمت الأرشفة ✔ — بدأت فترة جديدة (حُذف ${a.days.length} يوم من الجهاز)`);
}

// ---------------- السجل ----------------
let hDayInit = false;
async function renderHistory() {
  const days = (await getAll('days')).sort((a, b) => (b.openedAt || b.ts || 0) - (a.openedAt || a.ts || 0));
  const sel = $('hDay');
  const cur = hDayInit ? sel.value : (state.today || '');
  hDayInit = true;
  sel.innerHTML = '<option value="">📚 كل الأيام (سجل الأيام)</option>' + days.map(d =>
    `<option value="${esc(d.date)}">${esc(dayLabel(d))} — ${d.status === 'closed' ? 'مغلق' : 'مفتوح'}</option>`).join('');
  sel.value = days.some(d => d.date === cur) ? cur : '';
  const d = sel.value;
  const type = $('hType').value;
  $('hDayReport').innerHTML = '<div class="hint">لمراجعة يوم بالتفصيل أو تعديل عملياته أو تسجيل إرجاع، افتح تبويب «الأيام الماضية».</div>';
  let list = d ? await read('tx', s => s.index('date').getAll(d)) : await getAll('tx');
  if (type) list = list.filter(t => t.type === type);
  list.sort((a, b) => b.ts - a.ts);
  const s = summarize(list);
  $('hSummary').innerHTML =
    sumItem('عدد عمليات البيع/الشراء', s.count) +
    sumItem('مبيعات', fmtMoney(s.sales) + ` (${fmtW(s.salesW)} غ)`) +
    sumItem('المصنعية', fmtMoney(s.making)) +
    sumItem('مشتريات', fmtMoney(s.purch) + ` (${fmtW(s.purchW)} غ)`);
  const shown = list.slice(0, 500);
  $('historyList').innerHTML = shown.length
    ? shown.map(t => txRow(t, { showDate: !d })).join('') + (list.length > 500 ? '<div class="empty">يتم عرض آخر 500 عملية — اختر يوماً لعرض تفاصيله</div>' : '')
    : '<div class="empty">لا توجد عمليات</div>';
}

// ---------------- الإعدادات والنسخ الاحتياطي ----------------
function renderSettings() {
  const r = state.settings.rates;
  $('sBuy21').value = r.buy[21]; $('sBuy18').value = r.buy[18];
  $('sSell21').value = r.sell[21]; $('sSell18').value = r.sell[18];
  $('sRef').value = String(state.settings.ref);
}
async function saveSettings() {
  const vals = ['sBuy21', 'sBuy18', 'sSell21', 'sSell18'].map(id => num($(id).value));
  if (vals.some(v => v <= 0)) return toast('القيم يجب أن تكون أكبر من صفر', true);
  const [b21, b18, s21, s18] = vals;
  state.settings.rates = { buy: { 21: b21, 18: b18 }, sell: { 21: s21, 18: s18 } };
  state.settings.ref = Number($('sRef').value);
  await kvSet('settings', state.settings);
  toast('تم حفظ الإعدادات ✔');
}
// يحفظ/يشارك ملفات: داخل تطبيق أندرويد عبر قائمة المشاركة (Drive، واتساب...)، وفي المتصفح تنزيل
// يرجع true إذا تمت المشاركة/التنزيل، false إذا ألغى المستخدم
async function saveFiles(files, title) {
  const C = window.Capacitor;
  if (C && C.isNativePlatform && C.isNativePlatform()) {
    const { Filesystem, Share } = C.Plugins || {};
    if (!Filesystem || !Share) { toast('ميزة الحفظ غير متوفرة في هذه النسخة من التطبيق', true); return false; }
    try {
      const uris = [];
      for (const f of files) {
        const r = await Filesystem.writeFile({ path: f.name, data: f.text, directory: 'CACHE', encoding: 'utf8' });
        uris.push(r.uri);
      }
      await Share.share({ title, files: uris, dialogTitle: 'احفظ الملف على Drive أو أرسله لنفسك' });
      return true;
    } catch (e) {
      if (/cancel/i.test(e && e.message || '')) return false;
      toast('تعذّر الحفظ: ' + (e && e.message || e), true);
      return false;
    }
  }
  const fileObjs = files.map(f => new File([f.text], f.name, { type: f.type }));
  try {
    if (navigator.canShare && navigator.canShare({ files: fileObjs })) {
      await navigator.share({ files: fileObjs, title });
      return true;
    }
  } catch (e) { if (e.name === 'AbortError') return false; }
  for (const f of fileObjs) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    await new Promise(r => setTimeout(r, 400));
  }
  return true;
}

async function exportBackup() {
  const data = {
    app: 'goldshop', version: DB_VER, exportedAt: new Date().toISOString(),
    settings: state.settings, currentDay: state.today, days: await getAll('days'), tx: await getAll('tx'),
    agents: await getAll('agents'), agentMoves: await getAll('agentMoves'),
  };
  const ok = await saveFiles([{ name: `goldshop-backup-${todayKey()}.json`, text: JSON.stringify(data), type: 'application/json' }], 'نسخة احتياطية — محل الذهب');
  if (!ok) return;
  await kvSet('lastBackup', Date.now());
  toast('تم تصدير النسخة الاحتياطية ✔');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'goldshop') throw new Error('ملف غير صالح');
    if (data.kind === 'archive') throw new Error('هذا ملف أرشيف للحفظ فقط وليس نسخة احتياطية كاملة — لا يُسترجع حتى لا تضيع بياناتك الحالية');
    if (!confirm(`سيتم استبدال كل البيانات الحالية بالنسخة الاحتياطية بتاريخ ${data.exportedAt}.\nهل أنت متأكد؟`)) return;
    const stores = ['kv', 'days', 'tx', 'agents', 'agentMoves'];
    await new Promise((resolve, reject) => {
      const t = db.transaction(stores, 'readwrite');
      stores.forEach(s => t.objectStore(s).clear());
      t.objectStore('kv').put(data.settings, 'settings');
      if (data.currentDay !== undefined) t.objectStore('kv').put(data.currentDay, 'currentDay');
      data.days.forEach(x => t.objectStore('days').put(x));
      data.tx.forEach(x => t.objectStore('tx').put(x));
      data.agents.forEach(x => t.objectStore('agents').put(x));
      data.agentMoves.forEach(x => t.objectStore('agentMoves').put(x));
      t.oncomplete = resolve; t.onerror = () => reject(t.error);
    });
    await loadAll();
    toast('تم استرجاع البيانات ✔');
  } catch (e) {
    toast('فشل الاسترجاع: ' + e.message, true);
  }
}
async function renderStorageInfo() {
  let txt = '';
  const lb = await kvGet('lastBackup');
  txt += lb ? `آخر نسخة احتياطية: ${new Date(lb).toLocaleString('ar')}. ` : 'لم يتم أخذ نسخة احتياطية بعد. ';
  if (navigator.storage && navigator.storage.persisted) {
    const p = await navigator.storage.persisted();
    txt += p ? 'التخزين الدائم: مفعّل ✔' : 'التخزين الدائم: غير مؤكد — ثبّت التطبيق على الشاشة الرئيسية.';
  }
  const arcs = (await kvGet('archives')) || [];
  if (arcs.length) { const l = arcs[arcs.length - 1]; txt += ` · آخر أرشفة: ${new Date(l.ts).toLocaleDateString('ar')} (من ${l.from} إلى ${l.to}، ${l.days} يوم).`; }
  $('storageInfo').textContent = txt;
}

// ---------------- التنقل والتحديث ----------------
function refreshAll() {
  renderHeader();
  renderToday();
  renderCash();
  if ($('tab-history').classList.contains('active')) renderHistory();
  if ($('tab-past').classList.contains('active')) renderPastDays();
  document.querySelectorAll('[data-df]').forEach(el => renderDF(el.dataset.df));
}
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'history') renderHistory();
  if (name === 'past') renderPastDays();
  if (name === 'settings') { renderSettings(); renderStorageInfo(); }
  if (name === 'agents') state.agentId ? renderAgentDetail() : renderAgents();
}
async function loadAll() {
  await loadSettings();
  await loadToday();
  await loadAgents();
  syncGramPrice();
  refreshAll();
  renderAgents();
}

function bindEvents() {
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tab === 'past') state.pastDay = null;   // التبويب يفتح دائماً على قائمة الأيام
    showTab(b.dataset.tab);
  });
  $('priceBtn').addEventListener('click', openPriceDlg);
  $('priceDlg').addEventListener('close', () => { if ($('priceDlg').returnValue === 'ok') savePrice(); });

  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  const pickKarat = e => {
    const b = e.target.closest('button'); if (!b) return;
    state.karat = Number(b.dataset.k); state.gramManual = false;
    renderKaratButtons(); syncGramPrice(); calcTrade();
  };
  $('tradeKarat').addEventListener('click', pickKarat);
  $('tradeKaratMinor').addEventListener('click', pickKarat);
  $('tWeight').addEventListener('input', calcTrade);
  $('tPaid').addEventListener('input', calcTrade);
  $('tFinal').addEventListener('input', calcTrade);
  $('tAddItem').addEventListener('click', addToCart);
  $('tGram').addEventListener('input', () => { state.gramManual = true; calcTrade(); });
  $('tGramReset').addEventListener('click', () => { state.gramManual = false; syncGramPrice(); calcTrade(); });
  $('tSubmit').addEventListener('click', submitTrade);
  document.addEventListener('click', e => {
    const v = e.target.closest('[data-void]'); if (v) voidTx(Number(v.dataset.void));
    const m = e.target.closest('[data-mvoid]'); if (m) voidMove(Number(m.dataset.mvoid));
    const ed = e.target.closest('[data-edit]'); if (ed) openEdit(Number(ed.dataset.edit));
    const rt = e.target.closest('[data-ret]'); if (rt) openReturn(Number(rt.dataset.ret), false);
    const ex = e.target.closest('[data-exch]'); if (ex) openReturn(Number(ex.dataset.exch), true);
    const pd = e.target.closest('[data-pday]'); if (pd) { state.pastDay = pd.dataset.pday; renderPastDays(); window.scrollTo(0, 0); }
    if (e.target.closest('#pdBack')) { state.pastDay = null; renderPastDays(); }
    const po = e.target.closest('[data-pd-opening]'); if (po) pastEditOpening(po.dataset.pdOpening);
    const pa = e.target.closest('[data-pd-actual]'); if (pa) pastEditActual(pa.dataset.pdActual);
    const pp = e.target.closest('[data-pd-add]'); if (pp) pastAddForDay(pp.dataset.pdAdd);
    if (e.target.closest('#exchCancel')) { state.exchange = null; renderExchange(); calcTrade(); toast('انتهى وضع التبديل — الإرجاع بقي مسجّلاً'); }
    const cd = e.target.closest('[data-cart-del]'); if (cd) removeFromCart(Number(cd.dataset.cartDel));
    const a = e.target.closest('[data-agent]'); if (a) openAgent(Number(a.dataset.agent));
    const dr = e.target.closest('[data-day]'); if (dr) { $('hDay').value = dr.dataset.day; renderHistory(); window.scrollTo(0, 0); }
  });

  $('openingSave').addEventListener('click', saveOpening);
  $('closeDayBtn').addEventListener('click', openCloseDialog);
  $('openDayBtn').addEventListener('click', openDayDialog);
  $('cdActual').addEventListener('input', calcCloseDiff);
  $('closeDayDlg').addEventListener('close', () => { if ($('closeDayDlg').returnValue === 'ok') closeDay(); });
  $('openDayDlg').addEventListener('close', () => { if ($('openDayDlg').returnValue === 'ok') openDay(); });
  $('cmIn').addEventListener('click', () => cashMove(1));
  $('cmOut').addEventListener('click', () => cashMove(-1));

  $('agAdd').addEventListener('click', addAgent);
  $('agBack').addEventListener('click', closeAgent);
  document.querySelectorAll('[data-amode]').forEach(b => b.addEventListener('click', () => setAMode(b.dataset.amode)));
  $('agKarat').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.akarat = Number(b.dataset.k);
    $('agKarat').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    state.rateManual = false; syncRate(); calcAgent();
  });
  $('amWeight').addEventListener('input', calcAgent);
  $('amFee').addEventListener('input', calcAgent);
  $('amRate').addEventListener('input', () => { state.rateManual = true; calcAgent(); });
  $('amRateReset').addEventListener('click', () => { state.rateManual = false; syncRate(); calcAgent(); });
  $('amSubmit').addEventListener('click', submitAgentMove);

  $('hDay').addEventListener('change', renderHistory);
  $('hType').addEventListener('change', renderHistory);
  $('hAll').addEventListener('click', () => { $('hDay').value = ''; renderHistory(); });

  $('sSave').addEventListener('click', saveSettings);

  // نافذة التعديل
  $('eBody').addEventListener('input', calcEdit);
  $('eBody').addEventListener('change', e => {
    const t = editing && editing.t;
    if (!t) return;
    if (e.target.matches('[data-f=karat]')) {   // تغيير العيار يجلب سعره من التسعيرة الحالية
      const row = e.target.closest('.edit-item');
      const p = karatPrice(Number(e.target.value), 'sale');
      if (p) row.querySelector('[data-f=gramPrice]').value = p;
    }
    if (e.target.id === 'eKarat') { const p = karatPrice(Number(e.target.value), 'purchase'); if (p) $('eGram').value = p; }
    calcEdit();
  });
  $('eBody').addEventListener('click', e => {
    const del = e.target.closest('[data-edel]');
    if (del) { readEditItems(); editing.items.splice(Number(del.dataset.edel), 1); renderEditBody(); }
    if (e.target.id === 'eAddItem') { readEditItems(); editing.items.push({ item: '', karat: 21, weight: 0, gramPrice: karatPrice(21, 'sale') }); renderEditBody(); }
  });
  $('eDate').addEventListener('input', calcEdit);
  $('eSave').addEventListener('click', saveEdit);
  $('eCancel').addEventListener('click', () => $('editDlg').close());
  $('rOk').addEventListener('click', doReturn);
  // الأرشفة
  $('archBtn').addEventListener('click', openArchive);
  $('archBtn2').addEventListener('click', openArchive);
  $('arTo').addEventListener('change', calcArchive);
  $('arExport').addEventListener('click', exportArchive);
  $('arPurge').addEventListener('click', purgeArchive);
  $('arCancel').addEventListener('click', () => $('archDlg').close());
  $('rCancel').addEventListener('click', () => $('retDlg').close());
  $('bExport').addEventListener('click', exportBackup);
  $('bImport').addEventListener('change', e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });

  // تذكير إذا بقي اليوم مفتوحاً من تاريخ سابق
  setInterval(renderHeader, 60000);
}

(async function init() {
  try {
    db = await openDB();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    renderKaratButtons();
    mountDateFields();
    bindEvents();
    await loadAll();
    setMode('sale');
    if (!hasPrices()) {
      openPriceDlg();
      $('priceDlg').addEventListener('close', () => { if (!state.day) setTimeout(openDayDialog, 300); }, { once: true });
    } else if (!state.day) openDayDialog();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-size:22px">خطأ في فتح قاعدة البيانات: ${esc(e.message)}</div>`;
  }
})();
