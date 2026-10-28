const { describe, it, assert } = require('./test-helper');
const AIService = require('../src/services/ai.service');

describe('AI Response Parsing Tests', () => {
    
    it('should parse valid JSON with all fields', () => {
        const json = JSON.stringify({
            reply: 'Ваш заказ принят!',
            status: 'qualified',
            action: 'none',
            thought: 'Клиент хочет сделать заказ, статус qualified.',
            status_reasoning: 'Клиент перечислил позиции заказа.',
            order_summary: 'Капучино 0.3'
        });
        
        const res = AIService._parseResponse(json);
        assert.strictEqual(res.reply, 'Ваш заказ принят!');
        assert.strictEqual(res.status, 'qualified');
        assert.strictEqual(res.action, 'none');
        assert.strictEqual(res.thought, 'Клиент хочет сделать заказ, статус qualified.');
        assert.strictEqual(res.statusReasoning, 'Клиент перечислил позиции заказа.');
        assert.strictEqual(res.orderSummary, 'Капучино 0.3');
    });
    
    it('should parse JSON wrapped in markdown code blocks', () => {
        const raw = `
Пример ответа от модели:
\`\`\`json
{
    "reply": "Хорошо, оформляем заказ.",
    "status": "qualified",
    "action": "none",
    "thought": "Заказ оформлен.",
    "status_reasoning": "Пользователь подтвердил заказ.",
    "order_summary": "Латте, синнабон"
}
\`\`\`
Конец ответа.
`;
        const res = AIService._parseResponse(raw);
        assert.strictEqual(res.reply, 'Хорошо, оформляем заказ.');
        assert.strictEqual(res.status, 'qualified');
        assert.strictEqual(res.action, 'none');
        assert.strictEqual(res.orderSummary, 'Латте, синнабон');
    });
    
    it('should handle empty or null response gracefully', () => {
        const resNull = AIService._parseResponse(null);
        assert.ok(resNull.reply);
        assert.strictEqual(resNull.status, null);
        assert.strictEqual(resNull.action, null);
        
        const resEmpty = AIService._parseResponse('   ');
        assert.ok(resEmpty.reply);
        assert.strictEqual(resEmpty.status, null);
        assert.strictEqual(resEmpty.action, null);
    });
    
    it('should fallback to plain text if JSON is invalid', () => {
        const rawText = 'Извините, я не понял ваш вопрос. Можете повторить?';
        const res = AIService._parseResponse(rawText);
        
        assert.strictEqual(res.reply, rawText);
        assert.strictEqual(res.status, null);
        assert.strictEqual(res.action, null);
        assert.strictEqual(res.thought, null);
    });
    
    it('should extract status using regex from broken JSON/plain text if possible', () => {
        const rawText = 'Результат: {\n  "status": "booked"\n}';
        const res = AIService._parseResponse(rawText);
        assert.strictEqual(res.status, 'booked');
    });
    
    it('should validate and filter invalid statuses', () => {
        const json = JSON.stringify({
            reply: 'Ответ',
            status: 'invalid_status_name',
            action: 'none',
            thought: 'Мысли',
            status_reasoning: 'Почему',
            order_summary: ''
        });
        
        const res = AIService._parseResponse(json);
        assert.strictEqual(res.status, null); // invalid status should filter to null
    });
    
    it('should validate and filter invalid actions', () => {
        const json = JSON.stringify({
            reply: 'Ответ',
            status: 'new',
            action: 'delete_all_databases',
            thought: 'Мысли',
            status_reasoning: 'Почему',
            order_summary: ''
        });
        
        const res = AIService._parseResponse(json);
        assert.strictEqual(res.action, 'none'); // invalid action falls back to 'none'
    });
    
    it('should extract order_summary field correctly', () => {
        const json = JSON.stringify({
            reply: 'Готовим капучино на миндальном!',
            status: 'offer',
            action: 'none',
            thought: 'Клиент выбрал кофе и молоко',
            status_reasoning: 'Переход в offer',
            order_summary: 'Капучино 0.4 на миндальном'
        });
        
        const res = AIService._parseResponse(json);
        assert.strictEqual(res.orderSummary, 'Капучино 0.4 на миндальном');
    });

    it('should parse coffee pickup time and confirmed status', () => {
        const json = JSON.stringify({
            reply: 'Заказ подтверждён, ждём вас к 14:30.',
            status: 'pickup_confirmed',
            action: 'none',
            thought: 'Бариста подтвердил заказ.',
            status_reasoning: 'Самовывоз подтверждён сотрудником.',
            order_summary: 'Латте 0.3, круассан',
            pickup_time: 'к 14:30'
        });

        const res = AIService._parseResponse(json);
        assert.strictEqual(res.status, 'pickup_confirmed');
        assert.strictEqual(res.orderSummary, 'Латте 0.3, круассан');
        assert.strictEqual(res.pickupTime, 'к 14:30');
    });

    it('should keep coffee-only statuses out of standard businesses', () => {
        const res = AIService._parseResponse(JSON.stringify({
            reply: 'Готово',
            status: 'pickup_confirmed',
            action: 'none'
        }), { salesGoal: 'call', leadStatus: 'offer' });

        assert.strictEqual(res.status, 'offer');
    });

    it('should reserve coffee confirmation for the barista workflow', () => {
        const premature = AIService._parseResponse(JSON.stringify({
            reply: 'Заказ подтверждён',
            status: 'pickup_confirmed',
            action: 'none'
        }), { salesGoal: 'coffee_pickup', leadStatus: 'offer' });
        const activeConfirmed = AIService._parseResponse(JSON.stringify({
            reply: 'Заказ уже подтверждён',
            status: 'offer',
            action: 'none'
        }), {
            salesGoal: 'coffee_pickup',
            leadStatus: 'pickup_confirmed',
            hasActiveCoffeeOrder: true,
            activeOrderStatus: 'accepted'
        });
        const newCycle = AIService._parseResponse(JSON.stringify({
            reply: 'Передал новый заказ бариста',
            status: 'offer',
            action: 'none',
            order_summary: 'Айс кофе',
            pickup_time: 'к 15:00'
        }), {
            salesGoal: 'coffee_pickup',
            leadStatus: 'new',
            originalLeadStatus: 'pickup_confirmed',
            hasActiveCoffeeOrder: false
        });

        assert.strictEqual(premature.status, 'offer');
        assert.strictEqual(activeConfirmed.status, 'pickup_confirmed');
        assert.strictEqual(newCycle.status, 'offer');
        assert.strictEqual(newCycle.orderSummary, 'Айс кофе');
    });
});
