const INVISIBLE_MARKS_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\uFEFF]/g;

const ARABIC_DIGITS = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
};

export const NOVA_CALL_PATTERN = /(?:^|[\s.,!?،؛:(){}\[\]"'`-])((?:يا|ي)\s*نوفا)(?=$|[\s.,!?،؛:(){}\[\]"'`-])/i;

export function normalizeWhitespace(value) {
  return String(value || '')
    .replace(INVISIBLE_MARKS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeText(value, options = {}) {
  const { collapseWhitespace = true } = options;
  const base = String(value || '').replace(INVISIBLE_MARKS_RE, '');
  return collapseWhitespace ? base.replace(/\s+/g, ' ').trim() : base.trim();
}

export function normalizeName(value, fallback = 'Unknown') {
  const clean = sanitizeText(value);
  return clean || fallback;
}

export function toLatinDigits(str) {
  return String(str || '').replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);
}

export function parseLastCount(prompt) {
  const normalized = toLatinDigits(prompt);
  const match = normalized.match(/(?:ايه|إيه)\s+اخر\s+(\d+)\s+رساله/i);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? count : null;
}

export function extractUserPrompt(text) {
  const normalized = sanitizeText(text);
  if (!normalized) return null;
  if (!NOVA_CALL_PATTERN.test(normalized)) return null;
  const stripped = normalized.replace(NOVA_CALL_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return stripped || normalized;
}

export function parseEditCommand(text) {
  const normalized = toLatinDigits(sanitizeText(text));
  const match = normalized.match(/^\/edit\s+(all|\d+)\s*$/i);
  if (!match) return null;
  const value = match[1].toLowerCase();
  if (value === 'all') return { type: 'all' };
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? { type: 'count', count } : null;
}

export function parseSetCommand(text) {
  const normalized = toLatinDigits(sanitizeText(text));
  const match = normalized.match(/^\/set(?:\s+(.*))?$/i);
  if (!match) return null;

  const value = sanitizeText(match[1] || '').toLowerCase();
  if (!value) return { type: 'invalid' };
  if (value === 'false') return { type: 'disabled' };
  if (value === 'all') return { type: 'all' };

  const count = Number(value);
  if (Number.isFinite(count) && count >= 1 && Number.isInteger(count)) {
    return { type: 'count', count };
  }
  return { type: 'invalid' };
}

export function isMemberBuildCommand(text) {
  return sanitizeText(text).toLowerCase() === '/member';
}

export function parseStatusCommand(text) {
  return sanitizeText(text).toLowerCase() === '/status';
}

export function parseHelpCommand(text) {
  const normalized = sanitizeText(text).toLowerCase();
  return normalized === '/help' || normalized === '/commands';
}

export function parseMoodCommand(text) {
  const normalized = toLatinDigits(sanitizeText(text));
  const setMatch = normalized.match(/^\/mood\s+(.+?)\s+(-?\d{1,3})\s*$/i);
  if (setMatch) {
    const accountName = sanitizeText(setMatch[1]);
    const value = Number(setMatch[2]);
    if (!accountName || !Number.isFinite(value)) return null;
    return { type: 'set', accountName, value: Math.max(-100, Math.min(100, value)) };
  }
  if (/^\/mood\s*$/i.test(normalized)) return { type: 'show' };
  return null;
}

export function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('JSON object not found in AI response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function shortenText(text, max = 180) {
  const value = sanitizeText(text);
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
