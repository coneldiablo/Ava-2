"use strict";
const { describe, it, assert, createTestDB } = require("./test-helper");
const DB = require("../src/services/database.service");
const Store = require("../src/services/integrations/store");
const Catalog = require("../src/services/ava-autopilot.store");
const Products = require("../src/services/integrations/amocrm-catalog");
const Amo = require("../src/services/integrations/amocrm");
const axios = require("axios");
const Identity = require("../src/services/identity/identity-store");
async function fixture(fn) {
  createTestDB();
  process.env.CHANNEL_CREDENTIALS_MASTER_KEY = "11".repeat(32);
  const a = await DB.createInstance({ name: "A" }),
    b = await DB.createInstance({ name: "B" });
  Store.save(
    a.id,
    "amocrm",
    { domain: "fixture.amocrm.ru", mapping: {} },
    {
      accessToken: "fixture",
      refreshToken: "fixture",
      expiresAt: Date.now() + 3600000,
    },
  );
  Store.patch(a.id, "amocrm", { accountId: "101", status: "connected" });
  const model = {
    rows: [element(1, "12.34")],
    currency: "RUB",
    calls: [],
    fail: null,
  };
  const api = async (id, method, path, data, params) => {
    model.calls.push({ id, method, path, params });
    assert.equal(method, "GET");
    if (model.fail && path.includes(model.fail))
      throw Object.assign(new Error("fixture"), {
        code: "EXTERNAL_PROVIDER_UNAVAILABLE",
      });
    if (path === "/api/v4/account") return { id: 101 };
    if (path === "/api/v4/catalogs")
      return {
        _embedded: { catalogs: [{ id: 7, type: "products", name: "Товары" }] },
      };
    if (path.endsWith("/custom_fields"))
      return {
        _embedded: {
          custom_fields: [
            {
              id: 11,
              code: "PRICE",
              type: "monetary",
              currency: model.currency,
            },
            { id: 12, code: "UNIT" },
            { id: 13, code: "DESCRIPTION" },
          ],
        },
      };
    return { _embedded: { elements: params.page === 1 ? model.rows : [] } };
  };
  const oldActor = Identity.actor,
    oldAuthorize = Identity.authorizeCapability;
  Identity.actor = (id) => ({ userId: id });
  Identity.authorizeCapability = () => {};
  try {
    await fn({ a, b, model, api });
  } finally {
    Identity.actor = oldActor;
    Identity.authorizeCapability = oldAuthorize;
  }
}
function element(id, value) {
  return {
    id,
    account_id: 101,
    catalog_id: 7,
    name: "Товар " + id,
    updated_at: 1,
    custom_fields_values: [
      { field_id: 11, field_code: "PRICE", values: [{ value }] },
      { field_id: 12, field_code: "UNIT", values: [{ value: "кг" }] },
      {
        field_id: 13,
        field_code: "DESCRIPTION",
        values: [{ value: "Описание" }],
      },
    ],
  };
}
async function initial(f) {
  const p = await Products.preview(f.a.id, {}, { api: f.api });
  Products.publish(f.a.id, p.previewId);
  return p;
}
describe("amo catalog durable publication", () => {});
it("stages real product price without publishing and publishes once with unit, canonical revision and tenant isolation", () =>
  fixture(async (f) => {
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    assert.equal(Catalog.publishedOffers(f.a.id).length, 0);
    const r = Products.publish(f.a.id, p.previewId);
    assert.equal(r.results[0].status, "published");
    const o = Catalog.publishedOffers(f.a.id)[0];
    assert.equal(o.amountMinor, 1234);
    assert.equal(o.currency, "RUB");
    assert.match(o.terms, /кг/);
    assert.equal(o.description, "Описание");
    assert.equal(Catalog.publishedOffers(f.b.id).length, 0);
    assert.equal(Products.publish(f.a.id, p.previewId).replayed, true);
    assert.equal(DB.get("SELECT count(*) n FROM ava_catalog_versions").n, 1);
    assert.throws(
      () => Products.publish(f.b.id, p.previewId),
      (e) => e.code === "EXTERNAL_AUTH_REQUIRED",
    );
  }));
