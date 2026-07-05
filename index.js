#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import express from 'express';
import qrcode from 'qrcode';
import http from 'http';
import https from 'https';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys';
import {
  formatConversationLogLine,
  parseConversationLine,
  resolveConversationFilePath,
} from './chat-routing.js';

const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

const BASE_VAULT_DIR = path.resolve(process.cwd(), 'wa-panel-vault');
const GLOBAL_NAMES_MAP_PATH = path.join(BASE_VAULT_DIR, 'names_map.json');
const PRESENCE_HISTORY_PATH = path.join(BASE_VAULT_DIR, 'presence_routine_history.txt');
const MEDIA_VAULT_DIR = path.join(BASE_VAULT_DIR, 'media');
const SESSIONS_ROOT = path.resolve(process.cwd(), 'sessions');
const DIST_DIR = path.resolve(process.cwd(), 'dist');
const PORT = process.env.PORT || 3000;
const PAIRING_TIMEOUT_MS = 3 * 60 * 1000;
const CONVERSATION_FILE = 'conversation.txt';

const activeSessions = new Map();
const sessionStates = Object.create(null);
const eventSubscribers = new Set();
let httpServer = null;

function sanitizeSegment(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function getAuthDir(sessionName) {
  const authDir = path.resolve(path.join(SESSIONS_ROOT, sanitizeSegment(sessionName)));
  // Ensure SESSIONS_ROOT is absolute
  if (!path.isAbsolute(authDir)) {
    throw new Error(`Auth directory path must be absolute: ${authDir}`);
  }
  return authDir;
}

function getDirection(msg) {
  return msg?.key?.fromMe ? 'OUTGOING' : 'INCOMING';
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizePhoneId(jid) {
  return String(jid || '')
    .split('@')[0]
    .replace(/\D/g, '');
}

function readGlobalNamesMap() {
  if (!fs.existsSync(GLOBAL_NAMES_MAP_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_NAMES_MAP_PATH, 'utf8')) || {};
  } catch (error) {
    console.error('[GLOBAL] Failed to parse names_map.json:', error?.message || error);
    return {};
  }
}

function writeGlobalNamesMap(map) {
  ensureDirectory(BASE_VAULT_DIR);
  fs.writeFileSync(GLOBAL_NAMES_MAP_PATH, JSON.stringify(map, null, 2), 'utf8');
}

function syncNamesMapWithContacts(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return;
  }

  const namesMap = readGlobalNamesMap();
  let changed = false;

  for (const contact of contacts) {
    const name = contact?.name || contact?.verifiedName;
    if (!name || !contact?.id) {
      continue;
    }

    const phone = normalizePhoneId(contact.id);
    if (!phone) {
      continue;
    }

    if (namesMap[phone] !== name) {
      namesMap[phone] = name;
      changed = true;
    }
  }

  if (changed) {
    writeGlobalNamesMap(namesMap);
  }
}

function getContactNameFromGlobal(jid) {
  const phone = normalizePhoneId(jid);
  const namesMap = readGlobalNamesMap();
  return namesMap[phone] || null;
}

function appendPresenceRoutineEntry(jid, presenceState) {
  const phone = normalizePhoneId(jid) || jid || 'unknown';
  const label = getContactNameFromGlobal(jid) || phone;
  const timestamp = formatTimestamp(new Date());
  const line = `${timestamp} | ${label} | ${presenceState}`;

  ensureDirectory(BASE_VAULT_DIR);
  fs.appendFileSync(PRESENCE_HISTORY_PATH, `${line}\n`, 'utf8');
}

function getViewOncePayload(message) {
  const viewOnce = message?.viewOnceMessage || message?.viewOnceMessageV2;
  if (!viewOnce?.message) {
    return null;
  }
  return viewOnce.message;
}

function getMediaTypeAndExtension(msg) {
  if (msg.imageMessage) return { type: 'image', ext: 'jpg', inner: msg.imageMessage };
  if (msg.videoMessage) return { type: 'video', ext: 'mp4', inner: msg.videoMessage };
  if (msg.audioMessage) return { type: 'audio', ext: 'ogg', inner: msg.audioMessage };
  if (msg.stickerMessage) return { type: 'image', ext: 'webp', inner: msg.stickerMessage };
  return null;
}

function broadcastEvent(payload) {
  const data = JSON.stringify(payload);
  for (const subscriber of [...eventSubscribers]) {
    try {
      subscriber.write(`data: ${data}\n\n`);
    } catch {
      eventSubscribers.delete(subscriber);
    }
  }
}

