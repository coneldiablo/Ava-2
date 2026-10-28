'use strict';

const crypto = require('crypto');
const DB = require('../database.service');
const running = new WeakMap();
const VERSION = 1;
const LEASE_MS = 90_000; // Model requests have a shorter, bounded deadline.

function ensure() {
    DB.run(`CREATE TABLE IF NOT EXISTS dashboard_period_overviews (
        businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, start TEXT NOT NULL, endExclusive TEXT NOT NULL,
        version INTEGER NOT NULL, content TEXT, lease TEXT, leaseUntil INTEGER,
        PRIMARY KEY(businessId,kind,start,endExclusive,version))`);
}

function canceled() {
    return Object.assign(new Error('DASHBOARD_MODEL_CANCELED'), { code: 'DASHBOARD_MODEL_CANCELED', statusCode: 499 });
}

// Navigating away cancels only the HTTP subscriber. The shared generation must
// finish and persist so that reloading cannot continually start/cancel the AI.
function observe(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(canceled());
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(canceled()); };
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
            error => { signal.removeEventListener('abort', abort); reject(error); });
    });
}

function once(businessId, window, produce, signal) {
    if (signal?.aborted) return Promise.reject(canceled());
    ensure();
    const connection = DB.db;
    const params = [Number(businessId), window.kind, window.start, window.endExclusive, VERSION];
    const where = 'businessId=? AND kind=? AND start=? AND endExclusive=? AND version=?';
    const saved = connection.prepare(`SELECT content FROM dashboard_period_overviews WHERE ${where}`).get(...params);
    if (saved?.content) return observe(Promise.resolve(JSON.parse(saved.content)), signal);
    let jobs = running.get(connection);
    if (!jobs) { jobs = new Map(); running.set(connection, jobs); }
    const key = JSON.stringify(params);
    if (!jobs.has(key)) {
        const task = Promise.resolve().then(async () => {
            const token = crypto.randomUUID();
            const deadline = Date.now() + LEASE_MS + 50_000;
            try {
                while (true) {
                    connection.prepare(`INSERT INTO dashboard_period_overviews
                        (businessId,kind,start,endExclusive,version,lease,leaseUntil) VALUES (?,?,?,?,?,?,?)
                        ON CONFLICT(businessId,kind,start,endExclusive,version) DO UPDATE
                        SET lease=excluded.lease,leaseUntil=excluded.leaseUntil
                        WHERE content IS NULL AND leaseUntil<=?`).run(...params, token, Date.now() + LEASE_MS, Date.now());
                    const row = connection.prepare(`SELECT content,lease FROM dashboard_period_overviews WHERE ${where}`).get(...params);
                    if (row?.content) return JSON.parse(row.content);
                    if (row?.lease === token) break;
                    if (Date.now() >= deadline) throw Object.assign(new Error('DASHBOARD_MODEL_BUSY'), { code: 'DASHBOARD_MODEL_BUSY', statusCode: 429 });
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                const result = await produce();
                if (result.answerStatus === 'unavailable') throw Object.assign(new Error('DASHBOARD_FACTS_UNAVAILABLE'), { code: 'DASHBOARD_FACTS_UNAVAILABLE', statusCode: 503 });
                const update = connection.prepare(`UPDATE dashboard_period_overviews SET content=?,lease=NULL,leaseUntil=NULL
                    WHERE ${where} AND lease=? AND content IS NULL`).run(JSON.stringify(result), ...params, token);
                if (!update.changes) throw new Error('OVERVIEW_LEASE_LOST');
                return result;
            } catch (error) {
                connection.prepare(`DELETE FROM dashboard_period_overviews WHERE ${where} AND lease=? AND content IS NULL`).run(...params, token);
                throw error;
            } finally { jobs.delete(key); }
        });
        jobs.set(key, task);
    }
    return observe(jobs.get(key), signal);
}

module.exports = { once };
