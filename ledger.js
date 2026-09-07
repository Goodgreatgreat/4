/**
 * 股票紀錄的純函式計算核心。
 *
 * - 不讀寫 localStorage，也不呼叫網路，因此可安全用於瀏覽器、Node 測試與匯入/匯出流程。
 * - 金額內部保留較高精度；輸出金額預設取到小數 2 位、平均成本取到小數 8 位。
 * - 月/年彙總依市場（亦即幣別）分開，避免直接把 TWD 與 USD 相加。
 */

export const DEFAULT_TAIWAN_BROKER_SETTINGS = Object.freeze({
  standardFeeRate: 0.001425,
  discount: 1,
  minimumFee: 20,
  feeDecimals: 0,
  feeRounding: "round",
});

export const DEFAULT_US_BROKER_SETTINGS = Object.freeze({
  model: "fixed",
  fixedFee: 0,
  perShareFee: 0,
  percentageRate: 0,
  minimumFee: 0,
  feeDecimals: 2,
  feeRounding: "round",
});

// 稅率會隨法規及商品而變動，應讓使用者在設定頁修改；以下只是常用初始值。
export const DEFAULT_TAIWAN_TAX_RATES = Object.freeze({
  stock: 0.003,
  etf: 0.001,
  dayTrade: 0.0015,
});

const MARKET_CURRENCY = Object.freeze({ TW: "TWD", US: "USD" });
const ROUNDING_METHODS = new Set(["round", "floor", "ceil", "none"]);
const ASSET_TYPES = new Set(["stock", "etf", "bondetf", "dayTrade"]);
const CALCULATION_DECIMALS = 10;

export class LedgerValidationError extends Error {
  constructor(message, { code = "INVALID_INPUT", entryIndex = null, field = null } = {}) {
    super(message);
    this.name = "LedgerValidationError";
    this.code = code;
    this.entryIndex = entryIndex;
    this.field = field;
  }
}

function fail(message, details) {
  throw new LedgerValidationError(message, details);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requireObject(value, label, details = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label}必須是物件`, details);
  }
  return value;
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity, details = {} } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label}必須是有限數字`, details);
  }
  if (value < min || value > max) {
    fail(`${label}必須介於 ${min} 與 ${max} 之間`, details);
  }
  return value;
}

function optionalNonNegative(value, label, details = {}) {
  if (value === undefined || value === null) return undefined;
  return finiteNumber(value, label, { min: 0, details });
}

function positiveNumber(value, label, details = {}) {
  return finiteNumber(value, label, { min: Number.MIN_VALUE, details });
}

