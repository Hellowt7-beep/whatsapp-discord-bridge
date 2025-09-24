import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import whatsappPkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = whatsappPkg;
import { Client as DiscordClient, GatewayIntentBits, AttachmentBuilder } from 'discord.js';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import os from 'os';

// ES Module setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration
const CONFIG = {
    port: process.env.PORT || 3000,
    discordToken: process.env.DISCORD_BOT_TOKEN,
    discordChannelId: process.env.DISCORD_CHANNEL_ID,
    messageTimeout: (process.env.MESSAGE_TIMEOUT_MINUTES || 0.5) * 60 * 1000,
    triggerChar: process.env.TRIGGER_CHARACTER || '.',
    sessionName: process.env.WHATSAPP_SESSION_NAME || 'bridge-session',
    isProduction: process.env.NODE_ENV === 'production' || process.env.VERCEL,
    pingUrl: process.env.PING_URL || null
};

// Global variables
let whatsappClient = null;
let discordClient = null;
let activeMessages = new Map(); // Store active bridged messages
let isWhatsAppReady = false;
let isDiscordReady = false;
let lastPing = Date.now();
let serverStartTime = Date.now();
let currentQRCode = null;

// Use temp directory for uploads (Vercel-compatible)
const uploadsDir = os.tmpdir();

// Simplified Puppeteer configuration for Vercel
async function getPuppeteerConfig() {
    if (CONFIG.isProduction) {
        // Try different approaches for Vercel
        console.log('🔄 Trying Vercel-optimized Puppeteer config...');

        // First try: @sparticuz/chromium
        try {
            const executablePath = await chromium.executablePath();
            console.log('✅ Found Chromium at:', executablePath);

            return {
    executablePath: executablePath,
    headless: 'new',
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
    ],
    ignoreHTTPSErrors: true,
    timeout: 90000,
    protocolTimeout: 90000
};
            };
        } catch (chromiumError) {
            console.error('❌ Chromium failed:', chromiumError.message);

            // Fallback: System chromium (if available)
            console.log('🔄 Trying fallback config...');
            return {
                headless: true,
                timeout: 60000,
                protocolTimeout: 60000,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--single-process'
                ]
            };
        }
    } else {
        return {
            headless: true,
            timeout: 30000,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };
    }
}

// WhatsApp Client Setup
async function initializeWhatsApp() {
    console.log('🔄 Initializing WhatsApp client...');
    console.log('🚀 Environment: ' + (CONFIG.isProduction ? 'Production (Vercel)' : 'Development'));

    try {
        const puppeteerConfig = await getPuppeteerConfig();
        console.log('✅ Puppeteer config ready');

        // Session path for Vercel (always use temp dir)
        const sessionPath = path.join(os.tmpdir(), 'whatsapp-session');
        console.log('📁 Session path:', sessionPath);

        whatsappClient = new Client({
            authStrategy: new LocalAuth({
                clientId: CONFIG.sessionName,
                dataPath: sessionPath
            }),
            puppeteer: puppeteerConfig,
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
            }
        });

        whatsappClient.on('qr', (qr) => {
            console.log('\n' + '='.repeat(60));
            console.log('📱 WHATSAPP QR CODE - JETZT SCANNEN!');
            console.log('='.repeat(60));

            // WICHTIG: QR String für manuelle Konvertierung
            console.log('🔥 QR CODE STRING (kopieren für manuelle Konvertierung):');
            console.log(qr);
            console.log('🔥 Ende QR String');

            try {
                qrcode.generate(qr, { small: true });
            } catch (qrError) {
                console.log('QR Terminal Error, aber String verfügbar:', qr);
            }

            console.log('💡 1. WhatsApp öffnen → Menü → "Verknüpfte Geräte"');
            console.log('💡 2. "Gerät verknüpfen" → QR Code scannen');
            console.log('💡 3. QR Code läuft in 20 Sekunden ab!');
            console.log('🔗 QR Code auch verfügbar unter: /qr');
            console.log('🔗 Manuell: Kopiere QR String und gehe zu qr-generator.org');
            console.log('='.repeat(60) + '\n');

            // Store QR code for web display
            currentQRCode = qr;

            // Clear QR code after 20 seconds
            setTimeout(() => {
                currentQRCode = null;
            }, 20000);
        });

    whatsappClient.on('ready', () => {
        console.log('✅ WhatsApp client is ready!');
        isWhatsAppReady = true;
    });

    whatsappClient.on('authenticated', () => {
        console.log('🔐 WhatsApp authenticated successfully');
    });

    whatsappClient.on('auth_failure', (msg) => {
        console.error('❌ WhatsApp authentication failed:', msg);
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('📱 WhatsApp disconnected:', reason);
        isWhatsAppReady = false;

        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
            console.log('🔄 Attempting to reconnect WhatsApp...');
            initializeWhatsApp();
        }, 5000);
    });

    // Handle incoming WhatsApp messages
    whatsappClient.on('message', async (message) => {
        try {
            await handleWhatsAppMessage(message);
        } catch (error) {
            console.error('Error handling WhatsApp message:', error);
        }
    });

        console.log('🚀 Starting WhatsApp client initialization...');
        await whatsappClient.initialize();

    } catch (error) {
        console.error('❌ Failed to initialize WhatsApp client:', error);
        console.error('Error details:', error.message);

        // Retry with delay
        setTimeout(() => {
            console.log('🔄 Retrying WhatsApp initialization in 15 seconds...');
            initializeWhatsApp();
        }, 15000);
    }
}

