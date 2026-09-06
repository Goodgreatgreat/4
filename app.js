import {
  LedgerValidationError,
  calculateActualExchangeRate,
  calculateTaiwanSecuritiesTax,
  calculateTradeFee,
  processFxLedger,
  processLedger,
} from './ledger.js';
import {
  STORAGE_KEYS,
  buildBackup,
  createRecordId,
  readCollection,
  readStoredJson,
  removeRecord,
  restoreBackup,
  saveCollection,
  upsertRecord,
  writeStoredJson,
} from './storage.js';
import {
  TiingoError,
  fetchLatestTiingoClose,
  normalizeTiingoSymbol,
  normalizeTiingoToken,
  validateTiingoToken,
} from './tiingo.js';

const TIINGO_STORAGE = Object.freeze({
  token: 'stock-journal:tiingo-token:v1',
  enabled: 'stock-journal:tiingo-enabled:v1',
  autoUpdate: 'stock-journal:tiingo-auto-update:v1',
  lastRefresh: 'stock-journal:tiingo-last-refresh:v1',
});

const PRE_IMPORT_BACKUP_KEY = 'stock-journal:pre-import-backup:v1';
const DEFAULT_CATEGORIES = Object.freeze(['核心配置', '成長', '存股']);
const DEFAULT_BROKER = Object.freeze({
  id: 'sinopac',
  name: '永豐金證券',
  markets: ['TW', 'US'],
  tw: {
    standardFeeRate: 0.001425,
    discount: 0.28,
    minimumFee: 20,
    feeDecimals: 0,
    feeRounding: 'round',
  },
  us: {
    model: 'fixed',
    fixedFee: 0,
    perShareFee: 0,
    percentageRate: 0,
    minimumFee: 0,
    feeDecimals: 2,
    feeRounding: 'round',
  },
});

const DEFAULT_PREFERENCES = Object.freeze({
  defaultBrokers: { TW: DEFAULT_BROKER.id, US: DEFAULT_BROKER.id },
  categories: [...DEFAULT_CATEGORIES],
  taxRates: { stock: 0.003, etf: 0.001, dayTrade: 0.0015 },
  lastMonthlyReportSeen: '',
});

const knownNames = Object.freeze({
  '0050': '元大台灣50',
  '2330': '台積電',
  AAPL: 'Apple',
  NVDA: 'NVIDIA',
});
const knownSymbolsByName = Object.freeze(
  Object.fromEntries(Object.entries(knownNames).map(([symbol, name]) => [name.toLowerCase(), symbol])),
);

const currencyFormatters = {
  TWD: new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }),
  USD: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};
const numberFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 6 });
const percentFormatter = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toPositiveNumber(value) {
  const number = Number(String(value ?? '').replaceAll(',', '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toNonNegativeNumber(value, fallback = 0) {
  const text = String(value ?? '').replaceAll(',', '').trim();
  if (text === '') return fallback;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function taipeiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatDate(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : String(value || '日期未知');
}

function formatMoney(value, currency, { signed = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const prefix = currency === 'USD' ? 'US$' : 'NT$';
  const sign = signed && number > 0 ? '+' : '';
  return `${sign}${prefix}${currencyFormatters[currency]?.format(number) ?? number.toFixed(2)}`;
}

function formatPercent(value, { signed = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${signed && number > 0 ? '+' : ''}${percentFormatter.format(number)}%`;
}

function setFeedback(element, message, kind = 'info') {
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = !message;
}

function setValueClass(element, value) {
  if (!element) return;
  const number = Number(value);
  element.classList.toggle('is-profit', Number.isFinite(number) && number > 0);
  element.classList.toggle('is-loss', Number.isFinite(number) && number < 0);
}

function showToast(message, kind = 'success') {
  const toast = $('#app-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 3200);
}

function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function describeLedgerError(error) {
  if (error instanceof LedgerValidationError) {
    if (error.code === 'OVERSELL') return '這次修改會造成賣出股數大於當時庫存，請先確認較早的買入紀錄。';
    if (error.code === 'OVERSELL_USD') return '這次修改會造成賣出美元大於當時餘額，請先確認較早的換匯紀錄。';
    return error.message;
  }
  return error instanceof Error ? error.message : '資料無法計算，請檢查輸入內容。';
}

function getPreferences() {
  const saved = readStoredJson(localStorage, STORAGE_KEYS.preferences, {});
  return {
    ...clone(DEFAULT_PREFERENCES),
    ...saved,
    defaultBrokers: { ...DEFAULT_PREFERENCES.defaultBrokers, ...(saved.defaultBrokers ?? {}) },
    taxRates: { ...DEFAULT_PREFERENCES.taxRates, ...(saved.taxRates ?? {}) },
    categories: Array.isArray(saved.categories) && saved.categories.length
      ? [...new Set(saved.categories.map((item) => String(item).trim()).filter(Boolean))]
      : [...DEFAULT_CATEGORIES],
  };
}

function savePreferences(next) {
  writeStoredJson(localStorage, STORAGE_KEYS.preferences, next);
  return next;
}

function ensureInitialData() {
  if (readCollection(localStorage, 'brokers').length === 0) {
    saveCollection(localStorage, 'brokers', [clone(DEFAULT_BROKER)]);
  }
  const current = readStoredJson(localStorage, STORAGE_KEYS.preferences, null);
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    savePreferences(clone(DEFAULT_PREFERENCES));
  } else {
    savePreferences(getPreferences());
  }
}

function normalizeDate(value) {
  const date = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : taipeiDateKey();
}

function inferInstrument(rawValue, forcedMarket = null) {
  const raw = String(rawValue ?? '').normalize('NFKC').trim();
  const knownSymbol = knownSymbolsByName[raw.toLowerCase()] ?? null;
  const numeric = (knownSymbol && /^\d/.test(knownSymbol) ? knownSymbol : null)
    ?? raw.match(/(?:^|\s)(\d{4,6})(?:\s|$)/)?.[1]
    ?? (/^\d{4,6}$/.test(raw) ? raw : null);
  const latin = (knownSymbol && /^[A-Z]/.test(knownSymbol) ? knownSymbol : null)
    ?? raw.match(/(?:^|\s)([A-Za-z][A-Za-z0-9.-]{0,31})(?:\s|$)/)?.[1]
    ?? (/^[A-Za-z][A-Za-z0-9.-]{0,31}$/.test(raw) ? raw : null);
  const market = forcedMarket ?? (latin && !numeric ? 'US' : 'TW');
  let symbol = market === 'US' ? (latin ?? raw).toUpperCase() : (numeric ?? raw);
  symbol = symbol.trim();
  const remainingName = raw.replace(symbol, '').trim();
  return {
    market,
    symbol,
    name: remainingName || knownNames[symbol] || raw || symbol,
    assetType: market === 'TW' && /^00/.test(symbol) ? 'etf' : 'stock',
  };
}

function getBrokers() {
  return readCollection(localStorage, 'brokers');
}

function brokerSupports(broker, market) {
  return Array.isArray(broker?.markets) ? broker.markets.includes(market) : true;
}

function getDefaultBroker(market) {
  const brokers = getBrokers();
  const preferredId = getPreferences().defaultBrokers[market];
  return brokers.find((broker) => broker.id === preferredId && brokerSupports(broker, market))
    ?? brokers.find((broker) => brokerSupports(broker, market))
    ?? clone(DEFAULT_BROKER);
}

function getBrokerById(id, market) {
  return getBrokers().find((broker) => broker.id === id && (!market || brokerSupports(broker, market)))
    ?? getDefaultBroker(market);
}

function getFeeSettings(broker, market) {
  if (market === 'TW') return { ...DEFAULT_BROKER.tw, ...(broker?.tw ?? {}) };
  return { ...DEFAULT_BROKER.us, ...(broker?.us ?? {}) };
}

function calculateCharges(record) {
  const broker = getBrokerById(record.brokerId, record.market);
  const fee = calculateTradeFee({
    market: record.market,
    price: record.price,
    shares: record.shares,
    settings: getFeeSettings(broker, record.market),
  });
  const tax = calculateTaiwanSecuritiesTax({
    market: record.market,
    side: record.side,
    price: record.price,
    shares: record.shares,
    assetType: record.assetType,
    rates: getPreferences().taxRates,
  });
  return { fee, tax };
}

function migrateTransactions() {
  const original = readCollection(localStorage, 'transactions');
  let changed = false;
  const migrated = original.map((item, index) => {
    const inferred = inferInstrument(item.symbol || item.name || '未命名');
    const record = {
      ...item,
      id: item.id || createRecordId('trade'),
      type: 'trade',
      date: normalizeDate(item.date),
      market: item.market === 'US' ? 'US' : inferred.market,
      symbol: String(item.symbol || inferred.symbol).trim().toUpperCase(),
      name: item.name || inferred.name,
      assetType: item.assetType || inferred.assetType,
      brokerId: item.brokerId || getDefaultBroker(item.market === 'US' ? 'US' : inferred.market).id,
      createdAt: item.createdAt || item.date || new Date(Date.now() - index).toISOString(),
      sequence: Number.isFinite(item.sequence) ? item.sequence : Date.now() - index,
    };
    if (record.feeOverride === undefined || record.taxOverride === undefined) {
      const price = Number(record.price);
      const shares = Number(record.shares);
      if (price > 0 && shares > 0) {
        const charges = calculateCharges({ ...record, price, shares });
        if (record.feeOverride === undefined) record.feeOverride = charges.fee;
        if (record.taxOverride === undefined) record.taxOverride = charges.tax;
      }
    }
    if (JSON.stringify(record) !== JSON.stringify(item)) changed = true;
    return record;
  });
  if (changed) saveCollection(localStorage, 'transactions', migrated);
}

function chronological(records) {
  const orderValue = (record, fallback) => {
    const sequence = Number(record.sequence);
    if (Number.isFinite(sequence)) return sequence;
    const created = Date.parse(record.createdAt);
    return Number.isFinite(created) ? created : fallback;
  };
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const dateOrder = normalizeDate(left.record.date).localeCompare(normalizeDate(right.record.date));
      if (dateOrder) return dateOrder;
      const leftSequence = orderValue(left.record, left.index);
      const rightSequence = orderValue(right.record, right.index);
      return leftSequence - rightSequence || left.index - right.index;
    })
    .map(({ record }) => record);
}

function buildLedgerEntries(transactions = readCollection(localStorage, 'transactions'), dividends = readCollection(localStorage, 'dividends')) {
  const trades = transactions.map((record) => ({
    id: record.id,
    type: 'trade',
    date: normalizeDate(record.date),
    market: record.market === 'US' ? 'US' : 'TW',
    symbol: String(record.symbol).trim().toUpperCase(),
    side: record.side === 'sell' ? 'sell' : 'buy',
    price: Number(record.price),
    shares: Number(record.shares),
    assetType: record.assetType || 'stock',
    feeOverride: Number(record.feeOverride ?? 0),
    taxOverride: Number(record.taxOverride ?? 0),
    sequence: record.sequence,
    createdAt: record.createdAt,
  }));
  const income = dividends.map((record) => ({
    id: record.id,
    type: record.type === 'stock' ? 'stockDividend' : 'cashDividend',
    date: normalizeDate(record.date),
    market: record.market || (record.currency === 'USD' ? 'US' : 'TW'),
    symbol: String(record.symbol).trim().toUpperCase(),
    ...(record.type === 'stock' ? { shares: Number(record.shares) } : { amount: Number(record.amount) }),
    sequence: record.sequence,
    createdAt: record.createdAt,
  }));
  return chronological([...trades, ...income]).map(({ sequence, createdAt, ...entry }) => entry);
}

function calculateBook(transactions, dividends) {
  return processLedger(buildLedgerEntries(transactions, dividends));
}

function calculateFxBook(exchanges = readCollection(localStorage, 'exchanges')) {
  return processFxLedger(chronological(exchanges).map((record) => ({
    id: record.id,
    date: normalizeDate(record.date),
    side: record.side,
    usdAmount: Number(record.usdAmount),
    twdAmount: Number(record.twdAmount),
    feeTwd: Number(record.feeTwd ?? 0),
  })));
}

function safelyCalculateBook() {
  try {
    return calculateBook();
  } catch (error) {
    console.error(error);
    return { transactions: [], positions: [], openPositions: [], monthlySummaries: [], yearlySummaries: [], error };
  }
}

function findInstrument(market, symbol) {
  return readCollection(localStorage, 'instruments').find(
    (item) => item.market === market && String(item.symbol).toUpperCase() === String(symbol).toUpperCase(),
  );
}

function saveInstrument(data) {
  const existing = findInstrument(data.market, data.symbol);
  return upsertRecord(localStorage, 'instruments', {
    ...existing,
    ...data,
    id: existing?.id || `${data.market}:${String(data.symbol).toUpperCase()}`,
  });
}

const viewTitles = Object.freeze({
  entry: '記一筆',
  holdings: '目前持股',
  records: '交易、股息與換匯',
  reports: '報表',
  settings: '設定',
});

function showView(viewName) {
  $$('[data-view-panel]').forEach((view) => {
    const selected = view.dataset.viewPanel === viewName;
    view.hidden = !selected;
    view.classList.toggle('is-active', selected);
  });
  $$('[data-view]').forEach((button) => {
    const selected = button.dataset.view === viewName;
    button.classList.toggle('is-active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const pageTitle = $('#page-title');
  if (pageTitle) pageTitle.textContent = viewTitles[viewName] ?? '我的股票紀錄';
  if (viewName === 'holdings') renderHoldings();
  if (viewName === 'records') renderRecords();
  if (viewName === 'reports') renderReports();
  if (viewName === 'settings') renderSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));

// ── 極簡交易輸入 ──────────────────────────────────────────────────────────

let selectedSide = 'buy';
const tradeForm = $('#trade-form');
const tradeFeedback = $('#trade-feedback');

$$('input[name="side"]', tradeForm).forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    selectedSide = input.value;
    const label = $('#trade-submit span:first-child');
    if (label) label.textContent = selectedSide === 'buy' ? '記錄這筆買入' : '記錄這筆賣出';
  });
});

tradeForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = $('#trade-symbol')?.value.trim() ?? '';
  const price = toPositiveNumber($('#trade-price')?.value);
  const shares = toPositiveNumber($('#trade-shares')?.value);
  if (!raw || price === null || shares === null) {
    setFeedback(tradeFeedback, '請填寫股票名稱或代號、正確的成交價與股數。', 'error');
    return;
  }
  const inferred = inferInstrument(raw);
  if (!inferred.symbol) {
    setFeedback(tradeFeedback, '請輸入可辨識的股票名稱或代號。', 'error');
    return;
  }
  const broker = getDefaultBroker(inferred.market);
  const base = {
    id: createRecordId('trade'),
    type: 'trade',
    date: taipeiDateKey(),
    createdAt: new Date().toISOString(),
    sequence: Date.now(),
    side: selectedSide,
    symbol: inferred.symbol,
    name: inferred.name,
    market: inferred.market,
    assetType: inferred.assetType,
    price,
    shares,
    brokerId: broker.id,
    category: findInstrument(inferred.market, inferred.symbol)?.category ?? '',
    notes: '',
  };
  const charges = calculateCharges(base);
  const record = { ...base, feeOverride: charges.fee, taxOverride: charges.tax };
  try {
    calculateBook([record, ...readCollection(localStorage, 'transactions')], readCollection(localStorage, 'dividends'));
    upsertRecord(localStorage, 'transactions', record);
    saveInstrument({ market: record.market, symbol: record.symbol, name: record.name, assetType: record.assetType, category: record.category });
  } catch (error) {
    setFeedback(tradeFeedback, describeLedgerError(error), 'error');
    return;
  }
  setFeedback(
    tradeFeedback,
    `已儲存：${record.symbol} ${selectedSide === 'buy' ? '買入' : '賣出'} ${numberFormatter.format(shares)} 股。費稅已依「${broker.name}」設定帶入，可到紀錄頁修改。`,
    'success',
  );
  if ($('#trade-price')) $('#trade-price').value = '';
  if ($('#trade-shares')) $('#trade-shares').value = '';
  renderAll();
});

// ── 持股、分類與手動價格 ──────────────────────────────────────────────────

function getQuotes() {
  return readStoredJson(localStorage, STORAGE_KEYS.quotes, {});
}

function quoteKey(market, symbol) {
  return `${market}:${String(symbol).toUpperCase()}`;
}

function getQuote(market, symbol, quotes = getQuotes()) {
  return quotes[quoteKey(market, symbol)] ?? (market === 'US' ? quotes[String(symbol).toUpperCase()] : null);
}

function latestName(market, symbol) {
  const instrument = findInstrument(market, symbol);
  if (instrument?.name) return instrument.name;
  return readCollection(localStorage, 'transactions').find(
    (record) => record.market === market && record.symbol === symbol && record.name,
  )?.name ?? knownNames[symbol] ?? symbol;
}

function renderAllocationSummary(positions) {
  if (!positions.length) return '';
  const totals = new Map();
  for (const position of positions) {
    const category = findInstrument(position.market, position.symbol)?.category || '未分類';
    const key = `${position.currency}:${category}`;
    totals.set(key, (totals.get(key) ?? 0) + position.costBasis);
  }
  const byCurrency = {};
  for (const [key, amount] of totals) {
    const [currency, category] = key.split(':');
    byCurrency[currency] ??= [];
    byCurrency[currency].push({ category, amount });
  }
  const groups = Object.entries(byCurrency).map(([currency, rows]) => {
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const items = rows.sort((a, b) => b.amount - a.amount).map((row) =>
      `<span>${escapeHtml(row.category)} ${total ? percentFormatter.format((row.amount / total) * 100) : '0.00'}%</span>`,
    ).join('');
    return `<div><strong>${currency === 'USD' ? '美股（USD）' : '台股（TWD）'}</strong><p>${items}</p></div>`;
  }).join('');
  return `<article class="allocation-overview"><span class="card-label">成本配置</span>${groups}</article>`;
}

function createHoldingCard(position, quotes) {
  const instrument = findInstrument(position.market, position.symbol);
  const quote = getQuote(position.market, position.symbol, quotes);
  const categories = getPreferences().categories;
  const latestDividend = readCollection(localStorage, 'dividends')
    .filter((item) => (item.market || (item.currency === 'USD' ? 'US' : 'TW')) === position.market && String(item.symbol).toUpperCase() === position.symbol)
    .sort((a, b) => normalizeDate(b.date).localeCompare(normalizeDate(a.date)))[0];
  const currentPrice = Number(quote?.close);
  const hasPrice = Number.isFinite(currentPrice) && currentPrice > 0;
  const marketValue = hasPrice ? currentPrice * position.shares : null;
  const unrealized = hasPrice ? marketValue - position.costBasis : null;
  const returnRate = hasPrice && position.costBasis > 0 ? (unrealized / position.costBasis) * 100 : null;
  const options = ['<option value="">未分類</option>', ...categories.map((category) =>
    `<option value="${escapeHtml(category)}"${instrument?.category === category ? ' selected' : ''}>${escapeHtml(category)}</option>`,
  )].join('');
  const article = document.createElement('article');
  article.className = 'holding-card';
  article.dataset.holdingSymbol = position.symbol;
  article.dataset.market = position.market;
  article.innerHTML = `
    <div class="holding-card__top">
      <div class="stock-identity">
        <span class="stock-avatar" aria-hidden="true">${escapeHtml(position.symbol.slice(0, 1))}</span>
        <div><div class="stock-title"><h3>${escapeHtml(position.symbol)}</h3><span class="market-tag">${position.market === 'US' ? '美股' : '台股'}</span></div><p>${escapeHtml(latestName(position.market, position.symbol))}</p></div>
      </div>
      <div class="stock-price"><span>${quote?.source === 'manual' ? '手動價格' : quote?.source || '參考價格'}</span><strong>${hasPrice ? formatMoney(currentPrice, position.currency) : '尚無價格'}</strong></div>
    </div>
    <dl class="holding-metrics">
      <div><dt>持有股數</dt><dd>${numberFormatter.format(position.shares)} 股</dd></div>
      <div><dt>平均成本</dt><dd>${formatMoney(position.averageCost, position.currency)}</dd></div>
      <div><dt>持股成本</dt><dd>${formatMoney(position.costBasis, position.currency)}</dd></div>
      <div><dt>未實現損益</dt><dd data-pnl>${unrealized === null ? '尚無價格' : formatMoney(unrealized, position.currency, { signed: true })}</dd></div>
      <div><dt>已實現損益</dt><dd data-realized>${formatMoney(position.realizedTradingPnl, position.currency, { signed: true })}</dd></div>
      <div><dt>累計現金股息</dt><dd>${formatMoney(position.cashDividendIncome, position.currency)}</dd></div>
    </dl>
    <div class="holding-card__foot"><span>報酬率</span><strong data-return>${returnRate === null ? '尚無價格' : formatPercent(returnRate, { signed: true })}</strong></div>
    <div class="holding-card__extras">
      <label>資金分類<select data-action="holding-category">${options}</select></label>
      <span>${latestDividend ? `最近股息日 ${formatDate(latestDividend.date)}` : '尚無股息紀錄'}</span>
    </div>
    <div class="inline-actions">
      <button class="text-button" type="button" data-action="manual-price">輸入收盤價</button>
      <button class="text-button" type="button" data-action="stock-history">查看歷史</button>
    </div>`;
  setValueClass($('[data-pnl]', article), unrealized);
  setValueClass($('[data-realized]', article), position.realizedTradingPnl);
  setValueClass($('[data-return]', article), returnRate);
  return article;
}

function renderHoldings() {
  const holdingList = $('#holding-list');
  if (!holdingList) return;
  const book = safelyCalculateBook();
  const positions = book.openPositions ?? [];
  const quotes = getQuotes();
  const fragment = document.createDocumentFragment();
  if (positions.length) {
    const allocation = document.createElement('div');
    allocation.innerHTML = renderAllocationSummary(positions);
    while (allocation.firstChild) fragment.append(allocation.firstChild);
  }
  positions.forEach((position) => fragment.append(createHoldingCard(position, quotes)));
  holdingList.replaceChildren(fragment);
  if ($('#holdings-empty')) $('#holdings-empty').hidden = positions.length > 0;
  renderTiingoControls();
}

$('#holding-list')?.addEventListener('change', (event) => {
  if (event.target.dataset.action !== 'holding-category') return;
  const card = event.target.closest('[data-holding-symbol]');
  saveInstrument({
    market: card.dataset.market,
    symbol: card.dataset.holdingSymbol,
    name: latestName(card.dataset.market, card.dataset.holdingSymbol),
    category: event.target.value,
  });
  renderHoldings();
  showToast('持股分類已更新。');
});

$('#holding-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  const card = button?.closest('[data-holding-symbol]');
  if (!button || !card) return;
  const market = card.dataset.market;
  const symbol = card.dataset.holdingSymbol;
  if (button.dataset.action === 'manual-price') {
    const previous = getQuote(market, symbol)?.close ?? '';
    const value = window.prompt(`輸入 ${symbol} 的最近收盤價（${market === 'US' ? 'USD' : 'TWD'}）`, previous);
    if (value === null) return;
    const close = toPositiveNumber(value);
    if (close === null) {
      showToast('收盤價必須大於 0。', 'error');
      return;
    }
    const quotes = getQuotes();
    quotes[quoteKey(market, symbol)] = { symbol, close, date: taipeiDateKey(), source: 'manual', fetchedAt: new Date().toISOString() };
    writeStoredJson(localStorage, STORAGE_KEYS.quotes, quotes);
    renderHoldings();
    renderReports();
  }
  if (button.dataset.action === 'stock-history') openStockHistory(`${market}:${symbol}`);
});

// ── 紀錄頁：分頁與交易編輯 ────────────────────────────────────────────────

$$('[data-record-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.recordTab;
    $$('[data-record-tab]').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    $$('[data-record-panel]').forEach((panel) => { panel.hidden = panel.dataset.recordPanel !== tab; });
  });
});

function resultById() {
  return new Map((safelyCalculateBook().transactions ?? []).map((result) => [result.id, result]));
}

function renderTradeRecords() {
  const list = $('#trade-record-list');
  if (!list) return;
  const results = resultById();
  const records = [...readCollection(localStorage, 'transactions')]
    .sort((a, b) => normalizeDate(b.date).localeCompare(normalizeDate(a.date)) || Number(b.sequence ?? 0) - Number(a.sequence ?? 0));
  const template = $('#trade-record-item-template');
  const nodes = records.map((record) => {
    const article = template.content.firstElementChild.cloneNode(true);
    const result = results.get(record.id);
    article.dataset.tradeId = record.id;
    $('[data-field="date"]', article).textContent = formatDate(record.date);
    $('[data-field="symbol"]', article).textContent = `${record.symbol}${record.name && record.name !== record.symbol ? ` · ${record.name}` : ''}`;
    $('[data-field="side"]', article).textContent = record.side === 'sell' ? '賣出' : '買入';
    $('[data-field="side"]', article).classList.toggle('is-sell', record.side === 'sell');
    $('[data-field="trade-value"]', article).textContent = `${formatMoney(record.price, record.market === 'US' ? 'USD' : 'TWD')} × ${numberFormatter.format(record.shares)} 股`;
    $('[data-field="fees-taxes"]', article).textContent = `${formatMoney(result?.fee ?? record.feeOverride ?? 0, record.market === 'US' ? 'USD' : 'TWD')}／${formatMoney(result?.tax ?? record.taxOverride ?? 0, record.market === 'US' ? 'USD' : 'TWD')}`;
    const pnl = $('[data-field="realized-pnl"]', article);
    pnl.textContent = record.side === 'sell' && result
      ? `${formatMoney(result.realizedPnl, result.currency, { signed: true })} (${formatPercent(result.returnRate, { signed: true })})`
      : '—';
    setValueClass(pnl, result?.realizedPnl);
    return article;
  });
  list.replaceChildren(...nodes);
  $('#trade-record-count').textContent = `${records.length} 筆`;
  $('#trade-records-empty').hidden = records.length > 0;
  renderChangeHistory();
}

function renderChangeHistory() {
  const labels = { transactions: '交易', dividends: '股息', exchanges: '換匯' };
  const records = readCollection(localStorage, 'auditLog')
    .filter((entry) => labels[entry.entity] && ['update', 'delete'].includes(entry.action))
    .slice(0, 100);
  const nodes = records.map((entry) => {
    const old = entry.before ?? {};
    const article = document.createElement('article');
    article.className = 'record-item change-history-item';
    const summary = old.symbol
      ? `${old.symbol} ${old.side === 'sell' ? '賣出' : old.side === 'buy' ? '買入' : ''}`
      : old.usdAmount ? `${old.side === 'sell' ? '賣出' : '買入'} USD ${old.usdAmount}` : labels[entry.entity];
    const details = old.price && old.shares
      ? `舊內容：${old.price} × ${old.shares} 股，費 ${old.feeOverride ?? 0}，稅 ${old.taxOverride ?? 0}`
      : old.amount ? `舊內容：${old.amount} ${old.currency || ''}`
        : old.shares ? `舊內容：${old.shares} 股` : '';
    const top = document.createElement('div');
    top.className = 'record-item__top';
    const heading = document.createElement('div');
    const time = document.createElement('time');
    time.textContent = formatDate(entry.changedAt);
    const title = document.createElement('h4');
    title.textContent = `${labels[entry.entity]}${entry.action === 'delete' ? '刪除前' : '修改前'} · ${summary}`;
    heading.append(time, title);
    top.append(heading);
    article.append(top);
    if (details) {
      const paragraph = document.createElement('p');
      paragraph.className = 'record-item__note';
      paragraph.textContent = details;
      article.append(paragraph);
    }
    return article;
  });
  $('#change-history-list').replaceChildren(...nodes);
  $('#change-history-empty').hidden = records.length > 0;
}

function fillTradeEditOptions(record) {
  const brokerSelect = $('#trade-edit-broker');
  brokerSelect.replaceChildren(new Option('沿用預設券商', ''));
  getBrokers().filter((broker) => brokerSupports(broker, record.market)).forEach((broker) => brokerSelect.add(new Option(broker.name, broker.id)));
  brokerSelect.value = record.brokerId ?? '';
  const categorySelect = $('#trade-edit-category');
  categorySelect.replaceChildren(new Option('未分類', ''));
  getPreferences().categories.forEach((category) => categorySelect.add(new Option(category, category)));
  categorySelect.value = record.category ?? '';
}

function openTradeEdit(id) {
  const record = readCollection(localStorage, 'transactions').find((item) => item.id === id);
  if (!record) return;
  const result = resultById().get(id);
  $('#trade-edit-id').value = record.id;
  $('#trade-edit-date').value = normalizeDate(record.date);
  $('#trade-edit-market').value = record.market;
  $('#trade-edit-symbol').value = record.symbol;
  $('#trade-edit-name').value = record.name ?? '';
  $('#trade-edit-side').value = record.side;
  $('#trade-edit-asset-type').value = record.assetType ?? 'stock';
  $('#trade-edit-price').value = record.price;
  $('#trade-edit-shares').value = record.shares;
  $('#trade-edit-fee').value = result?.fee ?? record.feeOverride ?? 0;
  $('#trade-edit-tax').value = result?.tax ?? record.taxOverride ?? 0;
  $('#trade-edit-notes').value = record.notes ?? '';
  fillTradeEditOptions(record);
  setFeedback($('#trade-edit-feedback'), '修改較早的交易後，後續成本與損益會自動重算。', 'info');
  openDialog($('#trade-edit-dialog'));
}

$('#trade-edit-market')?.addEventListener('change', () => {
  const record = { market: $('#trade-edit-market').value, brokerId: $('#trade-edit-broker').value };
  fillTradeEditOptions(record);
});

$('#trade-record-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  const item = button?.closest('[data-trade-id]');
  if (!button || !item) return;
  if (button.dataset.action === 'edit-trade') openTradeEdit(item.dataset.tradeId);
  if (button.dataset.action === 'delete-trade') {
    const records = readCollection(localStorage, 'transactions');
    const next = records.filter((record) => record.id !== item.dataset.tradeId);
    if (!window.confirm('確定刪除這筆交易？刪除前內容仍會保留在本機變更紀錄。')) return;
    try {
      calculateBook(next, readCollection(localStorage, 'dividends'));
      removeRecord(localStorage, 'transactions', item.dataset.tradeId);
      renderAll();
      showToast('交易已刪除，後續成本已重算。');
    } catch (error) {
      showToast(describeLedgerError(error), 'error');
    }
  }
});

$('#trade-edit-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const id = $('#trade-edit-id').value;
  const records = readCollection(localStorage, 'transactions');
  const previous = records.find((item) => item.id === id);
  if (!previous) return;
  const market = $('#trade-edit-market').value;
  const price = toPositiveNumber($('#trade-edit-price').value);
  const shares = toPositiveNumber($('#trade-edit-shares').value);
  const symbol = String($('#trade-edit-symbol').value).trim().toUpperCase();
  if (!symbol || price === null || shares === null) {
    setFeedback($('#trade-edit-feedback'), '請填寫正確的代號、成交價與股數。', 'error');
    return;
  }
  const brokerId = $('#trade-edit-broker').value || getDefaultBroker(market).id;
  const provisional = {
    ...previous,
    date: $('#trade-edit-date').value,
    market,
    symbol,
    name: $('#trade-edit-name').value.trim() || symbol,
    side: $('#trade-edit-side').value,
    assetType: $('#trade-edit-asset-type').value,
    price,
    shares,
    brokerId,
    category: $('#trade-edit-category').value,
    notes: $('#trade-edit-notes').value.trim(),
  };
  const feeText = $('#trade-edit-fee').value.trim();
  const taxText = $('#trade-edit-tax').value.trim();
  const enteredFee = feeText === '' ? undefined : toNonNegativeNumber(feeText, null);
  const enteredTax = taxText === '' ? undefined : toNonNegativeNumber(taxText, null);
  if (enteredFee === null || enteredTax === null) {
    setFeedback($('#trade-edit-feedback'), '手續費與證交稅不可為負數。', 'error');
    return;
  }
  const charges = calculateCharges(provisional);
  const updated = {
    ...provisional,
    feeOverride: enteredFee === undefined ? charges.fee : enteredFee,
    taxOverride: enteredTax === undefined ? charges.tax : enteredTax,
  };
  const next = records.map((item) => item.id === id ? updated : item);
  try {
    calculateBook(next, readCollection(localStorage, 'dividends'));
    upsertRecord(localStorage, 'transactions', updated);
    saveInstrument({ market, symbol, name: updated.name, assetType: updated.assetType, category: updated.category });
    closeDialog($('#trade-edit-dialog'));
    renderAll();
    showToast('交易已更新，所有後續數字已重算。');
  } catch (error) {
    setFeedback($('#trade-edit-feedback'), describeLedgerError(error), 'error');
  }
});

['#trade-edit-cancel', '#trade-edit-dialog-close'].forEach((selector) => $(selector)?.addEventListener('click', () => closeDialog($('#trade-edit-dialog'))));

// ── 股息紀錄 ──────────────────────────────────────────────────────────────

function updateDividendFields() {
  const isCash = $('#dividend-type-cash')?.checked;
  $('#dividend-cash-field').hidden = !isCash;
  $('#dividend-stock-field').hidden = isCash;
}

$$('input[name="dividend-type"]').forEach((input) => input.addEventListener('change', updateDividendFields));

function resetDividendForm() {
  $('#dividend-form')?.reset();
  $('#dividend-id').value = '';
  $('#dividend-date').value = taipeiDateKey();
  $('#dividend-form-title').textContent = '記一筆股息';
  $('#dividend-cancel-edit').hidden = true;
  updateDividendFields();
  setFeedback($('#dividend-feedback'), '', 'info');
}

function renderDividendRecords() {
  const records = [...readCollection(localStorage, 'dividends')]
    .sort((a, b) => normalizeDate(b.date).localeCompare(normalizeDate(a.date)) || Number(b.sequence ?? 0) - Number(a.sequence ?? 0));
  const template = $('#dividend-record-item-template');
  const nodes = records.map((record) => {
    const article = template.content.firstElementChild.cloneNode(true);
    article.dataset.dividendId = record.id;
    $('[data-field="date"]', article).textContent = formatDate(record.date);
    $('[data-field="symbol"]', article).textContent = record.symbol;
    $('[data-field="type"]', article).textContent = record.type === 'stock' ? '股票股利' : '現金股利';
    $('[data-field="value"]', article).textContent = record.type === 'stock'
      ? `${numberFormatter.format(record.shares)} 股`
      : formatMoney(record.amount, record.currency || 'TWD');
    const notes = $('[data-field="notes"]', article);
    notes.textContent = record.notes || '無備註';
    notes.hidden = !record.notes;
    return article;
  });
  $('#dividend-record-list').replaceChildren(...nodes);
  $('#dividend-record-count').textContent = `${records.length} 筆`;
  $('#dividend-records-empty').hidden = records.length > 0;
}

function editDividend(id) {
  const record = readCollection(localStorage, 'dividends').find((item) => item.id === id);
  if (!record) return;
  $('#dividend-id').value = record.id;
  $('#dividend-type-cash').checked = record.type !== 'stock';
  $('#dividend-type-stock').checked = record.type === 'stock';
  $('#dividend-symbol').value = record.symbol;
  $('#dividend-date').value = normalizeDate(record.date);
  $('#dividend-currency').value = record.currency || (record.market === 'US' ? 'USD' : 'TWD');
  $('#dividend-cash-amount').value = record.amount ?? '';
  $('#dividend-stock-shares').value = record.shares ?? '';
  $('#dividend-notes').value = record.notes ?? '';
  $('#dividend-form-title').textContent = '編輯股息';
  $('#dividend-cancel-edit').hidden = false;
  updateDividendFields();
  $('#dividend-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#dividend-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const id = $('#dividend-id').value || createRecordId('dividend');
  const previous = readCollection(localStorage, 'dividends').find((item) => item.id === id);
  const type = $('#dividend-type-stock').checked ? 'stock' : 'cash';
  const currency = $('#dividend-currency').value;
  const inferred = inferInstrument($('#dividend-symbol').value, currency === 'USD' ? 'US' : 'TW');
  const amount = type === 'cash' ? toPositiveNumber($('#dividend-cash-amount').value) : null;
  const shares = type === 'stock' ? toPositiveNumber($('#dividend-stock-shares').value) : null;
  if (!inferred.symbol || (type === 'cash' ? amount === null : shares === null)) {
    setFeedback($('#dividend-feedback'), `請填寫股票與正確的${type === 'cash' ? '入帳金額' : '入帳股數'}。`, 'error');
    return;
  }
  const record = {
    ...previous,
    id,
    type,
    date: $('#dividend-date').value,
    market: currency === 'USD' ? 'US' : 'TW',
    currency,
    symbol: inferred.symbol,
    ...(type === 'cash' ? { amount } : { shares }),
    notes: $('#dividend-notes').value.trim(),
    createdAt: previous?.createdAt || new Date().toISOString(),
    sequence: previous?.sequence ?? Date.now(),
  };
  const dividends = readCollection(localStorage, 'dividends');
  const next = previous ? dividends.map((item) => item.id === id ? record : item) : [record, ...dividends];
  try {
    calculateBook(readCollection(localStorage, 'transactions'), next);
    upsertRecord(localStorage, 'dividends', record);
    saveInstrument({ market: record.market, symbol: record.symbol, name: inferred.name, assetType: inferred.assetType });
    resetDividendForm();
    renderAll();
    showToast('股息紀錄已儲存。');
  } catch (error) {
    setFeedback($('#dividend-feedback'), describeLedgerError(error), 'error');
  }
});

$('#dividend-cancel-edit')?.addEventListener('click', resetDividendForm);

$('#dividend-record-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  const item = button?.closest('[data-dividend-id]');
  if (!button || !item) return;
  if (button.dataset.action === 'edit-dividend') editDividend(item.dataset.dividendId);
  if (button.dataset.action === 'delete-dividend') {
    if (!window.confirm('確定刪除這筆股息？刪除前內容仍會保留在變更紀錄。')) return;
    const dividends = readCollection(localStorage, 'dividends');
    const next = dividends.filter((record) => record.id !== item.dataset.dividendId);
    try {
      calculateBook(readCollection(localStorage, 'transactions'), next);
      removeRecord(localStorage, 'dividends', item.dataset.dividendId);
      resetDividendForm();
      renderAll();
      showToast('股息紀錄已刪除。');
    } catch (error) {
      showToast(describeLedgerError(error), 'error');
    }
  }
});

// ── 換匯紀錄 ──────────────────────────────────────────────────────────────

function updateFxRatePreview() {
  const usdAmount = toPositiveNumber($('#fx-usd-amount')?.value);
  const twdAmount = toPositiveNumber($('#fx-twd-amount')?.value);
  const feeTwd = toNonNegativeNumber($('#fx-fee')?.value, 0);
  if (usdAmount === null || twdAmount === null || feeTwd === null) {
    $('#fx-effective-rate').textContent = '—';
    return;
  }
  try {
    const rate = calculateActualExchangeRate({
      side: $('#fx-side-sell')?.checked ? 'sell' : 'buy',
      usdAmount,
      twdAmount,
      feeTwd,
    });
    $('#fx-effective-rate').textContent = `${rate.toFixed(4)} TWD/USD`;
  } catch {
    $('#fx-effective-rate').textContent = '—';
  }
}

['#fx-usd-amount', '#fx-twd-amount', '#fx-fee', '#fx-side-buy', '#fx-side-sell'].forEach((selector) => $(selector)?.addEventListener('input', updateFxRatePreview));

function resetFxForm() {
  $('#fx-form')?.reset();
  $('#fx-id').value = '';
  $('#fx-date').value = taipeiDateKey();
  $('#fx-form-title').textContent = '記一筆換匯';
  $('#fx-cancel-edit').hidden = true;
  updateFxRatePreview();
  setFeedback($('#fx-feedback'), '', 'info');
}

function renderFxRecords() {
  const records = [...readCollection(localStorage, 'exchanges')]
    .sort((a, b) => normalizeDate(b.date).localeCompare(normalizeDate(a.date)) || Number(b.sequence ?? 0) - Number(a.sequence ?? 0));
  let resultMap = new Map();
  try {
    resultMap = new Map(calculateFxBook(records).transactions.map((item) => [item.id, item]));
  } catch (error) {
    setFeedback($('#fx-feedback'), describeLedgerError(error), 'error');
  }
  const template = $('#fx-record-item-template');
  const nodes = records.map((record) => {
    const result = resultMap.get(record.id);
    const article = template.content.firstElementChild.cloneNode(true);
    article.dataset.fxId = record.id;
    $('[data-field="date"]', article).textContent = formatDate(record.date);
    $('[data-field="side"]', article).textContent = record.side === 'sell' ? '賣出美元' : '買入美元';
    $('[data-field="usd-amount"]', article).textContent = `US$${currencyFormatters.USD.format(record.usdAmount)}`;
    $('[data-field="twd-amount"]', article).textContent = formatMoney(record.twdAmount, 'TWD');
    $('[data-field="fee"]', article).textContent = formatMoney(record.feeTwd ?? 0, 'TWD');
    $('[data-field="rate"]', article).textContent = result ? `${result.actualRate.toFixed(4)}` : '—';
    const notes = $('[data-field="notes"]', article);
    notes.textContent = record.notes || '';
    notes.hidden = !record.notes;
    return article;
  });
  $('#fx-record-list').replaceChildren(...nodes);
  $('#fx-record-count').textContent = `${records.length} 筆`;
  $('#fx-records-empty').hidden = records.length > 0;
}

function editFx(id) {
  const record = readCollection(localStorage, 'exchanges').find((item) => item.id === id);
  if (!record) return;
  $('#fx-id').value = record.id;
  $('#fx-side-buy').checked = record.side !== 'sell';
  $('#fx-side-sell').checked = record.side === 'sell';
  $('#fx-date').value = normalizeDate(record.date);
  $('#fx-usd-amount').value = record.usdAmount;
  $('#fx-twd-amount').value = record.twdAmount;
  $('#fx-fee').value = record.feeTwd ?? 0;
  $('#fx-notes').value = record.notes ?? '';
  $('#fx-form-title').textContent = '編輯換匯';
  $('#fx-cancel-edit').hidden = false;
  updateFxRatePreview();
  $('#fx-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#fx-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const id = $('#fx-id').value || createRecordId('fx');
  const records = readCollection(localStorage, 'exchanges');
  const previous = records.find((item) => item.id === id);
  const usdAmount = toPositiveNumber($('#fx-usd-amount').value);
  const twdAmount = toPositiveNumber($('#fx-twd-amount').value);
  const feeTwd = toNonNegativeNumber($('#fx-fee').value, 0);
  if (usdAmount === null || twdAmount === null || feeTwd === null) {
    setFeedback($('#fx-feedback'), '請填寫正確的美元、台幣金額與費用。', 'error');
    return;
  }
  const record = {
    ...previous,
    id,
    date: $('#fx-date').value,
    side: $('#fx-side-sell').checked ? 'sell' : 'buy',
    usdAmount,
    twdAmount,
    feeTwd,
    notes: $('#fx-notes').value.trim(),
    createdAt: previous?.createdAt || new Date().toISOString(),
    sequence: previous?.sequence ?? Date.now(),
  };
  const next = previous ? records.map((item) => item.id === id ? record : item) : [record, ...records];
  try {
    calculateFxBook(next);
    upsertRecord(localStorage, 'exchanges', record);
    resetFxForm();
    renderFxRecords();
    showToast('換匯紀錄已儲存。');
  } catch (error) {
    setFeedback($('#fx-feedback'), describeLedgerError(error), 'error');
  }
});

$('#fx-cancel-edit')?.addEventListener('click', resetFxForm);

$('#fx-record-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  const item = button?.closest('[data-fx-id]');
  if (!button || !item) return;
  if (button.dataset.action === 'edit-fx') editFx(item.dataset.fxId);
  if (button.dataset.action === 'delete-fx') {
    if (!window.confirm('確定刪除這筆換匯？')) return;
    const next = readCollection(localStorage, 'exchanges').filter((record) => record.id !== item.dataset.fxId);
    try {
      calculateFxBook(next);
      removeRecord(localStorage, 'exchanges', item.dataset.fxId);
      resetFxForm();
      renderFxRecords();
      showToast('換匯紀錄已刪除。');
    } catch (error) {
      showToast(describeLedgerError(error), 'error');
    }
  }
});

function renderRecords() {
  renderTradeRecords();
  renderDividendRecords();
  renderFxRecords();
}

// ── 報表與個股歷史 ────────────────────────────────────────────────────────

let reportSelection = { mode: 'month', key: taipeiDateKey().slice(0, 7) };

function matchesReport(date) {
  const key = normalizeDate(date);
  if (reportSelection.mode === 'all') return true;
  if (reportSelection.mode === 'year') return key.startsWith(reportSelection.key);
  return key.startsWith(reportSelection.key);
}

function setBreakdown(element, rows, emptyText = '—') {
  element.replaceChildren();
  const visible = rows.filter((row) => Number.isFinite(row.value));
  if (!visible.length) {
    element.textContent = emptyText;
    element.classList.remove('is-profit', 'is-loss');
    return;
  }
  visible.forEach((row) => {
    const span = document.createElement('span');
    span.className = 'metric-line';
    span.textContent = row.kind === 'percent'
      ? `${row.label} ${formatPercent(row.value, { signed: true })}`
      : formatMoney(row.value, row.currency, { signed: true });
    setValueClass(span, row.value);
    element.append(span);
  });
}

function renderReports() {
  const book = safelyCalculateBook();
  const selected = (book.transactions ?? []).filter((item) => matchesReport(item.date));
  const currencies = ['TWD', 'USD'];
  const realizedRows = currencies.map((currency) => ({
    currency,
    value: selected.filter((item) => item.currency === currency).reduce((sum, item) => sum + (item.realizedTradingPnl || 0), 0),
  }));
  const dividendRows = currencies.map((currency) => ({
    currency,
    value: selected.filter((item) => item.currency === currency).reduce((sum, item) => sum + (item.cashDividendIncome || 0), 0),
  }));
  setBreakdown($('#report-realized'), realizedRows);
  setBreakdown($('#report-dividends'), dividendRows);

  const fees = currencies.map((currency) => ({
    currency,
    value: selected.filter((item) => item.currency === currency).reduce((sum, item) => sum + (item.fee || 0) + (item.tax || 0), 0),
  }));
  const realizedSmall = $('#report-realized')?.nextElementSibling;
  if (realizedSmall) realizedSmall.textContent = `期間費稅：${fees.map((row) => formatMoney(row.value, row.currency)).join('／')}`;

  const quotes = getQuotes();
  const unrealizedRows = currencies.map((currency) => {
    const positions = (book.openPositions ?? []).filter((position) => position.currency === currency);
    const priced = positions.filter((position) => Number(getQuote(position.market, position.symbol, quotes)?.close) > 0);
    if (!priced.length) return { currency, value: Number.NaN };
    return {
      currency,
      value: priced.reduce((sum, position) => sum + Number(getQuote(position.market, position.symbol, quotes).close) * position.shares - position.costBasis, 0),
    };
  });
  setBreakdown($('#report-unrealized'), unrealizedRows, '尚無價格');

  const returnRows = currencies.map((currency) => {
    const matching = selected.filter((item) => item.currency === currency);
    const openPositions = (book.openPositions ?? []).filter((position) => position.currency === currency);
    const allOpenPriced = openPositions.every((position) => Number(getQuote(position.market, position.symbol, quotes)?.close) > 0);
    const soldCost = matching.reduce((sum, item) => sum + Number(item.allocatedCost || 0), 0);
    const openCost = openPositions.reduce((sum, position) => sum + position.costBasis, 0);
    const realized = matching.reduce((sum, item) => sum + Number(item.realizedPnl || 0), 0);
    const unrealized = allOpenPriced
      ? openPositions.reduce((sum, position) => sum + Number(getQuote(position.market, position.symbol, quotes)?.close) * position.shares - position.costBasis, 0)
      : 0;
    const denominator = soldCost + (allOpenPriced ? openCost : 0);
    return { label: currency, kind: 'percent', value: denominator > 0 ? ((realized + unrealized) / denominator) * 100 : Number.NaN };
  });
  setBreakdown($('#report-return'), returnRows, '尚無可計算資料');
}

$$('[data-report-period]').forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.reportPeriod;
    reportSelection = {
      mode,
      key: mode === 'year' ? taipeiDateKey().slice(0, 4) : mode === 'month' ? taipeiDateKey().slice(0, 7) : '',
    };
    $$('[data-report-period]').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    const monthButton = $('[data-report-period="month"]');
    if (monthButton) monthButton.textContent = '本月';
    renderReports();
  });
});

function renderHistoryOptions(preselect = '') {
  const select = $('#stock-history-select');
  const current = preselect || select.value;
  const keys = new Map();
  readCollection(localStorage, 'transactions').forEach((record) => keys.set(`${record.market}:${record.symbol}`, latestName(record.market, record.symbol)));
  readCollection(localStorage, 'dividends').forEach((record) => {
    const market = record.market || (record.currency === 'USD' ? 'US' : 'TW');
    keys.set(`${market}:${record.symbol}`, latestName(market, record.symbol));
  });
  select.replaceChildren(new Option('請選擇一檔股票', ''));
  [...keys.entries()].sort().forEach(([key, name]) => select.add(new Option(`${key.split(':')[1]} · ${name}`, key)));
  select.value = keys.has(current) ? current : '';
}

function renderStockHistory(key) {
  const list = $('#stock-history-list');
  const fields = Object.fromEntries($$('[data-field]', $('#stock-history-summary')).map((element) => [element.dataset.field, element]));
  if (!key) {
    Object.values(fields).forEach((field) => { field.textContent = '—'; field.classList.remove('is-profit', 'is-loss'); });
    list.innerHTML = '<p class="empty-note empty-note--card">選擇股票後，會依日期顯示每次交易後的庫存、平均成本、該筆損益與報酬率。</p>';
    return;
  }
  const [market, symbol] = key.split(':');
  const book = safelyCalculateBook();
  const events = (book.transactions ?? []).filter((item) => item.market === market && item.symbol === symbol);
  const position = (book.positions ?? []).find((item) => item.market === market && item.symbol === symbol);
  const currency = market === 'US' ? 'USD' : 'TWD';
  const soldCost = events.reduce((sum, item) => sum + Number(item.allocatedCost || 0), 0);
  const realized = position?.realizedTradingPnl ?? 0;
  fields.shares.textContent = `${numberFormatter.format(position?.shares ?? 0)} 股`;
  fields['average-cost'].textContent = formatMoney(position?.averageCost ?? 0, currency);
  fields['realized-pnl'].textContent = formatMoney(realized, currency, { signed: true });
  fields.return.textContent = soldCost > 0 ? formatPercent((realized / soldCost) * 100, { signed: true }) : '尚無賣出';
  setValueClass(fields['realized-pnl'], realized);
  setValueClass(fields.return, soldCost > 0 ? realized : 0);
  let cycle = 0;
  let previousShares = 0;
  const html = events.map((item) => {
    if (item.type === 'trade' && item.side === 'buy' && previousShares === 0) cycle += 1;
    const cycleLabel = cycle ? `第 ${cycle} 輪` : '股息';
    previousShares = item.sharesAfter;
    const title = item.type === 'trade'
      ? `${item.side === 'buy' ? '買入' : '賣出'} ${numberFormatter.format(item.shares)} 股${item.price ? ` @ ${formatMoney(item.price, currency)}` : ''}`
      : item.type === 'stockDividend' ? `股票股利 ${numberFormatter.format(item.shares)} 股` : `現金股利 ${formatMoney(item.cashDividendIncome, currency)}`;
    const pnl = item.realizedPnl ? `${formatMoney(item.realizedPnl, currency, { signed: true })} · ${formatPercent(item.returnRate, { signed: true })}` : '—';
    return `<article class="history-event"><div><time>${formatDate(item.date)}</time><span>${cycleLabel}</span></div><h3>${escapeHtml(title)}</h3><dl><div><dt>交易後股數</dt><dd>${numberFormatter.format(item.sharesAfter)}</dd></div><div><dt>交易後均價</dt><dd>${formatMoney(item.averageCostAfter, currency)}</dd></div><div><dt>該筆已實現／報酬率</dt><dd class="${item.realizedPnl > 0 ? 'is-profit' : item.realizedPnl < 0 ? 'is-loss' : ''}">${pnl}</dd></div></dl></article>`;
  }).join('');
  list.innerHTML = html || '<p class="empty-note empty-note--card">這檔股票尚無歷史紀錄。</p>';
}

function openStockHistory(preselect = '') {
  renderHistoryOptions(preselect);
  renderStockHistory($('#stock-history-select').value);
  openDialog($('#stock-history-dialog'));
}

$('#open-stock-history')?.addEventListener('click', () => openStockHistory());
$('#stock-history-select')?.addEventListener('change', (event) => renderStockHistory(event.target.value));
$('#stock-history-close')?.addEventListener('click', () => closeDialog($('#stock-history-dialog')));

// ── 券商、稅率與分類設定 ──────────────────────────────────────────────────

function renderBrokerSelect() {
  const select = $('#default-broker');
  const preferences = getPreferences();
  const current = select.value || preferences.defaultBrokers.TW;
  select.replaceChildren();
  getBrokers().forEach((broker) => select.add(new Option(`${broker.name}（${broker.markets?.join('／') || '台美股'}）`, broker.id)));
  select.add(new Option('＋ 新增券商…', '__new__'));
  select.value = getBrokers().some((broker) => broker.id === current) ? current : preferences.defaultBrokers.TW;
  renderSelectedBrokerRates();
}

function renderSelectedBrokerRates() {
  const id = $('#default-broker')?.value;
  if (!id || id === '__new__') return;
  const broker = getBrokers().find((item) => item.id === id) ?? DEFAULT_BROKER;
  const tw = getFeeSettings(broker, 'TW');
  $('#tw-standard-fee-rate').value = (tw.standardFeeRate * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  $('#tw-fee-discount').value = (tw.discount * 10).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  $('#tw-min-fee').value = tw.minimumFee;
  const tax = getPreferences().taxRates;
  $('#tw-stock-tax-rate').value = tax.stock * 100;
  $('#tw-etf-tax-rate').value = tax.etf * 100;
  $('#tw-day-trade-tax-rate').value = tax.dayTrade * 100;
  $('[data-field="tw-fee-summary"]', $('#broker-fee-summary')).textContent = `${(tw.standardFeeRate * 100).toFixed(4)}% × ${(tw.discount * 10).toFixed(1)} 折`;
  $('[data-field="tw-min-fee-summary"]', $('#broker-fee-summary')).textContent = formatMoney(tw.minimumFee, 'TWD');
  $('[data-field="tw-stock-tax-summary"]', $('#broker-fee-summary')).textContent = `${(tax.stock * 100).toFixed(2).replace(/0$/, '')}%`;
  $('[data-field="tw-etf-day-tax-summary"]', $('#broker-fee-summary')).textContent = `${(tax.etf * 100).toFixed(2).replace(/0$/, '')}%／${(tax.dayTrade * 100).toFixed(2).replace(/0$/, '')}%`;
}

function openBrokerDialog({ broker = null } = {}) {
  $('#broker-form').reset();
  const editing = broker ?? null;
  $('#broker-id').value = editing?.id ?? '';
  $('#broker-name').value = editing?.name ?? '';
  $('#broker-market-tw').checked = editing ? brokerSupports(editing, 'TW') : true;
  $('#broker-market-us').checked = editing ? brokerSupports(editing, 'US') : false;
  const tw = getFeeSettings(editing, 'TW');
  $('#broker-tw-rate').value = tw.standardFeeRate * 100;
  $('#broker-tw-discount').value = tw.discount * 10;
  $('#broker-tw-min-fee').value = tw.minimumFee;
  const us = getFeeSettings(editing, 'US');
  $('#broker-us-fee-mode').value = us.model === 'perShare' ? 'per-share' : us.model === 'percentage' ? 'percent' : 'fixed';
  $('#broker-us-fee-rate').value = us.model === 'perShare' ? us.perShareFee : us.model === 'percentage' ? us.percentageRate * 100 : us.fixedFee;
  $('#broker-us-min-fee').value = us.minimumFee;
  $('#broker-make-default').checked = false;
  updateBrokerMarketFields();
  setFeedback($('#broker-dialog-feedback'), '', 'info');
  openDialog($('#broker-dialog'));
}

function updateBrokerMarketFields() {
  $('#broker-tw-fields').hidden = !$('#broker-market-tw').checked;
  $('#broker-us-fields').hidden = !$('#broker-market-us').checked;
}

['#broker-market-tw', '#broker-market-us'].forEach((selector) => $(selector)?.addEventListener('change', updateBrokerMarketFields));

$('#default-broker')?.addEventListener('change', (event) => {
  if (event.target.value === '__new__') {
    openBrokerDialog();
    event.target.value = getPreferences().defaultBrokers.TW;
    return;
  }
  const broker = getBrokers().find((item) => item.id === event.target.value);
  const preferences = getPreferences();
  if (brokerSupports(broker, 'TW')) preferences.defaultBrokers.TW = broker.id;
  if (brokerSupports(broker, 'US')) preferences.defaultBrokers.US = broker.id;
  savePreferences(preferences);
  renderSelectedBrokerRates();
  setFeedback($('#broker-feedback'), `之後的新交易會套用「${broker.name}」；舊交易費稅不會被改寫。`, 'success');
});

$('#manage-brokers')?.addEventListener('click', () => {
  const selected = getBrokers().find((broker) => broker.id === $('#default-broker').value);
  openBrokerDialog({ broker: selected });
});

$('#broker-fee-save')?.addEventListener('click', () => {
  const id = $('#default-broker').value;
  const broker = getBrokers().find((item) => item.id === id);
  if (!broker) return;
  const standardRate = toNonNegativeNumber($('#tw-standard-fee-rate').value, null);
  const discount = toNonNegativeNumber($('#tw-fee-discount').value, null);
  const minimumFee = toNonNegativeNumber($('#tw-min-fee').value, null);
  const stockTax = toNonNegativeNumber($('#tw-stock-tax-rate').value, null);
  const etfTax = toNonNegativeNumber($('#tw-etf-tax-rate').value, null);
  const dayTax = toNonNegativeNumber($('#tw-day-trade-tax-rate').value, null);
  if (
    [standardRate, discount, minimumFee, stockTax, etfTax, dayTax].some((value) => value === null) ||
    discount > 10 || standardRate > 100 || stockTax > 100 || etfTax > 100 || dayTax > 100
  ) {
    setFeedback($('#broker-feedback'), '請檢查費率、折數、最低費與稅率。', 'error');
    return;
  }
  const nextTwSettings = {
    ...getFeeSettings(broker, 'TW'),
    standardFeeRate: standardRate / 100,
    discount: discount / 10,
    minimumFee,
  };
  const nextTaxRates = { stock: stockTax / 100, etf: etfTax / 100, dayTrade: dayTax / 100 };
  try {
    calculateTradeFee({ market: 'TW', price: 100, shares: 1, settings: nextTwSettings });
    for (const assetType of ['stock', 'etf', 'dayTrade']) {
      calculateTaiwanSecuritiesTax({ market: 'TW', side: 'sell', price: 100, shares: 1, assetType, rates: nextTaxRates });
    }
  } catch (error) {
    setFeedback($('#broker-feedback'), describeLedgerError(error), 'error');
    return;
  }
  upsertRecord(localStorage, 'brokers', {
    ...broker,
    tw: nextTwSettings,
  });
  const preferences = getPreferences();
  preferences.taxRates = nextTaxRates;
  savePreferences(preferences);
  renderSettings();
  setFeedback($('#broker-feedback'), '費稅預設已儲存，只會套用到之後新增或重新試算的交易。', 'success');
});

$('#broker-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const markets = ['TW', 'US'].filter((market) => $(`#broker-market-${market.toLowerCase()}`).checked);
  const name = $('#broker-name').value.trim();
  if (!name || !markets.length) {
    setFeedback($('#broker-dialog-feedback'), '請輸入券商名稱並至少選擇一個市場。', 'error');
    return;
  }
  const modeValue = $('#broker-us-fee-mode').value;
  const usRate = toNonNegativeNumber($('#broker-us-fee-rate').value, 0);
  const usMin = toNonNegativeNumber($('#broker-us-min-fee').value, 0);
  const twRate = toNonNegativeNumber($('#broker-tw-rate').value, 0.1425);
  const twDiscount = toNonNegativeNumber($('#broker-tw-discount').value, 10);
  const twMin = toNonNegativeNumber($('#broker-tw-min-fee').value, 20);
  if (
    [usRate, usMin, twRate, twDiscount, twMin].some((value) => value === null) ||
    twDiscount > 10 || twRate > 100 || (modeValue === 'percent' && usRate > 100)
  ) {
    setFeedback($('#broker-dialog-feedback'), '請檢查券商費率欄位。', 'error');
    return;
  }
  const model = modeValue === 'per-share' ? 'perShare' : modeValue === 'percent' ? 'percentage' : 'fixed';
  const record = {
    id: $('#broker-id').value || createRecordId('broker'),
    name,
    markets,
    tw: { standardFeeRate: twRate / 100, discount: twDiscount / 10, minimumFee: twMin, feeDecimals: 0, feeRounding: 'round' },
    us: {
      model,
      fixedFee: model === 'fixed' ? usRate : 0,
      perShareFee: model === 'perShare' ? usRate : 0,
      percentageRate: model === 'percentage' ? usRate / 100 : 0,
      minimumFee: usMin,
      feeDecimals: 2,
      feeRounding: 'round',
    },
  };
  try {
    if (markets.includes('TW')) calculateTradeFee({ market: 'TW', price: 100, shares: 1, settings: record.tw });
    if (markets.includes('US')) calculateTradeFee({ market: 'US', price: 100, shares: 1, settings: record.us });
  } catch (error) {
    setFeedback($('#broker-dialog-feedback'), describeLedgerError(error), 'error');
    return;
  }
  upsertRecord(localStorage, 'brokers', record);
  if ($('#broker-make-default').checked) {
    const preferences = getPreferences();
    markets.forEach((market) => { preferences.defaultBrokers[market] = record.id; });
    savePreferences(preferences);
  }
  closeDialog($('#broker-dialog'));
  renderSettings();
  showToast('券商設定已儲存。');
});

['#broker-cancel', '#broker-dialog-close'].forEach((selector) => $(selector)?.addEventListener('click', () => closeDialog($('#broker-dialog'))));

function renderCategories() {
  const categories = getPreferences().categories;
  $('#category-preview').replaceChildren(...categories.map((category) => {
    const span = document.createElement('span');
    span.textContent = category;
    return span;
  }));
  const rows = categories.map((category) => {
    const row = document.createElement('div');
    row.className = 'category-row';
    row.dataset.categoryId = category;
    const label = document.createElement('span');
    label.textContent = category;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'delete-category';
    button.textContent = '刪除';
    button.setAttribute('aria-label', `刪除${category}分類`);
    row.append(label, button);
    return row;
  });
  $('#category-list').replaceChildren(...rows);
}

$('#open-category-settings')?.addEventListener('click', () => { renderCategories(); openDialog($('#category-dialog')); });
$('#category-dialog-close')?.addEventListener('click', () => closeDialog($('#category-dialog')));

$('#category-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#category-new-name').value.trim();
  const preferences = getPreferences();
  if (!name) return;
  if (preferences.categories.some((category) => category.toLowerCase() === name.toLowerCase())) {
    setFeedback($('#category-feedback'), '這個分類已存在。', 'error');
    return;
  }
  preferences.categories.push(name);
  savePreferences(preferences);
  $('#category-new-name').value = '';
  renderCategories();
  renderHoldings();
  setFeedback($('#category-feedback'), '分類已新增。', 'success');
});

$('#category-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="delete-category"]');
  const row = button?.closest('[data-category-id]');
  if (!button || !row) return;
  const name = row.dataset.categoryId;
  if (!window.confirm(`刪除「${name}」分類？既有持股會改為未分類。`)) return;
  const preferences = getPreferences();
  preferences.categories = preferences.categories.filter((category) => category !== name);
  savePreferences(preferences);
  const instruments = readCollection(localStorage, 'instruments').map((item) => item.category === name ? { ...item, category: '' } : item);
  saveCollection(localStorage, 'instruments', instruments);
  renderCategories();
  renderHoldings();
});