function integerInRange(value, label, min, max, details = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label}必須是 ${min} 到 ${max} 的整數`, details);
  }
  return value;
}

function roundTo(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return 0;
  const factor = 10 ** decimals;
  const rounded = Math.round((Math.abs(value) + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : Math.sign(value) * rounded;
}

function clean(value) {
  const cleaned = roundTo(value, CALCULATION_DECIMALS);
  return Math.abs(cleaned) < 10 ** -CALCULATION_DECIMALS ? 0 : cleaned;
}

function applyRounding(value, decimals, method) {
  if (method === "none") return clean(value);
  const factor = 10 ** decimals;
  const scaled = (Math.abs(value) + Number.EPSILON) * factor;
  const operation = method === "floor" ? Math.floor : method === "ceil" ? Math.ceil : Math.round;
  return Math.sign(value || 1) * (operation(scaled) / factor);
}

function normalizeRoundingSettings(settings, prefix, defaults, details) {
  const decimalsKey = `${prefix}Decimals`;
  const roundingKey = `${prefix}Rounding`;
  const decimals = settings[decimalsKey] ?? defaults[decimalsKey];
  const rounding = settings[roundingKey] ?? defaults[roundingKey];
  integerInRange(decimals, decimalsKey, 0, 8, details);
  if (!ROUNDING_METHODS.has(rounding)) {
    fail(`${roundingKey} 必須是 round、floor、ceil 或 none`, details);
  }
  return { decimals, rounding };
}

export function normalizeMarket(value) {
  if (typeof value !== "string") fail("market 必須是字串", { field: "market" });
  const normalized = value.trim().toUpperCase();
  if (["TW", "TAIWAN", "TWSE", "TPEX", "台股"].includes(normalized)) return "TW";
  if (["US", "USA", "NASDAQ", "NYSE", "美股"].includes(normalized)) return "US";
  fail("market 僅支援 TW（台股）或 US（美股）", { field: "market" });
}

function normalizeSide(value, details) {
  if (typeof value !== "string") fail("side 必須是 buy 或 sell", details);
  const normalized = value.trim().toLowerCase();
  if (["buy", "買", "買進"].includes(normalized)) return "buy";
  if (["sell", "賣", "賣出"].includes(normalized)) return "sell";
  fail("side 必須是 buy（買進）或 sell（賣出）", details);
}

function normalizeFxSide(value, details) {
  if (typeof value !== "string") fail("side 必須是 buy 或 sell", details);
  const normalized = value.trim().toLowerCase().replaceAll(/[-_\s]/g, "");
  if (["buy", "buyusd", "買", "買入", "買入美元"].includes(normalized)) return "buy";
  if (["sell", "sellusd", "賣", "賣出", "賣出美元"].includes(normalized)) return "sell";
  fail("side 必須是 buy（買入美元）或 sell（賣出美元）", details);
}

function normalizeEntryType(value, details) {
  const normalized = String(value ?? "trade").trim().toLowerCase().replaceAll(/[-_\s]/g, "");
  if (normalized === "trade" || normalized === "交易") return "trade";
  if (["cashdividend", "dividend", "現金股利", "現金股息"].includes(normalized)) {
    return "cashDividend";
  }
  if (["stockdividend", "股票股利", "股票股息"].includes(normalized)) return "stockDividend";
  if (normalized === 'split') return 'split';
  fail("type 必須是 trade、cashDividend 或 stockDividend", details);
}

function normalizeSymbol(value, details) {
  if (typeof value !== "string" || value.trim() === "") fail("symbol 不可空白", details);
  const symbol = value.trim().toUpperCase();
  if (symbol.length > 32) fail("symbol 長度不可超過 32 個字元", details);
  return symbol;
}

function normalizeDate(value, details) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail("date 必須使用 YYYY-MM-DD 格式", details);
  }
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail("date 不是有效日期", details);
  }
  return value;
}

function normalizeAssetType(value, details) {
  const raw = String(value ?? "stock").trim().toLowerCase();
  const normalized = raw === "daytrade" || raw === "day_trade" || raw === "day-trade"
    ? "dayTrade"
    : raw;
  if (!ASSET_TYPES.has(normalized)) {
    fail("assetType 必須是 stock、etf 或 dayTrade", details);
  }
  return normalized;
}

function mergeSettings(...parts) {
  return Object.assign({}, ...parts.filter((part) => part && typeof part === "object" && !Array.isArray(part)));
}

/**
 * 計算單筆交易手續費。
 *
 * TW settings: { standardFeeRate, discount, minimumFee, feeDecimals, feeRounding }
 * US settings: { model: fixed|perShare|percentage, fixedFee, perShareFee,
 *                percentageRate, minimumFee, feeDecimals, feeRounding }
 */
export function calculateTradeFee({ market, price, shares, feeOverride, settings = {} }) {
  const normalizedMarket = normalizeMarket(market);
  positiveNumber(price, "price", { field: "price" });
  positiveNumber(shares, "shares", { field: "shares" });
  requireObject(settings, "settings", { field: "settings" });

  const override = optionalNonNegative(feeOverride, "feeOverride", { field: "feeOverride" });
  const defaults = normalizedMarket === "TW" ? DEFAULT_TAIWAN_BROKER_SETTINGS : DEFAULT_US_BROKER_SETTINGS;
  const merged = mergeSettings(defaults, settings);
  const { decimals, rounding } = normalizeRoundingSettings(merged, "fee", defaults, {
    field: "settings",
  });

  if (override !== undefined) return applyRounding(override, decimals, rounding);

  const tradeValue = price * shares;
  let baseFee;
  if (normalizedMarket === "TW") {
    const standardFeeRate = finiteNumber(merged.standardFeeRate, "standardFeeRate", {
      min: 0,
      max: 1,
      details: { field: "settings.standardFeeRate" },
    });
    const discount = finiteNumber(merged.discount, "discount", {
      min: 0,
      max: 1,
      details: { field: "settings.discount" },
    });
    baseFee = tradeValue * standardFeeRate * discount;
  } else {
    const model = merged.model;
    if (!new Set(["fixed", "perShare", "percentage"]).has(model)) {
      fail("美股手續費 model 必須是 fixed、perShare 或 percentage", {
        field: "settings.model",
      });
    }
    if (model === "fixed") {
      baseFee = finiteNumber(merged.fixedFee, "fixedFee", {
        min: 0,
        details: { field: "settings.fixedFee" },
      });
    } else if (model === "perShare") {
      const rate = finiteNumber(merged.perShareFee, "perShareFee", {
        min: 0,
        details: { field: "settings.perShareFee" },
      });
      baseFee = shares * rate;
    } else {
      const rate = finiteNumber(merged.percentageRate, "percentageRate", {
        min: 0,
        max: 1,
        details: { field: "settings.percentageRate" },
      });
      baseFee = tradeValue * rate;
    }
  }

  const minimumFee = finiteNumber(merged.minimumFee, "minimumFee", {
    min: 0,
    details: { field: "settings.minimumFee" },
  });
  const additional = normalizedMarket === 'US'
    ? finiteNumber(merged.additionalFixedFee ?? 0, '額外每筆費', { min: 0 }) + shares * finiteNumber(merged.additionalPerShareFee ?? 0, '額外每股費', { min: 0 })
    : 0;
  return applyRounding(Math.max(baseFee, minimumFee) + additional, decimals, rounding);
}

/** 台股證交稅：僅賣出計算；可用 taxOverride 明確覆寫（包含 0）。 */
export function calculateTaiwanSecuritiesTax({
  market = "TW",
  side,
  price,
  shares,
  assetType = "stock",
  taxOverride,
  rates = DEFAULT_TAIWAN_TAX_RATES,
  taxDecimals = 0,
  taxRounding = "round",
  date,
}) {
  const normalizedMarket = normalizeMarket(market);
  const normalizedSide = normalizeSide(side, { field: "side" });
  positiveNumber(price, "price", { field: "price" });
  positiveNumber(shares, "shares", { field: "shares" });
  if (normalizedMarket !== "TW" || normalizedSide === "buy") return 0;

  const override = optionalNonNegative(taxOverride, "taxOverride", { field: "taxOverride" });
  integerInRange(taxDecimals, "taxDecimals", 0, 8, { field: "taxDecimals" });
  if (!ROUNDING_METHODS.has(taxRounding)) {
    fail("taxRounding 必須是 round、floor、ceil 或 none", { field: "taxRounding" });
  }
  if (override !== undefined) return applyRounding(override, taxDecimals, taxRounding);

  requireObject(rates, "rates", { field: "rates" });
  const normalizedAssetType = normalizeAssetType(assetType, { field: "assetType" });
  const rate = finiteNumber(normalizedAssetType === 'bondetf'
    ? (date && date >= '2017-01-01' && date <= '2026-12-31' ? 0 : (rates.etf ?? 0.001))
    : rates[normalizedAssetType], `${normalizedAssetType} 稅率`, {
    min: 0,
    max: 1,
    details: { field: `rates.${normalizedAssetType}` },
  });
  return applyRounding(price * shares * rate, taxDecimals, taxRounding);
}

function resolveBrokerSettings(entry, market, options, details) {
  const defaults = market === "TW" ? DEFAULT_TAIWAN_BROKER_SETTINGS : DEFAULT_US_BROKER_SETTINGS;
  const direct = market === "TW" ? options.taiwanBroker : options.usBroker;
  const marketSettings = options.brokerSettings?.[market];
  let named = null;

  if (entry.brokerId !== undefined && entry.brokerId !== null && entry.brokerId !== "") {
    if (typeof entry.brokerId !== "string") fail("brokerId 必須是字串", details);
    named = options.brokers?.[entry.brokerId];
    if (!named) fail(`找不到券商設定：${entry.brokerId}`, { ...details, code: "BROKER_NOT_FOUND" });
    if (named.market && normalizeMarket(named.market) !== market) {
      fail(`券商 ${entry.brokerId} 的市場與交易市場不符`, { ...details, code: "BROKER_MARKET_MISMATCH" });
    }
  }

  if (entry.feeSettings !== undefined) requireObject(entry.feeSettings, "feeSettings", details);
  return mergeSettings(defaults, direct, marketSettings, named, entry.feeSettings);
}

function snapshot(position, decimals) {
  const shares = roundTo(position.shares, decimals.quantity);
  const costBasis = roundTo(position.costBasis, decimals.money);
  return {
    market: position.market,
    currency: position.currency,
    symbol: position.symbol,
    accountId: position.accountId,
    shares,
    costBasis,
    averageCost: shares === 0 ? 0 : roundTo(position.costBasis / position.shares, decimals.averageCost),
    realizedTradingPnl: roundTo(position.realizedTradingPnl, decimals.money),
    cashDividendIncome: roundTo(position.cashDividendIncome, decimals.money),
    totalRealizedIncome: roundTo(
      position.realizedTradingPnl + position.cashDividendIncome,
      decimals.money,
    ),
    totalFees: roundTo(position.totalFees, decimals.money),
    totalTaxes: roundTo(position.totalTaxes, decimals.money),
    isClosed: shares === 0,
  };
}

function emptyPosition(market, symbol) {
  return {
    market,
    currency: MARKET_CURRENCY[market],
    symbol,
    shares: 0,
    costBasis: 0,
    realizedTradingPnl: 0,
    cashDividendIncome: 0,
    totalFees: 0,
    totalTaxes: 0,
  };
}

function emptySummary(period, market) {
  return {
    period,
    market,
    currency: MARKET_CURRENCY[market],
    buyValue: 0,
    sellValue: 0,
    fees: 0,
    taxes: 0,
    realizedTradingPnl: 0,
    cashDividendIncome: 0,
    totalRealizedIncome: 0,
    cashFlow: 0,
    tradeCount: 0,
    dividendCount: 0,
    cashDividendCount: 0,
    stockDividendCount: 0,
  };
}

function addToSummary(map, period, market, result) {
  const key = `${period}|${market}`;
  const summary = map.get(key) ?? emptySummary(period, market);
  if (result.type === "trade") {
    summary.tradeCount += 1;
    if (result.side === "buy") summary.buyValue += result._grossAmount;
    else summary.sellValue += result._grossAmount;
  } else {
    summary.dividendCount += 1;
    if (result.type === "cashDividend") summary.cashDividendCount += 1;
    else summary.stockDividendCount += 1;
  }
  summary.fees += result._fee;
  summary.taxes += result._tax;
  summary.realizedTradingPnl += result._realizedTradingPnl;
  summary.cashDividendIncome += result._cashDividendIncome;
  summary.totalRealizedIncome += result._realizedPnl;
  summary.cashFlow += result._cashFlow;
  map.set(key, summary);
}

function finalizeSummary(summary, moneyDecimals) {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [
      key,
      typeof value === "number" &&
      !["tradeCount", "dividendCount", "cashDividendCount", "stockDividendCount"].includes(key)
        ? roundTo(value, moneyDecimals)
        : value,
    ]),
  );
}

function normalizedOptions(options) {
  if (options === undefined) options = {};
  requireObject(options, "options");
  if (options.brokerSettings !== undefined) requireObject(options.brokerSettings, "brokerSettings");
  if (options.brokers !== undefined) requireObject(options.brokers, "brokers");
  if (options.taiwanBroker !== undefined) requireObject(options.taiwanBroker, "taiwanBroker");
  if (options.usBroker !== undefined) requireObject(options.usBroker, "usBroker");
  if (options.taiwanTaxRates !== undefined) requireObject(options.taiwanTaxRates, "taiwanTaxRates");

  return {
    ...options,
    taiwanTaxRates: mergeSettings(DEFAULT_TAIWAN_TAX_RATES, options.taiwanTaxRates),
    decimals: {
      money: integerInRange(options.moneyDecimals ?? 2, "moneyDecimals", 0, 8),
      averageCost: integerInRange(options.averageCostDecimals ?? 8, "averageCostDecimals", 0, 10),
      quantity: integerInRange(options.quantityDecimals ?? 8, "quantityDecimals", 0, 10),
      rate: integerInRange(options.rateDecimals ?? 6, "rateDecimals", 0, 10),
    },
    taxDecimals: integerInRange(options.taxDecimals ?? 0, "taxDecimals", 0, 8),
    taxRounding: options.taxRounding ?? "round",
  };
}

function publicResult(result, decimals) {
  const output = { ...result };
  for (const key of Object.keys(output)) {
    if (key.startsWith("_")) delete output[key];
  }
  output.grossAmount = roundTo(result._grossAmount, decimals.money);
  output.fee = roundTo(result._fee, decimals.money);
  output.tax = roundTo(result._tax, decimals.money);
  output.netAmount = roundTo(result._netAmount, decimals.money);
  output.cashFlow = roundTo(result._cashFlow, decimals.money);
  output.realizedTradingPnl = roundTo(result._realizedTradingPnl, decimals.money);
  output.cashDividendIncome = roundTo(result._cashDividendIncome, decimals.money);
  output.realizedPnl = roundTo(result._realizedPnl, decimals.money);
  output.returnRate =
    result._returnRate === null ? null : roundTo(result._returnRate, decimals.rate);
  output.sharesAfter = roundTo(result._sharesAfter, decimals.quantity);
  output.costBasisAfter = roundTo(result._costBasisAfter, decimals.money);
  output.averageCostAfter = roundTo(result._averageCostAfter, decimals.averageCost);
  if (result._allocatedCost !== undefined) {
    output.allocatedCost = roundTo(result._allocatedCost, decimals.money);
  }
  return output;
}

/**
 * 依日期（同日維持輸入順序）重算整本帳。
 *
 * Entry examples:
 *   { type:'trade', date:'2026-09-01', market:'TW', symbol:'2330',
 *     side:'buy', price:580, shares:1000, assetType:'stock', feeOverride:20 }
 *   { type:'cashDividend', date:'2026-09-10', market:'TW', symbol:'2330', amount:5000 }
 *   { type:'stockDividend', date:'2026-09-15', market:'TW', symbol:'2330', shares:50 }
 *
 * Cash dividend amount is gross income. withholdingTax and fee are optional deductions.
 */
export function processLedger(entries, options = {}) {
  if (!Array.isArray(entries)) fail("entries 必須是陣列", { field: "entries" });
  const normalized = normalizedOptions(options);
  if (!ROUNDING_METHODS.has(normalized.taxRounding)) {
    fail("taxRounding 必須是 round、floor、ceil 或 none", { field: "taxRounding" });
  }

  const datedEntries = entries.map((entry, inputIndex) => {
    const details = { entryIndex: inputIndex };
    requireObject(entry, `第 ${inputIndex + 1} 筆紀錄`, details);
    return {
      entry,
      inputIndex,
      date: normalizeDate(entry.date, { ...details, field: "date" }),
    };
  });
  datedEntries.sort((a, b) => a.date.localeCompare(b.date) || a.inputIndex - b.inputIndex);

  const positions = new Map();
  const monthly = new Map();
  const yearly = new Map();
  const results = [];
  const seenIds = new Set();

  for (let orderIndex = 0; orderIndex < datedEntries.length; orderIndex += 1) {
    const { entry, inputIndex, date } = datedEntries[orderIndex];
    const details = { entryIndex: inputIndex };
    const type = normalizeEntryType(entry.type, { ...details, field: "type" });
    const market = normalizeMarket(entry.market);
    const symbol = normalizeSymbol(entry.symbol, { ...details, field: "symbol" });
    const accountId = String(entry.accountId || 'default');
    const positionKey = JSON.stringify([accountId, market, symbol]);
    const position = positions.get(positionKey) ?? emptyPosition(market, symbol);
    position.accountId = accountId;
    const rawId = entry.id ?? `entry-${inputIndex + 1}`;
    if (typeof rawId !== "string" || rawId.trim() === "") {
      fail("id 必須是非空白字串", { ...details, field: "id" });
    }
    const id = rawId.trim();
    if (seenIds.has(id)) {
      fail(`交易紀錄 id 重複：${id}`, { ...details, code: "DUPLICATE_ID", field: "id" });
    }
    seenIds.add(id);

    let result = {
      id,
      inputIndex,
      orderIndex,
      type,
      date,
      market,
      currency: MARKET_CURRENCY[market],
      symbol,
      accountId,
      _grossAmount: 0,
      _fee: 0,
      _tax: 0,
      _netAmount: 0,
      _cashFlow: 0,
      _realizedTradingPnl: 0,
      _cashDividendIncome: 0,
      _realizedPnl: 0,
      _returnRate: 0,
    };

    if (type === "trade") {
      const side = normalizeSide(entry.side, { ...details, field: "side" });
      const price = positiveNumber(entry.price, "price", { ...details, field: "price" });
      const shares = positiveNumber(entry.shares, "shares", { ...details, field: "shares" });
      const assetType = market === "TW"
        ? normalizeAssetType(entry.assetType, { ...details, field: "assetType" })
        : String(entry.assetType ?? "stock");
      const feeSettings = resolveBrokerSettings(entry, market, normalized, details);
      const fee = calculateTradeFee({
        market,
        price,
        shares,
        feeOverride: entry.feeOverride,
        settings: feeSettings,
      });
      const tax = market === "TW"
        ? calculateTaiwanSecuritiesTax({
            market,
            side,
            price,
            shares,
            assetType,
            taxOverride: entry.taxOverride,
            rates: normalized.taiwanTaxRates,
            taxDecimals: normalized.taxDecimals,
            taxRounding: normalized.taxRounding,
            date,
          })
        : side === "sell"
          ? clean(
              optionalNonNegative(entry.taxOverride, "taxOverride", {
                ...details,
                field: "taxOverride",
              }) ?? 0,
            )
          : 0;
      const grossAmount = clean(price * shares);
      let allocatedCost = 0;
      let realizedTradingPnl = 0;
      let returnRate = 0;

      if (side === "buy") {
        position.shares = clean(position.shares + shares);
        position.costBasis = clean(position.costBasis + grossAmount + fee);
      } else {
        const sharesRemaining = clean(position.shares - shares);
        if (sharesRemaining < 0) {
          fail(
            `${market}:${symbol} 賣出 ${shares} 股，但當時僅持有 ${roundTo(position.shares, normalized.decimals.quantity)} 股`,
            { ...details, code: "OVERSELL", field: "shares" },
          );
        }
        const averageCostBefore = position.shares === 0 ? 0 : position.costBasis / position.shares;
        allocatedCost = clean(averageCostBefore * shares);
        const proceeds = clean(grossAmount - fee - tax);
        realizedTradingPnl = clean(proceeds - allocatedCost);
        returnRate = allocatedCost === 0 ? null : (realizedTradingPnl / allocatedCost) * 100;
        position.shares = sharesRemaining;
        if (position.shares === 0) position.costBasis = 0;
        else position.costBasis = clean(position.costBasis - allocatedCost);
        position.realizedTradingPnl = clean(position.realizedTradingPnl + realizedTradingPnl);
      }
      position.totalFees = clean(position.totalFees + fee);
      position.totalTaxes = clean(position.totalTaxes + tax);
      const netAmount = side === "buy" ? grossAmount + fee : grossAmount - fee - tax;
      result = {
        ...result,
        side,
        assetType,
        price,
        shares,
        _grossAmount: grossAmount,
        _fee: fee,
        _tax: tax,
        _netAmount: netAmount,
        _cashFlow: side === "buy" ? -netAmount : netAmount,
        _allocatedCost: allocatedCost,
        _realizedTradingPnl: realizedTradingPnl,
        _realizedPnl: realizedTradingPnl,
        _returnRate: returnRate,
      };
    } else if (type === "cashDividend") {
      const explicitAmount = entry.amount === undefined || entry.amount === null
        ? undefined
        : positiveNumber(entry.amount, "amount", { ...details, field: "amount" });
      const amountPerShare = entry.amountPerShare === undefined || entry.amountPerShare === null
        ? undefined
        : positiveNumber(entry.amountPerShare, "amountPerShare", {
          ...details,
          field: "amountPerShare",
        });
      if (explicitAmount === undefined && amountPerShare === undefined) {
        fail("現金股利必須提供 amount 或 amountPerShare", {
          ...details,
          field: "amount",
        });
      }
      if (explicitAmount !== undefined && amountPerShare !== undefined) {
        fail("amount 與 amountPerShare 只能擇一", { ...details, field: "amount" });
      }
      let dividendShares = null;
      if (amountPerShare !== undefined) {
        dividendShares = entry.shares === undefined
          ? position.shares
          : positiveNumber(entry.shares, "shares", { ...details, field: "shares" });
        if (dividendShares <= 0) {
          fail("用 amountPerShare 計算股利時必須有正持股或提供 shares", {
            ...details,
            field: "shares",
          });
        }
      } else if (entry.shares !== undefined) {
        dividendShares = positiveNumber(entry.shares, "shares", { ...details, field: "shares" });
      }
      const grossAmount = clean(
        explicitAmount !== undefined ? explicitAmount : amountPerShare * dividendShares,
      );
      const withholdingTax = optionalNonNegative(entry.withholdingTax, "withholdingTax", {
        ...details,
        field: "withholdingTax",
      }) ?? 0;
      const fee = optionalNonNegative(entry.fee, "fee", { ...details, field: "fee" }) ?? 0;
      const netAmount = clean(grossAmount - withholdingTax - fee);
      if (netAmount < 0) {
        fail("現金股利的扣繳稅與費用不可超過股利總額", {
          ...details,
          code: "NEGATIVE_DIVIDEND",
        });
      }
      const returnRate = position.costBasis === 0 ? null : (netAmount / position.costBasis) * 100;
      position.cashDividendIncome = clean(position.cashDividendIncome + netAmount);
      position.totalFees = clean(position.totalFees + fee);
      position.totalTaxes = clean(position.totalTaxes + withholdingTax);
      result = {
        ...result,
        amountPerShare: amountPerShare ?? null,
        shares: dividendShares,
        withholdingTax,
        _grossAmount: grossAmount,
        _fee: fee,
        _tax: withholdingTax,
        _netAmount: netAmount,
        _cashFlow: netAmount,
        _cashDividendIncome: netAmount,
        _realizedPnl: netAmount,
        _returnRate: returnRate,
      };
    } else if (type === 'split') {
      const factor = positiveNumber(entry.factor, 'factor', details);
      if (position.shares <= 0) fail('分割當日此帳戶沒有持股', { ...details, code: 'NO_SPLIT_POSITION' });
      position.shares = clean(position.shares * factor);
      result = { ...result, factor, shares: 0 };
    } else {
      const shares = positiveNumber(entry.shares, "shares", { ...details, field: "shares" });
      position.shares = clean(position.shares + shares);
      // 股票股利不增加總成本，所以平均成本會自然下降。
      result = {
        ...result,
        shares,
        _returnRate: 0,
      };
    }

    position.shares = clean(position.shares);
    position.costBasis = clean(position.costBasis);
    result._sharesAfter = position.shares;
    result._costBasisAfter = position.costBasis;
    result._averageCostAfter = position.shares === 0 ? 0 : position.costBasis / position.shares;
    positions.set(positionKey, position);

    addToSummary(monthly, date.slice(0, 7), market, result);
    addToSummary(yearly, date.slice(0, 4), market, result);
    results.push(publicResult(result, normalized.decimals));
  }

  const positionList = [...positions.values()]
    .map((position) => snapshot(position, normalized.decimals))
    .sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol));
  const monthlySummaries = [...monthly.values()]
    .sort((a, b) => a.period.localeCompare(b.period) || a.market.localeCompare(b.market))
    .map((summary) => finalizeSummary(summary, normalized.decimals.money));
  const yearlySummaries = [...yearly.values()]
    .sort((a, b) => a.period.localeCompare(b.period) || a.market.localeCompare(b.market))
    .map((summary) => finalizeSummary(summary, normalized.decimals.money));

  return {
    transactions: results,
    positions: positionList,
    openPositions: positionList.filter((position) => !position.isClosed),
    monthlySummaries,
    yearlySummaries,
  };
}

/**
 * 依實付／實收台幣計算單筆實際匯率。
 * 買入美元： (TWD + 手續費) / USD
 * 賣出美元： (TWD - 手續費) / USD
 */
export function calculateActualExchangeRate({ side, usdAmount, twdAmount, feeTwd = 0 }) {
  const normalizedSide = normalizeFxSide(side, { field: "side" });
  positiveNumber(usdAmount, "usdAmount", { field: "usdAmount" });
  positiveNumber(twdAmount, "twdAmount", { field: "twdAmount" });
  finiteNumber(feeTwd, "feeTwd", { min: 0, details: { field: "feeTwd" } });
  const effectiveTwd = normalizedSide === "buy" ? twdAmount + feeTwd : twdAmount - feeTwd;
  if (effectiveTwd <= 0) {
    fail("賣出美元的手續費必須小於台幣收入", {
      code: "INVALID_FX_FEE",
      field: "feeTwd",
    });
  }
  return clean(effectiveTwd / usdAmount);
}

function emptyFxSummary(period) {
  return {
    period,
    usdBought: 0,
    usdSold: 0,
    twdPaid: 0,
    twdReceived: 0,
    feesTwd: 0,
    realizedFxPnl: 0,
    twdCashFlow: 0,
    transactionCount: 0,
  };
}

function addToFxSummary(map, period, result) {
  const summary = map.get(period) ?? emptyFxSummary(period);
  summary.transactionCount += 1;
  summary.feesTwd += result._feeTwd;
  summary.realizedFxPnl += result._realizedFxPnl;
  summary.twdCashFlow += result._twdCashFlow;
  if (result.side === "buy") {
    summary.usdBought += result.usdAmount;
    summary.twdPaid += -result._twdCashFlow;
  } else {
    summary.usdSold += result.usdAmount;
    summary.twdReceived += result._twdCashFlow;
  }
  map.set(period, summary);
}

function finalizeFxSummary(summary, moneyDecimals, quantityDecimals) {
  return {
    ...summary,
    usdBought: roundTo(summary.usdBought, quantityDecimals),
    usdSold: roundTo(summary.usdSold, quantityDecimals),
    twdPaid: roundTo(summary.twdPaid, moneyDecimals),
    twdReceived: roundTo(summary.twdReceived, moneyDecimals),
    feesTwd: roundTo(summary.feesTwd, moneyDecimals),
    realizedFxPnl: roundTo(summary.realizedFxPnl, moneyDecimals),
    twdCashFlow: roundTo(summary.twdCashFlow, moneyDecimals),
  };
}

/**
 * 重算美元換匯帳。
 *
 * Entry: { date:'2026-09-01', side:'buy'|'sell', usdAmount:1000,
 *          twdAmount:32000, feeTwd:100 }
 * twdAmount 是不含手續費的台幣成交金額；feeTwd 可省略（視為 0）。
 */
export function processFxLedger(entries, options = {}) {
  if (!Array.isArray(entries)) fail("entries 必須是陣列", { field: "entries" });
  if (options === undefined) options = {};
  requireObject(options, "options", { field: "options" });
  const moneyDecimals = integerInRange(options.moneyDecimals ?? 2, "moneyDecimals", 0, 8);
  const quantityDecimals = integerInRange(options.quantityDecimals ?? 8, "quantityDecimals", 0, 10);
  const rateDecimals = integerInRange(options.rateDecimals ?? 6, "rateDecimals", 0, 10);

  const datedEntries = entries.map((entry, inputIndex) => {
    const details = { entryIndex: inputIndex };
    requireObject(entry, `第 ${inputIndex + 1} 筆換匯紀錄`, details);
    return {
      entry,
      inputIndex,
      date: normalizeDate(entry.date, { ...details, field: "date" }),
    };
  });
  datedEntries.sort((a, b) => a.date.localeCompare(b.date) || a.inputIndex - b.inputIndex);

  let usdCash = 0;
  let twdCostBasis = 0;
  let realizedFxPnl = 0;
  let totalFeesTwd = 0;
  const transactions = [];
  const monthly = new Map();
  const yearly = new Map();
  const seenIds = new Set();

  for (let orderIndex = 0; orderIndex < datedEntries.length; orderIndex += 1) {
    const { entry, inputIndex, date } = datedEntries[orderIndex];
    const details = { entryIndex: inputIndex };
    const rawId = entry.id ?? `fx-entry-${inputIndex + 1}`;
    if (typeof rawId !== "string" || rawId.trim() === "") {
      fail("id 必須是非空白字串", { ...details, field: "id" });
    }
    const id = rawId.trim();
    if (seenIds.has(id)) {
      fail(`換匯紀錄 id 重複：${id}`, { ...details, code: "DUPLICATE_ID", field: "id" });
    }
    seenIds.add(id);

    const side = normalizeFxSide(entry.side, { ...details, field: "side" });
    const usdAmount = positiveNumber(entry.usdAmount, "usdAmount", {
      ...details,
      field: "usdAmount",
    });
    const twdAmount = positiveNumber(entry.twdAmount, "twdAmount", {
      ...details,
      field: "twdAmount",
    });
    if (entry.fee !== undefined && entry.feeTwd !== undefined) {
      fail("fee 與 feeTwd 只能擇一", { ...details, field: "feeTwd" });
    }
    const feeTwd = optionalNonNegative(entry.feeTwd ?? entry.fee, "feeTwd", {
      ...details,
      field: "feeTwd",
    }) ?? 0;
    const actualRate = calculateActualExchangeRate({ side, usdAmount, twdAmount, feeTwd });
    let allocatedTwdCost = 0;
    let recordPnl = 0;
    let returnRate = 0;
    let twdCashFlow;

    if (side === "buy") {
      const totalPaid = clean(twdAmount + feeTwd);
      usdCash = clean(usdCash + usdAmount);
      twdCostBasis = clean(twdCostBasis + totalPaid);
      twdCashFlow = -totalPaid;
    } else {
      const usdRemaining = clean(usdCash - usdAmount);
      if (usdRemaining < 0) {
        fail(
          `賣出 ${usdAmount} USD，但當時僅有 ${roundTo(usdCash, quantityDecimals)} USD`,
          { ...details, code: "OVERSELL_USD", field: "usdAmount" },
        );
      }
      const averageRateBefore = usdCash === 0 ? 0 : twdCostBasis / usdCash;
      allocatedTwdCost = clean(averageRateBefore * usdAmount);
      const netReceived = clean(twdAmount - feeTwd);
      recordPnl = clean(netReceived - allocatedTwdCost);
      returnRate = allocatedTwdCost === 0 ? null : (recordPnl / allocatedTwdCost) * 100;
      usdCash = usdRemaining;
      if (usdCash === 0) twdCostBasis = 0;
      else twdCostBasis = clean(twdCostBasis - allocatedTwdCost);
      realizedFxPnl = clean(realizedFxPnl + recordPnl);
      twdCashFlow = netReceived;
    }
    totalFeesTwd = clean(totalFeesTwd + feeTwd);
    const weightedRateAfter = usdCash === 0 ? 0 : twdCostBasis / usdCash;
    const internalResult = {
      id,
      inputIndex,
      orderIndex,
      date,
      side,
      usdAmount,
      twdAmount,
      _feeTwd: feeTwd,
      _actualRate: actualRate,
      _allocatedTwdCost: allocatedTwdCost,
      _realizedFxPnl: recordPnl,
      _returnRate: returnRate,
      _twdCashFlow: twdCashFlow,
      _usdCashAfter: usdCash,
      _twdCostBasisAfter: twdCostBasis,
      _weightedRateAfter: weightedRateAfter,
    };
    transactions.push({
      id,
      inputIndex,
      orderIndex,
      date,
      side,
      usdAmount: roundTo(usdAmount, quantityDecimals),
      twdAmount: roundTo(twdAmount, moneyDecimals),
      feeTwd: roundTo(feeTwd, moneyDecimals),
      actualRate: roundTo(actualRate, rateDecimals),
      allocatedTwdCost: roundTo(allocatedTwdCost, moneyDecimals),
      realizedFxPnl: roundTo(recordPnl, moneyDecimals),
      returnRate: returnRate === null ? null : roundTo(returnRate, rateDecimals),
      twdCashFlow: roundTo(twdCashFlow, moneyDecimals),
      usdCashAfter: roundTo(usdCash, quantityDecimals),
      twdCostBasisAfter: roundTo(twdCostBasis, moneyDecimals),
      weightedExchangeRateAfter: roundTo(weightedRateAfter, rateDecimals),
    });
    addToFxSummary(monthly, date.slice(0, 7), internalResult);
    addToFxSummary(yearly, date.slice(0, 4), internalResult);
  }

  return {
    transactions,
    currentUsdCash: roundTo(usdCash, quantityDecimals),
    twdCostBasis: roundTo(twdCostBasis, moneyDecimals),
    weightedExchangeRate: roundTo(usdCash === 0 ? 0 : twdCostBasis / usdCash, rateDecimals),
    realizedFxPnl: roundTo(realizedFxPnl, moneyDecimals),
    totalFeesTwd: roundTo(totalFeesTwd, moneyDecimals),
    monthlySummaries: [...monthly.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((summary) => finalizeFxSummary(summary, moneyDecimals, quantityDecimals)),
    yearlySummaries: [...yearly.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((summary) => finalizeFxSummary(summary, moneyDecimals, quantityDecimals)),
  };
}
