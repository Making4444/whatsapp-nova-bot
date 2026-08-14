import fs from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeName, sanitizeText } from '../utils/text.js';
import { clamp } from '../utils/common.js';

function toTsMs(timestamp) {
  const value = Date.parse(timestamp || '');
  return Number.isFinite(value) ? value : Date.now();
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const clean = raw.replace(/^\uFEFF/, '');
    return JSON.parse(clean);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
}

function normalizeRoleSource(entry, botName) {
  if (entry.role === 'model' || entry.source === 'ai') {
    return {
      role: 'model',
      source: 'ai',
      author: botName,
    };
  }
  return {
    role: 'user',
    source: 'human',
    author: normalizeName(entry.author),
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    source: row.source,
    authorId: row.author_id || null,
    author: row.author || 'Unknown',
    text: row.text || '',
    timestamp: row.timestamp || null,
    messageId: row.message_id || null,
    replyTo: row.reply_to_message_id || row.reply_to_author || row.reply_to_text
      ? {
          messageId: row.reply_to_message_id || null,
          author: row.reply_to_author || 'Unknown',
          text: row.reply_to_text || '',
          timestamp: row.reply_to_timestamp || null,
        }
      : null,
  };
}

export class SqliteStorage {
  constructor(options) {
    this.dbPath = options.dbPath;
    this.membersPath = options.membersPath;
    this.legacyDatabaseJsonPath = options.legacyDatabaseJsonPath;
    this.legacyMembersPath = options.legacyMembersPath;
    this.legacyContextPath = options.legacyContextPath;
    this.botName = options.botName;
    this.logger = options.logger;
    this.db = null;
  }

