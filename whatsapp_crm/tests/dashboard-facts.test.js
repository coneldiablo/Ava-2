'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Deals = require('../src/services/customer-deals.store');
const Facts = require('../src/services/dashboard/facts');

function setup() {
    createTestDB();
    Deals.ensureSchema();
    DB.run(`INSERT INTO instances(id,name,hotelTimezone) VALUES
        (1,'Moscow business','Europe/Moscow'),(2,'New York business','America/New_York')`);
}

describe('Dashboard fact packet from real SQLite sources', () => {
    it('uses yesterday in each business timezone and isolates two tenants', () => {
        setup();
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,createdAt) VALUES
            (1,'start','A','2026-09-27T21:00:00Z'),
            (1,'before','A','2026-09-27T20:59:59Z'),
            (1,'end','A','2026-09-28T21:00:00Z'),
            (2,'ny','Private New York','2026-09-29T01:00:00Z')`);
        const now = new Date('2026-09-29T12:00:00Z');
        const moscow = Facts.getFactPacket(1, { window: 'yesterday', now });
        const newYork = Facts.getFactPacket(2, { window: 'yesterday', now });
        assert.deepStrictEqual(moscow.window, { kind: 'yesterday', timezone: 'Europe/Moscow',
            localDate: '2026-09-28', start: '2026-09-27T21:00:00.000Z',
            endExclusive: '2026-09-28T21:00:00.000Z', complete: true });
        assert.deepStrictEqual(newYork.window, { kind: 'yesterday', timezone: 'America/New_York',
            localDate: '2026-09-28', start: '2026-09-28T04:00:00.000Z',
            endExclusive: '2026-09-29T04:00:00.000Z', complete: true });
        assert.strictEqual(moscow.sources.clients.count, 1);
        assert.strictEqual(newYork.sources.clients.count, 1);
        assert.strictEqual(moscow.facts.filter(f => f.type === 'new_lead').length, 1);
        assert.strictEqual(moscow.facts.find(f => f.type === 'new_lead').related.chatId, 'start');
        assert.deepStrictEqual(moscow.facts.find(f => f.type === 'new_lead').subject,
            { type: 'client', name: 'A', chatId: 'start' });
        assert.ok(!JSON.stringify(moscow).includes('Private New York'));
        assert.notStrictEqual(moscow.sourceRevision, newYork.sourceRevision);
    });

    it('uses a completed or ongoing night and handles DST midnight boundaries', () => {
        setup();
        const during = Facts.getFactPacket(1, { window: 'overnight', now: new Date('2026-09-29T02:00:00Z') });
        assert.deepStrictEqual(during.window, { kind: 'overnight', timezone: 'Europe/Moscow',
            localDate: '2026-09-29', start: '2026-09-28T17:00:00.000Z',
            endExclusive: '2026-09-29T02:00:00.000Z', complete: false });
        assert.ok(during.limitations.includes('overnight_window_in_progress'));
        const completed = Facts.getFactPacket(1, { window: 'overnight', now: new Date('2026-09-29T12:00:00Z') });
        assert.deepStrictEqual(completed.window, { kind: 'overnight', timezone: 'Europe/Moscow',
            localDate: '2026-09-29', start: '2026-09-28T17:00:00.000Z',
            endExclusive: '2026-09-29T06:00:00.000Z', complete: true });
        const dst = Facts.getFactPacket(2, { window: 'yesterday', now: new Date('2026-03-09T12:00:00Z') });
        assert.strictEqual(dst.window.start, '2026-03-08T05:00:00.000Z');
        assert.strictEqual(dst.window.endExclusive, '2026-03-09T04:00:00.000Z');
    });

    it('keeps an ongoing night revision stable until a durable fact changes', () => {
        setup();
        const first = Facts.getFactPacket(1,
            { window: 'overnight', now: new Date('2026-09-29T02:00:00Z') });
        const later = Facts.getFactPacket(1,
            { window: 'overnight', now: new Date('2026-09-29T03:00:00Z') });
        assert.notStrictEqual(first.window.endExclusive, later.window.endExclusive);
        assert.strictEqual(first.sourceRevision, later.sourceRevision);
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,createdAt)
            VALUES (1,'new-at-0230','A','2026-09-29T02:30:00Z')`);
        const changed = Facts.getFactPacket(1,
            { window: 'overnight', now: new Date('2026-09-29T03:00:00Z') });
        assert.notStrictEqual(later.sourceRevision, changed.sourceRevision);
        assert.strictEqual(changed.sources.clients.count, 1);
        assert.strictEqual(changed.facts.find(f => f.type === 'new_lead').related.chatId, 'new-at-0230');
    });

    it('returns empty and partial source states without invented counts', () => {
        setup();
        const now = new Date('2026-09-29T12:00:00Z');
        const empty = Facts.getFactPacket(1, { window: 'yesterday', now });
        assert.strictEqual(empty.isEmpty, true);
        assert.strictEqual(empty.sourceUpdatedAt, null);
        assert.strictEqual(empty.sources.clients.count, 0);
        assert.strictEqual(empty.sources.customer_deals.status, 'partial');
        DB.db.exec('DROP TABLE outbound_attempts');
        const missing = Facts.getFactPacket(1, { window: 'yesterday', now });
        assert.strictEqual(missing.sources.outbound_attempts.status, 'unavailable');
        assert.strictEqual(missing.sources.outbound_attempts.count, null);
        assert.strictEqual(missing.status, 'partial');
        assert.notStrictEqual(empty.sourceRevision, missing.sourceRevision);
    });

    it('deduplicates linked WhatsApp and call events and changes revision on new facts', () => {
        setup();
        const at = '2026-09-28T22:00:00Z';
        DB.run(`INSERT INTO messages(id,instanceId,chatId,senderName,role,sourceMessageId,timestamp)
            VALUES (17,1,'chat-a','A','user','provider-17',?)`, [at]);
        DB.run(`INSERT INTO conversation_events(eventId,instanceId,chatId,channel,direction,sourceId,createdAt)
            VALUES ('event-message',1,'chat-a','whatsapp','inbound','provider-17',?)`, [at]);
        DB.run(`INSERT INTO conversation_events(eventId,instanceId,chatId,channel,direction,sourceId,createdAt)
            VALUES ('event-message-local',1,'chat-a','whatsapp','inbound','17',?)`, [at]);
        DB.run("INSERT INTO outbound_campaigns(campaignId,instanceId,name) VALUES ('campaign-a',1,'Test')");
        DB.run(`INSERT INTO outbound_attempts(attemptId,campaignId,instanceId,callId,phone,status,startedAt)
            VALUES ('attempt-a','campaign-a',1,'call-a','redacted','completed',?)`, [at]);
        DB.run(`INSERT INTO conversation_events(eventId,instanceId,channel,direction,callId,createdAt)
            VALUES ('event-call',1,'voice','outbound','call-a',?)`, [at]);
        const now = new Date('2026-09-29T12:00:00Z');
        const first = Facts.getFactPacket(1, { window: 'overnight', now });
        assert.strictEqual(first.sources.conversation_events.count, 3);
        assert.strictEqual(first.facts.filter(f => f.source.type === 'conversation_events').length, 0);
        assert.strictEqual(first.facts.filter(f => f.type === 'outbound_call').length, 1);
        assert.strictEqual(first.facts.filter(f => f.type === 'message').length, 1);
        DB.run(`INSERT INTO customer_deals(id,instanceId,title,stage,createdAt,updatedAt)
            VALUES ('deal-a',1,'Реальная сделка','new',?,?)`, [at, at]);
        DB.run(`INSERT INTO customer_deals(id,instanceId,title,stage,createdAt,updatedAt)
            VALUES ('deal-old',1,'Старая сделка','proposal','2026-09-20T00:00:00Z',?)`, [at]);
        const withDeal = Facts.getFactPacket(1, { window: 'overnight', now });
        assert.strictEqual(withDeal.facts.find(f => f.type === 'deal_created').source.id, 'deal-a');
        assert.strictEqual(withDeal.facts.find(f => f.source.id === 'deal-old').type, 'deal_updated');
        assert.notStrictEqual(first.sourceRevision, withDeal.sourceRevision);
        DB.run("UPDATE customer_deals SET nextAction='Позвонить',revision=2 WHERE id='deal-a'");
        const edited = Facts.getFactPacket(1, { window: 'overnight', now });
        assert.notStrictEqual(withDeal.sourceRevision, edited.sourceRevision);
        assert.strictEqual(edited.facts.find(f => f.type === 'deal_updated').source.id, 'deal-a');
        DB.run(`INSERT INTO lead_status_history(instanceId,chatId,fromStatus,toStatus,createdAt)
            VALUES (1,'chat-a','new','qualified',?)`, [at]);
        const second = Facts.getFactPacket(1, { window: 'overnight', now });
        assert.notStrictEqual(first.sourceRevision, second.sourceRevision);
        assert.strictEqual(second.facts.find(f => f.type === 'lead_status_change').source.type, 'lead_status_history');
        assert.throws(() => Facts.getFactPacket(0, { window: 'yesterday' }), /INVALID_BUSINESS_SCOPE/);
        assert.throws(() => Facts.getFactPacket(1, { window: 'today' }), /INVALID_WINDOW/);
    });

    it('includes a newly created task even when updatedAt is absent', () => {
        setup();
        DB.run(`INSERT INTO manager_tasks(taskId,instanceId,chatId,customerName,summary,priority,createdAt,updatedAt)
            VALUES ('task-new',1,'client-a','Клиент А','Нужно связаться','high','2026-09-28T22:00:00Z',NULL)`);
        const packet = Facts.getFactPacket(1,
            { window: 'overnight', now: new Date('2026-09-29T12:00:00Z') });
        const task = packet.facts.find(f => f.source.type === 'manager_tasks');
        assert.strictEqual(task.source.id, 'task-new');
        assert.strictEqual(task.occurredAt, '2026-09-28T22:00:00.000Z');
        assert.deepStrictEqual(task.subject, { type: 'client', name: 'Клиент А', chatId: 'client-a' });
    });
    it('collects existing business data without window events and isolates historical context', () => {
        setup();
        const now = new Date('2026-09-29T12:00:00Z');
        assert.strictEqual(Facts.getBusinessContext(1, { now }).businessDataEmpty, true);
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,createdAt) VALUES
            (1,'old-a','Historical A','2026-09-01T00:00:00Z'),
            (2,'old-b','Secret business B','2026-09-01T00:00:00Z')`);
        DB.run(`INSERT INTO messages(instanceId,chatId,senderName,role,content,timestamp) VALUES
            (1,'old-a','Historical A','user','Нужна бронь на октябрь','2026-09-02T00:00:00Z'),
            (1,'future','Future','user','Future secret','2026-10-02T00:00:00Z')`);
        const packet = Facts.getFactPacket(1, { window: 'overnight', now });
        assert.strictEqual(packet.isEmpty, true);
        assert.strictEqual(packet.hasBusinessData, true);
        assert.strictEqual(packet.businessDataEmpty, false);
        assert.ok(packet.contextFacts.some(f => f.summary.includes('Нужна бронь')));
        assert.ok(packet.contextFacts.some(f => f.occurredAt === '2026-09-01T00:00:00.000Z'));
        assert.ok(!JSON.stringify(packet).includes('Secret business B'));
        assert.ok(!JSON.stringify(packet).includes('Future secret'));
        assert.strictEqual(packet.sourceUpdatedAt, '2026-09-02T00:00:00.000Z');
        assert.strictEqual(Facts.getBusinessContext(1, { now }).sourceUpdatedAt, '2026-09-02T00:00:00.000Z');
        const revised = packet.sourceRevision;
        DB.run("UPDATE messages SET content='Уточнённая бронь' WHERE chatId='old-a'");
        assert.notStrictEqual(Facts.getFactPacket(1, { window: 'overnight', now }).sourceRevision, revised);
        assert.throws(() => Facts.getBusinessContext(3, { now }), /BUSINESS_NOT_FOUND/);
    });

    it('does not include internal directions or tool names in human summaries', () => {
        setup();
        const at = '2026-09-28T22:00:00Z';
        DB.run(`INSERT INTO conversation_events(eventId,instanceId,channel,direction,createdAt)
            VALUES ('uuid-event',1,'raw-channel','internal',?)`, [at]);
        const packet = Facts.getFactPacket(1, { window: 'overnight', now: new Date('2026-09-29T12:00:00Z') });
        const summaries = [...packet.facts, ...packet.contextFacts].map(f => f.summary).join(' ');
        assert.ok(!summaries.includes('internal'));
        assert.ok(!summaries.includes('uuid-event'));
        assert.ok(!summaries.includes('raw-channel'));
        assert.strictEqual(packet.contextSources.conversation_events.count, 0);
        assert.strictEqual(packet.contextFacts.length, 0);
        assert.strictEqual(packet.facts.length, 0);
        assert.strictEqual(packet.hasBusinessData, false);
        assert.strictEqual(packet.sources.conversation_events.count, 1);
    });

    it('keeps old unresolved tasks ahead of recent completed tasks in bounded context', () => {
        setup();
        DB.run(`INSERT INTO manager_tasks(taskId,instanceId,summary,status,createdAt,updatedAt)
            VALUES ('old-open',1,'Срочно связаться с клиентом','new','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`);
        for (let i = 0; i < 45; i++) DB.run(`INSERT INTO manager_tasks(taskId,instanceId,summary,status,createdAt,updatedAt)
            VALUES (?,1,'Закрыто','closed','2026-09-20T00:00:00Z','2026-09-20T00:00:00Z')`, [`closed-${i}`]);
        const context = Facts.getBusinessContext(1, { now: new Date('2026-09-29T12:00:00Z') });
        assert.strictEqual(context.contextSources.manager_tasks.count, 46);
        assert.strictEqual(context.contextSources.manager_tasks.returnedCount, 40);
        assert.strictEqual(context.contextSources.manager_tasks.status, 'partial');
        assert.ok(context.contextFacts.some(f => f.summary.includes('Срочно связаться')));
    });

    it('never copies future client lastMessage into historical facts', () => {
        setup();
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,lastMessage,lastMessageTime,createdAt)
            VALUES (1,'old-client','Client','FUTURE_CLIENT_TEXT','2026-10-02T00:00:00Z','2026-09-28T22:00:00Z')`);
        DB.run(`INSERT INTO conversation_events(eventId,instanceId,channel,direction,createdAt)
            VALUES ('draft-event',1,'internal','draft','2026-09-28T22:00:00Z')`);
        const now = new Date('2026-09-29T12:00:00Z');
        const packet = Facts.getFactPacket(1, { window: 'overnight', now });
        assert.ok(!JSON.stringify([...packet.facts, ...packet.contextFacts]).includes('FUTURE_CLIENT_TEXT'));
        assert.ok(!packet.facts.some(f => f.source.id === 'draft-event'));
        assert.ok(!packet.contextFacts.some(f => f.source.id === 'draft-event'));
        assert.strictEqual(packet.contextSources.clients.latestAt, '2026-09-28T22:00:00.000Z');
    });

});
