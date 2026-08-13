import { chunkArray } from '../utils/common.js';
import { extractJsonObject, normalizeName, sanitizeText, shortenText } from '../utils/text.js';

function normalizeMembers(rows) {
  const map = new Map();
  for (const row of rows) {
    const accountName = normalizeName(row.accountName || row.displayName || '');
    if (!accountName) continue;
    const realName = sanitizeText(row.realName || '');
    const key = accountName.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { accountName, realName });
    } else if (realName) {
      map.get(key).realName = realName;
    }
  }
  return Array.from(map.values());
}

function parseMembersResponse(text) {
  const parsed = extractJsonObject(text);
  if (!parsed || !Array.isArray(parsed.members)) {
    throw new Error('AI response does not contain members array.');
  }
  return normalizeMembers(parsed.members);
}

function toMemberLines(history) {
  const lines = [];
  for (const entry of history) {
    if (entry.source !== 'human') continue;
    const accountName = normalizeName(entry.author);
    const text = shortenText(entry.text, 260);
    if (!text) continue;
    const time = entry.timestamp || '';
    const reply = entry.replyTo
      ? ` | reply_to ${normalizeName(entry.replyTo.author)}: ${shortenText(entry.replyTo.text, 120)}`
      : '';
    lines.push(`${time} | accountName: ${accountName} | text: ${text}${reply}`);
  }
  return lines;
}

export async function buildMembersFromAi(options) {
  const { storage, ai, chatId, limit, chunkSize, systemInstruction, logger } = options;
  const history = storage.getMessages(chatId, { limit });
  const lines = toMemberLines(history);
  if (lines.length === 0) {
    throw new Error('No human messages found to build members file.');
  }

  const instruction = `ارجع JSON فقط بدون Markdown.
اعتمد على رسائل الجروب المرسلة لك.
المطلوب فقط استخراج الأشخاص بصيغة:
{
  "members": [
    {
      "accountName": "اسم الحساب كما يظهر في الرسائل",
      "realName": "الاسم الحقيقي لو تعرفه من السياق، ولو غير معروف خليه فارغ"
    }
  ]
}
قواعد:
1) لا تضف أي مفاتيح غير accountName و realName.
2) لا تكرر نفس accountName.
3) لا تخترع أسماء حقيقية من عندك.
4) realName يكون "" إذا غير معروف.
5) لو accountName عبارة عن رقم أو handle فقط، لا تعتبره realName.`;

  const chunks = chunkArray(lines, chunkSize);
  const merged = new Map();

  for (let i = 0; i < chunks.length; i += 1) {
    const current = chunks[i];
    const contents = `${instruction}\n\nChunk ${i + 1}/${chunks.length}:\n${current.join('\n')}`;
    const response = await ai.generate({
      contents,
      systemInstruction,
      label: `members:${i + 1}/${chunks.length}`,
    });
    logger.info('members_chunk_done', {
      chunk: i + 1,
      totalChunks: chunks.length,
      keyIndex: response.keyIndex,
    });
    const parsed = parseMembersResponse(response.text || '');
    for (const item of parsed) {
      const key = item.accountName.toLowerCase();
      if (!merged.has(key)) merged.set(key, item);
      else if (item.realName) merged.get(key).realName = item.realName;
    }
  }

  const members = Array.from(merged.values());
  const count = await storage.replaceMembers(members);
  return { count, chunks: chunks.length, sourceMessages: lines.length };
}

