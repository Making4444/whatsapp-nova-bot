import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const inputArg = process.argv[2];
if (!inputArg) {
  console.error('Usage: node scripts/import-whatsapp-chat.js <path-to-chat-txt>');
  process.exit(1);
}

const inputPath = path.resolve(process.cwd(), inputArg);
const outputPath = path.join(rootDir, 'database.json');

const RTL_MARKS_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\uFEFF]/g;
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

function toLatinDigits(value) {
  return String(value || '').replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);
}

function normalizeLine(line) {
  return toLatinDigits(String(line || '').replace(RTL_MARKS_RE, '')).trim();
}

function parseTimestamp(day, month, year, hour, minute, meridiemRaw) {
  const meridiem = String(meridiemRaw || '').toUpperCase();
  let h = Number(hour);
  const m = Number(minute);
  if (meridiem === 'PM' || meridiemRaw === 'م') {
    if (h < 12) h += 12;
  } else if (meridiem === 'AM' || meridiemRaw === 'ص') {
    if (h === 12) h = 0;
  }
  const fullYear = String(year).length === 2 ? Number(`20${year}`) : Number(year);
  const dt = new Date(fullYear, Number(month) - 1, Number(day), h, m, 0, 0);
  return dt.toISOString();
}

const raw = await fs.readFile(inputPath, 'utf8');
const clean = raw.replace(/^\uFEFF/, '');
const lines = clean.split(/\r?\n/);

const entries = [];
let current = null;

// Examples:
// 12/1/24، 10:15 م - Name: text
// 12/1/2024, 10:15 PM - Name: text
const headerRe = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[،,]\s*(\d{1,2}):(\d{2})\s*([صمAPMapm]{1,2})\s*-\s*(.*)$/;

for (const sourceLine of lines) {
  const line = normalizeLine(sourceLine);
  if (!line) continue;

  const m = line.match(headerRe);
  if (m) {
    const [, d, mo, y, h, mi, meridiem, rest] = m;
    const timestamp = parseTimestamp(d, mo, y, h, mi, meridiem);
    let author = 'System';
    let text = rest;
    const sep = rest.indexOf(': ');
    if (sep !== -1) {
      author = rest.slice(0, sep).trim() || 'Unknown';
      text = rest.slice(sep + 2);
    }
    current = {
      role: 'user',
      source: 'human',
      author,
      text,
      timestamp,
    };
    entries.push(current);
    continue;
  }

  if (current) {
    current.text = `${current.text}\n${line}`;
  }
}

entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

const output = {
  chats: {
    imported_nova_chat: entries,
  },
  meta: {
    bootstrappedChats: {
      imported_nova_chat: true,
    },
  },
};

await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`Imported ${entries.length} messages to ${outputPath}`);

