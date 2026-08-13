import { normalizeName, sanitizeText } from '../utils/text.js';

function toStableKey(message) {
  if (message.messageId) return `mid:${message.messageId}`;
  if (message.id) return `id:${message.id}`;
  return `${message.timestamp || ''}|${message.author || ''}|${message.text || ''}`;
}

function messageSortValue(message) {
  const ts = Date.parse(message.timestamp || '');
  if (Number.isFinite(ts)) return ts;
  return 0;
}

function formatGapDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function isDifferentCalendarDay(prevDate, currDate) {
  return (
    prevDate.getFullYear() !== currDate.getFullYear() ||
    prevDate.getMonth() !== currDate.getMonth() ||
    prevDate.getDate() !== currDate.getDate()
  );
}

function buildTimeGapMarker(prevMessage, currentMessage) {
  const prevTs = Date.parse(prevMessage?.timestamp || '');
  const currentTs = Date.parse(currentMessage?.timestamp || '');
  if (!Number.isFinite(prevTs) || !Number.isFinite(currentTs)) return null;

  const diffMs = currentTs - prevTs;
  if (diffMs < 5 * 60 * 1000) return null;

  const prevDate = new Date(prevTs);
  const currentDate = new Date(currentTs);
  const duration = formatGapDuration(diffMs);
  if (isDifferentCalendarDay(prevDate, currentDate)) {
    return `[time_gap] ---- ${duration} later (new day) ----`;
  }
  return `[time_gap] ---- ${duration} later ----`;
}

export function formatHistoryLines(messages) {
  const lines = [];
  let prev = null;
  for (const m of messages) {
    const gapMarker = buildTimeGapMarker(prev, m);
    if (gapMarker) lines.push(gapMarker);

    const time = m.timestamp ? new Date(m.timestamp).toLocaleString('ar-EG') : '';
    const author = m.author || 'Unknown';
    const text = sanitizeText(m.text);
    if (!m.replyTo) {
      lines.push(`${time} - ${author}: ${text}`);
      prev = m;
      continue;
    }
    const replyAuthor = m.replyTo.author || 'Unknown';
    const replyText = sanitizeText(m.replyTo.text);
    lines.push(`${time} - ${author}: ${text} (reply to ${replyAuthor}: ${replyText})`);
    prev = m;
  }
  return lines;
}

export function buildContextText(messages) {
  const lines = [];
  let prev = null;
  for (const m of messages) {
    const gapMarker = buildTimeGapMarker(prev, m);
    if (gapMarker) lines.push(gapMarker);

    const who = m.author || 'Unknown';
    const role = m.role || 'user';
    const source = m.source || (role === 'model' ? 'ai' : 'human');
    const time = m.timestamp || '';
    const replyMeta = m.replyTo
      ? ` | reply_to: ${m.replyTo.author || 'Unknown'}${m.replyTo.timestamp ? ` @ ${m.replyTo.timestamp}` : ''}: ${m.replyTo.text || ''}`
      : '';
    lines.push(`[${role}/${source}] ${who}${time ? ` @ ${time}` : ''}: ${m.text}${replyMeta}`);
    prev = m;
  }
  return lines.join('\n');
}

export function selectSmartContext(storage, chatId, options) {
  const {
    contextLimit,
    prompt,
    author,
    quotedInfo = null,
    hardCap = 1400,
  } = options;

  const base =
    contextLimit > 0
      ? storage.getMessages(chatId, { limit: contextLimit })
      : storage.getMessages(chatId, {});
  const semantic = storage.searchMessages(chatId, prompt, Math.max(30, Math.floor(hardCap * 0.35)));
  const authorTrail = storage.getMessages(chatId, {
    author,
    limit: Math.max(20, Math.floor(hardCap * 0.2)),
  });

  const bag = new Map();
  for (const item of base) bag.set(toStableKey(item), item);
  for (const item of semantic) bag.set(toStableKey(item), item);
  for (const item of authorTrail) bag.set(toStableKey(item), item);

  if (quotedInfo?.messageId) {
    const quoted = storage.findMessageById(chatId, quotedInfo.messageId);
    if (quoted) bag.set(toStableKey(quoted), quoted);
  }

  let merged = Array.from(bag.values()).sort((a, b) => messageSortValue(a) - messageSortValue(b));
  const truncated = merged.length > hardCap;
  if (truncated) merged = merged.slice(-hardCap);
  return { messages: merged, truncated };
}

function buildMembersSection(storage) {
  const members = storage.getMembers(300);
  if (!members.length) return '';
  const lines = members.map((m) => `- accountName: ${m.accountName} | realName: ${m.realName || ''}`);
  return `\n\nKnown group members:\n${lines.join('\n')}`;
}

function buildRelationshipSection(storage, chatId, author) {
  const current = storage.getRelationship(chatId, author);
  const top = storage.topRelationships(chatId, 8);
  const topLines = top.map((r) => `- ${r.accountName}: affinity=${Math.round(r.affinity)}, trust=${Math.round(r.trust)}`);
  return `\n\nRelationship state:\nCurrent speaker (${normalizeName(author)}): affinity=${Math.round(
    current.affinity,
  )}, trust=${Math.round(current.trust)}\nTop relations:\n${topLines.join('\n') || '- no data yet'}`;
}

function buildLongMemorySection(storage, chatId, author) {
  const currentAuthor = normalizeName(author);
  const mine = storage.getLongMemories(chatId, 80).filter((m) => m.key.startsWith(`member:${currentAuthor}:`));
  if (!mine.length) return '';
  const lines = mine.slice(0, 10).map((m) => `- ${m.key.replace(`member:${currentAuthor}:`, '')}: ${m.value}`);
  return `\n\nLong memory about ${currentAuthor}:\n${lines.join('\n')}`;
}

export function buildPromptPayload(storage, chatId, options) {
  const {
    author,
    chatName = '',
    isGroup = true,
    userPrompt,
    quotedInfo,
    contextLimit,
    searchResult,
    hardCap,
  } = options;
  const selected = selectSmartContext(storage, chatId, {
    contextLimit,
    prompt: userPrompt,
    author,
    quotedInfo,
    hardCap,
  });
  const contextText = buildContextText(selected.messages);
  const chatContextSection = `Current Chat Context:\n- Type: ${isGroup ? 'Group Chat' : 'Private Direct Message (DM)'}\n- Name: ${chatName || (isGroup ? 'Group' : author)}\n- Chat ID: ${chatId}`;
  const quotedSection = quotedInfo
    ? `\n\nQuoted message in current request:\nAuthor: ${quotedInfo.author}\nTime: ${
        quotedInfo.timestamp || 'Unknown'
      }\nText: ${quotedInfo.text || ''}`
    : '';
  const membersSection = buildMembersSection(storage);
  const relationshipSection = buildRelationshipSection(storage, chatId, author);
  const longMemorySection = buildLongMemorySection(storage, chatId, author);
  const searchSection = searchResult?.used
    ? `\n\nInternet search results (${searchResult.provider}):\n${searchResult.context}`
    : '';
  const truncationNote = selected.truncated
    ? '\n\n[Note: context was trimmed to keep prompt within limit.]'
    : '';

  const prompt = `${chatContextSection}\n\nConversation so far:\n${contextText}${quotedSection}${membersSection}${relationshipSection}${longMemorySection}${searchSection}${truncationNote}\n\nUser request (latest message): ${author}: ${userPrompt}`;
  return {
    prompt,
    contextCount: selected.messages.length,
    truncated: selected.truncated,
  };
}