function renderSettings() {
  renderBrokerSelect();
  renderCategories();
  renderTiingoControls();
}

// ── 本機備份 ──────────────────────────────────────────────────────────────

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

$('#export-data')?.addEventListener('click', () => {
  const backup = buildBackup(localStorage);
  downloadJson(backup, `股票紀錄備份-${taipeiDateKey()}.json`);
  setFeedback($('#backup-feedback'), '備份已匯出；Tiingo Token 不包含在檔案中。', 'success');
});

$('#import-data')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const beforeImport = buildBackup(localStorage);
  let replaced = false;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!window.confirm('匯入會以備份內容覆蓋目前紀錄。程式會先在這台裝置保留一份匯入前快照，確定繼續？')) return;
    localStorage.setItem(PRE_IMPORT_BACKUP_KEY, JSON.stringify(beforeImport));
    restoreBackup(localStorage, payload, { mode: 'replace' });
    replaced = true;
    ensureInitialData();
    migrateTransactions();
    calculateBook();
    calculateFxBook();
    renderAll();
    setFeedback($('#backup-feedback'), '匯入完成。Tiingo Token 維持這台裝置原本的設定。', 'success');
  } catch (error) {
    if (replaced) {
      restoreBackup(localStorage, beforeImport, { mode: 'replace' });
      ensureInitialData();
      migrateTransactions();
      renderAll();
    }
    setFeedback($('#backup-feedback'), `匯入失敗：${error.message || '檔案格式不正確'}。原資料已保留。`, 'error');
  } finally {
    event.target.value = '';
  }
});

