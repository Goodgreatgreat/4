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
  DOCUMENT_KEY,
  atomicUpdate,
  validateBackup,
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
  normalizeRelayUrl,
  validateTiingoToken,
} from './tiingo.js';
import {
  TaiwanQuoteError,
  fetchPublishedTaiwanQuotes,
} from './tw-quotes.js';
import { investmentPerformance, quoteUsable, combinePositions, allocationAdvice, dateNumber } from './performance.js';

const TIINGO_STORAGE = Object.freeze({
  token: 'stock-journal:tiingo-token:v1',
  enabled: 'stock-journal:tiingo-enabled:v1',
  autoUpdate: 'stock-journal:tiingo-auto-update:v1',
  lastRefresh: 'stock-journal:tiingo-last-refresh:v1',
});

const TW_QUOTE_STORAGE = Object.freeze({
  lastRefresh: 'stock-journal:tw-official-last-refresh:v1',
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
    sellFeeRate: 0,
    sellMinimumFee: 0,
    feeDecimals: 2,
    feeRounding: 'round',
  },
});

const DEFAULT_PREFERENCES = Object.freeze({
  defaultBrokers: { TW: DEFAULT_BROKER.id, US: DEFAULT_BROKER.id },
  categories: [...DEFAULT_CATEGORIES],
  categorySignals: {},
  taxRates: { stock: 0.003, etf: 0.001, dayTrade: 0.0015 },
  lastMonthlyReportSeen: '',
  accounts: [{ id: 'default', name: '原有帳戶' }],
  defaultAccountId: 'default',
  allocationTargets: {},
  allocationTolerance: 5,
});

const knownNames = Object.freeze({
  '0050': '元大台灣50',
  '2330': '台積電',
  AAPL: 'Apple',
  NVDA: 'NVIDIA',
  MSFT: 'Microsoft',
  GOOGL: 'Alphabet',
  AMZN: 'Amazon',
  META: 'Meta',
  TSLA: 'Tesla',
  AMD: 'AMD',
  SPY: 'SPDR S&P 500 ETF',
  QQQ: 'Invesco QQQ ETF',
  VOO: 'Vanguard S&P 500 ETF',
  VTI: 'Vanguard Total Stock Market ETF',
  VT: 'Vanguard Total World Stock ETF',
});
const knownSymbolsByName = Object.freeze(
  Object.fromEntries(Object.entries(knownNames).map(([symbol, name]) => [name.toLowerCase(), symbol])),
);
const KNOWN_US_ETFS = new Set(['SPY', 'QQQ', 'VOO', 'VTI', 'VT']);

const currencyFormatters = {
  TWD: new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }),
  USD: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};
const numberFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 6 });
const percentFormatter = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PIE_COLORS = Object.freeze(['#bc4749', '#386641', '#dda15e', '#457b9d', '#6d597a', '#e76f51', '#588157', '#8d99ae']);

let taiwanCatalog = {};
let taiwanCatalogMeta = null;
let taiwanCatalogPromise = null;
let taiwanCatalogByName = new Map();
let holdingStockFilter = '';
let recordStockFilter = '';
let combinedView = false;
let taiwanCatalogLoadedAt = 0;
let refreshingTw = false;
let refreshingUs = false;

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