it("updates source identity in place and leaves existing quote revision stale", () =>
  fixture(async (f) => {
    await initial(f);
    const before = Catalog.publishedOffers(f.a.id)[0];
    f.model.rows[0] = element(1, "19.99");
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    Products.publish(f.a.id, p.previewId);
    const after = Catalog.publishedOffers(f.a.id)[0];
    assert.equal(after.id, before.id);
    assert.equal(after.amountMinor, 1999);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(Products.state(f.a.id).sources[0].offerRevision, 2);
  }));
it("unchanged snapshots do not create duplicate offers or revisions", () =>
  fixture(async (f) => {
    await initial(f);
    await initial(f);
    assert.equal(Catalog.offers(f.a.id).length, 1);
    assert.equal(Catalog.offers(f.a.id)[0].revision, 1);
  }));
it("preserves manual and CSV rows, detects manual edit of an imported row", () =>
  fixture(async (f) => {
    await initial(f);
    const imported = Catalog.offers(f.a.id)[0];
    Catalog.saveOffer(f.a.id, {
      ...imported,
      name: "Ручная правка",
      revision: 2,
    });
    Catalog.saveOffer(f.a.id, {
      id: "csv",
      name: "CSV",
      revision: 1,
      active: true,
      publishedAt: "now",
      amountMinor: 1,
      currency: "RUB",
    });
    f.model.rows[0] = element(1, "50");
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    assert.equal(
      Products.publish(f.a.id, p.previewId).results[0].status,
      "conflict",
    );
    assert.equal(Catalog.offer(f.a.id, imported.id).name, "Ручная правка");
    assert.equal(Catalog.offer(f.a.id, "csv").active, true);
  }));
it("detects a manual edit after preview and concurrent stale previews", () =>
  fixture(async (f) => {
    await initial(f);
    f.model.rows[0] = element(1, "20");
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    const q = await Products.preview(f.a.id, {}, { api: f.api });
    Products.publish(f.a.id, p.previewId);
    assert.equal(
      Products.publish(f.a.id, q.previewId).results[0].status,
      "conflict",
    );
  }));
it("missing invalid prices never become zero; existing invalid source retires only after publication", () =>
  fixture(async (f) => {
    await initial(f);
    f.model.rows = [element(1, ""), element(2, null), element(3, "0")];
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    assert.equal(p.errors.length, 2);
    assert.equal(Catalog.publishedOffers(f.a.id).length, 1);
    const r = Products.publish(f.a.id, p.previewId);
    assert.equal(r.results[0].status, "retired");
    assert.equal(r.results[1].status, "skipped");
    assert.equal(Catalog.publishedOffers(f.a.id)[0].amountMinor, 0);
  }));
it("requires explicit currency for numeric PRICE and respects monetary provider currency", () =>
  fixture(async (f) => {
    f.model.currency = null;
    let p = await Products.preview(f.a.id, {}, { api: f.api });
    assert.equal(p.items[0].offer.currency, null);
    assert(p.items[0].errors.includes("EXTERNAL_CATALOG_CURRENCY_REQUIRED"));
    p = await Products.preview(f.a.id, { currency: "USD" }, { api: f.api });
    assert.equal(p.items[0].offer.currency, "USD");
    assert.equal(p.items[0].source.currencySource, "confirmed_mapping");
    f.model.currency = "EUR";
    p = await Products.preview(f.a.id, { currency: "USD" }, { api: f.api });
    assert.equal(p.items[0].offer.currency, "EUR");
  }));
it("full empty snapshot retires only owned products", () =>
  fixture(async (f) => {
    await initial(f);
    Catalog.saveOffer(f.a.id, {
      id: "manual",
      name: "manual",
      revision: 1,
      active: true,
      publishedAt: "now",
    });
    f.model.rows = [];
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    Products.publish(f.a.id, p.previewId);
    assert.equal(Catalog.publishedOffers(f.a.id).length, 1);
    assert.equal(Catalog.publishedOffers(f.a.id)[0].id, "manual");
  }));
