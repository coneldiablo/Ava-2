'use strict';

// Run directly with Node. This is a characterization of the 9b0c961 baseline,
// not a contract for the replacement Ask implementation.
const { strict: assert } = require('node:assert');
const express = require('express');
const { createTestDB } = require('../test-helper');
const DB = require('../../src/services/database.service');
const Identity = require('../../src/services/identity/identity-store');
const Auth = require('../../src/services/auth.service');
const Deals = require('../../src/services/customer-deals.store');
const AI = require('../../src/services/dashboard/ai');
const Knowledge = require('../../src/services/dashboard/ai.knowledge');
const routes = require('../../src/routes/dashboard-ai.routes');

async function main() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name,hotelTimezone) VALUES (1,'Business A','Europe/Moscow'),(2,'Business B','America/New_York')");
    DB.run("INSERT INTO ava_users(id,email,displayName) VALUES ('qa-a','qa-a@example.test','QA A')");
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('qa-a',1,'hotel_owner')");
    const from = '2026-09-28T00:00:00.000Z';
    const to = '2026-09-29T00:00:00.000Z';
    DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
        [1, 'lead-a', 'Tenant A lead', 'new', '2026-09-28T10:00:00.000Z']);
    DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
        [2, 'lead-b', 'FOREIGN_TENANT_MARKER', 'new', '2026-09-28T11:00:00.000Z']);
    Deals.create(1, { title: 'Tenant A follow-up', nextActionAt: '2026-09-28' });
    Deals.create(2, { title: 'FOREIGN_DEAL_MARKER', nextActionAt: '2026-09-28' });

    const previousSession = Auth.getSession;
    const previousKnowledge = Knowledge.askKnowledge;
    let knowledgeCalls = 0;
    Auth.getSession = () => ({ userId: 'qa-a' });
    Knowledge.askKnowledge = async () => { knowledgeCalls++; throw new Error('unexpected knowledge call'); };
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => { req.auth = { userId: 'qa-a' }; next(); });
    app.use('/api', routes);
    const listener = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const ask = async (businessId, question) => {
        const response = await fetch(`${base}/api/dashboard/${businessId}/ai/ask`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
            body: JSON.stringify({ question, from, to }),
        });
        return { status: response.status, body: await response.json() };
    };

    try {
        const churnOne = await ask(1, 'Кто из клиентов рискует уйти?');
        const churnTwo = await ask(1, 'Почему клиент Иван рискует уйти и что ему предложить?');
        const forecastOne = await ask(1, 'Прогноз выручки на квартал');
        const forecastTwo = await ask(1, 'Каков прогноз выручки по сделке Tenant A follow-up?');
        for (const result of [churnOne, churnTwo, forecastOne, forecastTwo]) {
            assert.equal(result.status, 200);
            assert.equal(result.body.success, true);
            assert.equal(result.body.provenance, 'crm_records');
            assert.ok(!JSON.stringify(result.body).includes('FOREIGN_'));
        }
        assert.equal(churnOne.body.answer, churnTwo.body.answer);
        assert.equal(forecastOne.body.answer, forecastTwo.body.answer);
        assert.equal(knowledgeCalls, 0);
        assert.equal((await ask(2, 'Кто из клиентов рискует уйти?')).status, 403);

        const range = { from, to };
        const before = AI.snapshot(1, range);
        DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
            [1, 'lead-a-new', 'Newly saved lead', 'new', '2026-09-28T12:00:00.000Z']);
        const immediatelyAfterSave = AI.snapshot(1, range);
        assert.equal(immediatelyAfterSave.facts.newClientCount, before.facts.newClientCount);
        const moscowNight = AI.nightPeriod(1, new Date('2026-09-28T23:00:00.000Z'));
        const newYorkNight = AI.nightPeriod(2, new Date('2026-09-28T23:00:00.000Z'));
        assert.notDeepEqual(moscowNight, newYorkNight);
        process.stdout.write(JSON.stringify({ baseline: '9b0c961',
            repeatedChurnAnswer: true, repeatedForecastAnswer: true,
            knowledgeCalls, persistedFactHiddenByCache: true,
            tenantAccessDenied: true, distinctNightWindows: true }) + '\n');
    } finally {
        await new Promise(resolve => listener.close(resolve));
        Auth.getSession = previousSession;
        Knowledge.askKnowledge = previousKnowledge;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
