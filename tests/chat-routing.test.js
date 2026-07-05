import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { formatConversationLogLine, parseConversationLine, resolveConversationFileName, resolveConversationFilePath } from '../chat-routing.js';

test('uses the raw phone number for one-to-one chats', () => {
  const fileName = resolveConversationFileName('1234567890@s.whatsapp.net');
  assert.equal(fileName, '1234567890.txt');
});

test('uses the group id for group chats', () => {
  const fileName = resolveConversationFileName('1234567890@g.us', { isGroup: true });
  assert.equal(fileName, 'Group_1234567890.txt');
});

test('builds the conversation file path inside the device folder', () => {
  const filePath = resolveConversationFilePath({
    baseVaultDir: '/tmp/vault',
    sessionName: 'Pixel',
    remoteJid: '1234567890@s.whatsapp.net',
  });

  assert.equal(filePath, path.join('/tmp/vault', 'Pixel', '1234567890.txt'));
});

test('formats and parses a modern conversation line', () => {
  const line = formatConversationLogLine({ timestamp: '12:34:56', senderDisplay: 'You', content: 'Hello' });
  assert.equal(line, '[12:34:56] [You]: Hello');

  const parsed = parseConversationLine(line);
  assert.deepEqual(parsed, {
    timestamp: '12:34:56',
    direction: 'OUTGOING',
    sender: 'You',
    content: 'Hello',
  });
});
