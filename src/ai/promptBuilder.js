import { normalizeName, sanitizeText } from '../utils/text.js';
import { computeMoodDescription } from '../memory/relationships.js';

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
  const mood = computeMoodDescription(current.affinity, current.trust);
  const top = storage.topRelationships(chatId, 8);
  const topLines = top.map((r) => `- ${r.accountName}: affinity=${Math.round(r.affinity)}, trust=${Math.round(r.trust)}`);
  return `\n\n[EMOTIONAL STATE & RELATIONSHIP WITH ${normalizeName(author)}]:
- Affinity Score: ${Math.round(current.affinity)} / 100
- Trust Score: ${Math.round(current.trust)} / 100
- Emotional Mood: ${mood.title}
- Nova Emotional Guidance: ${mood.promptRule}
\nTop Group Relations:\n${topLines.join('\n') || '- no data yet'}`;
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
    ? `\n\n[DIRECT REPLY / QUOTED MESSAGE CONTEXT]\n${author} is quoting and replying directly to this specific message:\n- Quoted Message Author: ${quotedInfo.author}\n- Quoted Message Time: ${quotedInfo.timestamp || 'Unknown'}\n- Quoted Message Text: "${quotedInfo.text || ''}"\n-> Nova instruction: You must respond directly with reference to this quoted message and answer ${author}'s point accurately!`
    : '';
  const membersSection = buildMembersSection(storage);
  const relationshipSection = buildRelationshipSection(storage, chatId, author);
  const longMemorySection = buildLongMemorySection(storage, chatId, author);
  const searchSection = searchResult?.used
    ? `\n\n[LIVE INTERNET SEARCH RESULTS (${searchResult.provider})]:\n${searchResult.context}\n-> Nova instruction: Use these live search results to provide accurate, up-to-date facts in your Egyptian response.`
    : '';
  const truncationNote = selected.truncated
    ? '\n\n[Note: older history was trimmed to keep context fast and fresh.]'
    : '';

  const userRequestSection = `\n\n[CURRENT USER REQUEST]\n- Sender: ${author}\n- User Prompt: "${userPrompt || '(User called "يا نوفا" to get your attention)'}"\n- Guidance: If ${author} wrote consecutive messages or statements in the conversation history just before calling you, connect all parts logically and answer their complete question naturally without asking them to repeat themselves.`;

  const prompt = `${chatContextSection}\n\nConversation History:\n${contextText}${quotedSection}${membersSection}${relationshipSection}${longMemorySection}${searchSection}${truncationNote}${userRequestSection}`;
  return {
    prompt,
    contextCount: selected.messages.length,
    truncated: selected.truncated,
  };
}
