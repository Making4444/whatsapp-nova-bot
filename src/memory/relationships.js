import { clamp } from '../utils/common.js';
import { normalizeName, sanitizeText } from '../utils/text.js';

const POSITIVE_WORDS = [
  'بحبك',
  'حبيبي',
  'تسلم',
  'جامد',
  'عاش',
  'شكرا',
  'شكر',
  'فنان',
  'كويس',
  'برافو',
];

const NEGATIVE_WORDS = [
  'اهبل',
  'غبي',
  'رخم',
  'خرا',
  'زي الزفت',
  'مالوش لازمة',
  'سيء',
  'مقرف',
  'اقفل',
  'اسكت',
];

const SOFT_NEGATIVE_WORDS = ['متضايق', 'زعلان', 'مش عاجبني', 'مش حلو'];

export function scoreRelationshipDelta(text, options = {}) {
  const normalized = sanitizeText(text).toLowerCase();
  if (!normalized) return { affinityDelta: 0, trustDelta: 0 };

  let positive = 0;
  let negative = 0;
  let softNegative = 0;

  for (const word of POSITIVE_WORDS) {
    if (normalized.includes(word)) positive += 1;
  }
  for (const word of NEGATIVE_WORDS) {
    if (normalized.includes(word)) negative += 1;
  }
  for (const word of SOFT_NEGATIVE_WORDS) {
    if (normalized.includes(word)) softNegative += 1;
  }

  let affinityDelta = positive * 2 - negative * 4 - softNegative * 2;
  let trustDelta = positive - negative * 2 - softNegative;

  if (options.addressedToBot && (negative > 0 || softNegative > 0)) {
    affinityDelta -= 2;
    trustDelta -= 1;
  }
  if (options.addressedToBot && positive > 0) {
    affinityDelta += 1;
  }

  return {
    affinityDelta: clamp(affinityDelta, -10, 10),
    trustDelta: clamp(trustDelta, -6, 6),
  };
}

export function applyRelationshipFromMessage(storage, payload) {
  const accountName = normalizeName(payload.author);
  const text = sanitizeText(payload.text);
  const delta = scoreRelationshipDelta(text, {
    addressedToBot: Boolean(payload.addressedToBot),
  });
  if (delta.affinityDelta === 0 && delta.trustDelta === 0) return null;
  return storage.adjustRelationship(payload.chatId, accountName, delta);
}

export function extractLongMemoryFacts(storage, payload) {
  const text = sanitizeText(payload.text);
  if (!text) return 0;
  const author = normalizeName(payload.author);
  const chatId = payload.chatId;
  let updates = 0;

  const nameMatch = text.match(/(?:اسمي|انا اسمي|أنا اسمي)\s+([^\s،,.!?]{2,}(?:\s+[^\s،,.!?]{2,})?)/i);
  if (nameMatch) {
    const value = sanitizeText(nameMatch[1]);
    if (value && storage.upsertLongMemory(chatId, `member:${author}:real_name`, value)) updates += 1;
  }

  const fromMatch = text.match(/(?:انا من|أنا من)\s+([^\s،,.!?]{2,}(?:\s+[^\s،,.!?]{2,})?)/i);
  if (fromMatch) {
    const value = sanitizeText(fromMatch[1]);
    if (value && storage.upsertLongMemory(chatId, `member:${author}:from`, value)) updates += 1;
  }

  const likesMatch = text.match(/(?:انا بحب|أنا بحب)\s+(.{2,40})/i);
  if (likesMatch) {
    const value = sanitizeText(likesMatch[1]);
    if (value && storage.upsertLongMemory(chatId, `member:${author}:likes`, value)) updates += 1;
  }

  return updates;
}