it("duplicate response aborts without a preview or mass deletion", () =>
  fixture(async (f) => {
    await initial(f);
    f.model.rows.push(element(1, "99"));
    await assert.rejects(
      () => Products.preview(f.a.id, {}, { api: f.api }),
      (e) => e.code === "EXTERNAL_CATALOG_DUPLICATE",
    );
    assert.equal(Catalog.publishedOffers(f.a.id).length, 1);
    assert.equal(
      DB.get("SELECT count(*) n FROM customer_amo_catalog_previews").n,
      1,
    );
  }));
it("partial pagination failure preserves canonical rows and rejects publication snapshot", () =>
  fixture(async (f) => {
    await initial(f);
    let calls = 0;
    const api = async (...args) => {
      if (args[2].endsWith("/elements")) {
        calls++;
        if (calls === 1)
          return {
            _embedded: { elements: [element(2, "3")] },
            _links: { next: { href: "untrusted" } },
          };
        throw Object.assign(new Error(), {
          code: "EXTERNAL_PROVIDER_UNAVAILABLE",
        });
      }
      return f.api(...args);
    };
    await assert.rejects(() => Products.preview(f.a.id, {}, { api }));
    assert.equal(Catalog.publishedOffers(f.a.id).length, 1);
    assert.equal(
      DB.get("SELECT count(*) n FROM customer_amo_catalog_previews").n,
      1,
    );
  }));
it("bounded pagination rejects truncation and never follows arbitrary next URLs", () =>
  fixture(async (f) => {
    let calls = 0;
    const api = async (...args) => {
      if (args[2].endsWith("/elements"))
        return {
          _embedded: { elements: [element(++calls, "1")] },
          _links: { next: { href: "https://evil.test/" } },
        };
      return f.api(...args);
    };
    await assert.rejects(
      () => Products.preview(f.a.id, {}, { api }),
      (e) => e.code === "EXTERNAL_CATALOG_TRUNCATED",
    );
    assert.equal(calls, 100);
    assert.equal(Catalog.publishedOffers(f.a.id).length, 0);
  }));
it("connection revision change during fetch rejects staging and old preview publication", () =>
  fixture(async (f) => {
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    Store.disconnect(f.a.id, "amocrm");
    assert.throws(
      () => Products.publish(f.a.id, p.previewId),
      (e) => e.code === "EXTERNAL_AUTH_REQUIRED",
    );
    assert.equal(Catalog.publishedOffers(f.a.id).length, 0);
  }));
it("account mismatch cannot import another account", () =>
  fixture(async (f) => {
    f.model.rows[0].account_id = 999;
    await assert.rejects(
      () => Products.preview(f.a.id, {}, { api: f.api }),
      (e) => e.code === "EXTERNAL_CATALOG_SCOPE_INVALID",
    );
  }));
it("expiry prevents publication", () =>
  fixture(async (f) => {
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    DB.run("UPDATE customer_amo_catalog_previews SET createdAt=0");
    assert.throws(
      () => Products.publish(f.a.id, p.previewId),
      (e) => e.code === "EXTERNAL_CATALOG_PREVIEW_EXPIRED",
    );
  }));
it("scheduled enabled update publishes latest prices and disabling stops reads", () =>
  fixture(async (f) => {
    assert.throws(
      () =>
        Products.settings(
          f.a.id,
          { enabled: true, intervalMinutes: 5 },
          { actorId: "owner" },
        ),
      (e) => e.code === "EXTERNAL_CATALOG_INITIAL_PUBLISH_REQUIRED",
    );
    await initial(f);
    Products.settings(
      f.a.id,
      { enabled: true, intervalMinutes: 5 },
      { actorId: "owner" },
    );
    f.model.rows = [element(1, "99.10")];
    await Products.refreshDue({ api: f.api });
    assert.equal(Catalog.publishedOffers(f.a.id)[0].amountMinor, 9910);
    assert.equal(Products.state(f.a.id).settings.lastError, null);
    Products.settings(f.a.id, { enabled: false, intervalMinutes: 5 });
    const n = f.model.calls.length;
    await Products.refreshDue({ api: f.api });
    assert.equal(f.model.calls.length, n);
  }));