function createSessionState(sessionName, patch = {}) {
  return {
    sessionName,
    phoneNumber: null,
    mode: null,
    status: 'pending',
    connected: false,
    pairingCode: null,
    qrCode: null,
    qrDataUrl: null,
    message: null,
    lastUpdated: null,
    ...patch,
  };
}

function setSessionState(sessionName, patch = {}) {
  const nextState = {
    ...(sessionStates[sessionName] || createSessionState(sessionName)),
    ...patch,
    lastUpdated: new Date().toISOString(),
  };

  sessionStates[sessionName] = nextState;
  broadcastEvent({ type: 'session', session: nextState });
}

function removeSessionState(sessionName) {
  delete sessionStates[sessionName];
  broadcastEvent({ type: 'session-removed', sessionName });
}

function readCreds(sessionName) {
  const credsPath = path.join(getAuthDir(sessionName), 'creds.json');
  if (!fs.existsSync(credsPath)) {
    console.log(`[${sessionName}] No existing creds file at ${credsPath}`);
    return null;
  }

  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    console.log(`[${sessionName}] Loaded creds from disk. Registered: ${creds.registered === true}`);
    return creds;
  } catch (error) {
    console.error(`[${sessionName}] Unable to read creds:`, error.message);
    return null;
  }
}

function wipeSessionAuth(sessionName) {
  const authDir = getAuthDir(sessionName);
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log(`[${sessionName}] Auth keys deleted.`);
  }
}

