'use strict';
// Audit-only identity in the existing isolated fixture. No production startup.
const path = require('node:path');
const send = process.send.bind(process);
process.send = function (message, ...args) {
    if (message?.ready) {
        const DB = require(path.resolve(__dirname, '../whatsapp_crm/src/services/database.service'));
        const Identity = require(path.resolve(__dirname, '../whatsapp_crm/src/services/identity/identity-store'));
        DB.run("INSERT INTO ava_users(id,subject,email,displayName,platformRole) VALUES('audit-admin','audit-admin','admin@example.test','Оператор проверки','platform_admin')");
        message.sessions.admin = 'ava2:' + Identity.createSession('audit-admin', 'isolated-audit');
    }
    return send(message, ...args);
};
require('./product-journeys-browser.server.cjs');