it("scheduled errors and leases are durable and do not destroy offers", () =>
  fixture(async (f) => {
    await initial(f);
    Products.settings(
      f.a.id,
      { enabled: true, intervalMinutes: 5 },
      { actorId: "owner" },
    );
    DB.run("UPDATE customer_amo_catalog_settings SET lease=?,leaseUntil=?", [
      "held",
      Date.now() + 600000,
    ]);
    const n = f.model.calls.length;
    await Products.refreshDue({ api: f.api });
    assert.equal(f.model.calls.length, n);
    DB.run("UPDATE customer_amo_catalog_settings SET lease=NULL");
    f.model.fail = "/elements";
    await Products.refreshDue({ api: f.api });
    assert.equal(
      Products.state(f.a.id).settings.lastError,
      "EXTERNAL_PROVIDER_UNAVAILABLE",
    );
    assert.equal(Catalog.publishedOffers(f.a.id).length, 1);
  }));
it("scheduled refresh preserves owner edits and exposes conflict", () =>
  fixture(async (f) => {
    await initial(f);
    Products.settings(
      f.a.id,
      { enabled: true, intervalMinutes: 5 },
      { actorId: "owner" },
    );
    const o = Catalog.offers(f.a.id)[0];
    Catalog.saveOffer(f.a.id, { ...o, amountMinor: 100, revision: 2 });
    await Products.refreshDue({ api: f.api });
    assert.equal(Catalog.offers(f.a.id)[0].amountMinor, 100);
    assert.equal(
      Products.state(f.a.id).settings.lastError,
      "EXTERNAL_CATALOG_LOCAL_CONFLICT",
    );
  }));
it("rechecks permission before storing/publishing", () =>
  fixture(async (f) => {
    await assert.rejects(() =>
      Products.preview(
        f.a.id,
        {},
        {
          api: f.api,
          beforeWrite: () => {
            throw Object.assign(new Error(), { code: "CAPABILITY_REQUIRED" });
          },
        },
      ),
    );
    assert.equal(f.model.calls.length, 0);
    const p = await Products.preview(f.a.id, {}, { api: f.api });
    assert.throws(() =>
      Products.publish(f.a.id, p.previewId, {
        beforeWrite: () => {
          throw new Error("revoked");
        },
      }),
    );
    assert.equal(Catalog.publishedOffers(f.a.id).length, 0);
  }));
it("uses actual existing OAuth refresh before reading products", () =>
  fixture(async (f) => {
    Store.patch(f.a.id, "amocrm", {
      credentials: {
        accessToken: "expired",
        refreshToken: "refresh",
        clientId: "id",
        clientSecret: "secret",
        expiresAt: 0,
      },
    });
    const original = axios.request;
    let refresh = 0;
    axios.request = async (c) => {
      if (c.url.endsWith("/oauth2/access_token")) {
        refresh++;
        return {
          data: {
            access_token: "new",
            refresh_token: "rotated",
            expires_in: 3600,
          },
        };
      }
      assert.equal(c.headers.Authorization, "Bearer new");
      return {
        data: await f.api(
          f.a.id,
          c.method,
          new URL(c.url).pathname,
          null,
          c.params,
        ),
      };
    };
    try {
      const p = await Products.preview(f.a.id);
      assert.equal(p.items[0].offer.amountMinor, 1234);
      assert.equal(refresh, 1);
    } finally {
      axios.request = original;
    }
  }));
it("canonical published source reaches AI context and quote/invoice lines, then rejects stale revisions", () =>
  fixture(async (f) => {
    await initial(f);
    const Knowledge = require("../src/services/knowledge-local.service"),
      Studio = require("../src/services/customer-studio.service");
    const offer = Catalog.publishedOffers(f.a.id)[0];
    assert(
      Knowledge.catalogContext(f.a.id, "Каталог").some(
        (o) => o.offerId === offer.id,
      ),
    );
    assert.equal(Studio.catalog(f.a.id)[0].amountMinor, 1234);
    const lines = Studio.validateLines(f.a.id, [
      { offerId: offer.id, offerRevision: offer.revision, quantity: 2 },
    ]);
    assert.equal(lines[0].totalMinor, 2468);
    f.model.rows = [element(1, "19")];
    await initial(f);
    assert.throws(
      () =>
        Studio.validateLines(f.a.id, [
          { offerId: offer.id, offerRevision: offer.revision, quantity: 2 },
        ]),
      (e) => e.code === "STUDIO_CATALOG_CHANGED",
    );
  }));
