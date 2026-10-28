'use strict';

const path = require('path');
const PDFDocument = require('pdfkit');
const FONT = path.join(__dirname, 'assets', 'NotoSans.ttf');

function exportPdf(briefing) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 48, info: {
            Title: 'AVA — брифинг', Author: 'AVA', Subject: 'Брифинг по подтверждённым данным CRM',
        } });
        const chunks = [];
        let size = 0;
        doc.on('data', chunk => {
            size += chunk.length;
            if (size > 5 * 1024 * 1024) doc.destroy(new Error('PDF_TOO_LARGE'));
            else chunks.push(chunk);
        });
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        try {
            doc.font(FONT).fontSize(20).text('Брифинг AVA');
            doc.moveDown(0.5).fontSize(10)
                .text(`Период: ${briefing.period.from} — ${briefing.period.to}`)
                .text(`Сформировано: ${briefing.generatedAt}`)
                .text(`Обновление источников: ${briefing.sourceUpdatedAt || 'нет данных'}`);
            doc.moveDown().fontSize(13).text('Сводка');
            doc.moveDown(0.3).fontSize(10).text(briefing.summary);
            doc.moveDown().fontSize(13).text('Рекомендации');
            if (!briefing.recommendations.length) doc.moveDown(0.3).fontSize(10).text('Нет рекомендаций на основе доступных подтверждённых данных.');
            briefing.recommendations.forEach((item, index) => {
                doc.moveDown(0.7).fontSize(11).text(`${index + 1}. ${item.title}`);
                doc.fontSize(10).text(item.reason).text(`Действие: ${item.action}`);
                for (const src of item.sources) doc.fontSize(8).text(`Источник: ${src.type} ${src.id}, ${src.createdAt}`);
            });
            doc.moveDown().fontSize(8).text('Рекомендации не выполняют действия автоматически. Данные CRM могут обновиться после формирования файла.');
            doc.end();
        } catch (error) { doc.destroy(error); }
    });
}

module.exports = { exportPdf };