// Discord Client Setup
function initializeDiscord() {
    console.log('🔄 Initializing Discord client...');

    discordClient = new DiscordClient({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions
        ]
    });

    discordClient.once('clientReady', () => {
        console.log(`✅ Discord bot logged in as ${discordClient.user.tag}!`);
        isDiscordReady = true;
    });

    discordClient.on('error', (error) => {
        console.error('Discord client error:', error);
    });

    discordClient.on('messageCreate', async (message) => {
        try {
            await handleDiscordMessage(message);
        } catch (error) {
            console.error('Error handling Discord message:', error);
        }
    });

    discordClient.login(CONFIG.discordToken).catch(error => {
        console.error('Failed to login to Discord:', error);
        setTimeout(() => {
            console.log('🔄 Retrying Discord login...');
            initializeDiscord();
        }, 10000);
    });
}

// Handle WhatsApp messages starting with trigger character
async function handleWhatsAppMessage(message) {
    // Skip if message doesn't start with trigger character
    if (!message.body.startsWith(CONFIG.triggerChar)) {
        return;
    }

    // Skip if message is from status broadcast
    if (message.from === 'status@broadcast') {
        return;
    }

    console.log(`📨 WhatsApp message received: ${message.body}`);

    // Use the complete message content (keep trigger character)
    const content = message.body.trim();
    if (!content) return;

    // Get chat info
    const chat = await message.getChat();
    const contact = await message.getContact();

    // Create bridge message ID for response collection
    const bridgeId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store message info for response bridging
    activeMessages.set(bridgeId, {
        whatsappChatId: message.from,
        whatsappChat: chat,
        originalMessage: message,
        timestamp: Date.now(),
        responses: []
    });

    try {
        // Send to Discord
        const discordChannel = await discordClient.channels.fetch(CONFIG.discordChannelId);
        if (!discordChannel) {
            console.error('Discord channel not found');
            return;
        }

        // Send the message content directly to Discord
        let discordMessage = content;

        // Handle media if present
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            if (media) {
                // Save media file
                const fileName = `${Date.now()}_${media.filename || 'media'}`;
                const filePath = path.join(uploadsDir, fileName);

                // Write media to file
                const buffer = Buffer.from(media.data, 'base64');
                fs.writeFileSync(filePath, buffer);

                // Send to Discord with attachment
                const attachment = new AttachmentBuilder(filePath);
                await discordChannel.send({
                    content: discordMessage,
                    files: [attachment]
                });

                // Clean up file after sending
                setTimeout(() => {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                }, 5000);
            }
        } else {
            // Send text only
            await discordChannel.send(discordMessage);
        }

        console.log(`✅ Message sent to Discord: ${discordMessage}`);

        // Set timeout to collect responses and send back to WhatsApp
        setTimeout(async () => {
            await processCollectedResponses(bridgeId);
        }, CONFIG.messageTimeout);

    } catch (error) {
        console.error('Error sending message to Discord:', error);
        activeMessages.delete(bridgeId);
    }
}