// ── Tiingo：選用、預設關閉的美股備援 ────────────────────────────────────

const tiingoEnabledInput = $('#tiingo-enabled');
const tiingoConnectionSettings = $('#tiingo-connection-settings');
const tokenInput = $('#tiingo-token');
const tokenStatus = $('#tiingo-status');
const tokenFeedback = $('#tiingo-feedback');
const autoUpdateInput = $('#tiingo-auto-update');
const refreshButton = $('#refresh-us-prices');

function isTiingoEnabled() {
  return localStorage.getItem(TIINGO_STORAGE.enabled) === 'true';
}

function isAutoUpdateEnabled() {
  return localStorage.getItem(TIINGO_STORAGE.autoUpdate) === 'true';
}

function getStoredToken() {
  return localStorage.getItem(TIINGO_STORAGE.token) ?? '';
}

function setConnectionStatus(message, state) {
  const label = $('[data-status-text]', tokenStatus);
  if (label) label.textContent = message;
  if (tokenStatus) tokenStatus.dataset.state = state;
}

function renderTiingoControls() {
  const enabled = isTiingoEnabled();
  const token = getStoredToken();
  const hasUsHoldings = (safelyCalculateBook().openPositions ?? []).some((position) => position.market === 'US');
  if (tiingoEnabledInput) tiingoEnabledInput.checked = enabled;
  if (tiingoConnectionSettings) tiingoConnectionSettings.hidden = !enabled;
  if (refreshButton) refreshButton.hidden = !enabled || !hasUsHoldings;
  if ($('#us-quote-meta')) $('#us-quote-meta').hidden = !enabled || !hasUsHoldings;
  if (!enabled) {
    setFeedback($('#quote-feedback'), '', 'info');
    return;
  }
  setConnectionStatus(token ? '已連接，可作為美股備援' : '尚未連接', token ? 'connected' : 'disconnected');
  if (tokenInput) {
    tokenInput.type = 'password';
    tokenInput.value = '';
    tokenInput.placeholder = token ? `Token 已儲存（尾碼 ${token.slice(-4)}）` : '日後需要時再貼上 Token';
  }
  if ($('#tiingo-clear')) $('#tiingo-clear').hidden = !token;
  if (autoUpdateInput) {
    autoUpdateInput.checked = isAutoUpdateEnabled();
    autoUpdateInput.disabled = !token;
  }
  renderQuoteMeta();
}

