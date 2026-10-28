const axios = require('axios');
const Logger = require('../utils/logger');
const DB = require('./database.service');

class CRMService {
    async processLead(instanceConfig, clientData, leadStatus) {
        try {
            const configured = instanceConfig?.id && require('./integrations/store').get(instanceConfig.id, 'amocrm');
            if (configured?.accountId && configured.status !== 'disconnected') {
                return this.sendLeadToAmoCRM(instanceConfig, clientData, leadStatus);
            }
            if (!instanceConfig || instanceConfig.crmIntegration === 'none' || !instanceConfig.crmIntegration) {
                return { success: true, message: 'CRM integration is disabled' };
            }
            if (instanceConfig.crmIntegration === 'amocrm') {
                return await this.sendLeadToAmoCRM(instanceConfig, clientData, leadStatus);
            } else if (instanceConfig.crmIntegration === 'bitrix24') {
                return await this.sendLeadToBitrix24(instanceConfig, clientData, leadStatus);
            } else {
                return { success: false, error: 'Unknown CRM type' };
            }
        } catch (error) {
            const code = /^EXTERNAL_/.test(error?.code || '') ? error.code : 'CRM_SYNC_FAILED';
            Logger.error('CRM lead processing failed:', code);
            return { success: false, error: code };
        }
    }

    async sendLeadToAmoCRM(instanceConfig, clientData, leadStatus) {
        const id = Number(instanceConfig?.id || clientData?.instanceId);
        if (!Number.isSafeInteger(id) || id < 1 || !clientData?.chatId) {
            return { success: false, error: 'EXTERNAL_SCOPE_INVALID', safeToRetry: true };
        }
        const Store = require('./integrations/store');
        const Amo = require('./integrations/amocrm');
        try {
            const configured = Store.get(id, 'amocrm');
            if (!configured && (!instanceConfig.amoCrmDomain || !instanceConfig.amoCrmAccessToken)) {
                return { success: false, error: 'EXTERNAL_NOT_CONFIGURED', safeToRetry: true };
            }
            return await Amo.syncClient(id, clientData.chatId, leadStatus, {
                legacy: configured ? null : instanceConfig,
                sourceId: clientData.crmSourceId || null,
            });
        } catch (error) {
            // Never turn a failed note/status update into a new contact or deal.
            // Durable operation keys also fence writes whose ACK was lost.
            const code = /^EXTERNAL_/.test(error?.code || '') ? error.code : 'EXTERNAL_SYNC_FAILED';
            Logger.warn('amoCRM sync needs attention:', code);
            return { success: false, error: code, safeToRetry: error.safeToRetry === true,
                unknown: error.unknown === true };
        }
    }

    async sendLeadToBitrix24(instanceConfig, clientData, leadStatus) {
        const { bitrix24WebhookUrl } = instanceConfig;

        if (!bitrix24WebhookUrl) {
            throw new Error('Bitrix24 Webhook URL is missing');
        }

        const baseUrl = bitrix24WebhookUrl.endsWith('/') ? bitrix24WebhookUrl : `${bitrix24WebhookUrl}/`;

        // Bitrix stage ID mapping approximation
        const bitrixStageMapping = {
            'new': 'NEW',
            'qualified': 'PREPARATION',
            'audit': 'EXECUTING',
            'offer': 'FINAL_INVOICE',
            'pickup_confirmed': 'WON',
            'ready_for_pickup': 'WON',
            'booked': 'WON',
            'junk': 'LOSE'
        };
        const stageId = bitrixStageMapping[leadStatus] || 'NEW';

        // Check if already exists
        if (clientData.crmContactId && clientData.crmLeadId) {
            try {
                await axios.post(`${baseUrl}crm.deal.update.json`, {
                    id: clientData.crmLeadId,
                    fields: {
                        STAGE_ID: stageId,
                        COMMENTS: `Статус изменён на: ${leadStatus}`
                    }
                });
                Logger.success(`Bitrix24: Updated deal ${clientData.crmLeadId} with status ${leadStatus} (Stage: ${stageId})`);
                return { success: true, dealId: clientData.crmLeadId, updated: true };
            } catch (err) {
                Logger.warn(`Bitrix24: Could not update existing deal, creating new: ${err.message}`);
            }
        }

        // 1. Create a contact
        const contactData = {
            fields: {
                NAME: clientData.name || clientData.senderName || 'Unknown Contact',
                PHONE: [{ "VALUE": clientData.chatId.replace('@c.us', ''), "VALUE_TYPE": "WORK" }],
                OPENED: "Y"
            }
        };

        let contactId = null;
        try {
            const contactRes = await axios.post(`${baseUrl}crm.contact.add.json`, contactData);
            if (contactRes.data.result) {
                contactId = contactRes.data.result;
            } else {
                throw new Error(JSON.stringify(contactRes.data));
            }
        } catch (err) {
            Logger.error('Bitrix24 Contact Creation Error:', err.response?.data || err.message);
            throw err;
        }

        // 2. Create a deal (lead)
        const dealData = {
            fields: {
                TITLE: `Новая заявка WhatsApp: ${clientData.name || clientData.senderName}`,
                CONTACT_ID: contactId,
                OPENED: "Y",
                COMMENTS: `Lead Status in CRM: ${leadStatus}`
            }
        };

        const dealRes = await axios.post(`${baseUrl}crm.deal.add.json`, dealData);
        let dealId = null;
        if (dealRes.data.result) {
            dealId = dealRes.data.result;

            // Save CRM IDs back to our DB
            try {
                const idInstance = instanceConfig.id || clientData.instanceId;
                await DB.updateClientCrmIds(idInstance, clientData.chatId, String(contactId), String(dealId));
            } catch (e) {
                Logger.warn(`Could not save CRM IDs to DB: ${e.message}`);
            }

            Logger.success(`Successfully sent deal to Bitrix24. Deal ID: ${dealId}`);
            return { success: true, dealId };
        } else {
            throw new Error(JSON.stringify(dealRes.data));
        }
    }
}

module.exports = new CRMService();
