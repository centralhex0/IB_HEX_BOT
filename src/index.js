const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const commands = require('./commands/allCommands');

// Configuration
const CONFIG = {
    ownerNumber: '224621963059@s.whatsapp.net',
    prefix: 'Ib',
    startTime: Date.now()
};

// Serveur Web pour QR Code
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../web')));

let qrCodeData = null;
let botStatus = 'disconnected';
let sock = null;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../web/index.html'));
});

app.get('/status', (req, res) => {
    res.json({ status: botStatus, qr: qrCodeData });
});

server.listen(3000, () => {
    console.log('🌐 Serveur web: http://localhost:3000');
});

// Démarrer le bot
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['IB-HEX-BOT', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
            io.emit('qr', qrCodeData);
            console.log('📱 QR Code généré');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            botStatus = 'disconnected';
            io.emit('status', 'disconnected');
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot connecté!');
            botStatus = 'connected';
            qrCodeData = null;
            io.emit('status', 'connected');
            io.emit('qr', null);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Gestion des messages
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        const msg = m.messages[0];
        if (!msg.message) return;
        
        const messageContent = msg.message.conversation || 
                              msg.message.extendedTextMessage?.text || '';
        
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || from;
        const isOwner = sender.includes(CONFIG.ownerNumber.replace('@s.whatsapp.net',''));
        const isGroup = from.endsWith('@g.us');
        
        // Vérifier préfixe
        if (!messageContent.toLowerCase().startsWith(CONFIG.prefix.toLowerCase())) return;
        
        const args = messageContent.slice(CONFIG.prefix.length).trim().split(/\s+/);
        const commandName = args.shift().toLowerCase();
        
        // Commande spéciale 🥷
        const cmd = commandName === '🥷' ? commands['🥷'] : commands[commandName];
        
        if (cmd) {
            // Vérifier ownerOnly
            if (cmd.ownerOnly && !isOwner) {
                return await sock.sendMessage(from, { text: '❌ Réservé au propriétaire' });
            }
            
            // Vérifier groupOnly
            if (cmd.groupOnly && !isGroup) {
                return await sock.sendMessage(from, { text: '❌ Groupe uniquement' });
            }
            
            try {
                await cmd.execute({
                    sock,
                    m,
                    from,
                    sender,
                    isOwner,
                    isGroup,
                    args,
                    startTime: CONFIG.startTime
                });
            } catch (err) {
                console.error('Erreur:', err);
                await sock.sendMessage(from, { text: '❌ Erreur: ' + err.message });
            }
        }
    });
}

startBot();
 
