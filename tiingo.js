/**
 * Small browser-safe Tiingo EOD client.
 *
 * The caller should keep the user's token in local-only storage and pass it to
 * these functions when needed. The token is sent in the Authorization header,
 * never in the URL.
 */

export const TIINGO_SOURCE = "Tiingo EOD";
export const TIINGO_API_BASE_URL = "https://api.tiingo.com";

export class TiingoError extends Error {
  constructor(message, { code, status = null, retryable = false, retryAfterSeconds = null, cause } = {}) {
    // Assign cause manually for older mobile browsers that do not implement
    // Error's second constructor argument yet.
    super(message);
    this.name = "TiingoError";
    this.code = code || "TIINGO_ERROR";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Normalize a US ticker for Tiingo without allowing path characters. */
export function normalizeTiingoSymbol(value) {
  const symbol = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^\$/, "")
    .replace(/[‐‑‒–—−]/g, "-")
    .toUpperCase();

  if (!symbol) {
    throw new TiingoError("請輸入美股代號。", { code: "INVALID_SYMBOL" });
  }

  // Covers common US symbols such as AAPL, BRK.B and BRK-B while rejecting
  // slashes/query fragments that could change the requested endpoint.
  if (!/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(symbol)) {
    throw new TiingoError("美股代號格式不正確。", { code: "INVALID_SYMBOL" });
  }

  return symbol;
}

/** Normalize a pasted token, including an optional leading `Token ` label. */
export function normalizeTiingoToken(value) {
  const token = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^Token\s+/i, "")
    .trim();

  if (!token || token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new TiingoError("Tiingo Token 格式不正確。", { code: "INVALID_TOKEN" });
  }

  return token;
}

/**
 * Validate a user's token with Tiingo's official test endpoint.
 * Resolves to true when Tiingo accepts it; otherwise throws TiingoError.
 */
export async function validateTiingoToken(token, options = {}) {
  const normalizedToken = normalizeTiingoToken(token);
  const response = await requestTiingo("/api/test/", normalizedToken, options);
  const payload = await readJson(response);

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw malformedResponseError();
  }

  if (typeof payload.message !== "string" || !/successfully sent a request/i.test(payload.message)) {
    throw new TiingoError("Tiingo Token 無效，請重新貼上後再試。", {
      code: "UNAUTHORIZED",
      status: response.status,
    });
  }

  return true;
}

/**
 * Fetch the latest completed EOD raw close for a US stock/ETF.
 *
 * @returns {{symbol: string, close: number, date: string, source: string, fetchedAt: string}}
 */
export async function fetchLatestTiingoClose(symbol, token, options = {}) {
  const normalizedSymbol = normalizeTiingoSymbol(symbol);
  const normalizedToken = normalizeTiingoToken(token);
  const response = await requestTiingo(
    `/tiingo/daily/${encodeURIComponent(normalizedSymbol)}/prices`,
    normalizedToken,
    options,
  );
  const payload = await readJson(response);

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new TiingoError("Tiingo 沒有回傳可用的收盤價。", {
      code: "MALFORMED_RESPONSE",
      status: response.status,
    });
  }

  const validRows = payload
    .map(parsePriceRow)
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);

  if (validRows.length === 0) {
    throw malformedResponseError(response.status);
  }

  const latest = validRows.at(-1);
  return {
    symbol: normalizedSymbol,
    close: latest.close,
    date: latest.date,
    source: TIINGO_SOURCE,
    fetchedAt: getFetchedAt(options.now),
  };
}

async function requestTiingo(path, token, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TiingoError("此瀏覽器不支援網路查價。", { code: "FETCH_UNAVAILABLE" });
  }

  let response;
  try {
    response = await fetchImpl(`${TIINGO_API_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Token ${token}`,
      },
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new TiingoError("Tiingo 查價已取消。", {
        code: "REQUEST_ABORTED",
        retryable: true,
        cause: error,
      });
    }
    throw new TiingoError("目前無法連線 Tiingo，請確認網路後再試一次。", {
      code: "NETWORK_ERROR",
      retryable: true,
      cause: error,
    });
  }

  if (!response || typeof response.ok !== "boolean") {
    throw malformedResponseError();
  }

  if (!response.ok) {
    throw errorForStatus(response);
  }

  return response;
}

function errorForStatus(response) {
  const status = Number(response.status) || null;

  if (status === 401) {
    return new TiingoError("Tiingo Token 無效，請重新貼上後再試。", {
      code: "UNAUTHORIZED",
      status,
    });
  }
  if (status === 403) {
    return new TiingoError("這組 Tiingo Token 沒有查詢此資料的權限。", {
      code: "FORBIDDEN",
      status,
    });
  }
  if (status === 404) {
    return new TiingoError("Tiingo 找不到這個股票代號。", {
      code: "SYMBOL_NOT_FOUND",
      status,
    });
  }
  if (status === 429) {
    return new TiingoError("Tiingo 今日或每小時的免費查詢額度已用完，請稍後再試。", {
      code: "RATE_LIMITED",
      status,
      retryable: true,
      retryAfterSeconds: parseRetryAfter(response.headers?.get?.("retry-after")),
    });
  }

  return new TiingoError(`Tiingo 暫時無法提供資料（HTTP ${status ?? "未知"}）。`, {
    code: "HTTP_ERROR",
    status,
    retryable: status === null || status >= 500,
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new TiingoError("Tiingo 回傳的資料格式無法解析。", {
      code: "MALFORMED_RESPONSE",
      status: Number(response?.status) || null,
      cause: error,
    });
  }
}

function parsePriceRow(row) {
  if (!row || typeof row !== "object") return null;

  const hasNumericClose =
    typeof row.close === "number" ||
    (typeof row.close === "string" && row.close.trim() !== "");
  const close = hasNumericClose ? Number(row.close) : Number.NaN;
  const timestamp = Date.parse(row.date);
  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp).toISOString().slice(0, 10);
  return { close, date, timestamp };
}

function malformedResponseError(status = null) {
  return new TiingoError("Tiingo 回傳的資料不完整，已保留原本的股價。", {
    code: "MALFORMED_RESPONSE",
    status: Number(status) || null,
  });
}

function parseRetryAfter(value) {
  if (value == null || value === "") return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function getFetchedAt(now) {
  const value = typeof now === "function" ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TiingoError("無法記錄行情更新時間。", { code: "INVALID_CLOCK" });
  }
  return date.toISOString();
}
