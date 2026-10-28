const express = require('express');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api.routes');
const mlRoutes = require('./routes/ml.routes');
const pmsPublicRoutes = require('./routes/pms-public.routes');
const twentyPublicRoutes = require('./routes/twenty-public.routes');
const instagramRoutes = require('./routes/instagram.routes');
const createOnyxLlmRouter = require('./routes/onyx-llm.routes');
const DB = require('./services/database.service');
const PushService = require('./services/push.service');
const FollowUpService = require('./services/followup.service');
const SmartTriggersService = require('./services/smart-triggers.service');
const SequenceService = require('./services/sequence.service');
const TelegramService = require('./services/telegram.service');
const EmailService = require('./services/email.service');
const VkService = require('./services/vk.service');
const MaxService = require('./services/max.service');
const BaristaBotService = require('./services/barista-bot.service');
const CoffeeFeedbackService = require('./services/coffee-feedback.service');
const AuthService = require('./services/auth.service');
const Logger = require('./utils/logger');
const PmsService = require('./services/pms/pms.service');
const TwentyService = require('./services/twenty/twenty.service');


class App {
    constructor() {
        this.app = express();
        this.startTime = Date.now();
        this.middlewares();
        this.routes();
    }

    middlewares() {
        this.app.set('trust proxy', true); // Correct req.protocol behind reverse proxy
        this.app.use(cors());
        // Emergency image: enforce live whole-account owner access before early routers.
        this.app.use('/api', require('./services/identity/team-emergency-guard')());
        // Mount before the generic 1 MB JSON parser to preserve signed raw bytes
        // and enforce the tighter Meta webhook body limit.
        this.app.use('/api/integrations', instagramRoutes.publicRouter);
        this.app.use(express.json({
            limit: '1mb',
            verify: (req, _res, buffer) => {
                if (req.originalUrl.startsWith('/api/integrations/twenty/webhooks/') ||
                    ['/api/webhook', '/api/webhook/openwa'].includes(req.originalUrl.split('?')[0])) {
                    req.rawBody = Buffer.from(buffer);
                }
            },
        }));
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Referrer-Policy', 'same-origin');
            res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
            next();
        });

        // Request logging middleware - log every incoming request
        this.app.use((req, res, next) => {
            const bodySize = req.body ? JSON.stringify(req.body).length : 0;
            Logger.info(`[HTTP] ${req.method} ${Logger.safeRequestPath(req.originalUrl)} (body: ${bodySize} bytes, ip: ${req.ip})`);
            next();
        });

        // Serve static files from React app
        this.app.use(express.static(path.join(__dirname, '../frontend/dist')));
    }

    routes() {
        this.app.use('/api', require('./routes/identity.routes'));
        this.app.use('/api', require('./routes/module-access.routes')());
        this.app.post('/api/auth/login', AuthService.login.bind(AuthService));
        this.app.get('/api/auth/me', AuthService.me.bind(AuthService));
        this.app.post('/api/auth/logout', AuthService.logout.bind(AuthService));

        // Public Bnovo webhook endpoint. Authentication is the 256-bit opaque
        // path token; every event is re-fetched through the authenticated API.
        this.app.use('/api/integrations', pmsPublicRoutes);
        this.app.use('/api/integrations', twentyPublicRoutes);
        // Separate revocable business-scoped key; never an Admin/service token.
        this.app.use('/api/integrations', createOnyxLlmRouter());

        // Internal AVA/Sales Brain API. It is intentionally separated from browser-session auth.
        this.app.use('/api/ml', AuthService.requireServiceToken.bind(AuthService), mlRoutes);

        // API Routes
        this.app.use('/api', (req, res, next) => req.emergencyProviderCallback
            ? next() : AuthService.requireAuth(req, res, next));
        this.app.use('/api', instagramRoutes.customerRouter);
        this.app.use('/api', require('./routes/customer-calls.routes'));
        this.app.use('/api', require('./routes/customer-deals.routes'));
        this.app.use('/api', require('./routes/dashboard-metrics.routes'));
        this.app.use('/api', require('./routes/dashboard-intelligence.routes'));
        this.app.use('/api', require('./routes/dashboard-ai.routes'));
        this.app.use('/api', require('./routes/customer-studio.routes'));
        this.app.use('/api', require('./routes/customer-intelligence.routes'));
        this.app.use('/api', require('./routes/customer-team.routes'));
        this.app.use('/api', require('./routes/customer-activity.routes'));
        this.app.use('/api', require('./routes/client-identity.routes'));
        this.app.use('/api', require('./routes/customer-knowledge-preview.routes'));
        this.app.use('/api', require('./routes/customer-native-crm.routes'));
        this.app.use('/api', require('./routes/customer-business-gpt.routes'));
        this.app.use('/api', require('./routes/customer-outbound-attempts.routes'));
        this.app.use('/api', require('./routes/customer-trigger-preview.routes'));
        this.app.use('/api', apiRoutes);

        // Catch-all handler for React Routing (must be last)
        this.app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
        });
    }

    async start(port = 3000) {
        // Initialize database BEFORE starting server
        try {
            AuthService.assertConfigured();
            await DB.init();
            require('./services/identity/identity-store').ensureSchema();
            // Identity tables now exist; complete legacy assignment backfill before writers start.
            DB.createSalesWorkspaceTables();
            require('./services/dashboard/metrics').ensureSchema();
            // Initialize Push Service VAPID keys
            PushService.init();
            // Start per-instance follow-up service
            FollowUpService.start();
            // Start new services
            SmartTriggersService.start();
            SequenceService.start();
            TelegramService.start().catch(e => Logger.warn('[App] Telegram start error:', e.message));
            EmailService.start().catch(e => Logger.warn('[App] Email start error:', e.message));
            VkService.start().catch(e => Logger.warn('[App] VK start error:', e.message));
            MaxService.start().catch(e => Logger.warn('[App] MAX start error:', e.message));
            BaristaBotService.start().catch(e => Logger.warn('[App] Barista Bot start error:', e.message));
            CoffeeFeedbackService.start();
            PmsService.start();
            TwentyService.start();
            require('./services/crm-memory.service').start();
        } catch (err) {
            Logger.error('Не удалось инициализировать БД:', err);
            process.exit(1);
        }

        this.app.listen(port, () => {
            Logger.success(`🚀 Сервер запущен на порту ${port}`);
            Logger.info(`Админ панель: http://localhost:${port}`);
            Logger.info(`Webhook URL: http://localhost:${port}/api/webhook`);
        });
    }
}

module.exports = new App();
