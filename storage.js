export const BACKUP_FORMAT = 'personal-stock-journal';
export const BACKUP_VERSION = 2;

export const STORAGE_KEYS = Object.freeze({
  transactions: 'stock-journal:transactions:v1',
  dividends: 'stock-journal:dividends:v1',
  exchanges: 'stock-journal:exchanges:v1',
  brokers: 'stock-journal:brokers:v1',
  preferences: 'stock-journal:preferences:v1',
  instruments: 'stock-journal:instruments:v1',
  auditLog: 'stock-journal:audit-log:v1',
  quotes: 'stock-journal:tiingo-quotes:v1',
});

const COLLECTION_NAMES = Object.freeze([
  'transactions',
  'dividends',
  'exchanges',
  'brokers',
  'instruments',
  'auditLog',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createRecordId(prefix = 'record') {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function readStoredJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw === null ? clone(fallback) : JSON.parse(raw);
  } catch {
    return clone(fallback);
  }
}

export function writeStoredJson(storage, key, value) {
  storage.setItem(key, JSON.stringify(value));
  return value;
}

export function readCollection(storage, name) {
  const key = STORAGE_KEYS[name];
  if (!key || !COLLECTION_NAMES.includes(name)) throw new TypeError(`Unknown collection: ${name}`);
  const value = readStoredJson(storage, key, []);
  return Array.isArray(value) ? value : [];
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
  saveCollection(storage, 'auditLog', log.slice(0, 500));
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
  const collectionKey = STORAGE_KEYS[name];
  const auditKey = STORAGE_KEYS.auditLog;
  const previousCollection = storage.getItem(collectionKey);
  const previousAudit = storage.getItem(auditKey);
  const log = readCollection(storage, 'auditLog');
  log.unshift({
    id: createRecordId('audit'),
    changedAt: new Date().toISOString(),
    ...clone(entry),
  });

  try {
    storage.setItem(collectionKey, JSON.stringify(records));
    storage.setItem(auditKey, JSON.stringify(log.slice(0, 500)));
  } catch (error) {
    restoreRawValue(storage, collectionKey, previousCollection);
    restoreRawValue(storage, auditKey, previousAudit);
    throw error;
  }
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

function validateBackup(payload) {
  if (!payload || typeof payload !== 'object' || payload.format !== BACKUP_FORMAT) {
    throw new TypeError('這不是本程式的備份檔。');
  }
  if (!Number.isInteger(payload.version) || payload.version < 1 || payload.version > BACKUP_VERSION) {
    throw new TypeError('備份檔版本不受支援。');
  }
  if (!payload.data || typeof payload.data !== 'object') throw new TypeError('備份檔缺少資料。');
  COLLECTION_NAMES.forEach((name) => {
    if (payload.data[name] !== undefined && !Array.isArray(payload.data[name])) {
      throw new TypeError(`備份檔的 ${name} 格式不正確。`);
    }
  });
  if (
    payload.data.preferences !== undefined &&
    (!payload.data.preferences || typeof payload.data.preferences !== 'object' || Array.isArray(payload.data.preferences))
  ) {
    throw new TypeError('備份檔的 preferences 格式不正確。');
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

  try {
    pending.forEach((value, key) => storage.setItem(key, value));
  } catch (error) {
    previous.forEach((value, key) => {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    });
    throw error;
  }

  return {
    transactions: readCollection(storage, 'transactions').length,
    dividends: readCollection(storage, 'dividends').length,
    exchanges: readCollection(storage, 'exchanges').length,
    brokers: readCollection(storage, 'brokers').length,
  };
}