// Handle Discord responses
async function handleDiscordMessage(message) {
    // Skip if not in bridge channel
    if (message.channel.id !== CONFIG.discordChannelId) return;

    console.log(`📨 Discord response received: ${message.content}`);

    // Find active bridge messages to respond to
    for (const [bridgeId, bridgeData] of activeMessages.entries()) {
        // Check if message was sent within timeout period
        const timeDiff = Date.now() - bridgeData.timestamp;
        if (timeDiff <= CONFIG.messageTimeout) {
            // Add response to bridge data
            const response = {
                content: message.content,
                author: message.author.username,
                attachments: [],
                timestamp: Date.now()
            };

            // Handle attachments
            if (message.attachments.size > 0) {
                for (const attachment of message.attachments.values()) {
                    try {
                        // Download attachment
                        const response_download = await axios.get(attachment.url, {
                            responseType: 'arraybuffer'
                        });

                        const fileName = `${bridgeId}_${attachment.name}`;
                        const filePath = path.join(uploadsDir, fileName);

                        fs.writeFileSync(filePath, response_download.data);

                        response.attachments.push({
                            name: attachment.name,
                            path: filePath,
                            contentType: attachment.contentType
                        });
                    } catch (error) {
                        console.error('Error downloading Discord attachment:', error);
                    }
                }
            }

            bridgeData.responses.push(response);
            break;
        }
    }
}