it("rechecks scheduled owner permission and prevents publication after account/config reconnect", () =>
  fixture(async (f) => {
    await initial(f);
    Products.settings(
      f.a.id,
      { enabled: true, intervalMinutes: 5 },
      { actorId: "owner" },
    );
    Identity.authorizeCapability = () => {
      throw Object.assign(new Error(), { code: "CAPABILITY_DENIED" });
    };
    const n = f.model.calls.length;
    await Products.refreshDue({ api: f.api });
    assert.equal(f.model.calls.length, n);
    assert.equal(
      Products.state(f.a.id).settings.lastError,
      "CAPABILITY_DENIED",
    );
    Identity.authorizeCapability = () => {};
    DB.run("UPDATE customer_amo_catalog_settings SET nextAt=0");
    DB.run(
      "UPDATE customer_external_connections SET revision=revision+1 WHERE instanceId=?",
      [f.a.id],
    );
    await Products.refreshDue({ api: f.api });
    assert.equal(f.model.calls.length, n);
    assert.equal(
      Products.state(f.a.id).settings.lastError,
      "EXTERNAL_CONNECTION_CHANGED",
    );
  }));
it("disable during provider read cancels automatic publication", () =>
  fixture(async (f) => {
    await initial(f);
    Products.settings(
      f.a.id,
      { enabled: true, intervalMinutes: 5 },
      { actorId: "owner" },
    );
    f.model.rows = [element(1, "99")];
    const api = async (...args) => {
      if (args[2].endsWith("/elements"))
        Products.settings(f.a.id, { enabled: false, intervalMinutes: 5 });
      return f.api(...args);
    };
    await Products.refreshDue({ api });
    assert.equal(Catalog.publishedOffers(f.a.id)[0].amountMinor, 1234);
    assert.equal(Products.state(f.a.id).settings.enabled, false);
    assert.equal(Products.state(f.a.id).settings.nextAt, 0);
    assert.equal(
      DB.get("SELECT lease FROM customer_amo_catalog_settings").lease,
      null,
    );
  }));
it("all catalog-owned tables cascade on business deletion", () =>
  fixture(async (f) => {
    await initial(f);
    Products.settings(
      f.a.id,
      { enabled: true, intervalMinutes: 5 },
      { actorId: "owner" },
    );
    for (const table of [
      "customer_amo_catalog_previews",
      "customer_amo_catalog_sources",
      "customer_amo_catalog_settings",
    ]) {
      const key = DB.all("PRAGMA foreign_key_list(" + table + ")").find(
        (r) => r.from === "instanceId",
      );
      assert.equal(key.table, "instances");
      assert.equal(key.on_delete, "CASCADE");
    }
    DB.run("DELETE FROM customer_external_connections WHERE instanceId=?", [
      f.a.id,
    ]);
    DB.run("DELETE FROM instances WHERE id=?", [f.a.id]);
    for (const table of [
      "customer_amo_catalog_previews",
      "customer_amo_catalog_sources",
      "customer_amo_catalog_settings",
    ])
      assert.equal(DB.get("SELECT count(*) n FROM " + table).n, 0);
  }));
it("new catalog routes deny wrong tenant, session and cross-origin writes", () =>
  fixture(async (f) => {
    process.env.WHATSAPP_CRM_PUBLIC_URL = "https://ava.example.test";
    const router = require("../src/routes/customer-external-integrations.routes"),
      Auth = require("../src/services/auth.service");
    const old = Auth.getSession;
    Auth.getSession = (r) => r.auth;
    Identity.authorizeCapability = (actor, id) => {
      if (actor.userId !== "owner" || id !== f.a.id)
        throw Object.assign(new Error(), {
          code: "CAPABILITY_DENIED",
          statusCode: 403,
        });
    };
    try {
      for (const suffix of ["/preview", "/publish", "/settings"]) {
        const layer = router.stack.find(
          (l) =>
            l.route?.path ===
            "/external-integrations/:instanceId/amocrm/catalog" + suffix,
        );
        const handler = layer.route.stack.at(-1).handle;
        for (const bad of ["tenant", "session", "origin"]) {
          const res = {
            statusCode: 200,
            set() {},
            status(n) {
              this.statusCode = n;
              return this;
            },
            json(v) {
              this.body = v;
              return this;
            },
          };
          await handler(
            {
              method: suffix === "/settings" ? "PUT" : "POST",
              params: {
                instanceId: String(bad === "tenant" ? f.b.id : f.a.id),
              },
              body: {},
              query: {},
              auth: { userId: bad === "session" ? "other" : "owner" },
              get: (k) =>
                k === "origin"
                  ? bad === "origin"
                    ? "https://evil.test"
                    : "https://ava.example.test"
                  : null,
            },
            res,
          );
          assert.equal(res.statusCode, 403);
          assert.equal(res.body.success, false);
        }
      }
    } finally {
      Auth.getSession = old;
    }
  }));