function toOptionalNonNegativeNumber(value) {
  const text = String(value ?? '').replaceAll(',', '').trim();
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
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
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${signed && number > 0 ? '+' : ''}${percentFormatter.format(number)}%`;
}

function setFeedback(element, message, kind = 'info') {
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = !message;
  element.classList.toggle('is-large-success', element.id === 'trade-feedback' && kind === 'success' && Boolean(message));
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
    categorySignals: saved.categorySignals && typeof saved.categorySignals === 'object'
      ? clone(saved.categorySignals)
      : {},
    categories: Array.isArray(saved.categories)
      ? [...new Set(saved.categories.map((item) => String(item).trim()).filter(Boolean))]
      : [...DEFAULT_CATEGORIES],
  };
}

function activeAccount() { return getPreferences().defaultAccountId || 'default'; }
function accountName(id) { return getPreferences().accounts.find((a) => a.id === (id || 'default'))?.name || '原有帳戶'; }
function inScope(record) { return combinedView || (record.accountId || 'default') === activeAccount(); }
function scopedRecords(name) { return readCollection(localStorage, name).filter(inScope); }

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

function installTaiwanCatalog(payload) {
  taiwanCatalogLoadedAt = Date.now();
  taiwanCatalogMeta = payload;
  taiwanCatalog = payload.quotes ?? {};
  taiwanCatalogByName = new Map(
    Object.values(taiwanCatalog).map((quote) => [String(quote.name).toLowerCase(), quote]),
  );
  updateStockSuggestions($('#trade-symbol')?.value ?? '');
  updateTradeInstrumentPreview();
  return payload;
}

async function loadTaiwanCatalog({ force = false } = {}) {
  if (!force && taiwanCatalogMeta && Date.now() - taiwanCatalogLoadedAt < 60 * 60 * 1000) return taiwanCatalogMeta;
  if (!force && taiwanCatalogPromise) return taiwanCatalogPromise;
  taiwanCatalogPromise = fetchPublishedTaiwanQuotes({ cacheBust: force ? Date.now() : taipeiDateKey() })
    .then(installTaiwanCatalog)
    .finally(() => { taiwanCatalogPromise = null; });
  return taiwanCatalogPromise;
}

function updateStockSuggestions(value = '') {
  const list = $('#stock-suggestions');
  if (!list) return;
  const query = String(value).normalize('NFKC').trim().toLowerCase();
  const choices = Object.entries(knownNames).map(([symbol, name]) => ({ symbol, name }));
  if (query) {
    for (const quote of Object.values(taiwanCatalog)) {
      if (quote.symbol.toLowerCase().startsWith(query) || quote.name.toLowerCase().includes(query)) {
        choices.push(quote);
        if (choices.length >= 28) break;
      }
    }
  }
  const unique = new Map(choices.map((item) => [item.symbol, item]));
  list.replaceChildren(...[...unique.values()].map((item) => {
    const option = document.createElement('option');
    option.value = item.symbol;
    option.label = item.name;
    return option;
  }));
}

function inferInstrument(rawValue, forcedMarket = null) {
  const raw = String(rawValue ?? '').normalize('NFKC').trim();
  const savedInstrument = readCollection(localStorage, 'instruments').find((item) => (!forcedMarket || item.market === forcedMarket) && (String(item.name).toLowerCase() === raw.toLowerCase() || String(item.symbol).toLowerCase() === raw.toLowerCase()));
  const catalogByName = taiwanCatalogByName.get(raw.toLowerCase());
  const knownSymbol = catalogByName?.symbol ?? savedInstrument?.symbol ?? knownSymbolsByName[raw.toLowerCase()] ?? null;
  const taiwanPattern = /^(?:\d{4}[A-Z]?|00[A-Z0-9]{2,6}|9\d{5})$/i;
  const numeric = (knownSymbol && /^\d/.test(knownSymbol) ? knownSymbol : null)
    ?? raw.match(/(?:^|\s)(\d[A-Za-z0-9]{3,7})(?:\s|$)/)?.[1]
    ?? (taiwanPattern.test(raw) ? raw : null);
  const latin = (knownSymbol && /^[A-Z]/.test(knownSymbol) ? knownSymbol : null)
    ?? raw.match(/(?:^|\s)([A-Za-z][A-Za-z0-9.-]{0,31})(?:\s|$)/)?.[1]
    ?? (/^[A-Za-z][A-Za-z0-9.-]{0,31}$/.test(raw) ? raw : null);
  const market = forcedMarket ?? (latin && !numeric ? 'US' : 'TW');
  let symbol = market === 'US' ? (latin ?? raw).toUpperCase() : (numeric ?? raw).toUpperCase();
  symbol = symbol.trim();
  const official = market === 'TW' ? taiwanCatalog[symbol] : null;
  const remainingName = raw.replace(symbol, '').trim();
  return {
    market,
    symbol,
    name: official?.name || savedInstrument?.name || remainingName || knownNames[symbol] || raw || symbol,
    assetType: official?.kind ?? savedInstrument?.assetType ?? (((market === 'TW' && /^00/.test(symbol)) || (market === 'US' && KNOWN_US_ETFS.has(symbol))) ? 'etf' : 'stock'),
    board: official?.board ?? null,
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
  const feeSettings = getFeeSettings(broker, record.market);
  const fee = calculateTradeFee({
    market: record.market,
    price: record.price,
    shares: record.shares,
    settings: feeSettings,
  });
  const tax = record.market === 'TW'
    ? calculateTaiwanSecuritiesTax({
      market: record.market,
      side: record.side,
      price: record.price,
      shares: record.shares,
      assetType: record.assetType,
      rates: getPreferences().taxRates,
      date: record.date,
    })
    : record.side === 'sell'
      ? Math.round(Math.max(
        Number(record.price) * Number(record.shares) * Number(feeSettings.sellFeeRate || 0) + Number(record.shares) * Number(feeSettings.sellPerShareFee || 0),
        Number(feeSettings.sellMinimumFee || 0),
      ) * 100) / 100
      : 0;
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
      accountId: item.accountId || 'default',
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
      const leftOrder = Number(left.record.dayOrder ?? left.record.sequence ?? 0);
      const rightOrder = Number(right.record.dayOrder ?? right.record.sequence ?? 0);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
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
    accountId: record.accountId || 'default',
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
    dayOrder: record.dayOrder,
    createdAt: record.createdAt,
  }));
  const income = dividends.map((record) => ({
    id: record.id,
    type: record.type === 'split' ? 'split' : record.type === 'stock' ? 'stockDividend' : 'cashDividend',
    accountId: record.accountId || 'default',
    factor: record.factor,
    date: normalizeDate(record.date),
    market: record.market || (record.currency === 'USD' ? 'US' : 'TW'),
    symbol: String(record.symbol).trim().toUpperCase(),
    ...(record.type === 'stock' ? { shares: Number(record.shares) } : { amount: Number(record.amount) }),
    sequence: record.sequence,
    dayOrder: record.dayOrder,
    createdAt: record.createdAt,
  }));
  return chronological([...trades, ...income]).map(({ sequence, createdAt, ...entry }) => entry);
}

function calculateBook(transactions, dividends) {
  const entries = buildLedgerEntries(transactions, dividends);
  if (entries.some((entry) => entry.date > taipeiDateKey())) throw new Error('帳務紀錄不可使用未來日期，請核對成交／發放日。');
  return processLedger(entries);
}

function nextDayOrder(date, accountId = activeAccount()) {
  return Math.max(0, ...[...readCollection(localStorage, 'transactions'), ...readCollection(localStorage, 'dividends')].filter((r) => r.date === date && (r.accountId || 'default') === accountId).map((r) => Number(r.dayOrder || 0))) + 1;
}

function migrateDayOrders() {
  const counters = new Map();
  const collections = ['transactions', 'dividends'];
  const records = chronological(collections.flatMap((name) => readCollection(localStorage, name).map((r) => ({ ...r, collection: name }))));
  for (const r of records) {
    const key = `${r.accountId || 'default'}:${r.date}`;
    const order = Math.max((counters.get(key) || 0) + 1, Number(r.dayOrder || 0));
    if (r.dayOrder == null) r.dayOrder = order;
    counters.set(key, order);
  }
  atomicUpdate(localStorage, (draft) => {
    for (const name of collections) {
      const next = records.filter((r) => r.collection === name).map(({ collection, ...r }) => r);
      if (JSON.stringify(next) !== JSON.stringify(readCollection(draft, name))) saveCollection(draft, name, next);
    }
  });
}

function calculateFxBook(exchanges = readCollection(localStorage, 'exchanges')) {
  const accounts = [...new Set(exchanges.map((r) => r.accountId || 'default'))];
  if (accounts.length > 1) {
    const books = accounts.map((id) => calculateFxBook(exchanges.filter((r) => (r.accountId || 'default') === id)));
    return { transactions: books.flatMap((b) => b.transactions) };
  }
  return processFxLedger(chronological(exchanges).map((record) => ({
    id: record.id,
    date: normalizeDate(record.date),
    side: record.side,
    usdAmount: Number(record.usdAmount),
    twdAmount: Number(record.twdAmount),
    feeTwd: Number(record.feeTwd ?? 0),
  })));
}

function safelyCalculateBook({ all = false } = {}) {
  try {
    const book = calculateBook();
    if (all || combinedView) return book;
    return { ...book, transactions: book.transactions.filter(inScope), positions: book.positions.filter(inScope), openPositions: book.openPositions.filter(inScope) };
  } catch (error) {
    console.error(error);
    return { transactions: [], positions: [], openPositions: [], monthlySummaries: [], yearlySummaries: [], error };
  }
}

function findInstrument(market, symbol, accountId = activeAccount()) {
  return readCollection(localStorage, 'instruments').find(
    (item) => (item.accountId || 'default') === accountId && item.market === market && String(item.symbol).toUpperCase() === String(symbol).toUpperCase(),
  );
}

function saveInstrument(data, { audit = true, storage = localStorage } = {}) {
  const accountId = data.accountId || activeAccount();
  const existing = readCollection(storage, 'instruments').find((i) => (i.accountId || 'default') === accountId && i.market === data.market && i.symbol === data.symbol);
  const next = {
    ...existing,
    ...data,
    accountId,
    id: existing?.id || JSON.stringify([accountId, data.market, String(data.symbol).toUpperCase()]),
  };
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return existing;
  return upsertRecord(storage, 'instruments', next, { audit });
}

const viewTitles = Object.freeze({
  entry: '記一筆',
  holdings: '目前持股',
  records: '交易、股息與換匯',
  reports: '報表',
  settings: '設定',
  assets: '總資產配置',
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

function renderTradeCategoryOptions(inferred = inferInstrument($('#trade-symbol')?.value ?? '')) {
  const wrap = $('#trade-category-wrap');
  const select = $('#trade-category');
  if (!select) return;
  const existing = inferred.symbol ? findInstrument(inferred.market, inferred.symbol) : null;
  const identity = `${inferred.market}:${inferred.symbol}`;
  const current = select.dataset.instrument === identity ? select.value : (existing?.category || '');
  select.dataset.instrument = identity;
  select.replaceChildren(new Option('未分類', ''));
  getPreferences().categories.forEach((category) => select.add(new Option(category, category)));
  select.value = getPreferences().categories.includes(current) ? current : (existing?.category || '');
  if (wrap) wrap.hidden = selectedSide !== 'buy';
}

function updateTradeInstrumentPreview() {
  const input = $('#trade-symbol');
  const preview = $('#trade-name-preview');
  const raw = input?.value.trim() ?? '';
  if (!raw) {
    if (preview) {
      preview.textContent = '輸入台股代號會自動帶入名稱與股票／ETF 類型。';
      preview.dataset.state = 'hint';
    }
    if ($('#trade-currency')) $('#trade-currency').textContent = '$';
    renderTradeCategoryOptions({ market: 'TW', symbol: '' });
    return;
  }
  const inferred = inferInstrument(raw);
  const exactTaiwan = inferred.market === 'TW' ? taiwanCatalog[inferred.symbol] : null;
  const known = inferred.market === 'US' ? knownNames[inferred.symbol] : (exactTaiwan?.name || knownNames[inferred.symbol]);
  if ($('#trade-currency')) $('#trade-currency').textContent = inferred.market === 'US' ? 'US$' : 'NT$';
  if (preview) {
    if (known || exactTaiwan) {
      const marketLabel = inferred.market === 'US' ? '美股' : `${exactTaiwan?.board === 'TPEx' ? '上櫃' : '上市'}${inferred.assetType === 'etf' ? ' ETF' : '股票'}`;
      const taxLabel = inferred.market === 'TW'
        ? ` · 賣出證交稅 ${(calculateTaiwanSecuritiesTax({ side: 'sell', price: 100000, shares: 1, assetType: inferred.assetType, date: $('#trade-date')?.value || taipeiDateKey(), rates: getPreferences().taxRates }) / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`
        : '';
      preview.textContent = `${inferred.symbol} · ${inferred.name} · ${marketLabel}${taxLabel}`;
      preview.dataset.state = 'matched';
    } else {
      preview.textContent = inferred.market === 'US'
        ? `${inferred.symbol} · 美股（名稱可稍後在紀錄中修正）`
        : `${inferred.symbol} · 尚未在最新台股清單中找到，仍可先記帳`;
      preview.dataset.state = 'unmatched';
    }
  }
  renderTradeCategoryOptions(inferred);
}

$('#trade-symbol')?.addEventListener('input', (event) => {
  updateStockSuggestions(event.target.value);
  updateTradeInstrumentPreview();
});

$$('input[name="side"]', tradeForm).forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    selectedSide = input.value;
    const label = $('#trade-submit span:first-child');
    if (label) label.textContent = selectedSide === 'buy' ? '記錄這筆買入' : '記錄這筆賣出';
    updateTradeInstrumentPreview();
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
  if (!inferred.symbol || (inferred.market === 'TW' && !/^(?:\d{4}[A-Z]?|00[A-Z0-9]{2,6}|9\d{5})$/.test(inferred.symbol))) {
    setFeedback(tradeFeedback, '請輸入可辨識的股票名稱或代號。', 'error');
    return;
  }
  const broker = getDefaultBroker(inferred.market);
  const base = {
    id: createRecordId('trade'),
    type: 'trade',
    accountId: activeAccount(),
    date: $('#trade-date')?.value || taipeiDateKey(),
    dayOrder: Number($('#trade-order')?.value || nextDayOrder($('#trade-date')?.value || taipeiDateKey())),
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
    category: selectedSide === 'buy'
      ? ($('#trade-category')?.value ?? findInstrument(inferred.market, inferred.symbol)?.category ?? '')
      : (findInstrument(inferred.market, inferred.symbol)?.category ?? ''),
    notes: '',
  };
  let record;
  try {
    const charges = calculateCharges(base);
    record = { ...base, feeOverride: charges.fee, taxOverride: charges.tax };
    calculateBook([record, ...readCollection(localStorage, 'transactions')], readCollection(localStorage, 'dividends'));
    atomicUpdate(localStorage, (draft) => {
      upsertRecord(draft, 'transactions', record);
      saveInstrument({ accountId: record.accountId, market: record.market, symbol: record.symbol, name: record.name, assetType: record.assetType, category: record.category }, { storage: draft });
    });
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
  if ($('#trade-order')) $('#trade-order').value = '';
  maybeAutoRefreshTaiwanQuotes();
  maybeAutoRefresh();
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
  if (market === 'TW' && taiwanCatalog[symbol]?.name) return taiwanCatalog[symbol].name;
  return readCollection(localStorage, 'transactions').find(
    (record) => record.market === market && record.symbol === symbol && record.name,
  )?.name ?? knownNames[symbol] ?? symbol;
}

function renderAllocationSummary(positions) {
  if (!positions.length) return '';
  const totals = new Map();
  for (const position of positions) {
    const category = findInstrument(position.market, position.symbol, position.accountId)?.category || '未分類';
    const key = `${position.currency}:${category}`;
    totals.set(key, (totals.get(key) ?? 0) + position.costBasis);
  }
  const byCurrency = {};
  for (const [key, amount] of totals) {
    const currency = key.slice(0, key.indexOf(':'));
    const category = key.slice(key.indexOf(':') + 1);
    byCurrency[currency] ??= [];
    byCurrency[currency].push({ category, amount });
  }
  const groups = Object.entries(byCurrency).map(([currency, rows]) => {
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const slices = rows.sort((a, b) => b.amount - a.amount).map((row, index) => {
      const percentage = total ? (row.amount / total) * 100 : 0;
      return { ...row, percentage, color: PIE_COLORS[index % PIE_COLORS.length], colorIndex: index % PIE_COLORS.length };
    });
    const items = slices.map((row) => `
      <li class="allocation-legend-item"><span class="allocation-swatch allocation-swatch--${row.colorIndex}"></span><span>${escapeHtml(row.category)}</span><strong>${percentFormatter.format(row.percentage)}%</strong></li>`,
    ).join('');
    const aria = slices.map((row) => `${row.category} ${percentFormatter.format(row.percentage)}%`).join('、');
    return `<article class="allocation-card"><div class="allocation-card__heading"><h3>${currency === 'USD' ? '美股 · USD' : '台股 · TWD'}</h3><p>依持股成本</p></div><div class="allocation-card__body"><div class="allocation-pie"><canvas width="240" height="240" data-pie-values="${slices.map((row) => row.amount).join(',')}" data-pie-count="${slices.length}" role="img" aria-label="${escapeHtml(aria)}">${escapeHtml(aria)}</canvas></div><ul class="allocation-legend">${items}</ul></div></article>`;
  }).join('');
  return `<div class="allocation-chart-grid">${groups}</div>`;
}

function drawAllocationCharts(root) {
  $$('canvas[data-pie-values]', root).forEach((canvas) => {
    const context = canvas.getContext?.('2d');
    if (!context) return;
    const values = canvas.dataset.pieValues.split(',').map(Number).filter((value) => Number.isFinite(value) && value >= 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    const center = canvas.width / 2;
    const radius = center - 4;
    let angle = -Math.PI / 2;
    context.clearRect(0, 0, canvas.width, canvas.height);
    values.forEach((value, index) => {
      const nextAngle = angle + (total ? (value / total) * Math.PI * 2 : 0);
      context.beginPath();
      context.moveTo(center, center);
      context.arc(center, center, radius, angle, nextAngle);
      context.closePath();
      context.fillStyle = PIE_COLORS[index % PIE_COLORS.length];
      context.fill();
      angle = nextAngle;
    });
    context.beginPath();
    context.arc(center, center, radius * 0.54, 0, Math.PI * 2);
    context.fillStyle = '#fffdf9';
    context.fill();
    context.fillStyle = '#242722';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '900 30px system-ui, sans-serif';
    context.fillText(canvas.dataset.pieCount || '0', center, center - 8);
    context.fillStyle = '#73766f';
    context.font = '700 14px system-ui, sans-serif';
    context.fillText('類別', center, center + 22);
  });
}

function holdingSignalMessages(category, returnRate, dailyChange) {
  if (!category) return [];
  const setting = getPreferences().categorySignals?.[category] ?? {};
  const messages = [];
  if (Number(setting.profitReturn) > 0 && Number(returnRate) >= Number(setting.profitReturn)) {
    messages.push(`報酬率已達獲利提醒 ${formatPercent(setting.profitReturn)}`);
  }
  if (Number(setting.lossReturn) > 0 && Number(returnRate) <= -Number(setting.lossReturn)) {
    messages.push(`報酬率已達虧損提醒 -${formatPercent(setting.lossReturn)}`);
  }
  if (Number(setting.riseChange) > 0 && Number(dailyChange) >= Number(setting.riseChange)) {
    messages.push(`當日漲幅已達 ${formatPercent(setting.riseChange)}`);
  }
  if (Number(setting.fallChange) > 0 && Number(dailyChange) <= -Number(setting.fallChange)) {
    messages.push(`當日跌幅已達 -${formatPercent(setting.fallChange)}`);
  }
  return messages;
}

function createHoldingCard(position, quotes) {
  const instrument = findInstrument(position.market, position.symbol, position.accountId);
  const quote = getQuote(position.market, position.symbol, quotes);
  const categories = getPreferences().categories;
  const latestDividend = readCollection(localStorage, 'dividends')
    .filter((item) => (item.market || (item.currency === 'USD' ? 'US' : 'TW')) === position.market && String(item.symbol).toUpperCase() === position.symbol)
    .sort((a, b) => normalizeDate(b.date).localeCompare(normalizeDate(a.date)))[0];
  const currentPrice = Number(quote?.close);
  const hasPrice = quoteUsable(quote, taipeiDateKey());
  const marketValue = hasPrice ? currentPrice * position.shares : null;
  const unrealized = hasPrice ? marketValue - position.costBasis : null;
  const returnRate = hasPrice && position.costBasis > 0 ? (unrealized / position.costBasis) * 100 : null;
  const dailyChange = quote?.changePercent == null ? Number.NaN : Number(quote.changePercent);
  const hasDailyChange = Number.isFinite(dailyChange) && quote?.date === taipeiDateKey() && !quote?.needsSplitReview;
  const category = instrument?.category || '';
  const signals = holdingSignalMessages(category, returnRate, hasDailyChange ? dailyChange : null);
  const options = ['<option value="">未分類</option>', ...categories.map((category) =>
    `<option value="${escapeHtml(category)}"${instrument?.category === category ? ' selected' : ''}>${escapeHtml(category)}</option>`,
  )].join('');
  const article = document.createElement('article');
  article.className = `holding-card${signals.length ? ' has-signal' : ''}`;
  article.dataset.holdingSymbol = position.symbol;
  article.dataset.market = position.market;
  article.dataset.accountId = position.accountId;
  article.innerHTML = `
    <div class="holding-card__top">
      <div class="stock-identity">
        <span class="stock-avatar" aria-hidden="true">${escapeHtml(position.symbol.slice(0, 1))}</span>
        <div><div class="stock-title"><h3>${escapeHtml(position.symbol)}</h3><span class="market-tag">${position.market === 'US' ? '美股' : '台股'}</span></div><p>${escapeHtml(latestName(position.market, position.symbol))}</p></div>
      </div>
      <div class="stock-price"><span>${escapeHtml(quote?.source === 'manual' ? '手動價格' : quote?.source || '參考價格')}</span><strong>${hasPrice ? formatMoney(currentPrice, position.currency) : '尚無可用價格'}</strong><small>${quote?.date ? escapeHtml(formatDate(quote.date)) : ''}${quote?.needsSplitReview ? ' · 請先確認股票分割' : ''}</small></div>
    </div>
    <dl class="holding-metrics">
      <div><dt>持有股數</dt><dd>${numberFormatter.format(position.shares)} 股</dd></div>
      <div><dt>平均成本</dt><dd>${formatMoney(position.averageCost, position.currency)}</dd></div>
      <div><dt>持股成本</dt><dd>${formatMoney(position.costBasis, position.currency)}</dd></div>
      <div><dt>未實現損益</dt><dd data-pnl>${unrealized === null ? '尚無價格' : formatMoney(unrealized, position.currency, { signed: true })}</dd></div>
      <div><dt>已實現損益</dt><dd data-realized>${formatMoney(position.realizedTradingPnl, position.currency, { signed: true })}</dd></div>
      <div><dt>累計現金股息</dt><dd>${formatMoney(position.cashDividendIncome, position.currency)}</dd></div>
      <div><dt>當日漲跌幅</dt><dd data-change>${hasDailyChange ? formatPercent(dailyChange, { signed: true }) : '尚無資料'}</dd></div>
    </dl>
    <div class="holding-card__foot"><span>報酬率</span><strong data-return>${returnRate === null ? '尚無價格' : formatPercent(returnRate, { signed: true })}</strong></div>
    <div class="holding-card__extras">
      <label>${combinedView ? '合併檢視（分類請切回帳戶修改）' : escapeHtml(accountName(position.accountId))}<select data-action="holding-category" ${combinedView ? 'disabled' : ''}>${options}</select></label>
      <span>${latestDividend ? `最近股息日 ${formatDate(latestDividend.date)}` : '尚無股息紀錄'}</span>
    </div>
    ${signals.length ? `<div class="holding-signal" role="status"><strong>提醒</strong><span>${signals.map(escapeHtml).join('；')}</span></div>` : ''}
    <div class="inline-actions">
      <button class="text-button" type="button" data-action="manual-price">輸入收盤價</button>
      <button class="text-button" type="button" data-action="stock-history">查看歷史</button>
    </div>`;
  setValueClass($('[data-pnl]', article), unrealized);
  setValueClass($('[data-realized]', article), position.realizedTradingPnl);
  setValueClass($('[data-return]', article), returnRate);
  setValueClass($('[data-change]', article), hasDailyChange ? dailyChange : null);
  return article;
}

function renderHoldingFilter(positions) {
  const select = $('#holding-stock-filter');
  if (!select) return;
  const validKeys = new Set(positions.map((position) => `${position.market}:${position.symbol}`));
  if (!validKeys.has(holdingStockFilter)) holdingStockFilter = '';
  select.replaceChildren(new Option('全部持股', ''));
  [...positions]
    .sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol))
    .forEach((position) => select.add(new Option(`${position.symbol} · ${latestName(position.market, position.symbol)}`, `${position.market}:${position.symbol}`)));
  select.value = holdingStockFilter;
}

function renderHoldings() {
  const holdingList = $('#holding-list');
  if (!holdingList) return;
  const book = safelyCalculateBook();
  const accountPositions = book.openPositions ?? [];
  const positions = combinedView ? combinePositions(accountPositions) : accountPositions;
  const quotes = getQuotes();
  renderHoldingFilter(positions);
  const fragment = document.createDocumentFragment();
  if (positions.length) {
    const allocation = $('#allocation-overview');
    if (allocation) {
      allocation.innerHTML = renderAllocationSummary(accountPositions);
      allocation.hidden = false;
      drawAllocationCharts(allocation);
    }
  }
  const visiblePositions = holdingStockFilter
    ? positions.filter((position) => `${position.market}:${position.symbol}` === holdingStockFilter)
    : positions;
  visiblePositions.forEach((position) => fragment.append(createHoldingCard(position, quotes)));
  holdingList.replaceChildren(fragment);
  if ($('#allocation-overview') && !positions.length) $('#allocation-overview').hidden = true;
  if ($('#holdings-empty')) {
    $('#holdings-empty').hidden = visiblePositions.length > 0;
    $('#holdings-empty').textContent = positions.length ? '找不到這檔持股。' : '還沒有持股。先到「記一筆」新增買入紀錄。';
  }
  renderTaiwanQuoteControls();
  renderTiingoControls();
}

$('#holding-stock-filter')?.addEventListener('change', (event) => {
  holdingStockFilter = event.target.value;
  renderHoldings();
});

$('#holding-list')?.addEventListener('change', (event) => {
  if (event.target.dataset.action !== 'holding-category') return;
  const card = event.target.closest('[data-holding-symbol]');
  saveInstrument({
    market: card.dataset.market,
    accountId: card.dataset.accountId,
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

// ── 台股官方每日收盤價（由 GitHub Actions 發布為同網域資料）─────────────

const twRefreshButton = $('#refresh-tw-prices');

function renderTaiwanQuoteControls() {
  const hasTaiwanHoldings = (safelyCalculateBook().openPositions ?? []).some((position) => position.market === 'TW');
  if (twRefreshButton) twRefreshButton.hidden = !hasTaiwanHoldings;
  const meta = $('#tw-quote-meta');
  if (meta) meta.hidden = !hasTaiwanHoldings;
  const cachedDates = Object.values(getQuotes())
    .filter((quote) => quote?.source === '臺灣證券交易所' || quote?.source === '證券櫃檯買賣中心')
    .map((quote) => quote.date)
    .filter(Boolean)
    .sort();
  const asOf = taiwanCatalogMeta?.asOf ?? cachedDates.at(-1);
  if ($('#tw-price-asof')) $('#tw-price-asof').textContent = asOf ? formatDate(asOf) : '尚未更新';
}

function describeTaiwanQuoteError(error) {
  if (error instanceof TaiwanQuoteError && error.code === 'HTTP_ERROR') {
    return '尚未找到台股行情檔。請先在 GitHub「Actions」執行一次「更新台股每日收盤價」。';
  }
  if (error instanceof TaiwanQuoteError) return '暫時無法取得台股收盤價，已保留上次成功更新的價格。';
  return '台股價格更新失敗，原有資料未被覆蓋。';
}

async function refreshTaiwanQuotes({ quiet = false, force = true } = {}) {
  if (refreshingTw) return;
  const positions = (safelyCalculateBook({ all: true }).openPositions ?? []).filter((position) => position.market === 'TW');
  if (!positions.length) {
    renderTaiwanQuoteControls();
    if (!quiet) setFeedback($('#quote-feedback'), '目前沒有台股持股可更新。', 'info');
    return;
  }
  if (twRefreshButton) twRefreshButton.disabled = true;
  refreshingTw = true;
  try {
    const payload = await loadTaiwanCatalog({ force });
    const quotes = getQuotes();
    let success = 0;
    for (const position of positions) {
      const official = payload.quotes[position.symbol];
      if (!official) continue;
      quotes[quoteKey('TW', position.symbol)] = {
        ...official,
        source: official.board === 'TPEx' ? '證券櫃檯買賣中心' : '臺灣證券交易所',
        fetchedAt: new Date().toISOString(),
      };
      saveInstrument({
        accountId: position.accountId,
        market: 'TW',
        symbol: position.symbol,
        name: official.name,
        assetType: official.kind,
        category: findInstrument('TW', position.symbol, position.accountId)?.category ?? '',
      }, { audit: false });
      success += 1;
    }
    if (success) {
      writeStoredJson(localStorage, STORAGE_KEYS.quotes, quotes);
      localStorage.setItem(TW_QUOTE_STORAGE.lastRefresh, String(Date.now()));
      renderHoldings();
      renderReports();
    }
    if (!quiet) {
      setFeedback(
        $('#quote-feedback'),
        success === positions.length
          ? `已更新 ${success} 檔台股的 ${formatDate(payload.asOf)} 收盤價。`
          : `已更新 ${success} 檔；另有 ${positions.length - success} 檔未在官方清單中找到。`,
        success ? 'success' : 'error',
      );
    }
  } catch (error) {
    if (!quiet) setFeedback($('#quote-feedback'), describeTaiwanQuoteError(error), 'error');
  } finally {
    refreshingTw = false;
    if (twRefreshButton) twRefreshButton.disabled = false;
    renderTaiwanQuoteControls();
  }
}

twRefreshButton?.addEventListener('click', () => refreshTaiwanQuotes());

async function maybeAutoRefreshTaiwanQuotes() {
  if (!navigator.onLine) return;
  try {
    await loadTaiwanCatalog();
    renderTaiwanQuoteControls();
    const hasMissing = safelyCalculateBook({ all: true }).openPositions.some((p) => p.market === 'TW' && !getQuote(p.market, p.symbol));
    if (hasMissing || Date.now() - Number(localStorage.getItem(TW_QUOTE_STORAGE.lastRefresh) || 0) >= 60 * 60 * 1000) {
      await refreshTaiwanQuotes({ quiet: true, force: false });
    } else {
      renderHoldings();
    }
  } catch {
    renderTaiwanQuoteControls();
  }
}

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
  return new Map((safelyCalculateBook({ all: true }).transactions ?? []).map((result) => [result.id, result]));
}

function recordKey(record) {
  const market = record.market || (record.currency === 'USD' ? 'US' : 'TW');
  return `${market}:${String(record.symbol ?? '').toUpperCase()}`;
}

function renderRecordFilter() {
  const select = $('#record-stock-filter');
  if (!select) return;
  const choices = new Map();
  [...scopedRecords('transactions'), ...scopedRecords('dividends')].forEach((record) => {
    if (!record.symbol) return;
    const key = recordKey(record);
    const [market, symbol] = key.split(':');
    choices.set(key, `${symbol} · ${latestName(market, symbol)}`);
  });
  if (!choices.has(recordStockFilter)) recordStockFilter = '';
  select.replaceChildren(new Option('全部股票', ''));
  [...choices.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-TW'))
    .forEach(([key, label]) => select.add(new Option(label, key)));
  select.value = recordStockFilter;
}

$('#record-stock-filter')?.addEventListener('change', (event) => {
  recordStockFilter = event.target.value;
  renderRecords();
});

function renderTradeRecords() {
  const list = $('#trade-record-list');
  if (!list) return;
  const results = resultById();
  const allRecords = [...scopedRecords('transactions')]
    .sort((a, b) => normalizeDate(b.date).localeCompare(normalizeDate(a.date)) || Number(b.sequence ?? 0) - Number(a.sequence ?? 0));
  const records = recordStockFilter ? allRecords.filter((record) => recordKey(record) === recordStockFilter) : allRecords;
  const template = $('#trade-record-item-template');
  const nodes = records.map((record) => {
    const article = template.content.firstElementChild.cloneNode(true);
    const result = results.get(record.id);
    article.dataset.tradeId = record.id;
    $('[data-field="date"]', article).textContent = `${formatDate(record.date)} · ${accountName(record.accountId)} · 當日順序 ${record.dayOrder ?? '未設定'}`;
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
  $('#trade-record-count').textContent = recordStockFilter ? `${records.length}／${allRecords.length} 筆` : `${records.length} 筆`;
  $('#trade-records-empty').hidden = records.length > 0;
  renderChangeHistory();
}

function renderChangeHistory() {
  const labels = { transactions: '交易', dividends: '股息', exchanges: '換匯' };
  const records = readCollection(localStorage, 'auditLog')
    .filter((entry) => inScope(entry.before || entry.after || {}))
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
  $('#trade-edit-order').value = record.dayOrder ?? 1;
  $('#trade-edit-account').replaceChildren(...getPreferences().accounts.map((a) => new Option(a.name, a.id)));
  $('#trade-edit-account').value = record.accountId || 'default';
  $('#trade-edit-fee-policy').value = 'keep';
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
  $('#trade-edit-category').value = findInstrument(record.market, record.symbol, record.accountId || 'default')?.category || '';
  $('#trade-edit-category').dataset.initial = $('#trade-edit-category').value;
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
    dayOrder: Number($('#trade-edit-order').value),
    accountId: $('#trade-edit-account').value,
    market,
    symbol,
    name: $('#trade-edit-name').value.trim() || symbol,
    side: $('#trade-edit-side').value,
    assetType: $('#trade-edit-asset-type').value,
    price,
    shares,
    brokerId,
    category: previous.category,
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
  const changedInputs = ['date','market','symbol','side','assetType','price','shares','brokerId'].some((key) => provisional[key] !== previous[key]);
  if (changedInputs && $('#trade-edit-fee-policy').value === 'keep' && !window.confirm('成交條件已修改。是否仍保留畫面中的實付費稅？按取消後可選「依目前券商設定重算」。')) return;
  const charges = calculateCharges(provisional);
  const recalculate = $('#trade-edit-fee-policy').value === 'recalculate';
  const updated = {
    ...provisional,
    feeOverride: recalculate || enteredFee === undefined ? charges.fee : enteredFee,
    taxOverride: recalculate || enteredTax === undefined ? charges.tax : enteredTax,
  };
  const next = records.map((item) => item.id === id ? updated : item);
  try {
    calculateBook(next, readCollection(localStorage, 'dividends'));
    atomicUpdate(localStorage, (draft) => {
      upsertRecord(draft, 'transactions', updated);
      const categoryChanged = $('#trade-edit-category').value !== $('#trade-edit-category').dataset.initial;
      saveInstrument({ accountId: updated.accountId, market, symbol, name: updated.name, assetType: updated.assetType, ...(categoryChanged ? { category: $('#trade-edit-category').value } : {}) }, { storage: draft });
    });
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
  const allRecords = [...scopedRecords('dividends')]
    .sort((a, b) => normalizeDate(b.date).localeCompare(normalizeDate(a.date)) || Number(b.sequence ?? 0) - Number(a.sequence ?? 0));
  const records = recordStockFilter ? allRecords.filter((record) => recordKey(record) === recordStockFilter) : allRecords;
  const template = $('#dividend-record-item-template');
  const nodes = records.map((record) => {
    const article = template.content.firstElementChild.cloneNode(true);
    article.dataset.dividendId = record.id;
    $('[data-field="date"]', article).textContent = formatDate(record.date);
    $('[data-field="symbol"]', article).textContent = record.symbol;
    $('[data-field="type"]', article).textContent = `${accountName(record.accountId)} · ${record.type === 'split' ? '股票分割／合併' : record.type === 'stock' ? '股票股利' : '現金股利'}`;
    $('[data-field="value"]', article).textContent = record.type === 'split' ? `股數 × ${record.factor}` : record.type === 'stock'
      ? `${numberFormatter.format(record.shares)} 股`
      : formatMoney(record.amount, record.currency || 'TWD');
    const notes = $('[data-field="notes"]', article);
    notes.textContent = record.notes || '無備註';
    notes.hidden = !record.notes;
    return article;
  });
  $('#dividend-record-list').replaceChildren(...nodes);
  $('#dividend-record-count').textContent = recordStockFilter ? `${records.length}／${allRecords.length} 筆` : `${records.length} 筆`;
  $('#dividend-records-empty').hidden = records.length > 0;
}

function editDividend(id) {
  const record = readCollection(localStorage, 'dividends').find((item) => item.id === id);
  if (!record) return;
  if (record.type === 'split') { showToast('分割紀錄如需修正，請刪除後重新新增；原內容會保留。', 'info'); return; }
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
    accountId: previous?.accountId || activeAccount(),
    dayOrder: previous?.dayOrder || nextDayOrder($('#dividend-date').value),
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
    atomicUpdate(localStorage, (draft) => {
      upsertRecord(draft, 'dividends', record);
      saveInstrument({ accountId: record.accountId, market: record.market, symbol: record.symbol, name: inferred.name, assetType: inferred.assetType }, { storage: draft });
    });
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
    accountId: previous?.accountId || activeAccount(),
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
  renderRecordFilter();
  renderTradeRecords();
  renderDividendRecords();
  renderFxRecords();
}

// ── 報表與個股歷史 ────────────────────────────────────────────────────────

let reportSelection = { mode: 'month', key: taipeiDateKey().slice(0, 7) };

function syncReportControls() {
  const monthControl = $('#report-month-control');
  const yearControl = $('#report-year-control');
  if (monthControl) monthControl.hidden = reportSelection.mode !== 'month';
  if (yearControl) yearControl.hidden = reportSelection.mode !== 'year';
  if ($('#report-month')) $('#report-month').value = reportSelection.mode === 'month' ? reportSelection.key : taipeiDateKey().slice(0, 7);
  if ($('#report-year')) $('#report-year').value = reportSelection.mode === 'year' ? reportSelection.key : taipeiDateKey().slice(0, 4);
  const label = reportSelection.mode === 'all'
    ? '全部期間'
    : reportSelection.mode === 'year'
      ? `${reportSelection.key} 年`
      : `${reportSelection.key.slice(0, 4)} 年 ${reportSelection.key.slice(5, 7)} 月`;
  if ($('#report-period-label')) $('#report-period-label').textContent = `目前顯示：${label}`;
}

function matchesReport(date) {
  const key = normalizeDate(date);
  if (reportSelection.mode === 'all') return true;
  if (reportSelection.mode === 'year') return key.startsWith(reportSelection.key);
  return key.startsWith(reportSelection.key);
}

function setBreakdown(element, rows, emptyText = '—') {
  element.replaceChildren();
  const visible = rows;
  if (!visible.length) {
    element.textContent = emptyText;
    element.classList.remove('is-profit', 'is-loss');
    return;
  }
  visible.forEach((row) => {
    const span = document.createElement('span');
    span.className = 'metric-line';
    span.textContent = !Number.isFinite(row.value) ? `${row.label || row.currency}：${row.message || '資料不足'}` : row.kind === 'percent'
      ? `${row.label} ${formatPercent(row.value, { signed: true })}`
      : formatMoney(row.value, row.currency, { signed: true });
    setValueClass(span, row.value);
    element.append(span);
  });
}

function renderReports() {
  syncReportControls();
  const book = safelyCalculateBook();
  if (book.error) {
    for (const selector of ['#report-realized','#report-dividends','#report-unrealized','#report-return']) $(selector).textContent = '帳本有錯誤，無法完整計算';
    $('#annualized-results').textContent = describeLedgerError(book.error);
    return;
  }
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
    const priced = positions.filter((position) => quoteUsable(getQuote(position.market, position.symbol, quotes), taipeiDateKey()));
    if (priced.length !== positions.length) return { currency, value: Number.NaN, message: `缺 ${positions.length - priced.length} 檔可用價格` };
    return {
      currency,
      value: priced.reduce((sum, position) => sum + Number(getQuote(position.market, position.symbol, quotes).close) * position.shares - position.costBasis, 0),
    };
  });
  setBreakdown($('#report-unrealized'), unrealizedRows, '尚無價格');
  $('#report-unrealized').nextElementSibling.textContent = '目前庫存估算，非所選月份／年底市值';

  const returnRows = currencies.map((currency) => {
    const matching = selected.filter((item) => item.currency === currency);
    const openPositions = (book.openPositions ?? []).filter((position) => position.currency === currency);
    const allOpenPriced = openPositions.every((position) => quoteUsable(getQuote(position.market, position.symbol, quotes), taipeiDateKey()));
    const soldCost = matching.reduce((sum, item) => sum + Number(item.allocatedCost || 0), 0);
    const openCost = openPositions.reduce((sum, position) => sum + position.costBasis, 0);
    const realized = matching.reduce((sum, item) => sum + Number(item.realizedPnl || 0), 0);
    if (reportSelection.mode !== 'all') return { label: currency, kind: 'percent', value: soldCost > 0 ? matching.reduce((sum, item) => sum + Number(item.realizedTradingPnl || 0), 0) / soldCost * 100 : NaN, message: '此期間尚無賣出配對成本' };
    if (openPositions.length && !allOpenPriced) return { label: currency, kind: 'percent', value: Number.NaN, message: '缺少完整持股價格' };
    const unrealized = allOpenPriced
      ? openPositions.reduce((sum, position) => sum + Number(getQuote(position.market, position.symbol, quotes)?.close) * position.shares - position.costBasis, 0)
      : 0;
    const denominator = soldCost + (allOpenPriced ? openCost : 0);
    return { label: currency, kind: 'percent', value: denominator > 0 ? ((realized + unrealized) / denominator) * 100 : Number.NaN };
  });
  setBreakdown($('#report-return'), returnRows, '尚無完整價格');
  $('#report-return').previousElementSibling.textContent = reportSelection.mode === 'all' ? '累計簡單報酬率' : '期間已售成本報酬率';
  $('#report-return').nextElementSibling.textContent = reportSelection.mode === 'all' ? '非年化；含股息與目前持股估值' : '期間已實現交易損益 ÷ 期間賣出配對成本';
  renderAnnualized(book, quotes);
}

function renderAnnualized(book, quotes) {
  const labels = { insufficient: '尚缺投入或回收資料', 'same-day': '所有現金流都在同一天', ambiguous: '現金流多次正負反轉，可能無唯一年化解；請參考金額與簡單報酬', 'out-of-range': '數值超出可靠計算範圍' };
  $('#annualized-results').innerHTML = ['TWD','USD'].map((currency) => {
    const result = investmentPerformance(book, quotes, currency, taipeiDateKey());
    if (result.status !== 'ok') return `<article class="report-card"><span>${currency} · 年化報酬率</span><p>${escapeHtml(result.status === 'missing-quotes' ? `缺少可用價格：${result.missing.join('、')}` : labels[result.status])}</p></article>`;
    const stale = result.quoteDates.some((d) => dateNumber(taipeiDateKey()) - dateNumber(d) > 4);
    return `<article class="report-card"><span>${currency} · ${result.annualized ? '年化報酬率（XIRR）' : '期間資金加權報酬率'}</span><strong class="${result.rate > 0 ? 'is-profit' : result.rate < 0 ? 'is-loss' : ''}">${formatPercent((result.annualized ? result.rate : result.periodRate) * 100)}</strong><small>自第一筆現金流至 ${escapeHtml(result.valuationDate)} · ${result.days} 天${stale ? ' · 含較舊行情' : ''}</small>${!result.annualized ? `<details><summary>未滿一年，查看年化換算</summary><p>${formatPercent(result.rate * 100)}（短期外推試算，不是未來預測）</p></details>` : ''}<p>${result.quoteDates.length ? `估值使用最近收盤價：${escapeHtml(result.quoteDates.join('、'))}；並非即時市值。` : '已無持股，不會重複加入賣出款。'}</p></article>`;
  }).join('');
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
    renderReports();
  });
});

$('#report-month')?.addEventListener('change', (event) => {
  if (!/^\d{4}-\d{2}$/.test(event.target.value)) return;
  reportSelection = { mode: 'month', key: event.target.value };
  renderReports();
});

$('#report-year')?.addEventListener('change', (event) => {
  const year = Number(event.target.value);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return;
  reportSelection = { mode: 'year', key: String(year) };
  renderReports();
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
  const position = combinePositions(book.positions ?? []).find((item) => item.market === market && item.symbol === symbol);
  const currency = market === 'US' ? 'USD' : 'TWD';
  const soldCost = events.reduce((sum, item) => sum + Number(item.allocatedCost || 0), 0);
  const realized = position?.realizedTradingPnl ?? 0;
  fields.shares.textContent = `${numberFormatter.format(position?.shares ?? 0)} 股`;
  fields['average-cost'].textContent = formatMoney(position?.averageCost ?? 0, currency);
  fields['realized-pnl'].textContent = formatMoney(realized, currency, { signed: true });
  fields.return.textContent = soldCost > 0 ? formatPercent((realized / soldCost) * 100, { signed: true }) : '尚無賣出';
  setValueClass(fields['realized-pnl'], realized);
  setValueClass(fields.return, soldCost > 0 ? realized : 0);
  const cycles = new Map();
  const html = events.map((item) => {
    let { cycle, previousShares } = cycles.get(item.accountId) || { cycle: 0, previousShares: 0 };
    if (item.type === 'trade' && item.side === 'buy' && previousShares === 0) cycle += 1;
    const cycleLabel = cycle ? `第 ${cycle} 輪` : '股息';
    previousShares = item.sharesAfter;
    cycles.set(item.accountId, { cycle, previousShares });
    const title = item.type === 'trade'
      ? `${item.side === 'buy' ? '買入' : '賣出'} ${numberFormatter.format(item.shares)} 股${item.price ? ` @ ${formatMoney(item.price, currency)}` : ''}`
      : item.type === 'split' ? `股票分割／合併 × ${item.factor}` : item.type === 'stockDividend' ? `股票股利 ${numberFormatter.format(item.shares)} 股` : `現金股利 ${formatMoney(item.cashDividendIncome, currency)}`;
    const pnl = item.side === 'sell' || item.type === 'cashDividend' ? `${formatMoney(item.realizedPnl, currency, { signed: true })} · ${formatPercent(item.returnRate, { signed: true })}` : '—';
    return `<article class="history-event"><div><time>${formatDate(item.date)}</time><span>${escapeHtml(accountName(item.accountId))} · ${cycleLabel}</span></div><h3>${escapeHtml(title)}</h3><dl><div><dt>此帳戶交易後股數</dt><dd>${numberFormatter.format(item.sharesAfter)}</dd></div><div><dt>此帳戶交易後均價</dt><dd>${formatMoney(item.averageCostAfter, currency)}</dd></div><div><dt>該筆已實現／報酬率</dt><dd class="${item.realizedPnl > 0 ? 'is-profit' : item.realizedPnl < 0 ? 'is-loss' : ''}">${pnl}</dd></div></dl></article>`;
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
  const preferences = getPreferences();
  for (const market of ['TW', 'US']) {
    const select = $(`#default-broker-${market.toLowerCase()}`);
    if (!select) continue;
    const supported = getBrokers().filter((broker) => brokerSupports(broker, market));
    const current = preferences.defaultBrokers[market];
    select.replaceChildren();
    supported.forEach((broker) => select.add(new Option(broker.name, broker.id)));
    select.add(new Option('＋ 新增券商…', '__new__'));
    select.value = supported.some((broker) => broker.id === current)
      ? current
      : supported[0]?.id ?? '__new__';
  }
  renderSelectedBrokerRates();
}

function describeUsFee(settings) {
  if (settings.model === 'perShare') return `每股 US$${currencyFormatters.USD.format(settings.perShareFee || 0)}`;
  if (settings.model === 'percentage') return `成交額 ${percentFormatter.format((settings.percentageRate || 0) * 100)}%`;
  return `每筆 US$${currencyFormatters.USD.format(settings.fixedFee || 0)}`;
}

function renderSelectedBrokerRates() {
  const twBroker = getBrokers().find((item) => item.id === $('#default-broker-tw')?.value) ?? getDefaultBroker('TW');
  const usBroker = getBrokers().find((item) => item.id === $('#default-broker-us')?.value) ?? getDefaultBroker('US');
  const tw = getFeeSettings(twBroker, 'TW');
  const us = getFeeSettings(usBroker, 'US');
  $('#tw-standard-fee-rate').value = (tw.standardFeeRate * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  $('#tw-fee-discount').value = (tw.discount * 10).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  $('#tw-min-fee').value = tw.minimumFee;
  const tax = getPreferences().taxRates;
  $('#tw-stock-tax-rate').value = tax.stock * 100;
  $('#tw-etf-tax-rate').value = tax.etf * 100;
  $('#tw-day-trade-tax-rate').value = tax.dayTrade * 100;
  $('#us-fee-mode').value = us.model === 'perShare' ? 'per-share' : us.model === 'percentage' ? 'percent' : 'fixed';
  $('#us-fee-rate').value = us.model === 'perShare' ? us.perShareFee : us.model === 'percentage' ? us.percentageRate * 100 : us.fixedFee;
  $('#us-min-fee').value = us.minimumFee;
  $('#us-sell-fee-rate').value = (us.sellFeeRate || 0) * 100;
  $('#us-sell-min-fee').value = us.sellMinimumFee || 0;
  $('#us-additional-fixed').value = us.additionalFixedFee || 0;
  $('#us-additional-share').value = us.additionalPerShareFee || 0;
  $('#us-sell-share').value = us.sellPerShareFee || 0;
  $('[data-field="tw-fee-summary"]', $('#broker-fee-summary')).textContent = `${(tw.standardFeeRate * 100).toFixed(4)}% × ${(tw.discount * 10).toFixed(1)} 折`;
  $('[data-field="tw-min-fee-summary"]', $('#broker-fee-summary')).textContent = formatMoney(tw.minimumFee, 'TWD');
  $('[data-field="tw-stock-tax-summary"]', $('#broker-fee-summary')).textContent = `${(tax.stock * 100).toFixed(2).replace(/0$/, '')}%`;
  $('[data-field="tw-etf-day-tax-summary"]', $('#broker-fee-summary')).textContent = `${(tax.etf * 100).toFixed(2).replace(/0$/, '')}%／${(tax.dayTrade * 100).toFixed(2).replace(/0$/, '')}%`;
  $('[data-field="us-fee-summary"]', $('#broker-fee-summary')).textContent = describeUsFee(us);
  $('[data-field="us-min-fee-summary"]', $('#broker-fee-summary')).textContent = formatMoney(us.minimumFee || 0, 'USD');
  $('[data-field="us-sell-fee-summary"]', $('#broker-fee-summary')).textContent = `成交額 ${percentFormatter.format((us.sellFeeRate || 0) * 100)}%`;
  $('[data-field="us-sell-min-fee-summary"]', $('#broker-fee-summary')).textContent = formatMoney(us.sellMinimumFee || 0, 'USD');
}

function openBrokerDialog({ broker = null, market = 'TW' } = {}) {
  $('#broker-form').reset();
  const editing = broker ?? null;
  $('#broker-id').value = editing?.id ?? '';
  $('#broker-name').value = editing?.name ?? '';
  $('#broker-market-tw').checked = editing ? brokerSupports(editing, 'TW') : market === 'TW';
  $('#broker-market-us').checked = editing ? brokerSupports(editing, 'US') : market === 'US';
  const tw = getFeeSettings(editing, 'TW');
  $('#broker-tw-rate').value = tw.standardFeeRate * 100;
  $('#broker-tw-discount').value = tw.discount * 10;
  $('#broker-tw-min-fee').value = tw.minimumFee;
  const us = getFeeSettings(editing, 'US');
  $('#broker-us-fee-mode').value = us.model === 'perShare' ? 'per-share' : us.model === 'percentage' ? 'percent' : 'fixed';
  $('#broker-us-fee-rate').value = us.model === 'perShare' ? us.perShareFee : us.model === 'percentage' ? us.percentageRate * 100 : us.fixedFee;
  $('#broker-us-min-fee').value = us.minimumFee;
  $('#broker-us-sell-fee-rate').value = (us.sellFeeRate || 0) * 100;
  $('#broker-us-sell-min-fee').value = us.sellMinimumFee || 0;
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

for (const market of ['TW', 'US']) {
  $(`#default-broker-${market.toLowerCase()}`)?.addEventListener('change', (event) => {
    if (event.target.value === '__new__') {
      openBrokerDialog({ market });
      event.target.value = getPreferences().defaultBrokers[market];
      return;
    }
    const broker = getBrokers().find((item) => item.id === event.target.value);
    if (!broker) return;
    const preferences = getPreferences();
    preferences.defaultBrokers[market] = broker.id;
    savePreferences(preferences);
    renderSelectedBrokerRates();
    setFeedback($('#broker-feedback'), `${market === 'TW' ? '台股' : '美股'}新交易會套用「${broker.name}」；舊交易費稅不會改寫。`, 'success');
  });
}

$('#manage-brokers')?.addEventListener('click', () => {
  const selected = getBrokers().find((broker) => broker.id === $('#default-broker-tw').value);
  openBrokerDialog({ broker: selected, market: 'TW' });
});

$('#manage-us-brokers')?.addEventListener('click', () => {
  const selected = getBrokers().find((broker) => broker.id === $('#default-broker-us').value);
  openBrokerDialog({ broker: selected, market: 'US' });
});

$('#broker-fee-save')?.addEventListener('click', () => {
  const id = $('#default-broker-tw').value;
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

$('#us-broker-fee-save')?.addEventListener('click', () => {
  const id = $('#default-broker-us').value;
  const broker = getBrokers().find((item) => item.id === id);
  if (!broker) return;
  const modeValue = $('#us-fee-mode').value;
  const rate = toNonNegativeNumber($('#us-fee-rate').value, null);
  const minimumFee = toNonNegativeNumber($('#us-min-fee').value, null);
  const sellRate = toNonNegativeNumber($('#us-sell-fee-rate').value, null);
  const sellMinimumFee = toNonNegativeNumber($('#us-sell-min-fee').value, null);
  if ([rate, minimumFee, sellRate, sellMinimumFee].some((value) => value === null) || (modeValue === 'percent' && rate > 100) || sellRate > 100) {
    setFeedback($('#broker-feedback'), '請檢查美股手續費、最低費與賣出稅費率。', 'error');
    return;
  }
  const model = modeValue === 'per-share' ? 'perShare' : modeValue === 'percent' ? 'percentage' : 'fixed';
  const settings = {
    ...getFeeSettings(broker, 'US'),
    model,
    fixedFee: model === 'fixed' ? rate : 0,
    perShareFee: model === 'perShare' ? rate : 0,
    percentageRate: model === 'percentage' ? rate / 100 : 0,
    minimumFee,
    sellFeeRate: sellRate / 100,
    sellMinimumFee,
    additionalFixedFee: toNonNegativeNumber($('#us-additional-fixed').value, 0),
    additionalPerShareFee: toNonNegativeNumber($('#us-additional-share').value, 0),
    sellPerShareFee: toNonNegativeNumber($('#us-sell-share').value, 0),
  };
  try {
    calculateTradeFee({ market: 'US', price: 100, shares: 1, settings });
  } catch (error) {
    setFeedback($('#broker-feedback'), describeLedgerError(error), 'error');
    return;
  }
  upsertRecord(localStorage, 'brokers', { ...broker, us: settings });
  renderSettings();
  setFeedback($('#broker-feedback'), '美股手續費與賣出稅費已儲存，只套用到之後新增或重新試算的交易。', 'success');
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
  const usSellRate = toNonNegativeNumber($('#broker-us-sell-fee-rate').value, 0);
  const usSellMin = toNonNegativeNumber($('#broker-us-sell-min-fee').value, 0);
  const twRate = toNonNegativeNumber($('#broker-tw-rate').value, 0.1425);
  const twDiscount = toNonNegativeNumber($('#broker-tw-discount').value, 10);
  const twMin = toNonNegativeNumber($('#broker-tw-min-fee').value, 20);
  if (
    [usRate, usMin, usSellRate, usSellMin, twRate, twDiscount, twMin].some((value) => value === null) ||
    twDiscount > 10 || twRate > 100 || usSellRate > 100 || (modeValue === 'percent' && usRate > 100)
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
      sellFeeRate: usSellRate / 100,
      sellMinimumFee: usSellMin,
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
  const preferences = getPreferences();
  const categories = preferences.categories;
  $('#category-preview').replaceChildren(...categories.map((category) => {
    const span = document.createElement('span');
    span.textContent = category;
    return span;
  }));
  const rows = categories.map((category) => {
    const row = document.createElement('div');
    row.className = 'category-row';
    row.dataset.categoryId = category;
    const signals = preferences.categorySignals?.[category] ?? {};
    const fields = [
      ['profitReturn', '獲利報酬達到', '例如 15'],
      ['lossReturn', '虧損報酬達到', '例如 10'],
      ['riseChange', '單日上漲達到', '例如 5'],
      ['fallChange', '單日下跌達到', '例如 5'],
    ];
    const content = document.createElement('div');
    content.className = 'category-row__content';
    const top = document.createElement('div');
    top.className = 'category-row__top';
    const label = document.createElement('span');
    label.className = 'category-row__name';
    label.textContent = category;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'delete-category';
    button.textContent = '刪除';
    button.setAttribute('aria-label', `刪除${category}分類`);
    top.append(label, button);
    const grid = document.createElement('div');
    grid.className = 'category-alert-grid';
    for (const [key, fieldLabel, placeholder] of fields) {
      const field = document.createElement('div');
      field.className = 'category-alert-field';
      const id = `category-signal-${categories.indexOf(category)}-${key}`;
      field.innerHTML = `<label for="${id}">${fieldLabel}（%）</label><input id="${id}" type="number" min="0" step="0.1" inputmode="decimal" placeholder="${placeholder}" data-signal-key="${key}" value="${escapeHtml(signals[key] ?? '')}"><small>留白代表關閉</small>`;
      grid.append(field);
    }
    content.append(top, grid);
    row.append(content);
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
  renderTradeCategoryOptions();
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
  if (preferences.categorySignals) delete preferences.categorySignals[name];
  savePreferences(preferences);
  const instruments = readCollection(localStorage, 'instruments').map((item) => item.category === name ? { ...item, category: '' } : item);
  saveCollection(localStorage, 'instruments', instruments);
  renderCategories();
  renderHoldings();
  renderTradeCategoryOptions();
});

$('#category-list')?.addEventListener('change', (event) => {
  const input = event.target.closest('[data-signal-key]');
  const row = input?.closest('[data-category-id]');
  if (!input || !row) return;
  const value = toOptionalNonNegativeNumber(input.value);
  if (Number.isNaN(value) || value === 0 || value > 1000) {
    setFeedback($('#category-feedback'), '提醒門檻請填大於 0、最多 1000 的百分比，或留白關閉。', 'error');
    renderCategories();
    return;
  }
  const preferences = getPreferences();
  preferences.categorySignals ??= {};
  preferences.categorySignals[row.dataset.categoryId] ??= {};
  preferences.categorySignals[row.dataset.categoryId][input.dataset.signalKey] = value;
  savePreferences(preferences);
  setFeedback($('#category-feedback'), `「${row.dataset.categoryId}」提醒門檻已儲存。`, 'success');
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
    validateBackup(payload);
    calculateBook(payload.data.transactions, payload.data.dividends);
    calculateFxBook(payload.data.exchanges);
    if (!window.confirm('匯入會以備份內容覆蓋目前紀錄。程式會先在這台裝置保留一份匯入前快照，確定繼續？')) return;
    localStorage.setItem(PRE_IMPORT_BACKUP_KEY, JSON.stringify(beforeImport));
    restoreBackup(localStorage, payload, { mode: 'replace' });
    replaced = true;
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

$('#restore-pre-import')?.addEventListener('click', () => {
  try {
    const raw = localStorage.getItem(PRE_IMPORT_BACKUP_KEY);
    if (!raw) { setFeedback($('#backup-feedback'), '目前沒有匯入前快照。', 'info'); return; }
    const payload = validateBackup(JSON.parse(raw));
    calculateBook(payload.data.transactions, payload.data.dividends);
    calculateFxBook(payload.data.exchanges);
    if (!window.confirm('以最近一次匯入前快照還原？建議先匯出目前資料。')) return;
    restoreBackup(localStorage, payload);
    renderAll();
    setFeedback($('#backup-feedback'), '已還原匯入前快照。', 'success');
  } catch (error) { setFeedback($('#backup-feedback'), error.message, 'error'); }
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
    return;
  }
  setConnectionStatus(token ? '已存 Token；連線狀態以測試結果為準' : '尚未連接', token ? 'connected' : 'disconnected');
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
  if (refreshingUs) return;
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
  const symbols = [...new Set((safelyCalculateBook({ all: true }).openPositions ?? []).filter((position) => position.market === 'US').map((position) => position.symbol))];
  if (!symbols.length) {
    if (!quiet) setFeedback($('#quote-feedback'), '目前沒有美股持股可更新。', 'info');
    return;
  }
  refreshButton.disabled = true;
  refreshingUs = true;
  let success = 0;
  const failures = [];
  for (const rawSymbol of symbols) {
    try {
      const symbol = normalizeTiingoSymbol(rawSymbol);
      const quote = await fetchLatestTiingoClose(symbol, token, { relayUrl: getRelay() });
      const quotes = getQuotes();
      const splitEvents = readCollection(localStorage, 'dividends').filter((r) => r.type === 'split' && r.market === 'US' && r.symbol === symbol);
      const unconfirmed = quote.splits?.some((split) => safelyCalculateBook({ all: true }).openPositions.some((p) => p.market === 'US' && p.symbol === symbol && !splitEvents.some((e) => (e.accountId || 'default') === p.accountId && e.date === split.date && Number(e.factor) === split.factor)));
      quote.needsSplitReview = Boolean(unconfirmed || quotes[quoteKey('US', symbol)]?.needsSplitReview);
      quotes[quoteKey('US', symbol)] = quote;
      writeStoredJson(localStorage, STORAGE_KEYS.quotes, quotes);
      success += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (success) {
    localStorage.setItem(TIINGO_STORAGE.lastRefresh, String(Date.now()));
    renderHoldings();
    renderReports();
  }
  refreshButton.disabled = false;
  refreshingUs = false;
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
    await validateTiingoToken(token, { relayUrl: getRelay() });
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
  const missing = safelyCalculateBook({ all: true }).openPositions.some((p) => p.market === 'US' && !getQuote(p.market, p.symbol));
  if (!missing && Date.now() - Number(localStorage.getItem(TIINGO_STORAGE.lastRefresh) || 0) < 60 * 60 * 1000) return;
  refreshUsQuotes({ quiet: true });
}

window.addEventListener('online', maybeAutoRefresh);
window.addEventListener('online', maybeAutoRefreshTaiwanQuotes);

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
  showView('reports');
  showToast(`已開啟 ${previousMonth} 月報；本月只會自動顯示一次。`, 'info');
}

function renderAll() {
  renderAccounts();
  renderHoldings();
  renderRecords();
  renderReports();
  renderSettings();
  renderHistoryOptions();
  renderAssets();
}

function renderAccounts() {
  $('#account-select').replaceChildren(...getPreferences().accounts.map((a) => new Option(a.name, a.id)));
  $('#account-select').value = activeAccount();
  $('#combined-view').setAttribute('aria-pressed', String(combinedView));
  $('#combined-view').textContent = combinedView ? '返回分帳' : '合併檢視';
  $('#account-scope-note').textContent = combinedView ? `顯示全部帳戶；新增仍記入「${accountName(activeAccount())}」` : `分帳檢視 · ${accountName(activeAccount())}`;
}
$('#account-select')?.addEventListener('change', (event) => {
  savePreferences({ ...getPreferences(), defaultAccountId: event.target.value });
  combinedView = false; resetDividendForm(); resetFxForm(); renderAll();
});
$('#combined-view')?.addEventListener('click', () => { combinedView = !combinedView; renderAll(); });
$('#account-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#account-name').value.trim(); if (!name) return;
  const preferences = getPreferences();
  if (preferences.accounts.some((a) => a.name === name)) { showToast('已有相同帳戶名稱。', 'error'); return; }
  const account = { id: createRecordId('account'), name };
  preferences.accounts.push(account); preferences.defaultAccountId = account.id;
  savePreferences(preferences); combinedView = false; $('#account-form').reset(); renderAll();
});

$('#split-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const inferred = inferInstrument($('#split-symbol').value);
    const record = { id: createRecordId('split'), accountId: activeAccount(), type: 'split', market: inferred.market, symbol: inferred.symbol, date: $('#split-date').value, factor: Number($('#split-factor').value), dayOrder: Number($('#split-order').value), sequence: Date.now() };
    const records = readCollection(localStorage, 'dividends');
    if (records.some((r) => r.type === 'split' && r.date === record.date && r.symbol === record.symbol && r.market === record.market && (r.accountId || 'default') === record.accountId)) throw new Error('同帳戶／股票／日期已有分割事件，請先核對。');
    calculateBook(readCollection(localStorage, 'transactions'), [...records, record]);
    atomicUpdate(localStorage, (draft) => {
      upsertRecord(draft, 'dividends', record);
      const quotes = readStoredJson(draft, STORAGE_KEYS.quotes, {});
      const key = quoteKey(record.market, record.symbol);
      if (quotes[key]) {
        // Other accounts may still need their split event; confirm every held account.
        const events = [...records, record];
        const pending = (quotes[key].splits || []).some((s) => calculateBook().openPositions.some((p) => p.symbol === record.symbol && p.market === record.market && !events.some((e) => e.type === 'split' && e.symbol === p.symbol && e.market === p.market && (e.accountId || 'default') === p.accountId && e.date === s.date && e.factor === s.factor)));
        quotes[key].needsSplitReview = pending;
        writeStoredJson(draft, STORAGE_KEYS.quotes, quotes);
      }
    });
    renderAll(); setFeedback($('#split-feedback'), '已記錄分割，股數與平均成本已重算。可到股息紀錄查看或刪除。', 'success');
  } catch (error) { setFeedback($('#split-feedback'), describeLedgerError(error), 'error'); }
});

const ASSET_BUCKETS = ['台股','美股','債券','現金','其他'];
function renderAssets() {
  const preferences = getPreferences(); const quotes = getQuotes(); const book = safelyCalculateBook();
  const rows = new Map(ASSET_BUCKETS.map((c) => [c, 0])); const warnings = []; const blockers = [];
  const rate = Number(preferences.valuationFx?.rate); const dates = [];
  const add = (category, value, currency, date, name) => {
    if (currency === 'USD' && !(rate > 0)) { blockers.push(`${name} 缺美元估值匯率`); return; }
    rows.set(category, (rows.get(category) || 0) + value * (currency === 'USD' ? rate : 1));
    if (date) dates.push(date);
  };
  for (const p of book.openPositions) {
    const quote = getQuote(p.market, p.symbol, quotes);
    if (!quoteUsable(quote, taipeiDateKey())) { blockers.push(`${p.symbol} 缺可用股價`); continue; }
    const type = findInstrument(p.market, p.symbol, p.accountId)?.assetType || quote.kind;
    add(type === 'bondetf' ? '債券' : p.market === 'US' ? '美股' : '台股', quote.close * p.shares, p.currency, quote.date, p.symbol);
  }
  const assets = scopedRecords('assets');
  for (const a of assets) add(a.category, a.value, a.currency, a.date, a.name);
  if (book.error) blockers.push('帳本計算錯誤');
  if (!assets.some((a) => a.category === '現金')) warnings.push('尚未填寫現金餘額，不能視為完整總資產');
  const old = dates.filter((d) => dateNumber(taipeiDateKey()) - dateNumber(d) > 7);
  if (old.length) warnings.push('含超過 7 天的價格或餘額，請對帳更新');
  if (rate > 0 && preferences.valuationFx?.date) warnings.push(`美元估值：${rate}，日期 ${preferences.valuationFx.date}（手動）`);
  const chartRows = [...rows].map(([category, amount]) => ({ category, amount }));
  const total = chartRows.reduce((sum, r) => sum + r.amount, 0);
  $('#asset-total').textContent = `${blockers.length ? '已知部分 ' : ''}${formatMoney(total, 'TWD')}`;
  $('#asset-completeness').textContent = [...blockers, ...warnings, '僅涵蓋已輸入的資產；不含未記錄資產或負債。'].join('；');
  $('#asset-pie').innerHTML = total > 0 ? `<div class="allocation-card__body"><div class="allocation-pie"><canvas width="240" height="240" data-pie-values="${chartRows.map((r) => r.amount).join(',')}" data-pie-count="${chartRows.filter((r) => r.amount > 0).length}" role="img" aria-label="已記錄資產市值配置圓餅圖"></canvas></div><ul class="allocation-legend">${chartRows.map((r, i) => `<li class="allocation-legend-item"><span class="allocation-swatch allocation-swatch--${i}"></span><span>${escapeHtml(r.category)}</span><strong>${formatPercent(r.amount / total * 100)}</strong></li>`).join('')}</ul></div>` : '<p>先新增股票、現金或其他資產，這裡就會出現配置圖。</p>';
  drawAllocationCharts($('#asset-pie'));
  $('#asset-list').innerHTML = assets.map((a) => `<article class="record-item"><h4>${escapeHtml(a.name)} · ${escapeHtml(accountName(a.accountId))}</h4><p>${formatMoney(a.value, a.currency)} · ${escapeHtml(a.category)} · ${escapeHtml(a.date)}</p><button type="button" class="text-button" data-edit-asset="${escapeHtml(a.id)}">更新餘額</button> <button type="button" class="text-button" data-delete-asset="${escapeHtml(a.id)}">刪除</button></article>`).join('');
  if (!$('#allocation-target-fields').children.length) $('#allocation-target-fields').innerHTML = ASSET_BUCKETS.map((c, i) => `<div class="field"><label for="target-${i}">${c}目標（%）</label><input id="target-${i}" data-target-category="${c}" type="number" min="0" max="100" step="any" required value="${Number(preferences.allocationTargets[c] || 0)}"></div>`).join('');
  const advice = allocationAdvice(chartRows, preferences.allocationTargets, preferences.allocationTolerance);
  $('#allocation-advice').innerHTML = blockers.length || !assets.some((a) => a.category === '現金') ? '<p>先補齊股價、匯率與現金餘額（沒有現金可填 0），再計算調整差額。</p>' : advice.status === 'invalid-targets' ? '<p>請選擇範例或自行填寫合計 100% 的目標比例，再按套用。</p>' : advice.rows.map((r) => `<article class="record-item${r.alert ? ' has-signal' : ''}"><h4>${escapeHtml(r.category)} · ${formatPercent(r.weight)} / 目標 ${formatPercent(r.target)}</h4><p>${r.alert ? '超過你的容許偏差；' : '在容許偏差內；'}${r.adjustment >= 0 ? '距目標可增加' : '距目標可減少'} ${formatMoney(Math.abs(r.adjustment), 'TWD')}（未計費稅）</p></article>`).join('');
  if (!$('#asset-date').value) $('#asset-date').value = taipeiDateKey();
  if (!$('#valuation-fx').value && rate > 0) $('#valuation-fx').value = rate;
  if (!$('#valuation-fx-date').value) $('#valuation-fx-date').value = preferences.valuationFx?.date || taipeiDateKey();
}
$('#asset-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const old = readCollection(localStorage, 'assets').find((a) => a.id === $('#asset-id').value);
    const value = toNonNegativeNumber($('#asset-value').value, null); if (value === null) throw new Error('請填正確金額');
    dateNumber($('#asset-date').value);
    if ($('#asset-date').value > taipeiDateKey()) throw new Error('資產餘額不可填未來日期');
    upsertRecord(localStorage, 'assets', { id: old?.id || createRecordId('asset'), accountId: old?.accountId || activeAccount(), name: $('#asset-name').value.trim(), category: $('#asset-category').value, currency: $('#asset-currency').value, value, date: $('#asset-date').value });
    $('#asset-form').reset(); $('#asset-id').value = ''; renderAssets(); showToast('資產餘額已儲存。');
  } catch (error) { setFeedback($('#asset-feedback'), error.message, 'error'); }
});
$('#asset-cancel')?.addEventListener('click', () => { $('#asset-form').reset(); $('#asset-id').value = ''; renderAssets(); });
$('#asset-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('button'); if (!button) return;
  const id = button.dataset.editAsset || button.dataset.deleteAsset;
  const asset = readCollection(localStorage, 'assets').find((a) => a.id === id); if (!asset) return;
  if (button.dataset.deleteAsset) { if (window.confirm('刪除這筆資產餘額？原資料保留在變更紀錄中。')) { removeRecord(localStorage, 'assets', id); renderAssets(); } return; }
  for (const field of ['id','name','category','currency','value','date']) $(`#asset-${field}`).value = asset[field];
});
$('#valuation-fx-form')?.addEventListener('submit', (event) => {
  event.preventDefault(); const rate = toPositiveNumber($('#valuation-fx').value);
  if (!rate || $('#valuation-fx-date').value > taipeiDateKey()) return;
  savePreferences({ ...getPreferences(), valuationFx: { rate, date: $('#valuation-fx-date').value, source: '使用者手動估值匯率' } }); renderAssets();
});
$('#allocation-example')?.addEventListener('change', (event) => {
  const values = event.target.value.split(',').map(Number);
  if (!event.target.value) return;
  $$('[data-target-category]').forEach((input, i) => { input.value = values[i] || 0; });
});
$('#allocation-form')?.addEventListener('submit', (event) => {
  event.preventDefault(); const targets = Object.fromEntries($$('[data-target-category]').map((input) => [input.dataset.targetCategory, Number(input.value)]));
  if (allocationAdvice([], targets).status === 'invalid-targets') { setFeedback($('#asset-feedback'), '目標比例合計必須為 100%。', 'error'); return; }
  savePreferences({ ...getPreferences(), allocationTargets: targets, allocationTolerance: Number($('#allocation-tolerance').value) }); renderAssets(); setFeedback($('#asset-feedback'), '已套用你的配置目標。', 'success');
});

function getRelay() { return localStorage.getItem('stock-journal:tiingo-relay:v1') || ''; }
$('#save-relay')?.addEventListener('click', () => {
  try {
    const url = normalizeRelayUrl($('#tiingo-relay').value);
    if (url && !window.confirm(`Tiingo Token 會經過 ${url}。請確認這是你自己部署並信任的中繼。`)) return;
    localStorage.setItem('stock-journal:tiingo-relay:v1', url);
    setFeedback(tokenFeedback, url ? `中繼已設定：${url}；請重新測試 Token。` : '改回直接連線。', 'info');
  } catch (error) { setFeedback(tokenFeedback, error.message, 'error'); }
});

try {
  ensureInitialData(); migrateTransactions(); migrateDayOrders();
  resetDividendForm(); resetFxForm(); renderAll(); updateTradeInstrumentPreview();
  maybeShowMonthlyReport(); maybeAutoRefresh(); maybeAutoRefreshTaiwanQuotes();
} catch (error) {
  $('#main-content').innerHTML = `<section class="settings-card"><h2>已停止寫入，請先保護資料</h2><p>${escapeHtml(error.message)}</p><p>不要清除瀏覽器資料。原始內容仍保留在裝置，請先下載給自己保管，再處理備份還原。</p><button class="secondary-button" id="download-recovery" type="button">下載原始資料（不含 Token）</button></section>`;
  document.getElementById('download-recovery').addEventListener('click', () => downloadJson(Object.fromEntries([DOCUMENT_KEY, ...Object.values(STORAGE_KEYS)].map((k) => [k, localStorage.getItem(k)])), `原始帳本救援-${taipeiDateKey()}.json`));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { maybeAutoRefreshTaiwanQuotes(); maybeAutoRefresh(); } });
window.addEventListener('storage', (event) => { if (event.key === DOCUMENT_KEY) showToast('另一個分頁更新了帳本，請重新整理後再記帳。', 'info'); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 私密瀏覽若禁止 Service Worker，記帳與本機儲存仍可正常使用。
    });
  });
}