  async init() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.#createSchema();
    await this.#migrateLegacyIfNeeded();
    await this.syncFromMembersJsonFile();
  }

  async syncFromMembersJsonFile() {
    const fileData = await readJsonSafe(this.membersPath);
    if (fileData && Array.isArray(fileData.members)) {
      const items = fileData.members
        .map((item) => ({
          accountName: normalizeName(item.accountName || item.displayName || ''),
          realName: sanitizeText(item.realName || ''),
        }))
        .filter((item) => item.accountName);
      if (items.length > 0) {
        this.replaceMembersSync(items);
      }
    }
  }

  #createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user', 'model')),
        source TEXT NOT NULL CHECK(source IN ('human', 'ai')),
        author_id TEXT,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        reply_to_message_id TEXT,
        reply_to_author TEXT,
        reply_to_text TEXT,
        reply_to_timestamp TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_message
      ON messages(chat_id, message_id);

      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
      ON messages(chat_id, ts_ms, id);

      CREATE INDEX IF NOT EXISTS idx_messages_chat_author
      ON messages(chat_id, author);

      CREATE TABLE IF NOT EXISTS members (
        account_name TEXT PRIMARY KEY,
        real_name TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationships (
        chat_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        affinity REAL NOT NULL DEFAULT 0,
        trust REAL NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, account_name)
      );

      CREATE TABLE IF NOT EXISTS long_memories (
        chat_id TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        memory_value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, memory_key)
      );
    `);
  }

  #getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    return row.value;
  }

  #setSetting(key, value) {
    this.db
      .prepare(`
        INSERT INTO settings(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, String(value));
  }

  #runInTransaction(work) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = work();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw err;
    }
  }

  async #migrateLegacyIfNeeded() {
    const done = this.#getSetting('migration_v2_done', 'false');
    if (done === 'true') return;

    let migratedMessages = 0;
    let migratedMembers = 0;
    let migratedContext = false;

    const legacyDB = await readJsonSafe(this.legacyDatabaseJsonPath);
    if (legacyDB && legacyDB.chats && typeof legacyDB.chats === 'object') {
      for (const [chatId, rows] of Object.entries(legacyDB.chats)) {
        if (!Array.isArray(rows)) continue;
        const normalized = rows.map((entry) => {
          const base = normalizeRoleSource(entry, this.botName);
          return {
            role: base.role,
            source: base.source,
            authorId: entry.authorId || null,
            author: base.author,
            text: sanitizeText(entry.text),
            timestamp: entry.timestamp || new Date().toISOString(),
            messageId: entry.messageId || null,
            replyTo: entry.replyTo || null,
          };
        });
        migratedMessages += this.addMessagesBulk(chatId, normalized);
        this.#setSetting(`bootstrapped:${chatId}`, 'true');
      }
    }

    const legacyContext = await readJsonSafe(this.legacyContextPath);
    if (legacyContext && Object.prototype.hasOwnProperty.call(legacyContext, 'contextLimit')) {
      const count = Number(legacyContext.contextLimit);
      const value = Number.isFinite(count) && count >= 0 ? count : 300;
      this.#setSetting('context_limit', value);
      migratedContext = true;
    }

    const legacyMembers = await readJsonSafe(this.legacyMembersPath);
    if (legacyMembers && Array.isArray(legacyMembers.members)) {
      const items = legacyMembers.members
        .map((item) => ({
          accountName: normalizeName(item.accountName || item.displayName || ''),
          realName: sanitizeText(item.realName || ''),
        }))
        .filter((item) => item.accountName);
      if (items.length > 0) {
        migratedMembers = this.replaceMembersSync(items);
      }
    }

    this.#setSetting('migration_v2_done', 'true');
    this.logger.info('storage_migration_done', {
      dbPath: this.dbPath,
      migratedMessages,
      migratedMembers,
      migratedContext,
    });
  }

  getContextLimit(defaultValue) {
    const saved = Number(this.#getSetting('context_limit', defaultValue));
    if (!Number.isFinite(saved) || saved < 0) return defaultValue;
    return saved;
  }

  setContextLimit(value) {
    const limit = Number(value);
    const normalized = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 0;
    this.#setSetting('context_limit', normalized);
    return normalized;
  }

  getBootstrapSyncSetting(defaultLimit) {
    const fallback = Number(defaultLimit);
    const fallbackCount = Number.isFinite(fallback) && fallback >= 1 ? Math.floor(fallback) : 1000;
    const raw = sanitizeText(this.#getSetting('bootstrap_sync', '')).toLowerCase();

    if (raw === 'false') return { type: 'disabled' };
    if (raw === 'all') return { type: 'all' };

    const count = Number(raw);
    if (Number.isFinite(count) && count >= 1) {
      return { type: 'count', count: Math.floor(count) };
    }

    return { type: 'count', count: fallbackCount };
  }

  setBootstrapSyncSetting(value) {
    if (value?.type === 'disabled') {
      this.#setSetting('bootstrap_sync', 'false');
      return { type: 'disabled' };
    }
    if (value?.type === 'all') {
      this.#setSetting('bootstrap_sync', 'all');
      return { type: 'all' };
    }
    if (value?.type === 'count') {
      const count = Number(value.count);
      if (!Number.isFinite(count) || count < 1) {
        throw new Error('Invalid bootstrap count');
      }
      const normalized = Math.floor(count);
      this.#setSetting('bootstrap_sync', String(normalized));
      return { type: 'count', count: normalized };
    }
    throw new Error('Invalid bootstrap sync setting');
  }

  isBootstrapped(chatId) {
    return this.#getSetting(`bootstrapped:${chatId}`, 'false') === 'true';
  }

  setBootstrapped(chatId) {
    this.#setSetting(`bootstrapped:${chatId}`, 'true');
  }

  addMessage(chatId, entry) {
    const msg = {
      role: entry.role === 'model' ? 'model' : 'user',
      source: entry.source === 'ai' ? 'ai' : 'human',
      authorId: entry.authorId || null,
      author: normalizeName(entry.author),
      text: sanitizeText(entry.text),
      timestamp: entry.timestamp || new Date().toISOString(),
      messageId: entry.messageId || null,
      replyTo: entry.replyTo || null,
    };
    const insert = this.db.prepare(`
      INSERT INTO messages (
        chat_id, message_id, role, source, author_id, author, text, timestamp, ts_ms,
        reply_to_message_id, reply_to_author, reply_to_text, reply_to_timestamp
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, message_id) DO NOTHING
    `);
    const result = insert.run(
      chatId,
      msg.messageId,
      msg.role,
      msg.source,
      msg.authorId,
      msg.author,
      msg.text,
      msg.timestamp,
      toTsMs(msg.timestamp),
      msg.replyTo?.messageId || null,
      msg.replyTo?.author || null,
      msg.replyTo?.text || null,
      msg.replyTo?.timestamp || null,
    );
    return Number(result?.changes || 0) > 0;
  }

  addMessagesBulk(chatId, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const insert = this.db.prepare(`
      INSERT INTO messages (
        chat_id, message_id, role, source, author_id, author, text, timestamp, ts_ms,
        reply_to_message_id, reply_to_author, reply_to_text, reply_to_timestamp
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, message_id) DO NOTHING
    `);
    let inserted = 0;
    this.#runInTransaction(() => {
      for (const entry of entries) {
        const role = entry.role === 'model' ? 'model' : 'user';
        const source = entry.source === 'ai' ? 'ai' : 'human';
        const text = sanitizeText(entry.text);
        if (!text && source === 'human') continue;
        const timestamp = entry.timestamp || new Date().toISOString();
        const result = insert.run(
          chatId,
          entry.messageId || null,
          role,
          source,
          entry.authorId || null,
          normalizeName(entry.author),
          text,
          timestamp,
          toTsMs(timestamp),
          entry.replyTo?.messageId || null,
          entry.replyTo?.author || null,
          entry.replyTo?.text || null,
          entry.replyTo?.timestamp || null,
        );
        inserted += Number(result?.changes || 0);
      }
    });
    return inserted;
  }

  getMessages(chatId, options = {}) {
    const limit = Number(options.limit || 0);
    const author = options.author ? normalizeName(options.author) : null;
    let rows = [];

    if (limit > 0 && author) {
      rows = this.db
        .prepare(`
          SELECT * FROM messages
          WHERE chat_id = ? AND author = ?
          ORDER BY ts_ms DESC, id DESC
          LIMIT ?
        `)
        .all(chatId, author, limit);
    } else if (limit > 0) {
      rows = this.db
        .prepare(`
          SELECT * FROM messages
          WHERE chat_id = ?
          ORDER BY ts_ms DESC, id DESC
          LIMIT ?
        `)
        .all(chatId, limit);
    } else if (author) {
      rows = this.db
        .prepare(`
          SELECT * FROM messages
          WHERE chat_id = ? AND author = ?
          ORDER BY ts_ms ASC, id ASC
        `)
        .all(chatId, author);
    } else {
      rows = this.db
        .prepare(`
          SELECT * FROM messages
          WHERE chat_id = ?
          ORDER BY ts_ms ASC, id ASC
        `)
        .all(chatId);
    }

    if (limit > 0) rows.reverse();
    return rows.map(rowToMessage);
  }

  getMessageCount(chatId) {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?')
      .get(chatId);
    return Number(row?.c || 0);
  }

  getHumanMessageCount(chatId) {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE chat_id = ? AND source = 'human'`)
      .get(chatId);
    return Number(row?.c || 0);
  }

  getChatIds() {
    const rows = this.db.prepare('SELECT DISTINCT chat_id FROM messages').all();
    return rows.map((r) => r.chat_id);
  }

  findMessageById(chatId, messageId) {
    if (!messageId) return null;
    const row = this.db
      .prepare(`
        SELECT * FROM messages
        WHERE chat_id = ? AND message_id = ?
        LIMIT 1
      `)
      .get(chatId, messageId);
    return rowToMessage(row);
  }

  deleteMessageById(chatId, messageId) {
    if (!chatId || !messageId) return 0;
    const result = this.db
      .prepare(`
        DELETE FROM messages
        WHERE chat_id = ? AND message_id = ?
      `)
      .run(chatId, messageId);
    return Number(result?.changes || 0);
  }

  deleteMessageByIdAnyChat(messageId) {
    if (!messageId) return 0;
    const result = this.db
      .prepare(`
        DELETE FROM messages
        WHERE message_id = ?
      `)
      .run(messageId);
    return Number(result?.changes || 0);
  }

  searchMessages(chatId, queryText, limit = 120) {
    const terms = Array.from(
      new Set(
        sanitizeText(queryText)
          .toLowerCase()
          .split(/\s+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 3),
      ),
    ).slice(0, 6);
    if (terms.length === 0) return [];

    const where = terms.map(() => 'LOWER(text) LIKE ?').join(' OR ');
    const params = [chatId, ...terms.map((t) => `%${t}%`), Math.max(1, limit)];
    const rows = this.db
      .prepare(`
        SELECT * FROM messages
        WHERE chat_id = ? AND (${where})
        ORDER BY ts_ms DESC, id DESC
        LIMIT ?
      `)
      .all(...params);
    rows.reverse();
    return rows.map(rowToMessage);
  }

  getMembers(limit = 300) {
    const rows = this.db
      .prepare(`
        SELECT account_name, real_name, updated_at
        FROM members
        ORDER BY account_name COLLATE NOCASE ASC
        LIMIT ?
      `)
      .all(Math.max(1, limit));
    return rows.map((row) => ({
      accountName: row.account_name,
      realName: row.real_name || '',
      updatedAt: row.updated_at,
    }));
  }

  getMembersCount() {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM members').get();
    return Number(row?.c || 0);
  }

  replaceMembersSync(members) {
    const now = new Date().toISOString();
    const unique = new Map();
    for (const item of members) {
      const accountName = normalizeName(item.accountName || item.displayName || '');
      if (!accountName) continue;
      const realName = sanitizeText(item.realName || '');
      if (!unique.has(accountName.toLowerCase())) {
        unique.set(accountName.toLowerCase(), { accountName, realName });
      } else if (realName) {
        unique.get(accountName.toLowerCase()).realName = realName;
      }
    }

    const insert = this.db.prepare(`
      INSERT INTO members(account_name, real_name, updated_at)
      VALUES (?, ?, ?)
    `);
    this.#runInTransaction(() => {
      this.db.prepare('DELETE FROM members').run();
      for (const row of unique.values()) {
        insert.run(row.accountName, row.realName, now);
      }
    });
    return unique.size;
  }

  async replaceMembers(members) {
    const count = this.replaceMembersSync(members);
    const payload = {
      meta: {
        initialized: true,
        initializedAt: new Date().toISOString(),
        sourceLimit: this.getContextLimit(0),
        updatedAt: new Date().toISOString(),
      },
      members: this.getMembers(10000).map((m) => ({
        accountName: m.accountName,
        realName: m.realName,
      })),
    };
    await fs.writeFile(this.membersPath, JSON.stringify(payload, null, 2), 'utf8');
    return count;
  }

  getRelationship(chatId, accountName) {
    const row = this.db
      .prepare(`
        SELECT affinity, trust, note, updated_at
        FROM relationships
        WHERE chat_id = ? AND account_name = ?
      `)
      .get(chatId, normalizeName(accountName));
    if (!row) {
      return {
        accountName: normalizeName(accountName),
        affinity: 0,
        trust: 0,
        note: '',
        updatedAt: null,
      };
    }
    return {
      accountName: normalizeName(accountName),
      affinity: Number(row.affinity || 0),
      trust: Number(row.trust || 0),
      note: row.note || '',
      updatedAt: row.updated_at || null,
    };
  }

  setRelationship(chatId, accountName, patch) {
    const current = this.getRelationship(chatId, accountName);
    const next = {
      affinity: clamp(Number(patch.affinity ?? current.affinity), -100, 100),
      trust: clamp(Number(patch.trust ?? current.trust), -100, 100),
      note: sanitizeText(patch.note ?? current.note ?? ''),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(`
        INSERT INTO relationships(chat_id, account_name, affinity, trust, note, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, account_name) DO UPDATE SET
          affinity = excluded.affinity,
          trust = excluded.trust,
          note = excluded.note,
          updated_at = excluded.updated_at
      `)
      .run(chatId, normalizeName(accountName), next.affinity, next.trust, next.note, next.updatedAt);
    return {
      accountName: normalizeName(accountName),
      affinity: next.affinity,
      trust: next.trust,
      note: next.note,
      updatedAt: next.updatedAt,
    };
  }

  adjustRelationship(chatId, accountName, deltas) {
    const current = this.getRelationship(chatId, accountName);
    return this.setRelationship(chatId, accountName, {
      affinity: current.affinity + Number(deltas.affinityDelta || 0),
      trust: current.trust + Number(deltas.trustDelta || 0),
      note: deltas.note ?? current.note,
    });
  }

  topRelationships(chatId, limit = 20) {
    const rows = this.db
      .prepare(`
        SELECT account_name, affinity, trust, note, updated_at
        FROM relationships
        WHERE chat_id = ?
        ORDER BY affinity DESC, trust DESC
        LIMIT ?
      `)
      .all(chatId, Math.max(1, limit));
    return rows.map((row) => ({
      accountName: row.account_name,
      affinity: Number(row.affinity || 0),
      trust: Number(row.trust || 0),
      note: row.note || '',
      updatedAt: row.updated_at || null,
    }));
  }

  upsertLongMemory(chatId, key, value) {
    const memoryKey = sanitizeText(key);
    const memoryValue = sanitizeText(value, { collapseWhitespace: false });
    if (!memoryKey || !memoryValue) return false;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO long_memories(chat_id, memory_key, memory_value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id, memory_key) DO UPDATE SET
          memory_value = excluded.memory_value,
          updated_at = excluded.updated_at
      `)
      .run(chatId, memoryKey, memoryValue, updatedAt);
    return true;
  }

  getLongMemories(chatId, limit = 80) {
    const rows = this.db
      .prepare(`
        SELECT memory_key, memory_value, updated_at
        FROM long_memories
        WHERE chat_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(chatId, Math.max(1, limit));
    return rows.map((row) => ({
      key: row.memory_key,
      value: row.memory_value,
      updatedAt: row.updated_at,
    }));
  }

  getLongMemory(chatId, key) {
    const row = this.db
      .prepare(`
        SELECT memory_value, updated_at
        FROM long_memories
        WHERE chat_id = ? AND memory_key = ?
      `)
      .get(chatId, sanitizeText(key));
    if (!row) return null;
    return {
      key: sanitizeText(key),
      value: row.memory_value,
      updatedAt: row.updated_at,
    };
  }
}