// Process collected responses and send back to WhatsApp
async function processCollectedResponses(bridgeId) {
    const bridgeData = activeMessages.get(bridgeId);
    if (!bridgeData) return;

    console.log(`🔄 Processing responses for bridge ID: ${bridgeId}`);

    try {
        const chat = bridgeData.whatsappChat;

        if (bridgeData.responses.length === 0) {
            // No responses received
            await chat.sendMessage('⏰ *Keine Antworten in 30 Sekunden erhalten.*');
        } else {
            // Send each response back to WhatsApp
            for (const response of bridgeData.responses) {
                // Send text response without author formatting
                if (response.content.trim()) {
                    await chat.sendMessage(response.content);
                }

                // Send attachments
                for (const attachment of response.attachments) {
                    try {
                        if (fs.existsSync(attachment.path)) {
                            // Check if it's a .txt file
                            if (attachment.name.toLowerCase().endsWith('.txt')) {
                                // Read and send the text content instead of the file
                                const textContent = fs.readFileSync(attachment.path, 'utf8');
                                await chat.sendMessage(textContent);
                            } else {
                                // Send other files normally
                                const media = MessageMedia.fromFilePath(attachment.path);
                                await chat.sendMessage(media);
                            }

                            // Clean up file
                            fs.unlinkSync(attachment.path);
                        }
                    } catch (error) {
                        console.error('Error sending attachment to WhatsApp:', error);
                        await chat.sendMessage(`❌ Fehler beim Senden der Datei: ${attachment.name}`);
                    }
                }

                // Small delay between messages
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    } catch (error) {
        console.error('Error processing responses:', error);
    } finally {
        // Clean up
        activeMessages.delete(bridgeId);
    }
}

// Self-ping function to keep alive
async function selfPing() {
    try {
        if (CONFIG.pingUrl) {
            await axios.get(CONFIG.pingUrl, { timeout: 5000 });
            console.log('🏓 Self-ping successful');
        }
        lastPing = Date.now();
    } catch (error) {
        console.error('Self-ping failed:', error);
    }
}

// Health check routes
app.get('/', (req, res) => {
    res.json({
        status: 'WhatsApp-Discord Bridge Active',
        whatsappReady: isWhatsAppReady,
        discordReady: isDiscordReady,
        activeMessages: activeMessages.size,
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        lastPing: new Date(lastPing).toISOString(),
        version: '2.2.0'
    });
});

app.get('/health', (req, res) => {
    const healthStatus = {
        status: 'healthy',
        timestamp: Date.now(),
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        memory: process.memoryUsage(),
        services: {
            whatsapp: isWhatsAppReady ? 'online' : 'offline',
            discord: isDiscordReady ? 'online' : 'offline'
        }
    };

    res.status(200).json(healthStatus);
});

app.get('/ping', (req, res) => {
    lastPing = Date.now();
    res.status(200).json({
        pong: true,
        timestamp: lastPing,
        uptime: Math.floor((Date.now() - serverStartTime) / 1000)
    });
});

app.get('/status', (req, res) => {
    res.json({
        whatsapp: {
            ready: isWhatsAppReady,
            connected: whatsappClient?.info || null
        },
        discord: {
            ready: isDiscordReady,
            user: isDiscordReady ? discordClient.user.tag : null
        },
        bridge: {
            activeMessages: activeMessages.size,
            config: {
                triggerChar: CONFIG.triggerChar,
                timeoutMinutes: CONFIG.messageTimeout / 60000
            }
        },
        server: {
            uptime: Math.floor((Date.now() - serverStartTime) / 1000),
            memory: process.memoryUsage(),
            lastPing: new Date(lastPing).toISOString()
        }
    });
});

// Dashboard route
// QR Code display route
// QR Code als Text ausgeben
app.get('/qr-string', (req, res) => {
    if (!currentQRCode) {
        res.json({
            error: 'Kein QR Code verfügbar',
            status: 'WhatsApp bereits verbunden oder wird initialisiert'
        });
        return;
    }

    res.json({
        qrString: currentQRCode,
        instruction: 'Kopiere diesen String und gehe zu qr-generator.org oder qr-code-generator.com',
        expiresIn: '20 Sekunden'
    });
});

app.get('/qr', (req, res) => {
    if (!currentQRCode) {
        res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp QR Code</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; }
        .status { padding: 15px; background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 10px; color: #856404; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp QR Code</h1>
        <div class="status">
            <strong>⏳ Kein QR Code verfügbar</strong>
            <br><br>
            WhatsApp ist bereits verbunden oder wird gerade initialisiert.
            <br><br>
            <a href="/dashboard">← Zurück zum Dashboard</a>
        </div>
    </div>
    <script>
        setTimeout(() => location.reload(), 5000);
    </script>
</body>
</html>
        `);
        return;
    }

    // Generate QR code as data URL for web display
    import('qrcode').then(QRCode => {
        QRCode.toDataURL(currentQRCode, { width: 256, margin: 2 })
            .then(qrDataURL => {
                res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp QR Code</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
        .qr-code { margin: 20px 0; }
        .instructions { background: #e7f3ff; padding: 15px; border-radius: 10px; margin: 20px 0; }
        .timer { color: #dc3545; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp QR Code</h1>

        <div class="qr-code">
            <img src="${qrDataURL}" alt="WhatsApp QR Code" style="max-width: 100%; height: auto;">
        </div>

        <div class="instructions">
            <strong>📋 Anleitung:</strong>
            <ol style="text-align: left;">
                <li>WhatsApp öffnen</li>
                <li>Menü → "Verknüpfte Geräte"</li>
                <li>"Gerät verknüpfen"</li>
                <li>QR Code scannen</li>
            </ol>
        </div>

        <div class="timer" id="timer">
            ⏱️ QR Code läuft in <span id="countdown">20</span> Sekunden ab
        </div>

        <br>
        <a href="/dashboard">← Zurück zum Dashboard</a>
    </div>

    <script>
        let countdown = 20;
        const timer = setInterval(() => {
            countdown--;
            document.getElementById('countdown').textContent = countdown;
            if (countdown <= 0) {
                clearInterval(timer);
                location.reload();
            }
        }, 1000);
    </script>
</body>
</html>
                `);
            })
            .catch(err => {
                res.send(`
<!DOCTYPE html>
<html><body style="text-align: center; padding: 50px;">
<h1>QR Code Error</h1>
<p>Fehler beim Generieren des QR Codes: ${err.message}</p>
<p>QR String: <code>${currentQRCode}</code></p>
<a href="/dashboard">← Zurück zum Dashboard</a>
</body></html>
                `);
            });
    }).catch(err => {
        res.send(`QR Code Error: ${err.message}\n\nQR String: ${currentQRCode}`);
    });
});