it("scheduled promised continuation emptiness fails closed without retiring published products", () =>
  fixture(async (f) => {
    f.model.rows = [element(1, "12.34"), element(2, "20"), element(3, "30")];
    await initial(f);
    Products.settings(
      f.a.id,
      { enabled: true, intervalMinutes: 5 },
      { actorId: "owner" },
    );
    const original = axios.request;
    const baseline = Catalog.publishedOffers(f.a.id);
    const storedPreviews = DB.get(
      "SELECT count(*) n FROM customer_amo_catalog_previews",
    ).n;
    const publishedPreviews = DB.get(
      "SELECT count(*) n FROM customer_amo_catalog_previews WHERE publishedJson IS NOT NULL",
    ).n;
    const requests = [];
    let emptyFullSnapshot = false,
      continuation;
    axios.request = async (config) => {
      requests.push({
        method: config.method,
        path: new URL(config.url).pathname,
        page: config.params?.page,
      });
      assert.equal(config.method, "GET");
      const path = new URL(config.url).pathname;
      if (!path.endsWith("/elements"))
        return {
          data: await f.api(f.a.id, config.method, path, null, config.params),
        };
      if (emptyFullSnapshot) return { data: { _embedded: { elements: [] } } };
      if (config.params.page === 1)
        return {
          data: {
            _embedded: { elements: [element(1, "99")] },
            _links: {
              next: {
                href: "https://fixture.amocrm.ru/api/v4/catalogs/7/elements?page=2",
              },
            },
          },
        };
      return { status: 204, data: continuation };
    };
    try {
      for (continuation of [
        null,
        undefined,
        "",
        { _embedded: { elements: [] } },
      ]) {
        DB.run("UPDATE customer_amo_catalog_settings SET nextAt=0");
        await Products.refreshDue();
        assert.deepEqual(Catalog.publishedOffers(f.a.id), baseline);
        assert.equal(
          DB.get("SELECT count(*) n FROM customer_amo_catalog_previews").n,
          storedPreviews,
        );
        assert.equal(
          DB.get(
            "SELECT count(*) n FROM customer_amo_catalog_previews WHERE publishedJson IS NOT NULL",
          ).n,
          publishedPreviews,
        );
        assert.equal(
          Products.state(f.a.id).settings.lastError,
          "EXTERNAL_CATALOG_TRUNCATED",
        );
        assert.equal(Products.state(f.a.id).settings.lastSuccessAt, null);
      }
      assert.equal(
        requests.filter((r) => r.path.endsWith("/elements") && r.page === 2)
          .length,
        4,
      );
      assert(requests.every((r) => r.method === "GET"));
      // Legitimate complete emptiness on page one still permits owner-authorized retirement.
      Products.settings(f.a.id, { enabled: false, intervalMinutes: 5 });
      emptyFullSnapshot = true;
      const preview = await Products.preview(f.a.id);
      assert.equal(preview.complete, true);
      assert.equal(Catalog.publishedOffers(f.a.id).length, 3);
      const publication = Products.publish(f.a.id, preview.previewId);
      assert.equal(
        publication.results.filter((r) => r.status === "retired").length,
        3,
      );
      assert.equal(Catalog.publishedOffers(f.a.id).length, 0);
      assert(requests.every((r) => r.method === "GET"));
    } finally {
      axios.request = original;
    }
  }));
