import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import axios from 'axios';
import { Boom } from '@hapi/boom';

const app = express();
app.use(cors());
app.use(express.json());

const WEBHOOK_URL = 'https://preview-sandbox--6016cf4dfae278239a345e1e83e91480.base44.app/functions/railwaySync';

// Store active connections
const connections = new Map();

// Notify Base44 webhook
async function notifyWebhook(data) {
    try {
        await axios.post(WEBHOOK_URL, data);
        console.log('✅ Webhook notificado:', data.event_type);
    } catch (error) {
        console.error('❌ Error notificando webhook:', error.message);
    }
}

// Create WhatsApp connection
async function connectWhatsApp(accountId) {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth_${accountId}`);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    connections.set(accountId, sock);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImage = await QRCode.toDataURL(qr);
            await notifyWebhook({
                event_type: 'qr_generated',
                data: { account_id: accountId, qr_code: qrImage }
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('🔄 Reconectando...');
                setTimeout(() => connectWhatsApp(accountId), 3000);
            } else {
                connections.delete(accountId);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp conectado:', accountId);
            await notifyWebhook({
                event_type: 'connected',
                data: { account_id: accountId }
            });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            const messageText = msg.message.conversation 
                || msg.message.extendedTextMessage?.text 
                || '';

            console.log('📩 Mensaje de:', from, '-', messageText);

            await notifyWebhook({
                event_type: 'message_received',
                data: {
                    account_id: accountId,
                    from: from.replace('@s.whatsapp.net', ''),
                    message: messageText,
                    timestamp: new Date().toISOString()
                }
            });
        }
    });

    return sock;
}

// API Routes
app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        message: 'Baileys WhatsApp Server',
        connections: connections.size 
    });
});

app.post('/connect', async (req, res) => {
    try {
        const { account_id } = req.body;
        if (!account_id) {
            return res.status(400).json({ error: 'account_id requerido' });
        }

        console.log('🔌 Iniciando conexión para:', account_id);
        await connectWhatsApp(account_id);
        
        res.json({ success: true, message: 'Conexión iniciada. Escanea el QR.' });
    } catch (error) {
        console.error('❌ Error conectando:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/status/:account_id', (req, res) => {
    const { account_id } = req.params;
    const connected = connections.has(account_id);
    res.json({ connected });
});

app.post('/send-message', async (req, res) => {
    try {
        const { account_id, to, message } = req.body;
        
        const sock = connections.get(account_id);
        if (!sock) {
            return res.status(404).json({ error: 'Cuenta no conectada' });
        }

        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error enviando mensaje:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Baileys corriendo en puerto ${PORT}`);
    console.log(`📡 Webhook URL: ${WEBHOOK_URL}`);
});