app.get('/dashboard', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp-Discord Bridge Dashboard</title>
    <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
        .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .status { padding: 15px; margin: 15px 0; border-radius: 10px; font-weight: bold; }
        .online { background: linear-gradient(135deg, #d4edda, #c3e6cb); color: #155724; border: 2px solid #28a745; }
        .offline { background: linear-gradient(135deg, #f8d7da, #f5c6cb); color: #721c24; border: 2px solid #dc3545; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .stat-card { background: linear-gradient(135deg, #f8f9fa, #e9ecef); padding: 20px; border-radius: 12px; text-align: center; border: 1px solid #dee2e6; }
        .stat-card h3 { margin: 0 0 10px 0; color: #495057; font-size: 14px; text-transform: uppercase; }
        .stat-card p { margin: 0; font-size: 24px; font-weight: bold; color: #212529; }
        .refresh-btn { background: linear-gradient(135deg, #007bff, #0056b3); color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; font-size: 16px; transition: all 0.3s; }
        .refresh-btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,123,255,0.4); }
        .qr-section { margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 10px; border-left: 4px solid #007bff; }
        .alert { padding: 15px; margin: 15px 0; border-radius: 10px; border-left: 4px solid #ffc107; background: #fff3cd; color: #856404; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🌉 WhatsApp-Discord Bridge</h1>
            <p>Dashboard & Status Monitor</p>
        </div>

        <div class="alert">
            <strong>💡 QR Code Hinweis:</strong>
            <br>1. WhatsApp offline? → Vercel Dashboard → Functions → "View Function Logs"
            <br>2. Suche nach "📱 WHATSAPP QR CODE" in den Logs
            <br>3. QR Code schnell scannen (läuft in 20 Sekunden ab!)
            <br>4. Bei Problemen: Seite neu laden um WhatsApp Client neu zu starten
            <br>5. Bot sammelt jetzt 30 Sekunden Discord-Antworten (auch von anderen Bots)
        </div>

        <div id="status-container"></div>

        <div style="text-align: center; margin: 30px 0;">
            <button class="refresh-btn" onclick="loadStatus()">🔄 Status Aktualisieren</button>
        </div>

        <div class="qr-section">
            <h3>📱 WhatsApp Setup</h3>
            <ol>
                <li>Öffne WhatsApp → Menü → "Verknüpfte Geräte"</li>
                <li>Klicke "Gerät verknüpfen"</li>
                <li><a href="/qr" target="_blank">🔗 QR Code anzeigen</a> oder aus Vercel Logs</li>
                <li>Bridge ist bereit! Nutze "${CONFIG.triggerChar}" vor Nachrichten</li>
                <li>Spezial: "${CONFIG.triggerChar}ha" wird direkt als ".ha" gesendet</li>
                <li>Bot sammelt 30 Sekunden lang Discord-Antworten (auch von anderen Bots)</li>
            </ol>
        </div>
    </div>

    <script>
        async function loadStatus() {
            try {
                const response = await fetch('/status');
                const data = await response.json();

                document.getElementById('status-container').innerHTML = \`
                    <div class="status \${data.whatsapp.ready ? 'online' : 'offline'}">
                        📱 WhatsApp: \${data.whatsapp.ready ? '✅ Online & Bereit' : '⏳ Offline - QR Code scannen erforderlich'}
                    </div>
                    <div class="status \${data.discord.ready ? 'online' : 'offline'}">
                        🤖 Discord: \${data.discord.ready ? '✅ Online (' + (data.discord.user || 'Unknown') + ')' : '❌ Offline - Token prüfen'}
                    </div>
                    <div class="stats">
                        <div class="stat-card">
                            <h3>Aktive Nachrichten</h3>
                            <p>\${data.bridge.activeMessages}</p>
                        </div>
                        <div class="stat-card">
                            <h3>Server Uptime</h3>
                            <p>\${Math.floor(data.server.uptime / 3600)}h \${Math.floor((data.server.uptime % 3600) / 60)}m</p>
                        </div>
                        <div class="stat-card">
                            <h3>Memory Usage</h3>
                            <p>\${Math.round(data.server.memory.rss / 1024 / 1024)}MB</p>
                        </div>
                        <div class="stat-card">
                            <h3>Trigger Zeichen</h3>
                            <p>"\${data.bridge.config.triggerChar}"</p>
                        </div>
                        <div class="stat-card">
                            <h3>Timeout</h3>
                            <p>\${data.bridge.config.timeoutMinutes} Min (30s)</p>
                        </div>
                        <div class="stat-card">
                            <h3>Letzter Ping</h3>
                            <p>\${new Date(data.server.lastPing).toLocaleTimeString('de-DE')}</p>
                        </div>
                    </div>
                \`;
            } catch (error) {
                document.getElementById('status-container').innerHTML = '<div class="status offline">❌ Fehler beim Laden des Status</div>';
            }
        }

        // Load status on page load
        loadStatus();

        // Auto-refresh every 30 seconds
        setInterval(loadStatus, 30000);
    </script>
</body>
</html>
    `);
});

// Initialize clients
console.log('🚀 Starting WhatsApp-Discord Bridge on Vercel...');
console.log('📡 Platform: Vercel Serverless');
console.log('🔧 Environment:', CONFIG.isProduction ? 'Production' : 'Development');
console.log('📁 Uploads Dir:', uploadsDir);

// Initialize Discord first (faster)
initializeDiscord();

// Initialize WhatsApp after a short delay
setTimeout(() => {
    initializeWhatsApp();
}, 2000);

// Set up periodic self-ping for uptime
if (CONFIG.pingUrl) {
    setInterval(selfPing, 5 * 60 * 1000); // Ping every 5 minutes
    console.log('🏓 Self-ping enabled for 24/7 uptime');
}

// Cleanup inactive messages every hour
setInterval(() => {
    const now = Date.now();
    for (const [bridgeId, bridgeData] of activeMessages.entries()) {
        if (now - bridgeData.timestamp > 60 * 60 * 1000) { // 1 hour
            activeMessages.delete(bridgeId);
            console.log(`🧹 Cleaned up expired message: ${bridgeId}`);
        }
    }
}, 60 * 60 * 1000);

// Start server only in development
let server;
if (!CONFIG.isProduction) {
    server = app.listen(CONFIG.port, () => {
        console.log(`🌐 Server running on port ${CONFIG.port}`);
        console.log(`📊 Dashboard: http://localhost:${CONFIG.port}/dashboard`);
        console.log(`🔗 Health: http://localhost:${CONFIG.port}/health`);
        console.log(`🏓 Ping: http://localhost:${CONFIG.port}/ping`);
    });
} else {
    console.log(`🌐 Vercel serverless function initialized`);
    console.log(`📊 Dashboard: /dashboard`);
    console.log(`🔗 Health: /health`);
    console.log(`🏓 Ping: /ping`);
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    if (discordClient) {
        await discordClient.destroy();
    }
    if (server) {
        server.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    if (discordClient) {
        await discordClient.destroy();
    }
    if (server) {
        server.close();
    }
    process.exit(0);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);

    // Try to restart services
    setTimeout(() => {
        console.log('🔄 Attempting to restart after uncaught exception...');
        if (!isDiscordReady) initializeDiscord();
        if (!isWhatsAppReady) initializeWhatsApp();
    }, 5000);
});

export default app;

