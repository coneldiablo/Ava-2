"use strict";
// Provider reads stage durable previews. Owner publication or explicitly enabled sync updates canonical prices.
const crypto = require("crypto");
const DB = require("../database.service");
const Store = require("./store");
const Catalog = require("../ava-autopilot.store");
const Identity = require("../identity/identity-store");
const currencies = ["RUB", "USD", "EUR", "KZT", "BYN"];
const hash = (v) =>
  crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const positive = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const initialized = new WeakSet();
function schema() {
  Store.schema();
  Catalog.ensureSchema();
  if (initialized.has(DB.db)) return;
  DB.db.exec(`
CREATE TABLE IF NOT EXISTS customer_amo_catalog_previews(id TEXT PRIMARY KEY,instanceId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,accountId TEXT NOT NULL,connectionRevision INTEGER NOT NULL,payloadJson TEXT NOT NULL,createdAt INTEGER NOT NULL,publishedJson TEXT);
CREATE INDEX IF NOT EXISTS amo_catalog_preview_scope ON customer_amo_catalog_previews(instanceId,createdAt);
CREATE TABLE IF NOT EXISTS customer_amo_catalog_sources(instanceId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,accountId TEXT NOT NULL,catalogId TEXT NOT NULL,elementId TEXT NOT NULL,offerId TEXT NOT NULL,sourceHash TEXT NOT NULL,offerHash TEXT NOT NULL,sourceJson TEXT NOT NULL,checkedAt INTEGER NOT NULL,publishedAt INTEGER NOT NULL,PRIMARY KEY(instanceId,accountId,catalogId,elementId));
CREATE TABLE IF NOT EXISTS customer_amo_catalog_settings(instanceId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,payloadJson TEXT NOT NULL,nextAt INTEGER NOT NULL DEFAULT 0,lastError TEXT,lease TEXT,leaseUntil INTEGER,lastSuccessAt INTEGER);`);
  initialized.add(DB.db);
}
function connection(id) {
  Store.scope(id, "amocrm");
  if (
    !DB.get("SELECT 1 FROM instances WHERE id=? AND isActive=1", [Number(id)])
  )
    Store.fail("BUSINESS_NOT_FOUND", 404);
  const c = Store.get(id, "amocrm");
  if (
    !c?.accountId ||
    c.status === "disconnected" ||
    (!c.credentials.accessToken && !c.credentials.refreshToken)
  )
    Store.fail("EXTERNAL_AUTH_REQUIRED", 409);
  return c;
}
function guard(id, c) {
  const now = connection(id);
  if (now.revision !== c.revision || now.accountId !== c.accountId)
    Store.fail("EXTERNAL_CONNECTION_CHANGED", 409);
}
function input(body = {}) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (k) =>
        !["catalogId", "priceFieldId", "unitFieldId", "currency"].includes(k),
    )
  )
    Store.fail("EXTERNAL_CATALOG_MAPPING_INVALID");
  const out = {};
  for (const k of ["catalogId", "priceFieldId", "unitFieldId"])
    if (body[k] != null) {
      if (!positive(body[k])) Store.fail("EXTERNAL_CATALOG_MAPPING_INVALID");
      out[k] = Number(body[k]);
    }
  if (body.currency != null) {
    if (!currencies.includes(body.currency))
      Store.fail("EXTERNAL_CATALOG_CURRENCY_REQUIRED");
    out.currency = body.currency;
  }
  return out;
}
function minor(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const s = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(s)) return null;
  const [a, b = ""] = s.split("."),
    n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  return Number.isSafeInteger(n) && n <= 100000000000 ? n : null;
}
async function pages(api, id, path, key, limit = 250) {
  const rows = [],
    seen = new Set(),
    deadline = Date.now() + 120000;
  let promisedNext = false;
  for (let page = 1; page <= 100; page++) {
    if (Date.now() > deadline) Store.fail("EXTERNAL_CATALOG_TRUNCATED", 502);
    const d = await api(id, "GET", path, null, { page, limit });
    if (d == null || d === "") {
      if (promisedNext) Store.fail("EXTERNAL_CATALOG_TRUNCATED", 502);
      return rows;
    }
    const batch = d?._embedded?.[key];
    if (!Array.isArray(batch) || batch.length > limit)
      Store.fail("EXTERNAL_CATALOG_RESPONSE_INVALID", 502);
    // A promised continuation cannot be accepted as an empty complete snapshot.
    if (promisedNext && batch.length === 0)
      Store.fail("EXTERNAL_CATALOG_TRUNCATED", 502);
    for (const row of batch) {
      if (!positive(row.id) || seen.has(String(row.id)))
        Store.fail("EXTERNAL_CATALOG_DUPLICATE", 502);
      seen.add(String(row.id));
      rows.push(row);
    }
    promisedNext = !!d?._links?.next;
    if (!promisedNext && batch.length < limit) return rows;
    if (batch.length === 0 && d?._links?.next)
      Store.fail("EXTERNAL_CATALOG_RESPONSE_INVALID", 502);
  }
  Store.fail("EXTERNAL_CATALOG_TRUNCATED", 502);
}
function normalize(row, fields, map, catalogId, accountId) {
  if (
    String(row.catalog_id) !== String(catalogId) ||
    String(row.account_id) !== String(accountId)
  )
    Store.fail("EXTERNAL_CATALOG_SCOPE_INVALID", 502);
  const get = (code, id) => {
    const metadata = fields.find((f) =>
      id ? Number(f.id) === Number(id) : f.code === code,
    );
    const values = (row.custom_fields_values || []).filter((f) =>
      metadata
        ? Number(f.field_id) === Number(metadata.id)
        : f.field_code === code,
    );
    if (values.length !== 1 || values[0].values?.length !== 1)
      return { value: null, metadata };
    return { value: values[0].values[0].value, metadata };
  };
  const price = get("PRICE", map.priceFieldId),
    currency = price.metadata?.currency || map.currency || null,
    amountMinor = minor(price.value),
    unit = get("UNIT", map.unitFieldId).value,
    description = get("DESCRIPTION").value,
    sku = get("SKU").value;
  const errors = [];
  if (
    row.is_deleted !== true &&
    (!row.name || typeof row.name !== "string" || row.name.length > 200)
  )
    errors.push("EXTERNAL_CATALOG_NAME_INVALID");
  if (row.is_deleted !== true && amountMinor === null)
    errors.push("EXTERNAL_CATALOG_PRICE_INVALID");
  if (row.is_deleted !== true && !currencies.includes(currency))
    errors.push("EXTERNAL_CATALOG_CURRENCY_REQUIRED");
  if (unit != null && (typeof unit !== "string" || unit.length > 100))
    errors.push("EXTERNAL_CATALOG_UNIT_INVALID");
  if (
    description != null &&
    (typeof description !== "string" || description.length > 4000)
  )
    errors.push("EXTERNAL_CATALOG_DESCRIPTION_INVALID");
  const source = {
    accountId: String(accountId),
    catalogId: String(catalogId),
    elementId: String(row.id),
    updatedAt: row.updated_at ?? null,
    sku: typeof sku === "string" ? sku.slice(0, 255) : null,
    unit: typeof unit === "string" ? unit : null,
    currencySource: price.metadata?.currency
      ? "provider_field"
      : map.currency
        ? "confirmed_mapping"
        : null,
    priceFieldId: price.metadata?.id || null,
  };
  return {
    elementId: String(row.id),
    source,
    sourceHash: hash({ row, fields, map }),
    errors,
    retired: row.is_deleted === true,
    offer: {
      name: typeof row.name === "string" ? row.name : "",
      description: typeof description === "string" ? description : "",
      terms: typeof unit === "string" ? `Единица измерения: ${unit}` : "",
      amountMinor,
      currency,
      active: true,
    },
  };
}
function sources(id, accountId, catalogId = null) {
  return DB.all(
    `SELECT * FROM customer_amo_catalog_sources WHERE instanceId=? AND accountId=?${catalogId == null ? "" : " AND catalogId=?"}`,
    [Number(id), accountId, ...(catalogId == null ? [] : [String(catalogId)])],
  );
}
async function preview(
  id,
  body = {},
  { beforeWrite = null, api = require("./amocrm").api } = {},
) {
  schema();
  const c = connection(id),
    map = input(body);
  if (beforeWrite) beforeWrite();
  const account = await api(id, "GET", "/api/v4/account");
  if (String(account?.id) !== c.accountId)
    Store.fail("EXTERNAL_ACCOUNT_CHANGED", 409);
  const catalogs = await pages(api, id, "/api/v4/catalogs", "catalogs");
  const catalog = catalogs.find(
    (x) => x.type === "products" && (!map.catalogId || x.id === map.catalogId),
  );
  if (!catalog) Store.fail("EXTERNAL_CATALOG_NOT_AVAILABLE", 409);
  map.catalogId = catalog.id;
  const fields = await pages(
    api,
    id,
    `/api/v4/catalogs/${catalog.id}/custom_fields`,
    "custom_fields",
    50,
  );
  if (
    map.priceFieldId &&
    !fields.some((f) => Number(f.id) === map.priceFieldId)
  )
    Store.fail("EXTERNAL_CATALOG_MAPPING_INVALID");
  if (map.unitFieldId && !fields.some((f) => Number(f.id) === map.unitFieldId))
    Store.fail("EXTERNAL_CATALOG_MAPPING_INVALID");
  const raw = await pages(
    api,
    id,
    `/api/v4/catalogs/${catalog.id}/elements`,
    "elements",
  );
  const old = sources(id, c.accountId, catalog.id),
    items = raw.map((row) =>
      normalize(row, fields, map, catalog.id, c.accountId),
    );
  for (const s of old)
    if (!items.some((i) => i.elementId === s.elementId))
      items.push({
        elementId: s.elementId,
        source: JSON.parse(s.sourceJson),
        sourceHash: hash({ missing: true, previous: s.sourceHash }),
        retired: true,
        errors: [],
        offer: null,
      });
  for (const i of items) {
    const s = old.find((s) => s.elementId === i.elementId),
      offer = s ? Catalog.offer(id, s.offerId) : null;
    i.offerId =
      s?.offerId || `amo_${id}_${c.accountId}_${catalog.id}_${i.elementId}`;
    i.expectedOfferHash = offer ? hash(offer) : null;
    i.manuallyChanged = !!s && hash(offer) !== s.offerHash;
  }
  guard(id, c);
  if (beforeWrite) beforeWrite();
  const result = {
    previewId: crypto.randomUUID(),
    accountId: c.accountId,
    catalogId: catalog.id,
    catalogName: String(catalog.name || "").slice(0, 255),
    mapping: map,
    complete: true,
    checkedAt: new Date().toISOString(),
    sourceRevision: hash(items.map((i) => [i.elementId, i.sourceHash]).sort()),
    items,
    errors: items.flatMap((i) =>
      i.errors.map((code) => ({ elementId: i.elementId, code })),
    ),
  };
  DB.run("INSERT INTO customer_amo_catalog_previews VALUES(?,?,?,?,?,?,NULL)", [
    result.previewId,
    Number(id),
    c.accountId,
    c.revision,
    JSON.stringify(result),
    Date.now(),
  ]);
  return result;
}
function publish(id, previewId, { beforeWrite = null } = {}) {
  schema();
  const c = connection(id);
  if (typeof previewId !== "string")
    Store.fail("EXTERNAL_CATALOG_PREVIEW_REQUIRED");
  return DB.db
    .transaction(() => {
      const row = DB.get(
        "SELECT * FROM customer_amo_catalog_previews WHERE id=? AND instanceId=?",
        [previewId, Number(id)],
      );
      if (!row) Store.fail("EXTERNAL_CATALOG_PREVIEW_REQUIRED", 404);
      if (
        row.accountId !== c.accountId ||
        row.connectionRevision !== c.revision
      )
        Store.fail("EXTERNAL_CONNECTION_CHANGED", 409);
      if (row.publishedJson)
        return { ...JSON.parse(row.publishedJson), replayed: true };
      if (Date.now() - row.createdAt > 3600000)
        Store.fail("EXTERNAL_CATALOG_PREVIEW_EXPIRED", 409);
      const p = JSON.parse(row.payloadJson),
        results = [];
      if (beforeWrite) beforeWrite();
      guard(id, c);
      for (const item of p.items) {
        const current = Catalog.offer(id, item.offerId),
          existing = DB.get(
            "SELECT * FROM customer_amo_catalog_sources WHERE instanceId=? AND accountId=? AND catalogId=? AND elementId=?",
            [Number(id), c.accountId, String(p.catalogId), item.elementId],
          );
        if (
          item.manuallyChanged ||
          (current && (!existing || hash(current) !== existing.offerHash)) ||
          (current ? hash(current) : null) !== item.expectedOfferHash
        ) {
          results.push({
            elementId: item.elementId,
            status: "conflict",
            code: "EXTERNAL_CATALOG_LOCAL_CONFLICT",
          });
          continue;
        }
        const retire = item.retired || item.errors.length > 0;
        if (retire && !existing) {
          results.push({
            elementId: item.elementId,
            status: "skipped",
            errors: item.errors,
          });
          continue;
        }
        if (existing?.sourceHash === item.sourceHash && current) {
          DB.run(
            "UPDATE customer_amo_catalog_sources SET checkedAt=? WHERE instanceId=? AND accountId=? AND catalogId=? AND elementId=?",
            [
              Date.now(),
              Number(id),
              c.accountId,
              String(p.catalogId),
              item.elementId,
            ],
          );
          results.push({
            elementId: item.elementId,
            offerId: item.offerId,
            status: "unchanged",
          });
          continue;
        }
        const now = new Date().toISOString(),
          next = {
            ...(retire ? current : item.offer),
            id: item.offerId,
            revision: (current?.revision || 0) + 1,
            active: !retire,
            createdAt: current?.createdAt || now,
            publishedAt: now,
          };
        Catalog.saveOffer(id, next, current?.revision ?? null);
        Catalog.publishOffer(id, next);
        DB.run(
          `INSERT INTO customer_amo_catalog_sources VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instanceId,accountId,catalogId,elementId) DO UPDATE SET sourceHash=excluded.sourceHash,offerHash=excluded.offerHash,sourceJson=excluded.sourceJson,checkedAt=excluded.checkedAt,publishedAt=excluded.publishedAt`,
          [
            Number(id),
            c.accountId,
            String(p.catalogId),
            item.elementId,
            item.offerId,
            item.sourceHash,
            hash(next),
            JSON.stringify(item.source),
            Date.now(),
            Date.now(),
          ],
        );
        results.push({
          elementId: item.elementId,
          offerId: item.offerId,
          revision: next.revision,
          status: retire ? "retired" : "published",
          errors: item.errors,
        });
      }
      const result = {
        previewId,
        sourceRevision: p.sourceRevision,
        publishedAt: new Date().toISOString(),
        results,
      };
      DB.run(
        "UPDATE customer_amo_catalog_previews SET publishedJson=? WHERE id=? AND instanceId=?",
        [JSON.stringify(result), previewId, Number(id)],
      );
      return result;
    })
    .immediate();
}
function state(id) {
  schema();
  Store.scope(id, "amocrm");
  const c = Store.get(id, "amocrm"),
    settings = DB.get(
      "SELECT * FROM customer_amo_catalog_settings WHERE instanceId=?",
      [Number(id)],
    ),
    p = DB.get(
      "SELECT * FROM customer_amo_catalog_previews WHERE instanceId=? AND accountId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1",
      [Number(id), c?.accountId || ""],
    );
  return {
    settings: settings
      ? {
          ...JSON.parse(settings.payloadJson),
          nextAt: settings.nextAt,
          lastError: settings.lastError,
          lastSuccessAt: settings.lastSuccessAt
            ? new Date(settings.lastSuccessAt).toISOString()
            : null,
        }
      : { enabled: false, intervalMinutes: 60 },
    preview: p ? JSON.parse(p.payloadJson) : null,
    publication: p?.publishedJson ? JSON.parse(p.publishedJson) : null,
    sources: c?.accountId
      ? sources(id, c.accountId).map((s) => ({
          ...JSON.parse(s.sourceJson),
          offerId: s.offerId,
          name: Catalog.offer(id, s.offerId)?.name || null,
          amountMinor: Catalog.offer(id, s.offerId)?.amountMinor ?? null,
          currency: Catalog.offer(id, s.offerId)?.currency || null,
          active: Catalog.offer(id, s.offerId)?.active === true,
          sourceRevision: s.sourceHash,
          offerRevision: Catalog.offer(id, s.offerId)?.revision || null,
          checkedAt: new Date(s.checkedAt).toISOString(),
          publishedAt: new Date(s.publishedAt).toISOString(),
          stale: Date.now() - s.checkedAt > 3600000,
          localConflict: hash(Catalog.offer(id, s.offerId)) !== s.offerHash,
        }))
      : [],
  };
}
function settings(id, body, { actorId = null } = {}) {
  schema();
  connection(id);
  if (
    !body ||
    typeof body.enabled !== "boolean" ||
    !Number.isInteger(body.intervalMinutes) ||
    body.intervalMinutes < 5 ||
    body.intervalMinutes > 1440 ||
    Object.keys(body).some(
      (k) => !["enabled", "intervalMinutes", "mapping"].includes(k),
    )
  )
    Store.fail("EXTERNAL_CATALOG_SETTINGS_INVALID");
  const value = {
    enabled: body.enabled,
    intervalMinutes: body.intervalMinutes,
    mapping: input(body.mapping || {}),
  };
  if (value.enabled) {
    if (!actorId) Store.fail("AUTHENTICATION_REQUIRED", 401);
    Identity.authorizeCapability(
      Identity.actor(actorId),
      Number(id),
      "business.manage",
    );
    value.actorId = actorId;
    const authorizedConnection = connection(id);
    value.accountId = authorizedConnection.accountId;
    value.connectionRevision = authorizedConnection.revision;
    const c = connection(id),
      last = DB.get(
        "SELECT payloadJson FROM customer_amo_catalog_previews WHERE instanceId=? AND accountId=? AND publishedJson IS NOT NULL ORDER BY createdAt DESC,rowid DESC LIMIT 1",
        [Number(id), c.accountId],
      );
    if (
      !last ||
      !sources(id, c.accountId, JSON.parse(last.payloadJson).catalogId).length
    )
      Store.fail("EXTERNAL_CATALOG_INITIAL_PUBLISH_REQUIRED", 409);
    const confirmed = JSON.parse(last.payloadJson).mapping;
    if (hash({ ...confirmed, ...value.mapping }) !== hash(confirmed))
      Store.fail("EXTERNAL_CATALOG_MAPPING_CHANGED", 409);
    value.mapping = confirmed;
  }
  DB.run(
    "INSERT INTO customer_amo_catalog_settings(instanceId,payloadJson,nextAt) VALUES(?,?,0) ON CONFLICT(instanceId) DO UPDATE SET payloadJson=excluded.payloadJson,nextAt=0",
    [Number(id), JSON.stringify(value)],
  );
  return state(id);
}
async function refreshDue({ api = require("./amocrm").api } = {}) {
  schema();
  for (const s of DB.all(
    "SELECT s.* FROM customer_amo_catalog_settings s JOIN instances i ON i.id=s.instanceId AND i.isActive=1 WHERE nextAt<=? AND json_extract(s.payloadJson,'$.enabled')=1 LIMIT 5",
    [Date.now()],
  )) {
    const value = JSON.parse(s.payloadJson);
    if (!value.enabled) continue;
    const lease = crypto.randomUUID();
    if (
      !DB.run(
        "UPDATE customer_amo_catalog_settings SET lease=?,leaseUntil=? WHERE instanceId=? AND (lease IS NULL OR leaseUntil<?)",
        [lease, Date.now() + 600000, s.instanceId, Date.now()],
      ).changes
    )
      continue;
    let error = null;
    try {
      const authorize = () => {
        if (!value.actorId) Store.fail("AUTHENTICATION_REQUIRED", 401);
        Identity.authorizeCapability(
          Identity.actor(value.actorId),
          Number(s.instanceId),
          "business.manage",
        );
      };
      authorize();
      const c = connection(s.instanceId);
      if (
        c.accountId !== value.accountId ||
        c.revision !== value.connectionRevision
      )
        Store.fail("EXTERNAL_CONNECTION_CHANGED", 409);
      const p = await preview(s.instanceId, value.mapping, {
        api,
        beforeWrite: authorize,
      });
      const current = DB.get(
        "SELECT payloadJson FROM customer_amo_catalog_settings WHERE instanceId=? AND lease=?",
        [s.instanceId, lease],
      );
      if (
        current &&
        current.payloadJson === s.payloadJson &&
        JSON.parse(current.payloadJson).enabled
      ) {
        const publication = publish(s.instanceId, p.previewId, {
          beforeWrite: authorize,
        });
        if (publication.results.some((r) => r.status === "conflict"))
          error = "EXTERNAL_CATALOG_LOCAL_CONFLICT";
      }
    } catch (e) {
      error =
        /^(EXTERNAL_|BUSINESS_|ACCOUNT_|CAPABILITY_|AUTHENTICATION_)/.test(
          e.code || "",
        )
          ? e.code
          : "EXTERNAL_CATALOG_REFRESH_FAILED";
    }
    DB.run(
      "UPDATE customer_amo_catalog_settings SET lease=NULL,leaseUntil=NULL,nextAt=?,lastError=?,lastSuccessAt=CASE WHEN ? IS NULL THEN ? ELSE lastSuccessAt END WHERE instanceId=? AND lease=? AND payloadJson=?",
      [
        Date.now() + value.intervalMinutes * 60000,
        error,
        error,
        Date.now(),
        s.instanceId,
        lease,
        s.payloadJson,
      ],
    );
    DB.run(
      "UPDATE customer_amo_catalog_settings SET lease=NULL,leaseUntil=NULL WHERE instanceId=? AND lease=?",
      [s.instanceId, lease],
    );
  }
}
module.exports = {
  schema,
  input,
  minor,
  normalize,
  preview,
  publish,
  state,
  settings,
  refreshDue,
};
