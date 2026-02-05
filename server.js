const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const API_KEY = process.env.API_KEY;
const WEBHOOK_URL = process.env.BASE_WEBHOOK_URL;

if (!API_KEY) {
    console.error('ERROR: API_KEY environment variable is not set.');
    process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '50kb' }));

// Middleware to check API Key
const checkApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
};

// Initialize WhatsApp Client
// Using LocalAuth for session persistence (note: on Render ephemeral instances, session is lost on restart unless a Disk is attached)
const SESSION_ID = 'tillpoint_main';
let isInitializing = false;
let isRestarting = false;
let cachedState = 'INITIALIZING';

const safeInitialize = (reason) => {
    if (isInitializing) {
        console.log('Initialize skipped (already initializing)');
        return;
    }
    isInitializing = true;
    cachedState = 'INITIALIZING';
    console.log(`Initializing WhatsApp client${reason ? `: ${reason}` : ''}...`);
    try {
        client.initialize();
    } catch (e) {
        console.error('Client initialize threw error:', e?.message || String(e));
        isInitializing = false;
    }
};
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--no-first-run',
            '--disable-default-apps',
            '--disable-features=site-per-process',
            '--no-zygote',
        ],
        headless: true
    }
});

// Helper to send webhook
const sendWebhook = async (event, data) => {
    if (!WEBHOOK_URL) return;
    try {
        await axios.post(WEBHOOK_URL, {
            event,
            session: SESSION_ID,
            data
        }, {
            headers: { 'x-api-key': API_KEY }
        });
        console.log(`Webhook sent: ${event}`);
    } catch (error) {
        console.error(`Failed to send webhook: ${event}`, error.message);
    }
};

// Event: QR Code generated
client.on('qr', async (qr) => {
    console.log('QR RECEIVED');

    cachedState = 'INITIALIZING';
    isInitializing = false;

    if (process.env.LOG_QR_TERMINAL === 'true') {
        const qrcodeTerminal = require('qrcode-terminal');
        qrcodeTerminal.generate(qr, { small: true });
    }

    // Send raw QR string only (lower memory than generating base64 images)
    sendWebhook('qr', qr);
});

// Event: Client ready
client.on('ready', () => {
    console.log('Client is ready!');
    cachedState = 'CONNECTED';
    isInitializing = false;
    const connectedUser = client?.info?.wid?.user || null;
    sendWebhook('ready', { me: { user: connectedUser } });
});

// Event: Client authenticated
client.on('authenticated', () => {
    console.log('Client authenticated');
    isInitializing = false;
});

// Event: Auth failure
client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    cachedState = 'DISCONNECTED';
    isInitializing = false;
    sendWebhook('auth_failure', msg);
});

// Event: Disconnected
client.on('disconnected', (reason) => {
    console.log('Client was disconnected', reason);
    cachedState = 'DISCONNECTED';
    isInitializing = false;
    sendWebhook('disconnected', reason);
});

// NOTE: Incoming messages are intentionally NOT handled
// This system is send-only for notifications - we don't need to receive/process messages
// This prevents flooding and resource spikes on Render

// API: Send Message
app.post('/client/sendMessage/:sessionId', checkApiKey, async (req, res) => {
    const { chatId, content, contentType } = req.body;

    if (!chatId || !content) {
        return res.status(400).json({ success: false, error: 'Missing chatId or content' });
    }

    try {
        // Check if client is ready
        let state = cachedState;
        if (state !== 'CONNECTED') {
            state = await client.getState();
            cachedState = state || cachedState;
        }

        if (state !== 'CONNECTED') {
            return res.status(503).json({
                success: false,
                error: `WhatsApp client not ready. Current state: ${state || 'INITIALIZING'}`
            });
        }

        // Direct send - this is the robust method that handles new chats automatically
        // Using sendSeen: false to avoid the markedUnread bug in whatsapp-web.js
        const maskedChatId = typeof chatId === 'string' ? chatId.replace(/\d(?=\d{4})/g, '*') : 'unknown';
        console.log(`Attempting to send message to ${maskedChatId}...`);
        const response = await client.sendMessage(chatId, content, { sendSeen: false });

        console.log('Message sent', response.id);
        res.json({ success: true, id: response.id });

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.toString() });
    }
});

// API: Check Status
app.get('/session/status/:sessionId', checkApiKey, async (req, res) => {
    try {
        const state = await client.getState();
        cachedState = state || cachedState;
        res.json({ success: true, state });
    } catch (error) {
        res.json({ success: false, error: error.toString() });
    }
});

// API: Logout and force new QR code
app.post('/session/logout/:sessionId', checkApiKey, async (req, res) => {
    try {
        if (isRestarting) {
            return res.status(202).json({ success: true, message: 'Restart already in progress.' });
        }
        isRestarting = true;
        console.log('Logging out and destroying session...');
        await client.logout();
        console.log('Logged out, reinitializing...');
        // After logout, reinitialize to get a new QR code
        setTimeout(() => {
            safeInitialize('logout');
            isRestarting = false;
        }, 2000);
        res.json({ success: true, message: 'Logged out. New QR code will be generated.' });
    } catch (error) {
        console.error('Logout error:', error);
        // Even if logout fails, try to reinitialize
        try {
            await client.destroy();
            setTimeout(() => {
                safeInitialize('logout_destroy');
                isRestarting = false;
            }, 2000);
            res.json({ success: true, message: 'Session destroyed. New QR code will be generated.' });
        } catch (e) {
            isRestarting = false;
            res.status(500).json({ success: false, error: error.toString() });
        }
    }
});

// API: Force restart (destroy and reinitialize)
app.post('/session/restart/:sessionId', checkApiKey, async (req, res) => {
    try {
        if (isRestarting) {
            return res.status(202).json({ success: true, message: 'Restart already in progress.' });
        }
        isRestarting = true;
        console.log('Force restarting WhatsApp client...');
        await client.destroy();
        console.log('Client destroyed, waiting before reinitialize...');
        setTimeout(() => {
            console.log('Reinitializing client...');
            safeInitialize('restart');
            isRestarting = false;
        }, 3000);
        res.json({ success: true, message: 'Client restarting. New QR code will appear in logs.' });
    } catch (error) {
        console.error('Restart error:', error);
        isRestarting = false;
        res.status(500).json({ success: false, error: error.toString() });
    }
});

// API: Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Client
safeInitialize('startup');

// Start Server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