function formatTimestamp(date = new Date()) {
  const pad = (num) => String(num).padStart(2, '0');
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${hours}:${minutes}:${seconds}`;
}

function extractTextContent(msg) {
  const message = msg?.message || {};
  if (typeof message.conversation === 'string' && message.conversation.trim()) {
    return message.conversation.trim();
  }
  const extended = message.extendedTextMessage;
  if (extended && typeof extended.text === 'string' && extended.text.trim()) {
    return extended.text.trim();
  }
  return null;
}

function parseChatFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);

  return lines.map((line, index) => {
    const parsed = parseConversationLine(line);

    if (parsed) {
      return {
        id: `${index}`,
        timestamp: parsed.timestamp,
        direction: parsed.direction,
        sender: parsed.sender,
        content: parsed.content,
      };
    }

    return {
      id: `${index}`,
      timestamp: null,
      direction: 'INCOMING',
      sender: null,
      content: line,
    };
  });
}

function listChatSessions(rootDir = BASE_VAULT_DIR) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const sessionEntries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  return sessionEntries.map((entry) => {
    const sessionDir = path.join(rootDir, entry.name);

    // load names map for display overrides
    const namesMapPath = path.join(sessionDir, 'names_map.json');
    let namesMap = {};
    if (fs.existsSync(namesMapPath)) {
      try {
        namesMap = JSON.parse(fs.readFileSync(namesMapPath, 'utf8')) || {};
      } catch (err) {
        console.error(`[${entry.name}] Failed to read names_map.json:`, err.message);
        namesMap = {};
      }
    }

    const files = fs
      .readdirSync(sessionDir, { withFileTypes: true })
      .filter((item) => item.isFile() && item.name.endsWith('.txt'))
      .sort((a, b) => a.name.localeCompare(b.name));

    const contacts = files.map((fileEntry) => {
      const baseName = fileEntry.name.replace(/\.txt$/, '');
      const globalNamesMap = readGlobalNamesMap();
      const contactName = globalNamesMap[baseName] || namesMap[baseName] || baseName;
      const filePath = path.join(sessionDir, fileEntry.name);
      let messageCount = 0;
      let keywordAlert = false;

      try {
        if (fs.existsSync(filePath)) {
          const fileContent = fs.readFileSync(filePath, 'utf8');
          const lines = fileContent.split(/\r?\n/).filter((l) => l.trim());
          messageCount = lines.length;
          const alertRegex = /\b(alert|urgent|critical|help|suspicious|flagged)\b/i;
          keywordAlert = alertRegex.test(fileContent);
        }
      } catch (err) {
        console.error(`Error reading file ${filePath} for metadata:`, err);
      }

      return {
        id: `${entry.name}:${fileEntry.name}`,
        sessionName: entry.name,
        contactName,
        fileName: fileEntry.name,
        messageCount,
        keywordAlert,
      };
    });

    return { sessionName: entry.name, contacts };
  });
}

function resolveContactName(remoteJid, pushName, sock) {
  const contactRecord = sock?.contacts?.get(remoteJid);
  const mappedName = getContactNameFromGlobal(remoteJid);
  const candidate =
    contactRecord?.name ||
    contactRecord?.verifiedName ||
    pushName ||
    mappedName ||
    contactRecord?.notify ||
    remoteJid;
  return candidate || remoteJid;
}

function getMediaMessage(message) {
  if (!message) return null;
  if (message.imageMessage) return { msg: message.imageMessage, type: 'image' };
  if (message.audioMessage) return { msg: message.audioMessage, type: 'audio' };
  
  const wrapperTypes = ['ephemeralMessage', 'viewOnceMessage', 'documentWithCaptionMessage'];
  for (const type of wrapperTypes) {
    if (message[type]?.message) {
      const unwrapped = getMediaMessage(message[type].message);
      if (unwrapped) return unwrapped;
    }
  }
  return null;
}

function triggerWebhook(sessionName, payload) {
  if (!WEBHOOK_URL) return;
  try {
    const url = new URL(WEBHOOK_URL);
    const client = url.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(payload);
    
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      res.resume();
    });
    
    req.on('error', (err) => {
      console.error(`[${sessionName}] Webhook request failed:`, err.message);
    });
    
    req.write(postData);
    req.end();
  } catch (err) {
    console.error(`[${sessionName}] Webhook URL parse error:`, err.message);
  }
}

async function handleMessagePacket(sessionName, msg, sock) {
  try {
    if (!msg?.message || msg.key?.fromMe === undefined) {
      return;
    }

    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      return;
    }

    const isGroup = remoteJid.endsWith('@g.us');
    const direction = getDirection(msg);
    const conversationFilePath = resolveConversationFilePath({
      baseVaultDir: BASE_VAULT_DIR,
      sessionName,
      remoteJid,
      isGroup,
    });

    if (!conversationFilePath) {
      return;
    }

    const sessionFolder = path.dirname(conversationFilePath);
    ensureDirectory(sessionFolder);

    const senderDisplay = isGroup
      ? direction === 'OUTGOING'
        ? 'You'
        : resolveContactName(msg.key?.participant || remoteJid, msg.pushName, sock) || (msg.key?.participant || remoteJid).split('@')[0]
      : direction === 'OUTGOING'
        ? 'You'
        : resolveContactName(remoteJid, msg.pushName, sock) || remoteJid.split('@')[0] || 'unknown';

    const contactName = path.basename(conversationFilePath, '.txt');

    const rawMessage = msg?.message || {};
    const isViewOnce = rawMessage.viewOnceMessage || rawMessage.viewOnceMessageV2;
    if (isViewOnce?.message) {
      msg.message = isViewOnce.message;
    }

    const textContent = extractTextContent(msg);
    if (textContent) {
      const cleanContent = textContent.replace(/\r?\n/g, ' ');
      const timestampStr = formatTimestamp(new Date());
      const logLine = formatConversationLogLine({
        timestamp: timestampStr,
        senderDisplay,
        content: cleanContent,
      });

      fs.appendFileSync(conversationFilePath, `${logLine}\n`, 'utf8');

      triggerWebhook(sessionName, {
        event: 'text_message',
        direction,
        isGroup,
        sessionName,
        contactName,
        content: cleanContent,
        timestamp: timestampStr,
      });

      broadcastEvent({ type: 'chat', sessionName, contactFile: path.basename(conversationFilePath) });
    }

    const mediaInfo = getMediaMessage(msg.message);
    if (mediaInfo) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        if (buffer) {
          const mediaFolder = path.join(sessionFolder, 'media');
          ensureDirectory(mediaFolder);

          const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          const extension = mediaInfo.type === 'image' ? 'jpg' : 'ogg';
          const fileName = `${fileId}.${extension}`;
          const mediaFilePath = path.join(mediaFolder, fileName);

          fs.writeFileSync(mediaFilePath, buffer);

          const timestampStr = formatTimestamp(new Date());
          const mediaRef = `media/${fileName}`;
          const logLine = formatConversationLogLine({
            timestamp: timestampStr,
            senderDisplay,
            content: mediaRef,
          });

          fs.appendFileSync(conversationFilePath, `${logLine}\n`, 'utf8');

          triggerWebhook(sessionName, {
            event: 'media_message',
            direction,
            isGroup,
            sessionName,
            contactName,
            mediaUrl: `/vault/${encodeURIComponent(sessionName)}/${mediaRef}`,
            timestamp: timestampStr,
          });

          broadcastEvent({ type: 'chat', sessionName, contactFile: path.basename(conversationFilePath) });
        }
      } catch (err) {
        console.error(`[${sessionName}] Failed to download/save media:`, err.message);
      }
    }
  } catch (error) {
    console.error(`[${sessionName}] Failed to process message packet:`, error.message);
  }
}

async function tearDownSession(sessionName, { wipeAuth = false, reason = null, removeState = false } = {}) {
  const record = activeSessions.get(sessionName);
  if (record?.pairingTimeout) {
    clearTimeout(record.pairingTimeout);
  }

  if (record?.sock) {
    try {
      record.sock.ev.removeAllListeners();
      record.sock.end(undefined);
    } catch (error) {
      console.error(`[${sessionName}] Error closing socket:`, error.message);
    }
  }

  activeSessions.delete(sessionName);

  if (wipeAuth) {
    wipeSessionAuth(sessionName);
  }

  if (removeState) {
    removeSessionState(sessionName);
    return;
  }

  if (reason) {
    setSessionState(sessionName, {
      status: 'error',
      connected: false,
      pairingCode: null,
      qrCode: null,
      qrDataUrl: null,
      message: reason,
    });
  }
}

function listPersistedSessionNames() {
  if (!fs.existsSync(SESSIONS_ROOT)) {
    return [];
  }

  return fs
    .readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function restorePersistedSessions() {
  for (const sessionName of listPersistedSessionNames()) {
    const creds = readCreds(sessionName);
    if (!creds) {
      console.log(`[${sessionName}] No credentials found. Wiping empty session folder...`);
      wipeSessionAuth(sessionName);
      continue;
    }

    if (!creds.registered) {
      console.log(`[${sessionName}] Credentials exist but not registered. Wiping incomplete auth...`);
      wipeSessionAuth(sessionName);
      continue;
    }

    if (activeSessions.has(sessionName)) {
      console.log(`[${sessionName}] Session already active. Skipping restore.`);
      continue;
    }

    const phoneNumber = creds.me?.id?.split(':')[0]?.split('@')[0] || null;
    console.log(`[${sessionName}] Restoring registered session for ${phoneNumber}...`);
    setSessionState(sessionName, {
      phoneNumber,
      mode: 'restored',
      status: 'reconnecting',
      connected: false,
      message: 'Restoring saved session…',
    });

    try {
      await startSession(sessionName, phoneNumber, 'restored', { isRestore: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to restore session.';
      console.error(`[${sessionName}] Restore failed:`, message);
      await tearDownSession(sessionName, { wipeAuth: true, reason: message, removeState: true });
    }
  }
}

async function startSession(sessionName, phoneNumber, mode = 'pairing', options = {}) {
  const { isRestore = false, isRetry = false } = options;
  const authDir = getAuthDir(sessionName);
  ensureDirectory(authDir);

  // CRITICAL: Check if creds already exist before loading fresh state
  // This prevents blank session overwrites
  const existingCredsOnDisk = readCreds(sessionName);
  if (existingCredsOnDisk?.registered && !isRetry) {
    console.log(`[${sessionName}] Found registered creds on disk. Will restore session using existing authentication.`);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Wrap saveCreds to add logging and verification
  const originalSaveCreds = saveCreds;
  const wrappedSaveCreds = async (...args) => {
    try {
      console.log(`[${sessionName}] creds.update event triggered - persisting credentials to disk...`);
      const result = await originalSaveCreds(...args);
      // Verify the save succeeded
      const verify = readCreds(sessionName);
      if (verify) {
        console.log(`[${sessionName}] Credentials successfully persisted. Registered: ${verify.registered === true}`);
      }
      return result;
    } catch (err) {
      console.error(`[${sessionName}] CRITICAL: Failed to save credentials:`, err.message);
      throw err;
    }
  };
  
  const contactsFile = path.join(authDir, 'contacts.json');
  const contactsMap = new Map();
  if (fs.existsSync(contactsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(contactsFile, 'utf8'));
      for (const [id, value] of Object.entries(data)) {
        contactsMap.set(id, value);
      }
    } catch (e) {
      console.error(`[${sessionName}] Failed to read contacts.json:`, e.message);
    }
  }

  const saveContacts = () => {
    try {
      const obj = Object.fromEntries(contactsMap.entries());
      fs.writeFileSync(contactsFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.error(`[${sessionName}] Failed to write contacts.json:`, e.message);
    }
  };

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.contacts = contactsMap;

  sock.ev.on('contacts.upsert', (newContacts) => {
    syncNamesMapWithContacts(newContacts);
    let changed = false;
    for (const contact of newContacts) {
      const existing = contactsMap.get(contact.id) || {};
      const updated = { ...existing, ...contact };
      if (JSON.stringify(existing) !== JSON.stringify(updated)) {
        contactsMap.set(contact.id, updated);
        changed = true;
      }
    }
    if (changed) saveContacts();
  });

  sock.ev.on('contacts.update', (updates) => {
    syncNamesMapWithContacts(updates);
    let changed = false;
    for (const update of updates) {
      const existing = contactsMap.get(update.id) || {};
      const updated = { ...existing, ...update };
      if (JSON.stringify(existing) !== JSON.stringify(updated)) {
        contactsMap.set(update.id, updated);
        changed = true;
      }
    }
    if (changed) saveContacts();
  });

  const sessionRecord = {
    sock,
    authDir,
    phoneNumber,
    mode,
    pairingCodeRequested: false,
    pairingTimeout: null,
    reconnectAttempts: 0,
  };
  activeSessions.set(sessionName, sessionRecord);

  const clearPairingTimeout = () => {
    if (sessionRecord.pairingTimeout) {
      clearTimeout(sessionRecord.pairingTimeout);
      sessionRecord.pairingTimeout = null;
    }
  };

  const schedulePairingTimeout = () => {
    clearPairingTimeout();
    sessionRecord.pairingTimeout = setTimeout(() => {
      if (!sessionStates[sessionName]?.connected) {
        void tearDownSession(sessionName, {
          wipeAuth: true,
          reason: 'Pairing timed out. Keys were cleared — try again.',
          removeState: true,
        });
      }
    }, PAIRING_TIMEOUT_MS);
  };

  const requestPairingCodeWhenReady = async () => {
    if (sessionRecord.pairingCodeRequested || state.creds.registered || mode !== 'pairing' || !phoneNumber) {
      return;
    }

    sessionRecord.pairingCodeRequested = true;
    try {
      const pairingCode = await sock.requestPairingCode(phoneNumber);
      setSessionState(sessionName, {
        status: 'pairing',
        connected: false,
        pairingCode,
        qrCode: null,
        qrDataUrl: null,
        message: `Enter this code on your phone for ${phoneNumber}.`,
      });
      schedulePairingTimeout();
    } catch (error) {
      console.error(`[${sessionName}] Request pairing code failed:`, error?.message || error);
      setSessionState(sessionName, {
        message: `Pairing failed: ${error?.message || 'unknown error'}. Retrying...`,
      });
      sessionRecord.pairingCodeRequested = false;
    }
  };

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (!state.creds.registered && mode === 'pairing') {
      await requestPairingCodeWhenReady();
    }

    if (qr && !state.creds.registered && mode === 'qr') {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 8 });
        setSessionState(sessionName, {
          status: 'pairing',
          connected: false,
          pairingCode: null,
          qrCode: qr,
          qrDataUrl,
          message: 'Scan this QR code with WhatsApp on your phone.',
        });
        schedulePairingTimeout();
      } catch (error) {
        console.error(`[${sessionName}] QR generation failed:`, error?.message || error);
      }
    }

    if (connection === 'open') {
      clearPairingTimeout();
      console.log(`[${sessionName}] Connected successfully.`);
      setSessionState(sessionName, {
        status: 'connected',
        connected: true,
        pairingCode: null,
        qrCode: null,
        qrDataUrl: null,
        message: 'Device connected and ready.',
      });
      return;
    }

    if (connection === 'close') {
      clearPairingTimeout();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[${sessionName}] Connection closed. Status: ${statusCode}. Checking credentials before reconnect...`);

      if (loggedOut) {
        await tearDownSession(sessionName, {
          wipeAuth: true,
          reason: 'Logged out from WhatsApp. Keys were cleared.',
          removeState: true,
        });
        return;
      }

      // CRITICAL: Before tearing down, verify auth exists
      const crededsForVerify = readCreds(sessionName);
      if (!crededsForVerify?.registered) {
        console.warn(`[${sessionName}] WARNING: Registered credentials NOT found on disk before disconnect. Auth may be lost.`);
      } else {
        console.log(`[${sessionName}] Confirmed: Registered credentials exist on disk. Safe to reconnect without wiping auth.`);
      }

      await tearDownSession(sessionName, { wipeAuth: false, removeState: false });
      setSessionState(sessionName, {
        status: 'reconnecting',
        connected: false,
        pairingCode: null,
        qrCode: null,
        qrDataUrl: null,
        message: 'Connection dropped. Reconnecting…',
      });

      // Use exponential backoff with retry flag to force credential reload
      const retryDelay = Math.min(3000 * (sessionRecord.reconnectAttempts || 1), 15000);
      sessionRecord.reconnectAttempts = (sessionRecord.reconnectAttempts || 0) + 1;
      
      setTimeout(() => {
        if (!activeSessions.has(sessionName)) {
          console.log(`[${sessionName}] Initiating reconnect attempt #${sessionRecord.reconnectAttempts} after ${retryDelay}ms...`);
          void startSession(sessionName, phoneNumber, mode, { isRestore: true, isRetry: true });
        }
      }, retryDelay);
    }
  });

  sock.ev.on('creds.update', wrappedSaveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') {
      return;
    }

    for (const msg of messages) {
      await handleMessagePacket(sessionName, msg, sock);
    }
  });

  sock.ev.on('presence.update', async (presence) => {
    try {
      const contactJid =
        presence?.participant ||
        presence?.id ||
        Object.keys(presence?.presences || {})[0] ||
        null;
      const presenceState =
        presence?.presence ||
        (presence?.presences?.[contactJid]?.presence) ||
        'unknown';
      if (!contactJid) {
        return;
      }
      appendPresenceRoutineEntry(contactJid, presenceState);
    } catch (err) {
      console.error(`[${sessionName}] presence.update failed:`, err?.message || err);
    }
  });

  if (state.creds.registered) {
    // Reset retry counter on successful connection
    sessionRecord.reconnectAttempts = 0;
    setSessionState(sessionName, {
      status: 'connected',
      connected: true,
      pairingCode: null,
      qrCode: null,
      qrDataUrl: null,
      message: isRestore ? 'Session restored.' : 'Session is connected.',
    });
    return;
  }

  // CRITICAL: Prevent blank session overwrites
  if (existingCredsOnDisk?.registered) {
    console.error(`[${sessionName}] CRITICAL ERROR: Session auth exists on disk but failed to load into socket state.`);
    console.log(`[${sessionName}] This indicates a file system or permission issue. Attempting socket recovery...`);
    // Force socket close and retry
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch (e) {
      // ignore
    }
    
    const retryDelay = 2000;
    setTimeout(() => {
      if (!activeSessions.has(sessionName)) {
        console.log(`[${sessionName}] Retrying session initialization after auth load failure...`);
        void startSession(sessionName, phoneNumber, mode, { isRestore: true, isRetry: true });
      }
    }, retryDelay);
    return;
  }

  if (mode === 'qr') {
    setSessionState(sessionName, {
      status: 'pairing',
      connected: false,
      pairingCode: null,
      qrCode: null,
      qrDataUrl: null,
      message: 'Waiting for QR code…',
    });
    schedulePairingTimeout();
    return;
  }

  if (mode === 'pairing') {
    setSessionState(sessionName, {
      status: 'pairing',
      connected: false,
      pairingCode: null,
      qrCode: null,
      qrDataUrl: null,
      message: 'Preparing pairing code…',
    });
    schedulePairingTimeout();

    setTimeout(() => {
      if (activeSessions.has(sessionName)) {
        void requestPairingCodeWhenReady();
      }
    }, 4000);
  }
}

