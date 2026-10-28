'use strict';

const DB = require('../database.service');
const initialized = new WeakSet();

function ensureSchema() {
    if (!DB.db) throw new Error('DASHBOARD_METRICS_UNAVAILABLE');
    if (initialized.has(DB.db)) return;
    // Called after customer_deals exists. SQLite fires these triggers inside the
    // same transaction as the deal write, so a failed update cannot leave an event.
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS dashboard_deal_won_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instanceId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
            dealId TEXT NOT NULL,
            amountMinor INTEGER NOT NULL,
            currency TEXT NOT NULL,
            occurredAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dashboard_deal_won_scope_time
            ON dashboard_deal_won_events(instanceId, occurredAt);
        CREATE TABLE IF NOT EXISTS dashboard_metrics_coverage (
            instanceId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
            trackingStartedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TRIGGER IF NOT EXISTS dashboard_deal_won_insert
        AFTER INSERT ON customer_deals WHEN NEW.stage = 'won'
        BEGIN
            INSERT INTO dashboard_deal_won_events(instanceId,dealId,amountMinor,currency)
            VALUES (NEW.instanceId,NEW.id,NEW.amountMinor,NEW.currency);
        END;
        CREATE TRIGGER IF NOT EXISTS dashboard_deal_won_transition
        AFTER UPDATE OF stage ON customer_deals
        WHEN OLD.stage <> 'won' AND NEW.stage = 'won'
        BEGIN
            INSERT INTO dashboard_deal_won_events(instanceId,dealId,amountMinor,currency)
            VALUES (NEW.instanceId,NEW.id,NEW.amountMinor,NEW.currency);
        END;
    `);
    initialized.add(DB.db);
}

function markTenant(instanceId) {
    ensureSchema();
    DB.run('INSERT OR IGNORE INTO dashboard_metrics_coverage(instanceId) VALUES (?)', [instanceId]);
}

module.exports = { ensureSchema, markTenant };
