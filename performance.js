// Pure, deterministic calculations. Rates are decimal fractions, not percentages.
const DAY = 86400000;
export function dateNumber(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('日期格式無效');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new TypeError('日期無效');
  return ms / DAY;
}

export function calculateXirr(flows) {
  const grouped = new Map();
  for (const { date, amount } of flows) {
    const day = dateNumber(date);
    if (!Number.isFinite(amount)) throw new TypeError('現金流必須是有限數字');
    grouped.set(day, (grouped.get(day) || 0) + amount);
  }
  const points = [...grouped].filter(([, amount]) => Math.abs(amount) > 1e-9).sort((a, b) => a[0] - b[0]);
  if (points.length < 2 || !points.some(([, v]) => v < 0) || !points.some(([, v]) => v > 0)) return { status: 'insufficient', rate: null };
  const days = points.at(-1)[0] - points[0][0];
  if (days <= 0) return { status: 'same-day', rate: null, days };
  const changes = points.slice(1).filter(([, v], i) => Math.sign(v) !== Math.sign(points[i][1])).length;
  // Non-conventional flows can have multiple or tangent roots. Do not choose an
  // arbitrary Newton root and present it as the user's unique annual return.
  if (changes > 1) return { status: 'ambiguous', rate: null, days };
  const scale = Math.max(...points.map(([, v]) => Math.abs(v)));
  const npv = (logRate) => {
    const terms = points.map(([d, v]) => [Math.log(Math.abs(v) / scale) - logRate * (d - points[0][0]) / 365, Math.sign(v)]);
    const max = Math.max(...terms.map(([v]) => v));
    return terms.reduce((sum, [v, sign]) => sum + sign * Math.exp(v - max), 0);
  };
  let lo = -20; let hi = 20; let left = npv(lo);
  if (Math.sign(left) === Math.sign(npv(hi))) return { status: 'out-of-range', rate: null, days };
  for (let i = 0; i < 160; i++) {
    const mid = (lo + hi) / 2; const value = npv(mid);
    if (Math.sign(value) === Math.sign(left)) { lo = mid; left = value; } else hi = mid;
  }
  const logRate = (lo + hi) / 2;
  return { status: 'ok', rate: Math.expm1(logRate), periodRate: Math.expm1(logRate * days / 365), days, annualized: days >= 365 };
}

export function quoteUsable(quote, today) {
  return Boolean(quote && Number.isFinite(quote.close) && quote.close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(quote.date) && quote.date <= today && !quote.needsSplitReview);
}

export function investmentPerformance(book, quotes, currency, today) {
  const transactions = book.transactions.filter((t) => t.currency === currency && t.date <= today);
  const positions = book.openPositions.filter((p) => p.currency === currency);
  const missing = positions.filter((p) => !quoteUsable(quotes[`${p.market}:${p.symbol}`] ?? quotes[p.symbol], today));
  if (missing.length) return { status: 'missing-quotes', rate: null, missing: missing.map((p) => p.symbol) };
  const flows = transactions.filter((t) => t.cashFlow !== 0).map((t) => ({ date: t.date, amount: t.cashFlow }));
  let value = 0;
  const dates = [];
  for (const p of positions) {
    const quote = quotes[`${p.market}:${p.symbol}`] ?? quotes[p.symbol];
    value += p.shares * quote.close; dates.push(quote.date);
  }
  // Value at today's valuation date, using individually disclosed last closes.
  if (positions.length) flows.push({ date: today, amount: value });
  return { ...calculateXirr(flows), value, quoteDates: [...new Set(dates)].sort(), valuationDate: positions.length ? today : transactions.at(-1)?.date };
}

export function combinePositions(positions) {
  const grouped = new Map();
  for (const position of positions) {
    const key = `${position.market}:${position.symbol}`;
    const row = grouped.get(key) || { ...position, accountId: 'all', shares: 0, costBasis: 0, realizedTradingPnl: 0, cashDividendIncome: 0, totalRealizedIncome: 0, totalFees: 0, totalTaxes: 0 };
    for (const field of ['shares','costBasis','realizedTradingPnl','cashDividendIncome','totalRealizedIncome','totalFees','totalTaxes']) row[field] += Number(position[field] || 0);
    row.averageCost = row.shares ? row.costBasis / row.shares : 0;
    row.isClosed = row.shares === 0;
    grouped.set(key, row);
  }
  return [...grouped.values()];
}

export function allocationAdvice(rows, targets, tolerance = 5) {
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const targetTotal = Object.values(targets).reduce((sum, value) => sum + Number(value), 0);
  if (!Object.values(targets).every((v) => Number.isFinite(Number(v)) && v >= 0 && v <= 100) || Math.abs(targetTotal - 100) > 0.01) return { status: 'invalid-targets', total, rows: [] };
  const actual = new Map(rows.map((r) => [r.category, r.amount]));
  return { status: total > 0 ? 'ok' : 'empty', total, rows: [...new Set([...actual.keys(), ...Object.keys(targets)])].map((category) => {
    const amount = actual.get(category) || 0; const target = Number(targets[category] || 0);
    const weight = total > 0 ? amount / total * 100 : 0;
    return { category, amount, weight, target, deviation: weight - target, adjustment: total * target / 100 - amount, alert: total > 0 && Math.abs(weight - target) > tolerance };
  }) };
}
