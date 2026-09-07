export const TW_QUOTES_DATA_URL = './data/tw-quotes.json';
export const TW_QUOTES_FORMAT = 'taiwan-official-daily-close';
export const TW_QUOTES_VERSION = 1;

const SUPPORTED_SYMBOL = /^(?:\d{4}[A-Z]?|00[A-Z0-9]{2,6}|9\d{5})$/;

export class TaiwanQuoteError extends Error {
  constructor(message, code = 'TW_QUOTE_ERROR') {
    super(message);
    this.name = 'TaiwanQuoteError';
    this.code = code;
  }
}

export function rocDateToIso(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const yearDigits = digits.length - 4;
  const year = Number(digits.slice(0, yearDigits)) + 1911;
  const month = Number(digits.slice(yearDigits, yearDigits + 2));
  const day = Number(digits.slice(yearDigits + 2));
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isSupportedTaiwanSymbol(value) {
  return SUPPORTED_SYMBOL.test(String(value ?? '').trim().toUpperCase());
}

function numericPrice(value) {
  const number = Number(String(value ?? '').replaceAll(',', '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

function numericChange(value) {
  const normalized = String(value ?? '').replaceAll(',', '').trim();
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeRow(row, board) {
  if (!row || typeof row !== 'object') return null;
  const isTwse = board === 'TWSE';
  const symbol = String(isTwse ? row.Code : row.SecuritiesCompanyCode).trim().toUpperCase();
  if (!isSupportedTaiwanSymbol(symbol)) return null;
  const name = String(isTwse ? row.Name : row.CompanyName).trim();
  const close = numericPrice(isTwse ? row.ClosingPrice : row.Close);
  const change = numericChange(row.Change);
  const date = rocDateToIso(row.Date);
  if (!name || close === null || !date) return null;
  const previousClose = change === null ? null : close - change;
  const changePercent = previousClose !== null && previousClose > 0
    ? (change / previousClose) * 100
    : null;
  return {
    symbol,
    name,
    close,
    change,
    changePercent,
    date,
    board,
    kind: symbol.startsWith('00') ? 'etf' : 'stock',
  };
}

export function buildTaiwanQuotePayload(twseRows, tpexRows, now = new Date()) {
  if (!Array.isArray(twseRows) || !Array.isArray(tpexRows)) {
    throw new TaiwanQuoteError('官方台股資料格式不正確。', 'INVALID_OFFICIAL_DATA');
  }
  const quoteMap = new Map();
  for (const row of twseRows) {
    const quote = normalizeRow(row, 'TWSE');
    if (quote) quoteMap.set(quote.symbol, quote);
  }
  for (const row of tpexRows) {
    const quote = normalizeRow(row, 'TPEx');
    if (quote && !quoteMap.has(quote.symbol)) quoteMap.set(quote.symbol, quote);
  }
  if (quoteMap.size === 0) {
    throw new TaiwanQuoteError('官方台股資料沒有可用收盤價。', 'EMPTY_OFFICIAL_DATA');
  }
  const quotes = Object.fromEntries([...quoteMap.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const asOf = Object.values(quotes).map((quote) => quote.date).sort().at(-1);
  const generatedAt = new Date(now).toISOString();
  return {
    format: TW_QUOTES_FORMAT,
    version: TW_QUOTES_VERSION,
    asOf,
    generatedAt,
    sources: {
      TWSE: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      TPEx: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
    },
    count: Object.keys(quotes).length,
    quotes,
  };
}

export function validateTaiwanQuotePayload(payload) {
  if (
    !payload ||
    payload.format !== TW_QUOTES_FORMAT ||
    payload.version !== TW_QUOTES_VERSION ||
    !payload.quotes ||
    typeof payload.quotes !== 'object' ||
    Array.isArray(payload.quotes)
  ) {
    throw new TaiwanQuoteError('台股行情檔案格式不正確。', 'INVALID_PUBLISHED_DATA');
  }
  if (!Object.keys(payload.quotes).length) throw new TaiwanQuoteError('台股行情檔為空。', 'INVALID_PUBLISHED_DATA');
  for (const [symbol, quote] of Object.entries(payload.quotes)) {
    if (!quote || !isSupportedTaiwanSymbol(symbol) || quote.symbol !== symbol || !Number.isFinite(quote.close) || quote.close <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(quote.date) || !['stock','etf','bondetf'].includes(quote.kind) || typeof quote.name !== 'string') throw new TaiwanQuoteError('台股行情含無效價格或商品資料。', 'INVALID_PUBLISHED_DATA');
  }
  return payload;
}

export async function fetchPublishedTaiwanQuotes({
  fetchImpl = globalThis.fetch,
  url = TW_QUOTES_DATA_URL,
  cacheBust = Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TaiwanQuoteError('此瀏覽器無法讀取台股行情。', 'FETCH_UNAVAILABLE');
  }
  const separator = url.includes('?') ? '&' : '?';
  let response;
  try {
    response = await fetchImpl(`${url}${separator}v=${encodeURIComponent(cacheBust)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new TaiwanQuoteError('目前無法下載台股日收盤資料，已保留上次價格。', 'NETWORK_ERROR');
  }
  if (!response?.ok) {
    throw new TaiwanQuoteError('台股日收盤資料尚未準備完成。', 'HTTP_ERROR');
  }
  try {
    return validateTaiwanQuotePayload(await response.json());
  } catch (error) {
    if (error instanceof TaiwanQuoteError) throw error;
    throw new TaiwanQuoteError('台股行情檔案無法解析。', 'MALFORMED_JSON');
  }
}
