export const BACKUP_FORMAT = 'personal-stock-journal';
export const BACKUP_VERSION = 3;
// One localStorage write commits the entire ledger, including its audit trail.
export const DOCUMENT_KEY = 'stock-journal:document:v3';

export const STORAGE_KEYS = Object.freeze({
  transactions: 'stock-journal:transactions:v1',
  dividends: 'stock-journal:dividends:v1',
  exchanges: 'stock-journal:exchanges:v1',
  brokers: 'stock-journal:brokers:v1',
  preferences: 'stock-journal:preferences:v1',
  instruments: 'stock-journal:instruments:v1',
  auditLog: 'stock-journal:audit-log:v1',
  quotes: 'stock-journal:tiingo-quotes:v1',
  assets: 'stock-journal:assets:v1',
});

const COLLECTION_NAMES = Object.freeze([
  'transactions',
  'dividends',
  'exchanges',
  'brokers',
  'instruments',
  'auditLog',
  'assets',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createRecordId(prefix = 'record') {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function readStoredJson(storage, key, fallback) {
  const document = readDocument(storage);
  if (Object.hasOwn(document, key)) return clone(document[key]);
  const raw = storage.getItem(key);
  if (raw === null) return clone(fallback);
  try { return JSON.parse(raw); }
  catch { throw new Error(`本機資料損壞（${key}）。已停止寫入，請先匯出原始資料或還原備份。`); }
}

export function writeStoredJson(storage, key, value) {
  const document = readDocument(storage);
  // Read all legacy data before the first migration. Never replace unreadable data.
  for (const legacyKey of Object.values(STORAGE_KEYS)) {
    if (Object.hasOwn(document, legacyKey)) continue;
    const raw = storage.getItem(legacyKey);
    if (raw !== null) {
      try { document[legacyKey] = JSON.parse(raw); }
      catch { throw new Error(`本機資料損壞（${legacyKey}），未變更原始資料。`); }
    }
  }
  document[key] = clone(value);
  storage.setItem(DOCUMENT_KEY, JSON.stringify(document));
  return value;
}

function readDocument(storage) {
  const raw = storage.getItem(DOCUMENT_KEY);
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('本機帳本格式損壞。已停止寫入，請保留原始資料並還原備份。'); }
}

export function atomicUpdate(storage, operation) {
  let draft = storage.getItem(DOCUMENT_KEY);
  const staged = {
    getItem: (key) => key === DOCUMENT_KEY ? draft : storage.getItem(key),
    setItem(key, value) {
      if (key !== DOCUMENT_KEY) throw new Error('不可在帳本交易中修改非帳本資料。');
      draft = value;
    },
  };
  const result = operation(staged);
  if (result?.then) throw new TypeError('帳本交易不可包含非同步作業。');
  if (draft !== storage.getItem(DOCUMENT_KEY)) storage.setItem(DOCUMENT_KEY, draft);
  return result;
}

export function readCollection(storage, name) {
  const key = STORAGE_KEYS[name];
  if (!key || !COLLECTION_NAMES.includes(name)) throw new TypeError(`Unknown collection: ${name}`);
  const value = readStoredJson(storage, key, []);
  if (!Array.isArray(value)) throw new Error(`本機 ${name} 格式不正確，已停止寫入。`);
  return value;
}

export function saveCollection(storage, name, records) {
  const key = STORAGE_KEYS[name];
  if (!key || !COLLECTION_NAMES.includes(name)) throw new TypeError(`Unknown collection: ${name}`);
  if (!Array.isArray(records)) throw new TypeError('Records must be an array.');
  writeStoredJson(storage, key, records);
  return records;
}

export function appendAudit(storage, entry) {
  const log = readCollection(storage, 'auditLog');
  log.unshift({
    id: createRecordId('audit'),
    changedAt: new Date().toISOString(),
    ...clone(entry),
  });
  saveCollection(storage, 'auditLog', log);
}

function restoreRawValue(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Best effort only. In browsers, restoring the smaller previous value normally succeeds
    // after the larger attempted write has failed because of quota pressure.
  }
}

function commitAuditedCollection(storage, name, records, entry) {
  const log = readCollection(storage, 'auditLog');
  log.unshift({
    id: createRecordId('audit'),
    changedAt: new Date().toISOString(),
    ...clone(entry),
  });

  atomicUpdate(storage, (draft) => {
    saveCollection(draft, name, records);
    saveCollection(draft, 'auditLog', log);
  });
}

export function upsertRecord(storage, name, record, { audit = true } = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('Record must be an object.');
  const records = readCollection(storage, name);
  const nextRecord = { ...clone(record), id: record.id || createRecordId(name.slice(0, -1)) };
  const index = records.findIndex(({ id }) => id === nextRecord.id);
  const before = index >= 0 ? records[index] : null;
  if (index >= 0) records[index] = nextRecord;
  else records.unshift(nextRecord);
  if (audit && name !== 'auditLog') {
    commitAuditedCollection(storage, name, records, {
      action: before ? 'update' : 'create',
      entity: name,
      recordId: nextRecord.id,
      before,
      after: nextRecord,
    });
  } else saveCollection(storage, name, records);
  return nextRecord;
}

export function removeRecord(storage, name, id, { audit = true } = {}) {
  const records = readCollection(storage, name);
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) return false;
  const [before] = records.splice(index, 1);
  if (audit && name !== 'auditLog') {
    commitAuditedCollection(storage, name, records, {
      action: 'delete',
      entity: name,
      recordId: id,
      before,
      after: null,
    });
  } else saveCollection(storage, name, records);
  return true;
}

