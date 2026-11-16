
'use strict';

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');

const baileys = require('@dnuzi/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const {
    useMultiFileAuthState,
    DisconnectReason,
    delay
} = baileys;

const router = express.Router();

const SESSION_ROOT = process.env.SESSION_DIR || '/data/zeno-sessions';
const API_KEY = process.env.PAIR_API_KEY;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 5);

const sessions = new Map();
const pairingRequests = new Map();
const cooldowns = new Map();

fs.ensureDirSync(SESSION_ROOT);

function cleanNumber(number) {
    return String(number || '').replace(/\D/g, '');
}

function auth(req, res, next) {
    if (!API_KEY) {
        return res.status(503).json({
            error: 'PAIR_API_KEY is missing'
        });
    }

    if (req.get('x-api-key') !== API_KEY) {
        return res.status(401).json({
            error: 'Unauthorized'
        });
    }

    next();
}

function getSessionPath(number) {
    return path.join(SESSION_ROOT, number);
}

function getStatusCode(error) {
    return error?.output?.statusCode ??
        error?.data?.statusCode ??
        error?.statusCode ?? null;
}

async function startBot(number) {
    if (sessions.has(number)) {
        return sessions.get(number);
    }

    const folder = getSessionPath(number);
    await fs.ensureDir(folder);

    const { state, saveCreds } =
        await useMultiFileAuthState(folder);

    const socket = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    const bot = {
        number,
        socket,
        connected: false,
        startedAt: Date.now(),
        reconnecting: false
    };

    sessions.set(number, bot);

    socket.ev.on('creds.update', async () => {
        try {
            await saveCreds();
        } catch (error) {
            console.error('Save credentials error:', error.message);
        }
    });

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !state.creds.registered) {
            const request = pairingRequests.get(number);

            if (request && !request.generated) {
                request.generated = true;

                try {
                    const code = await socket.requestPairingCode(number);
                    request.resolve(code);
                } catch (error) {
                    request.reject(error);
                }
            }
        }

        if (connection === 'open') {
            bot.connected = true;
            bot.reconnecting = false;

            const request = pairingRequests.get(number);
            if (request) request.resolve(null);

            console.log(`[${number}] Connected successfully`);
        }

        if (connection === 'close') {
            bot.connected = false;

            const status = getStatusCode(lastDisconnect?.error);

            console.log(`[${number}] Connection closed: ${status}`);

            const loggedOut =
                status === 401 ||
                status === DisconnectReason?.loggedOut;

            const replaced =
                status === 440 ||
                status === DisconnectReason?.connectionReplaced;

            if (loggedOut || replaced) {
                sessions.delete(number);
                console.log(`[${number}] Session needs attention`);
                return;
            }

            if (!bot.reconnecting) {
                bot.reconnecting = true;

                setTimeout(async () => {
                    try {
                        sessions.delete(number);
                        await startBot(number);
                    } catch (error) {
                        console.error('Reconnect error:', error.message);
                    }
                }, 5000);
            }
        }
    });

    return bot;
}

function makeWaiter() {
    let resolve;
    let reject;

    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });

    const timer = setTimeout(() => {
        reject(new Error('Pairing request timed out'));
    }, 30000);

    return {
        promise: promise.finally(() => clearTimeout(timer)),
        resolve,
        reject,
        generated: false
    };
}

// GET /pair?number=947XXXXXXXX
router.get('/', auth, async (req, res) => {
    const number = cleanNumber(req.query.number);

    if (number.length < 10 || number.length > 15) {
        return res.status(400).json({
            error: 'Invalid phone number'
        });
    }

    const existing = sessions.get(number);

    if (existing?.connected) {
        return res.json({
            status: 'already_connected',
            number
        });
    }

    if (sessions.size >= MAX_SESSIONS && !existing) {
        return res.status(429).json({
            error: 'Maximum sessions reached'
        });
    }

    const lastRequest = cooldowns.get(number) || 0;

    if (Date.now() - lastRequest < 60000) {
        return res.status(429).json({
            error: 'Wait 60 seconds before retrying'
        });
    }

    cooldowns.set(number, Date.now());

    const waiter = makeWaiter();
    pairingRequests.set(number, waiter);

    try {
        await startBot(number);

        const code = await waiter.promise;

        if (!code) {
            return res.json({
                status: 'connected',
                number
            });
        }

        return res.json({
            status: 'pairing_code_generated',
            number,
            code
        });

    } catch (error) {
        console.error('Pairing error:', error.message);

        return res.status(503).json({
            error: error.message
        });

    } finally {
        pairingRequests.delete(number);
    }
});

// Ping
router.get('/ping', auth, (req, res) => {
    res.json({
        status: 'active',
        bot: 'zeno-bot',
        sessions: sessions.size
    });
});

// Active bots
router.get('/active', auth, (req, res) => {
    const numbers = Array.from(sessions.values())
        .filter(bot => bot.connected)
        .map(bot => bot.number);

    res.json({
        count: numbers.length,
        numbers
    });
});

// Bot information
router.get('/botinfo', auth, (req, res) => {
    const bots = Array.from(sessions.values()).map(bot => ({
        number: bot.number,
        status: bot.connected ? 'online' : 'connecting',
        uptime: Math.floor(
            (Date.now() - bot.startedAt) / 1000
        )
    }));

    res.json({
        count: bots.length,
        bots
    });
});

// Restore saved sessions from Railway Volume
async function restoreSessions() {
    try {
        const folders = await fs.readdir(
            SESSION_ROOT,
            { withFileTypes: true }
        );

        for (const folder of folders) {
            if (
                !folder.isDirectory() ||
                !/^\d{10,15}$/.test(folder.name)
            ) continue;

            const creds = path.join(
                SESSION_ROOT,
                folder.name,
                'creds.json'
            );

            if (await fs.pathExists(creds)) {
                try {
                    await startBot(folder.name);
                    console.log(
                        `Restored session: ${folder.name}`
                    );

                    await delay(1000);

                } catch (error) {
                    console.error(
                        'Restore error:',
                        error.message
                    );
                }
            }
        }
    } catch (error) {
        console.error(
            'Session restore failed:',
            error.message
        );
    }
}

setTimeout(() => {
    restoreSessions();
}, 2000);

module.exports = router;
