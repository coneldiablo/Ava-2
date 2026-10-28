class PmsProvider {
    constructor(options = {}) {
        this.businessId = Number(options.businessId);
        this.provider = options.provider || 'unknown';
    }

    async testConnection() { throw new Error('Not implemented'); }
    async listBookings() { throw new Error('Not implemented'); }
    async getBooking() { throw new Error('Not implemented'); }
    async getBookingCustomer() { throw new Error('Not implemented'); }
    async getBookingGuests() { throw new Error('Not implemented'); }
    async getBookingServices() { throw new Error('Not implemented'); }
    async getAvailability() { throw new Error('Not implemented'); }
    async listRoomTypes() { throw new Error('Not implemented'); }
    async listTariffs() { throw new Error('Not implemented'); }
    async getTariffPrices() { throw new Error('Not implemented'); }
    async listWebhookSubscribers() { throw new Error('Not implemented'); }
    async createWebhookSubscriber() { throw new Error('Not implemented'); }
    async sendTestWebhook() { throw new Error('Not implemented'); }
}

module.exports = PmsProvider;