function renderQuoteMeta() {
  const quotes = getQuotes();
  const tiingoQuotes = Object.values(quotes).filter((quote) => quote?.source === 'Tiingo EOD');
  const latest = tiingoQuotes.map((quote) => quote.date).filter(Boolean).sort().at(-1);
  if ($('#us-price-asof')) $('#us-price-asof').textContent = latest ? formatDate(latest) : '尚未更新';
  if ($('#us-price-source')) $('#us-price-source').textContent = 'Tiingo EOD（備援）';
}

function describeTiingoError(error) {
  if (error instanceof TiingoError && error.code === 'NETWORK_ERROR' && window.location.hostname.endsWith('.github.io')) {
    return 'GitHub Pages 目前不能直接讀取 Tiingo；日後啟用時需再加安全連線橋接。記帳功能不受影響。';
  }
  if (error instanceof TiingoError) return error.message;
  return '暫時無法取得 Tiingo 行情，已保留原價格。';
}

tiingoEnabledInput?.addEventListener('change', () => {
  localStorage.setItem(TIINGO_STORAGE.enabled, String(tiingoEnabledInput.checked));
  if (tiingoEnabledInput.checked) $('#tiingo-disclosure').open = true;
  renderTiingoControls();
  setFeedback(tokenFeedback, tiingoEnabledInput.checked ? '已開啟備援設定；只有你主動更新時才會連線。' : '', 'info');
});

