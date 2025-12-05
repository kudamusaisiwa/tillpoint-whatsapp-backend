const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
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
app.use(express.json());

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
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    }
});

// Helper to send webhook
const sendWebhook = async (event, data) => {
    if (!WEBHOOK_URL) return;
    try {
        await axios.post(WEBHOOK_URL, {
            event,
            session: 'tillpoint_main',
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
client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.generate(qr, { small: true });
    sendWebhook('qr', qr);
});

// Event: Client ready
client.on('ready', () => {
    console.log('Client is ready!');
    sendWebhook('ready', { me: client.info });
});

// Event: Client authenticated
client.on('authenticated', () => {
    console.log('Client authenticated');
});

// Event: Auth failure
client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    sendWebhook('auth_failure', msg);
});

// Event: Disconnected
client.on('disconnected', (reason) => {
    console.log('Client was disconnected', reason);
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
        const state = await client.getState();
        console.log('Client state:', state);

        if (state !== 'CONNECTED') {
            return res.status(503).json({
                success: false,
                error: `WhatsApp client not ready. Current state: ${state || 'INITIALIZING'}`
            });
        }

        // Direct send - this is the robust method that handles new chats automatically
        console.log(`Attempting to send message to ${chatId}...`);
        const response = await client.sendMessage(chatId, content);

        console.log(`Message sent to ${chatId}`, response.id);
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
        res.json({ success: true, state });
    } catch (error) {
        res.json({ success: false, error: error.toString() });
    }
});

// API: Logout and force new QR code
app.post('/session/logout/:sessionId', checkApiKey, async (req, res) => {
    try {
        console.log('Logging out and destroying session...');
        await client.logout();
        console.log('Logged out, reinitializing...');
        // After logout, reinitialize to get a new QR code
        setTimeout(() => {
            client.initialize();
        }, 2000);
        res.json({ success: true, message: 'Logged out. New QR code will be generated.' });
    } catch (error) {
        console.error('Logout error:', error);
        // Even if logout fails, try to reinitialize
        try {
            await client.destroy();
            setTimeout(() => {
                client.initialize();
            }, 2000);
            res.json({ success: true, message: 'Session destroyed. New QR code will be generated.' });
        } catch (e) {
            res.status(500).json({ success: false, error: error.toString() });
        }
    }
});

// API: Force restart (destroy and reinitialize)
app.post('/session/restart/:sessionId', checkApiKey, async (req, res) => {
    try {
        console.log('Force restarting WhatsApp client...');
        await client.destroy();
        console.log('Client destroyed, waiting before reinitialize...');
        setTimeout(() => {
            console.log('Reinitializing client...');
            client.initialize();
        }, 3000);
        res.json({ success: true, message: 'Client restarting. New QR code will appear in logs.' });
    } catch (error) {
        console.error('Restart error:', error);
        res.status(500).json({ success: false, error: error.toString() });
    }
});

// API: Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Client
console.log('Initializing WhatsApp client...');
client.initialize();

// Start Server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