function hydrateSessionStates() {
  ensureDirectory(SESSIONS_ROOT);
  ensureDirectory(BASE_VAULT_DIR);
  console.log('[INIT] Session storage directories initialized.');
}

function startHttpServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(DIST_DIR));
  app.use('/vault', express.static(BASE_VAULT_DIR));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, sessions: Object.keys(sessionStates) });
  });

  app.get('/api/sessions', (_req, res) => {
    res.json({
      sessions: Object.values(sessionStates).sort((left, right) =>
        (left.lastUpdated || '').localeCompare(right.lastUpdated || '')
      ),
    });
  });

  const buildChatPayload = () => {
    const globalNamesPath = path.join(BASE_VAULT_DIR, 'names_map.json');
    let globalNamesMap = {};
    if (fs.existsSync(globalNamesPath)) {
      try {
        globalNamesMap = JSON.parse(fs.readFileSync(globalNamesPath, 'utf8')) || {};
      } catch (error) {
        console.error('[API] Failed to parse names_map.json:', error?.message || error);
      }
    }

    const sessions = listChatSessions().map((session) => ({
      ...session,
      contacts: (session.contacts || []).map((contact) => {
        const baseName = String(contact.fileName || '').replace(/\.txt$/, '');
        const mappedName = globalNamesMap[baseName] || contact.contactName || baseName;
        return { ...contact, contactName: mappedName };
      }),
    }));

    return { sessions };
  };

  app.get('/api/chats', (_req, res) => {
    res.json(buildChatPayload());
  });

  app.get('/api/conversations', (_req, res) => {
    res.json(buildChatPayload());
  });

  app.get('/api/sessions/:session/chats/:contactFile', (req, res) => {
    const sessionName = sanitizeSegment(req.params.session);
    const contactFile = req.params.contactFile;

    if (!sessionName || !contactFile || !contactFile.endsWith('.txt') || contactFile.includes('/') || contactFile.includes('\\')) {
      res.status(400).json({ error: 'Invalid session or contact file parameter.' });
      return;
    }

    const filePath = path.join(BASE_VAULT_DIR, sessionName, contactFile);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Chat file not found.' });
      return;
    }

    try {
      const messages = parseChatFile(filePath);
      res.json({ messages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/sessions/:session/chats/:contactFile/download', (req, res) => {
    const sessionName = sanitizeSegment(req.params.session);
    const contactFile = req.params.contactFile;

    if (!sessionName || !contactFile || !contactFile.endsWith('.txt') || contactFile.includes('/') || contactFile.includes('\\')) {
      res.status(400).json({ error: 'Invalid session or contact file parameter.' });
      return;
    }

    const filePath = path.join(BASE_VAULT_DIR, sessionName, contactFile);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Chat file not found.' });
      return;
    }

    res.download(filePath, contactFile);
  });

  app.delete('/api/sessions/:session/chats/:contactFile', (req, res) => {
    const sessionName = sanitizeSegment(req.params.session);
    const contactFile = req.params.contactFile;

    if (!sessionName || !contactFile || !contactFile.endsWith('.txt') || contactFile.includes('/') || contactFile.includes('\\')) {
      res.status(400).json({ error: 'Invalid session or contact file parameter.' });
      return;
    }

    const filePath = path.join(BASE_VAULT_DIR, sessionName, contactFile);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Chat file not found.' });
      return;
    }

    try {
      fs.unlinkSync(filePath);

      // remove any display name mapping for this conversation
      try {
        const namesMapPath = path.join(BASE_VAULT_DIR, sessionName, 'names_map.json');
        if (fs.existsSync(namesMapPath)) {
          const nm = JSON.parse(fs.readFileSync(namesMapPath, 'utf8')) || {};
          const base = contactFile.replace(/\.txt$/, '');
          if (nm && Object.prototype.hasOwnProperty.call(nm, base)) {
            delete nm[base];
            fs.writeFileSync(namesMapPath, JSON.stringify(nm, null, 2), 'utf8');
          }
        }
      } catch (e) {
        console.error(`[${sessionName}] Failed to update names_map.json during delete:`, e.message || e);
      }

      broadcastEvent({ type: 'chat', sessionName });
      res.json({ ok: true, message: 'Chat deleted successfully.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/sessions/:session/chats/:contactFile/rename', (req, res) => {
    const sessionName = sanitizeSegment(req.params.session);
    const contactFile = req.params.contactFile;
    const newName = req.body.newName;

    if (!sessionName || !contactFile || !contactFile.endsWith('.txt') || contactFile.includes('/') || contactFile.includes('\\')) {
      res.status(400).json({ error: 'Invalid session or contact file parameter.' });
      return;
    }

    if (!newName || typeof newName !== 'string' || !newName.trim()) {
      res.status(400).json({ error: 'New name is required.' });
      return;
    }

    const sanitizedNewName = sanitizeSegment(newName.trim());
    if (!sanitizedNewName) {
      res.status(400).json({ error: 'Invalid character in new name.' });
      return;
    }

    const sessionDir = path.join(BASE_VAULT_DIR, sessionName);
    const filePath = path.join(sessionDir, contactFile);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Chat file not found.' });
      return;
    }

    // Update names_map.json instead of renaming the actual file
    const namesMapPath = path.join(sessionDir, 'names_map.json');
    let namesMap = {};
    if (fs.existsSync(namesMapPath)) {
      try {
        namesMap = JSON.parse(fs.readFileSync(namesMapPath, 'utf8')) || {};
      } catch (err) {
        console.error(`[${sessionName}] Failed to read names_map.json:`, err.message || err);
        namesMap = {};
      }
    }

    const base = contactFile.replace(/\.txt$/, '');
    namesMap[base] = sanitizedNewName;

    try {
      fs.writeFileSync(namesMapPath, JSON.stringify(namesMap, null, 2), 'utf8');
      broadcastEvent({ type: 'chat', sessionName });
      res.json({ ok: true, message: 'Chat renamed successfully.', newFileName: contactFile, mappedName: sanitizedNewName });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    eventSubscribers.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    req.on('close', () => {
      eventSubscribers.delete(res);
    });
  });

  app.post('/api/sessions', async (req, res) => {
    const rawSessionName = String(req.body.sessionName || '');
    const rawPhoneNumber = String(req.body.phoneNumber || '');
    const mode = String(req.body.mode || 'pairing');
    const sessionName = sanitizeSegment(rawSessionName).trim();
    const phoneNumber = rawPhoneNumber.replace(/\D/g, '');

    if (!sessionName) {
      res.status(400).json({ error: 'Device name is required.' });
      return;
    }

    if (mode === 'pairing' && !/^[0-9]{8,15}$/.test(phoneNumber)) {
      res.status(400).json({ error: 'Phone number must be digits only with country code (e.g. 923001234567).' });
      return;
    }

    if (activeSessions.has(sessionName)) {
      res.status(409).json({ error: `Device "${sessionName}" is already active.` });
      return;
    }

    const existingCreds = readCreds(sessionName);
    if (existingCreds && !existingCreds.registered) {
      console.log(`[${sessionName}] Wiping invalid (unregistered) credentials from previous attempt...`);
      wipeSessionAuth(sessionName);
    }

    if (existingCreds?.registered) {
      console.warn(`[${sessionName}] Device already has valid registered credentials. Refusing to initialize new session.`);
      res.status(409).json({ error: `Device "${sessionName}" is already registered. Remove it first to re-pair.` });
      return;
    }

    try {
      setSessionState(sessionName, {
        phoneNumber: phoneNumber || null,
        mode,
        status: 'pending',
        connected: false,
        pairingCode: null,
        qrCode: null,
        qrDataUrl: null,
        message: mode === 'qr' ? 'Starting QR flow…' : 'Starting phone pairing…',
      });

      await startSession(sessionName, phoneNumber, mode);
      res.json({ ok: true, message: `Device ${sessionName} started.`, session: sessionStates[sessionName] });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to initialize the session.';
      await tearDownSession(sessionName, { wipeAuth: true, reason: message, removeState: true });
      res.status(500).json({ error: message });
    }
  });

  app.delete('/api/sessions/:sessionName', async (req, res) => {
    const sessionName = sanitizeSegment(req.params.sessionName);
    if (!sessionName) {
      res.status(400).json({ error: 'Device name is required.' });
      return;
    }

    const wipeAuth = req.query.wipeAuth !== 'false';

    await tearDownSession(sessionName, {
      wipeAuth,
      reason: wipeAuth ? 'Device removed.' : 'Device disconnected.',
      removeState: true,
    });

    res.json({ ok: true, message: wipeAuth ? 'Device removed and keys deleted.' : 'Device disconnected.' });
  });

  app.get('*', (_req, res) => {
    const fallbackIndex = path.join(process.cwd(), 'index.html');
    const builtIndex = path.join(DIST_DIR, 'index.html');
    const htmlPath = fs.existsSync(builtIndex) ? builtIndex : fallbackIndex;
    res.sendFile(htmlPath);
  });

  httpServer = app.listen(PORT, () => {
    console.log(`Express dashboard listening on http://0.0.0.0:${PORT}`);
    void restorePersistedSessions();
  });
}

function shutdown() {
  console.log('Shutting down active sessions...');
  for (const [sessionName, sessionRecord] of activeSessions.entries()) {
    try {
      sessionRecord.sock.end(undefined);
      console.log(`[${sessionName}] Session closed.`);
    } catch (error) {
      console.error(`[${sessionName}] Error closing session:`, error.message);
    }
  }

  if (httpServer) {
    httpServer.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

hydrateSessionStates();
startHttpServer();