$('#tiingo-token-toggle')?.addEventListener('click', () => {
  const show = tokenInput.type === 'password';
  tokenInput.type = show ? 'text' : 'password';
  $('#tiingo-token-toggle').setAttribute('aria-label', show ? '隱藏 Token' : '顯示 Token');
  $('#tiingo-token-toggle').setAttribute('aria-pressed', String(show));
});

async function refreshUsQuotes({ quiet = false } = {}) {
  if (!isTiingoEnabled()) return;
  const token = getStoredToken();
  if (!token) {
    if (!quiet) {
      showView('settings');
      $('#tiingo-disclosure').open = true;
      setFeedback(tokenFeedback, '請先貼上 Tiingo Token；在此之前所有記帳與報表仍可使用。', 'error');
    }
    return;
  }
  const symbols = (safelyCalculateBook().openPositions ?? []).filter((position) => position.market === 'US').map((position) => position.symbol);
  if (!symbols.length) {
    if (!quiet) setFeedback($('#quote-feedback'), '目前沒有美股持股可更新。', 'info');
    return;
  }
  refreshButton.disabled = true;
  const quotes = getQuotes();
  let success = 0;
  const failures = [];
  for (const rawSymbol of symbols) {
    try {
      const symbol = normalizeTiingoSymbol(rawSymbol);
      const quote = await fetchLatestTiingoClose(symbol, token);
      quotes[quoteKey('US', symbol)] = quote;
      success += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (success) {
    writeStoredJson(localStorage, STORAGE_KEYS.quotes, quotes);
    localStorage.setItem(TIINGO_STORAGE.lastRefresh, taipeiDateKey());
    renderHoldings();
    renderReports();
  }
  refreshButton.disabled = false;
  if (!quiet) {
    setFeedback(
      $('#quote-feedback'),
      failures.length ? (success ? `已更新 ${success} 檔，另有 ${failures.length} 檔失敗。` : describeTiingoError(failures[0])) : `已更新 ${success} 檔美股最近收盤價。`,
      failures.length ? 'error' : 'success',
    );
  }
}

$('#tiingo-save')?.addEventListener('click', async () => {
  let token;
  try {
    token = normalizeTiingoToken(tokenInput.value);
  } catch (error) {
    setFeedback(tokenFeedback, describeTiingoError(error), 'error');
    return;
  }
  const button = $('#tiingo-save');
  button.disabled = true;
  button.textContent = '正在測試…';
  try {
    await validateTiingoToken(token);
    localStorage.setItem(TIINGO_STORAGE.token, token);
    renderTiingoControls();
    setFeedback(tokenFeedback, 'Tiingo 備援已連接。是否每日更新仍由下方開關決定。', 'success');
  } catch (error) {
    setConnectionStatus('連接失敗', 'error');
    setFeedback(tokenFeedback, describeTiingoError(error), 'error');
  } finally {
    button.disabled = false;
    button.textContent = '測試並儲存';
  }
});

$('#tiingo-clear')?.addEventListener('click', () => {
  if (!window.confirm('清除這台裝置上的 Tiingo Token？交易、股息與快取價格不受影響。')) return;
  localStorage.removeItem(TIINGO_STORAGE.token);
  localStorage.removeItem(TIINGO_STORAGE.lastRefresh);
  localStorage.setItem(TIINGO_STORAGE.autoUpdate, 'false');
  renderTiingoControls();
  setFeedback(tokenFeedback, 'Tiingo 連線已清除。', 'success');
});

autoUpdateInput?.addEventListener('change', () => {
  localStorage.setItem(TIINGO_STORAGE.autoUpdate, String(autoUpdateInput.checked));
  setFeedback(tokenFeedback, autoUpdateInput.checked ? '已開啟每日一次的備援價格更新。' : '已關閉自動更新。', 'success');
});

refreshButton?.addEventListener('click', () => refreshUsQuotes());

function maybeAutoRefresh() {
  if (!isTiingoEnabled() || !isAutoUpdateEnabled() || !getStoredToken() || !navigator.onLine) return;
  if (localStorage.getItem(TIINGO_STORAGE.lastRefresh) === taipeiDateKey()) return;
  refreshUsQuotes({ quiet: true });
}

window.addEventListener('online', maybeAutoRefresh);

// ── 月初報表、啟動與離線安裝 ─────────────────────────────────────────────

function previousMonthKey() {
  const [year, month] = taipeiDateKey().slice(0, 7).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function maybeShowMonthlyReport() {
  const preferences = getPreferences();
  const currentMonth = taipeiDateKey().slice(0, 7);
  const previousMonth = previousMonthKey();
  const hasPreviousActivity = safelyCalculateBook().transactions.some((item) => item.date.startsWith(previousMonth));
  if (!hasPreviousActivity || preferences.lastMonthlyReportSeen === currentMonth) return;
  preferences.lastMonthlyReportSeen = currentMonth;
  savePreferences(preferences);
  reportSelection = { mode: 'month', key: previousMonth };
  const monthButton = $('[data-report-period="month"]');
  if (monthButton) monthButton.textContent = '上月';
  showView('reports');
  showToast(`已開啟 ${previousMonth} 月報；本月只會自動顯示一次。`, 'info');
}

function renderAll() {
  renderHoldings();
  renderRecords();
  renderReports();
  renderSettings();
  renderHistoryOptions();
}

ensureInitialData();
migrateTransactions();
resetDividendForm();
resetFxForm();
renderAll();
maybeShowMonthlyReport();
maybeAutoRefresh();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 私密瀏覽若禁止 Service Worker，記帳與本機儲存仍可正常使用。
    });
  });
}
