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
    messageTimeout: (process.env.MESSAGE_TIMEOUT_MINUTES || 2) * 60 * 1000,
    triggerChar: process.env.TRIGGER_CHARACTER || '.',
    sessionName: process.env.WHATSAPP_SESSION_NAME || 'bridge-session',
    isProduction: process.env.NODE_ENV === 'production',
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

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Improved Puppeteer configuration for Vercel
async function getPuppeteerConfig() {
    if (CONFIG.isProduction) {
        // Production configuration for Vercel
        try {
            return {
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                ignoreHTTPSErrors: true
            };
        } catch (error) {
            console.log('Chromium not available, using fallback config');
            return {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor'
                ]
            };
        }
    } else {
        // Development configuration
        return {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        };
    }
}

// WhatsApp Client Setup
async function initializeWhatsApp() {
    console.log('🔄 Initializing WhatsApp client...');

    const puppeteerConfig = await getPuppeteerConfig();

    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: CONFIG.sessionName,
            dataPath: './whatsapp-session'
        }),
        puppeteer: puppeteerConfig
    });

    whatsappClient.on('qr', (qr) => {
        console.log('📱 WhatsApp QR Code:');
        qrcode.generate(qr, { small: true });
        console.log('💡 Scan this QR code with your WhatsApp (Dual Account recommended)');
        console.log('🔗 Or visit: https://your-app.vercel.app/qr to see QR in browser');
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

    whatsappClient.initialize().catch(error => {
        console.error('Failed to initialize WhatsApp client:', error);
        setTimeout(() => {
            console.log('🔄 Retrying WhatsApp initialization...');
            initializeWhatsApp();
        }, 10000);
    });
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

    discordClient.once('ready', () => {
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

    // Extract message content (remove trigger character)
    const content = message.body.substring(1).trim();
    if (!content) return;

    // Get chat info
    const chat = await message.getChat();
    const contact = await message.getContact();

    // Create bridge message ID
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

        // Format message for Discord
        const discordMessage = `**From WhatsApp** (${contact.name || contact.pushname || 'Unknown'}):\n${content}\n\n*Bridge ID: ${bridgeId}*`;

        // Handle media if present
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            if (media) {
                // Save media file
                const fileName = `${bridgeId}_${media.filename || 'media'}`;
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

        console.log(`✅ Message bridged to Discord with ID: ${bridgeId}`);

        // Set timeout to collect responses
        setTimeout(async () => {
            await processCollectedResponses(bridgeId);
        }, CONFIG.messageTimeout);

    } catch (error) {
        console.error('Error bridging message to Discord:', error);
        activeMessages.delete(bridgeId);
    }
}

// Handle Discord responses
async function handleDiscordMessage(message) {
    // Skip bot messages
    if (message.author.bot) return;

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
            await chat.sendMessage('⏰ *Keine Antworten in 2 Minuten erhalten.*');
        } else {
            // Send each response back to WhatsApp
            for (const response of bridgeData.responses) {
                let messageText = `**${response.author}**: ${response.content}`;

                // Send text response
                if (response.content.trim()) {
                    await chat.sendMessage(messageText);
                }

                // Send attachments
                for (const attachment of response.attachments) {
                    try {
                        if (fs.existsSync(attachment.path)) {
                            const media = MessageMedia.fromFilePath(attachment.path);
                            await chat.sendMessage(media, {
                                caption: `📎 ${attachment.name} (von ${response.author})`
                            });

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

            await chat.sendMessage(`✅ *${bridgeData.responses.length} Antwort(en) von Discord weitergeleitet.*`);
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
        version: '2.0.0'
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
app.get('/dashboard', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp-Discord Bridge Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; }
        .status { padding: 10px; margin: 10px 0; border-radius: 5px; }
        .online { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .offline { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
        .stat-card { background: #e9ecef; padding: 15px; border-radius: 8px; text-align: center; }
        .refresh-btn { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌉 WhatsApp-Discord Bridge Dashboard</h1>
        <div id="status-container"></div>
        <button class="refresh-btn" onclick="loadStatus()">Aktualisieren</button>
    </div>

    <script>
        async function loadStatus() {
            try {
                const response = await fetch('/status');
                const data = await response.json();

                document.getElementById('status-container').innerHTML = \`
                    <div class="status \${data.whatsapp.ready ? 'online' : 'offline'}">
                        📱 WhatsApp: \${data.whatsapp.ready ? 'Online' : 'Offline'}
                    </div>
                    <div class="status \${data.discord.ready ? 'online' : 'offline'}">
                        🤖 Discord: \${data.discord.ready ? 'Online (' + (data.discord.user || 'Unknown') + ')' : 'Offline'}
                    </div>
                    <div class="stats">
                        <div class="stat-card">
                            <h3>Aktive Nachrichten</h3>
                            <p>\${data.bridge.activeMessages}</p>
                        </div>
                        <div class="stat-card">
                            <h3>Uptime</h3>
                            <p>\${Math.floor(data.server.uptime / 3600)}h \${Math.floor((data.server.uptime % 3600) / 60)}m</p>
                        </div>
                        <div class="stat-card">
                            <h3>Memory</h3>
                            <p>\${Math.round(data.server.memory.rss / 1024 / 1024)}MB</p>
                        </div>
                        <div class="stat-card">
                            <h3>Trigger</h3>
                            <p>"\${data.bridge.config.triggerChar}"</p>
                        </div>
                    </div>
                \`;
            } catch (error) {
                document.getElementById('status-container').innerHTML = '<div class="status offline">Error loading status</div>';
            }
        }
        loadStatus();
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

// Start server
const server = app.listen(CONFIG.port, () => {
    console.log(`🌐 Server running on port ${CONFIG.port}`);
    console.log(`📊 Dashboard: https://your-app.vercel.app/dashboard`);
    console.log(`🔗 Health: https://your-app.vercel.app/health`);
    console.log(`🏓 Ping: https://your-app.vercel.app/ping`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    if (whatsappClient) {
        await whatsappClient.destroy();
    }
    if (discordClient) {
        await discordClient.destroy();
    }
    server.close();
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
    server.close();
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