export function buildBackup(storage, now = new Date()) {
  const data = {};
  COLLECTION_NAMES.forEach((name) => {
    data[name] = readCollection(storage, name);
  });
  data.preferences = readStoredJson(storage, STORAGE_KEYS.preferences, {});
  data.quotes = readStoredJson(storage, STORAGE_KEYS.quotes, {});
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    excludes: ['Tiingo Token'],
    data,
  };
}

export function validateBackup(payload) {
  if (!payload || typeof payload !== 'object' || payload.format !== BACKUP_FORMAT) {
    throw new TypeError('這不是本程式的備份檔。');
  }
  if (!Number.isInteger(payload.version) || payload.version < 1 || payload.version > BACKUP_VERSION) {
    throw new TypeError('備份檔版本不受支援。');
  }
  if (!payload.data || typeof payload.data !== 'object') throw new TypeError('備份檔缺少資料。');
  COLLECTION_NAMES.forEach((name) => {
    if (name === 'assets' && payload.version < 3 && payload.data[name] === undefined) return;
    if (!Array.isArray(payload.data[name])) {
      throw new TypeError(`備份檔的 ${name} 格式不正確。`);
    }
    const ids = new Set();
    payload.data[name].forEach((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string' || !record.id || ids.has(record.id)) {
        throw new TypeError(`備份檔的 ${name} 有無效或重複的 id。`);
      }
      ids.add(record.id);
      if (['transactions', 'dividends', 'exchanges'].includes(name)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date) || Number.isNaN(Date.parse(record.date)) || new Date(record.date).toISOString().slice(0, 10) !== record.date) throw new TypeError(`${name} 日期無效。`);
      }
      if (name === 'transactions' && (!['TW','US'].includes(record.market) || !['buy','sell'].includes(record.side) || !record.symbol || !(Number(record.price) > 0) || !(Number(record.shares) > 0))) throw new TypeError('交易資料缺少市場、代號、方向、成交價或股數。');
      for (const field of ['price','shares','amount','feeOverride','taxOverride','usdAmount','twdAmount','feeTwd','value']) {
        if (record[field] != null && (!Number.isFinite(Number(record[field])) || Number(record[field]) < 0)) throw new TypeError(`${name} 的 ${field} 無效。`);
      }
    });
  });
  if (
    payload.data.preferences !== undefined &&
    (!payload.data.preferences || typeof payload.data.preferences !== 'object' || Array.isArray(payload.data.preferences))
  ) {
    throw new TypeError('備份檔的 preferences 格式不正確。');
  }
  if (!payload.data.preferences) throw new TypeError('備份檔缺少 preferences。');
  if (!payload.data.quotes || typeof payload.data.quotes !== 'object' || Array.isArray(payload.data.quotes)) throw new TypeError('備份檔的 quotes 格式不正確。');
  for (const quote of Object.values(payload.data.quotes)) {
    if (!quote || !Number.isFinite(quote.close) || quote.close <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(quote.date)) throw new TypeError('备份行情的價格或日期無效。');
  }
  return payload;
}

function mergeById(current, incoming) {
  const merged = new Map();
  current.forEach((record) => merged.set(record.id || createRecordId('legacy'), record));
  incoming.forEach((record) => merged.set(record.id || createRecordId('imported'), record));
  return [...merged.values()];
}

export function restoreBackup(storage, input, { mode = 'replace' } = {}) {
  if (!['replace', 'merge'].includes(mode)) throw new TypeError('匯入模式不正確。');
  const payload = validateBackup(typeof input === 'string' ? JSON.parse(input) : input);
  const previous = new Map();
  const pending = new Map();

  COLLECTION_NAMES.forEach((name) => {
    const key = STORAGE_KEYS[name];
    previous.set(key, storage.getItem(key));
    const incoming = payload.data[name] ?? [];
    const next = mode === 'merge' ? mergeById(readCollection(storage, name), incoming) : incoming;
    pending.set(key, JSON.stringify(next));
  });
  previous.set(STORAGE_KEYS.preferences, storage.getItem(STORAGE_KEYS.preferences));
  previous.set(STORAGE_KEYS.quotes, storage.getItem(STORAGE_KEYS.quotes));
  pending.set(
    STORAGE_KEYS.preferences,
    JSON.stringify(mode === 'merge'
      ? { ...readStoredJson(storage, STORAGE_KEYS.preferences, {}), ...(payload.data.preferences ?? {}) }
      : (payload.data.preferences ?? {})),
  );
  pending.set(
    STORAGE_KEYS.quotes,
    JSON.stringify(mode === 'merge'
      ? { ...readStoredJson(storage, STORAGE_KEYS.quotes, {}), ...(payload.data.quotes ?? {}) }
      : (payload.data.quotes ?? {})),
  );

  atomicUpdate(storage, (draft) => {
    pending.forEach((value, key) => writeStoredJson(draft, key, JSON.parse(value)));
  });

  return {
    transactions: readCollection(storage, 'transactions').length,
    dividends: readCollection(storage, 'dividends').length,
    exchanges: readCollection(storage, 'exchanges').length,
    brokers: readCollection(storage, 'brokers').length,
  };
}
