import path from 'path';

export function getRawJidPart(remoteJid) {
  return String(remoteJid || '').split('@')[0] || '';
}

export function resolveConversationFileName(remoteJid, { isGroup = false } = {}) {
  const normalizedJid = String(remoteJid || '').trim();
  const rawId = normalizedJid.split('@')[0] || '';
  if (!rawId) {
    return null;
  }

  const isGroupChat = isGroup || normalizedJid.endsWith('@g.us');
  if (isGroupChat) {
    return `Group_${rawId}.txt`;
  }

  return `${rawId}.txt`;
}

export function resolveConversationFilePath({ baseVaultDir, sessionName, remoteJid, isGroup = false }) {
  const fileName = resolveConversationFileName(remoteJid, { isGroup });
  if (!fileName) {
    return null;
  }

  return path.join(baseVaultDir, sessionName, fileName);
}

export function formatConversationLogLine({ timestamp, senderDisplay, content }) {
  return `[${timestamp}] [${senderDisplay}]: ${content}`;
}

export function parseConversationLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return null;
  }

  const legacyMatch = trimmed.match(/^\[(\d{2}:\d{2}:\d{2} \d{2}\/\d{2}\/\d{4})\]\s+\[(INCOMING|OUTGOING)\](?:\s+\[(.*?)\])?\s*:\s*(.*)$/);
  if (legacyMatch) {
    const [, timestamp, direction, sender, content] = legacyMatch;
    const senderValue = sender === 'MEDIA' ? null : sender;
    const normalizedDirection = direction === 'OUTGOING' ? 'OUTGOING' : 'INCOMING';
    return {
      timestamp,
      direction: normalizedDirection,
      sender: senderValue || null,
      content,
    };
  }

  const modernMatch = trimmed.match(/^\[(.+?)\]\s+\[(.*?)\]\s*:\s*(.*)$/);
  if (modernMatch) {
    const [, timestamp, sender, content] = modernMatch;
    const normalizedDirection = sender === 'You' ? 'OUTGOING' : 'INCOMING';
    return {
      timestamp,
      direction: normalizedDirection,
      sender: sender || null,
      content,
    };
  }

  return {
    timestamp: null,
    direction: 'INCOMING',
    sender: null,
    content: trimmed,
  };
}
