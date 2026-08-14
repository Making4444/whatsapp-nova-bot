import qrcode from 'qrcode-terminal';
import fs from 'fs/promises';
import path from 'path';
import whatsappWeb from 'whatsapp-web.js';
import { config } from './config/env.js';
import { createLogger } from './utils/logger.js';
import {
  extractUserPrompt,
  normalizeName,
  parseLastCount,
  sanitizeText,
} from './utils/text.js';
import { SqliteStorage } from './storage/sqlite.js';
import { GeminiPool } from './ai/providers/gemini.js';
import { SearchProvider } from './ai/providers/search.js';
import { buildPromptPayload, formatHistoryLines } from './ai/promptBuilder.js';
import { applyRelationshipFromMessage, extractLongMemoryFacts } from './memory/relationships.js';
import { createCommandRegistry } from './commands/registry.js';

const { Client, LocalAuth } = whatsappWeb;

export async function startBot() {
  const logger = createLogger('nova-bot');

  const apiKey = config.geminiApiKey || (config.geminiKeys && config.geminiKeys[0]);
  if (!apiKey) {
    throw new Error('Missing Gemini API key. Set GEMINI_API_KEY or GEMINI_API_KEY_1 in .env');
  }

  const storage = new SqliteStorage({
    dbPath: config.dbPath,
    membersPath: config.membersPath,
    legacyDatabaseJsonPath: config.legacyDatabaseJsonPath,
    legacyMembersPath: config.legacyMembersPath,
    legacyContextPath: config.legacyContextPath,
    botName: config.botName,
    logger,
  });
  await storage.init();

  const ai = new GeminiPool({
    apiKey,
    model: config.modelName,
    logger,
  });

  const searchProvider = new SearchProvider({
    tavilyKeys: config.tavilyKeys,
    serperKeys: config.serperKeys,
    timeoutMs: config.searchTimeoutMs,
    logger,
  });

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  });

  let selfName = 'Me';
  const targetChatIds = new Set();
  const configuredTargetGroupNames = new Set(
    config.targetGroupNames.map((name) => sanitizeText(name).toLowerCase()).filter(Boolean),
  );
  let warnedNoAdmins = false;

  const skipOutgoingCountByChat = new Map();
  const pendingAiReplyIds = new Set();
  const pendingAiReplyTextsByChat = new Map();
  const handledCommandIds = new Set();
  const handledCommandOrder = [];
  const chatQueue = new Map();

  function isAdmin(authorId) {
    if (!config.adminWaIds.length) {
      if (!warnedNoAdmins) {
        warnedNoAdmins = true;
        logger.warn('admin_guardrails_disabled', { reason: 'ADMIN_WA_IDS is empty' });
      }
      return true;
    }
    const value = String(authorId || '').trim();
    if (!value) return false;
    const base = value.replace(/@c\.us$/i, '');
    return config.adminWaIds.some((admin) => admin === value || admin === base || `${admin}@c.us` === value);
  }

  function isTargetGroup(chat, chatId) {
    return true;
  }

  function markHandledCommand(messageId) {
    if (!messageId || handledCommandIds.has(messageId)) return;
    handledCommandIds.add(messageId);
    handledCommandOrder.push(messageId);
    if (handledCommandOrder.length > 4000) {
      const old = handledCommandOrder.shift();
      if (old) handledCommandIds.delete(old);
    }
  }

  function isCommandHandled(messageId) {
    return Boolean(messageId && handledCommandIds.has(messageId));
  }

  function markSkipOutgoing(chatId, count = 1) {
    const current = skipOutgoingCountByChat.get(chatId) || 0;
    skipOutgoingCountByChat.set(chatId, current + count);
  }

  function consumeSkipOutgoing(chatId) {
    const current = skipOutgoingCountByChat.get(chatId) || 0;
    if (current <= 0) return false;
    if (current === 1) skipOutgoingCountByChat.delete(chatId);
    else skipOutgoingCountByChat.set(chatId, current - 1);
    return true;
  }

  function queueAiReply(chatId, text) {
    const queue = pendingAiReplyTextsByChat.get(chatId) || [];
    queue.push(text);
    pendingAiReplyTextsByChat.set(chatId, queue);
  }

  function markAiReplyId(messageId) {
    if (messageId) pendingAiReplyIds.add(messageId);
  }

  function consumeQueuedAiReply(chatId, text) {
    const queue = pendingAiReplyTextsByChat.get(chatId);
    if (!queue || queue.length === 0) return false;
    const idx = queue.indexOf(text);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    if (queue.length === 0) pendingAiReplyTextsByChat.delete(chatId);
    return true;
  }

  function consumePendingAiReply(chatId, messageId, text) {
    if (messageId && pendingAiReplyIds.has(messageId)) {
      pendingAiReplyIds.delete(messageId);
      consumeQueuedAiReply(chatId, text);
      return true;
    }
    return consumeQueuedAiReply(chatId, text);
  }

  async function sendBotReply(msg, chatId, text) {
    const finalText = sanitizeText(text, { collapseWhitespace: false });
    queueAiReply(chatId, finalText);
    try {
      if (msg && typeof msg.reply === 'function') {
        const sent = await msg.reply(finalText);
        markAiReplyId(sent?.id?._serialized);
        return;
      }
    } catch (err) {
      logger.warn('msg_reply_failed_trying_send_message', { chatId, error: err?.message || err });
    }

    try {
      const messageId = msg?.id?._serialized || null;
      const options = messageId ? { quotedMessageId: messageId } : {};
      const sent = await client.sendMessage(chatId, finalText, options);
      markAiReplyId(sent?.id?._serialized);
    } catch (finalErr) {
      logger.error('send_bot_reply_failed', { chatId, error: finalErr });
    }
  }

  async function sendSystemReply(msg, chatId, text) {
    markSkipOutgoing(chatId, 1);
    const finalText = sanitizeText(text, { collapseWhitespace: false });
    try {
      if (msg && typeof msg.reply === 'function') {
        await msg.reply(finalText);
        return;
      }
    } catch {}
    try {
      const messageId = msg?.id?._serialized || null;
      const options = messageId ? { quotedMessageId: messageId } : {};
      await client.sendMessage(chatId, finalText, options);
    } catch {}
  }

  async function getAuthorName(msg) {
    try {
      if (msg.fromMe) return selfName;
      const contact = await msg.getContact().catch(() => null);
      const name = contact?.pushname || contact?.name || contact?.number || (typeof msg.author === 'string' ? msg.author : null) || (typeof msg.from === 'string' ? msg.from : null) || 'شخص';
      return normalizeName(name);
    } catch {
      return 'شخص';
    }
  }

  function enqueueChatTask(chatId, task) {
    const prev = chatQueue.get(chatId) || Promise.resolve();
    const next = prev
      .then(task)
      .catch((err) => {
        logger.error('chat_task_failed', { chatId, error: err });
      })
      .finally(() => {
        if (chatQueue.get(chatId) === next) chatQueue.delete(chatId);
      });
    chatQueue.set(chatId, next);
    return next;
  }

  function isRetryableInitializeError(err) {
    const message = String(err?.message || '');
    return (
      /Execution context was destroyed/i.test(message) ||
      /Protocol error \(Runtime\.callFunctionOn\)/i.test(message) ||
      /browser is already running for .*userDataDir/i.test(message)
    );
  }

  function extractUserDataDirFromInitializeError(err) {
    const message = String(err?.message || '');
    const match = message.match(/browser is already running for (.+?)\. Use a different `userDataDir`/i);
    return sanitizeText(match?.[1] || '', { collapseWhitespace: false }) || null;
  }

  async function removeChromiumLockFiles(userDataDir) {
    if (!userDataDir) return;
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
    const removed = [];
    for (const file of lockFiles) {
      const filePath = path.join(userDataDir, file);
      try {
        await fs.rm(filePath, { force: true });
        removed.push(filePath);
      } catch {}
    }
    if (removed.length > 0) {
      logger.warn('chromium_lock_files_removed', {
        userDataDir,
        files: removed,
      });
    }
  }

  async function cleanupAfterInitializeFailure(err, attempt) {
    try {
      await client.destroy();
      logger.info('client_destroy_after_initialize_failure', { attempt });
    } catch (destroyErr) {
      logger.warn('client_destroy_after_initialize_failure_failed', {
        attempt,
        error: destroyErr,
      });
    }

    const userDataDir = extractUserDataDirFromInitializeError(err);
    if (userDataDir) await removeChromiumLockFiles(userDataDir);
  }

  async function removeAllSessionLockFiles() {
    const authDir = path.resolve(process.cwd(), '.wwebjs_auth');
    try {
      async function cleanDir(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await cleanDir(fullPath);
          } else if (
            ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'LOCK'].includes(entry.name) ||
            entry.name.endsWith('.lock')
          ) {
            await fs.rm(fullPath, { force: true }).catch(() => {});
            logger.info('removed_stale_lock_file', { file: entry.name });
          }
        }
      }
      await cleanDir(authDir);
    } catch {}
  }

  async function initializeClientWithRetry() {
    await removeAllSessionLockFiles();
    for (let attempt = 1; attempt <= config.initRetryAttempts; attempt += 1) {
      try {
        logger.info('client_initialize_attempt', {
          attempt,
          maxAttempts: config.initRetryAttempts,
        });
        await client.initialize();
        return;
      } catch (err) {
        const retryable = isRetryableInitializeError(err);
        logger.error('client_initialize_failed', {
          attempt,
          retryable,
          error: err,
        });
        if (!retryable || attempt >= config.initRetryAttempts) throw err;
        await cleanupAfterInitializeFailure(err, attempt);
        await new Promise((resolve) => setTimeout(resolve, config.initRetryDelayMs));
      }
    }
  }

  async function extractQuotedInfo(msg, chatId) {
    if (!msg.hasQuotedMsg) return null;
    try {
      const quoted = await msg.getQuotedMessage();
      const quotedId = quoted.id?._serialized || null;
      const mapped = storage.findMessageById(chatId, quotedId);
      const author = mapped?.author || (quoted.fromMe ? selfName : await getAuthorName(quoted));
      const timestamp = mapped?.timestamp || (quoted.timestamp ? new Date(quoted.timestamp * 1000).toISOString() : null);
      const text = mapped?.text || sanitizeText(quoted.body);
      return {
        messageId: quotedId,
        author,
        text,
        timestamp,
      };
    } catch {
      return null;
    }
  }

  async function resolveChatContext(...messages) {
    const items = messages.filter(Boolean);
    for (const item of items) {
      const chatId = item?.id?.remote || (item.fromMe ? item.to : item.from) || null;
      if (chatId) {
        let chat = null;
        try {
          if (typeof item.getChat === 'function') chat = await item.getChat();
        } catch {}
        return { chat, chatId };
      }
    }
    return { chat: null, chatId: null };
  }

  function toIsoFromWhatsAppTimestamp(secondsValue) {
    const seconds = Number(secondsValue);
    if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
    return new Date(seconds * 1000).toISOString();
  }

  function isTransientClientContextError(err) {
    const message = String(err?.message || '');
    return (
      /Execution context was destroyed/i.test(message) ||
      /Cannot find context with specified id/i.test(message) ||
      /Session closed/i.test(message) ||
      /Target closed/i.test(message)
    );
  }

  async function getChatsWithRetry(maxAttempts = 3, delayMs = 1200) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await client.getChats();
      } catch (err) {
        const retryable = isTransientClientContextError(err);
        if (!retryable || attempt >= maxAttempts) throw err;
        logger.warn('get_chats_retry', { attempt, maxAttempts, error: err });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return [];
  }

  async function fetchMessagesWithRetry(group, limit, maxAttempts = 3, delayMs = 1200) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await group.fetchMessages({ limit });
      } catch (err) {
        const retryable = isTransientClientContextError(err);
        if (!retryable || attempt >= maxAttempts) throw err;
        logger.warn('fetch_messages_retry', {
          groupName: group?.name || 'unknown',
          attempt,
          maxAttempts,
          error: err,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return [];
  }

  async function bootstrapGroupHistory() {
    logger.info('bootstrap_history_bypassed_for_stability', {});
    return;
  }

  async function handlePrompt(msg, chatId, author, authorId, rawText) {
    const userPrompt = extractUserPrompt(rawText);
    if (userPrompt === null) return;

    logger.info('trigger_detected_processing_reply', {
      chatId,
      author,
      rawText,
      userPrompt,
    });

    if (!userPrompt) {
      await sendBotReply(msg, chatId, 'اكتب رسالتك وفيها اسم الاستدعاء، مثال: يا نوفا مساء الخير');
      return;
    }

    const requestedCount = parseLastCount(userPrompt);
    if (requestedCount) {
      const history = storage.getMessages(chatId, { limit: requestedCount });
      if (history.length === 0) {
        await sendBotReply(msg, chatId, 'مفيش رسائل محفوظة لسه.');
        return;
      }
      const lines = formatHistoryLines(history);
      for (let i = 0; i < lines.length; i += config.maxReplyChunkLines) {
        const chunk = lines.slice(i, i + config.maxReplyChunkLines).join('\n');
        await sendBotReply(msg, chatId, chunk);
      }
      return;
    }

    let chat = null;
    try {
      chat = await msg.getChat();
    } catch {}
    const chatName = chat?.name || (chatId.endsWith('@g.us') ? 'Group' : 'Private Direct Message (DM)');
    const isGroup = Boolean(chat?.isGroup || chatId.endsWith('@g.us'));

    const contextLimit = storage.getContextLimit(config.defaultContextLimit);
    const quotedInfo = await extractQuotedInfo(msg, chatId);
    const searchResult = await searchProvider.run(userPrompt);

    const promptPayload = buildPromptPayload(storage, chatId, {
      author,
      chatName,
      isGroup,
      userPrompt,
      quotedInfo,
      contextLimit,
      searchResult,
      hardCap: config.promptHardCap,
    });

    logger.info('prompt_built', {
      author,
      authorId: authorId || null,
      chatId,
      contextLimit,
      contextCount: promptPayload.contextCount,
      truncated: promptPayload.truncated,
      searchUsed: searchResult.used,
    });

    try {
      const response = await ai.generate({
        contents: promptPayload.prompt,
        systemInstruction: config.systemPrompt,
        label: 'chat_reply',
      });
      if (!response.text) {
        await sendBotReply(msg, chatId, 'مش قادر اولد رد دلوقتي، حاول تاني.');
        return;
      }
      logger.info('ai_response_ok', {
        keyIndex: response.keyIndex,
        chatId,
        author,
      });
      const finalReply = searchResult.used ? `تم البحث\n${response.text}` : response.text;
      await sendBotReply(msg, chatId, finalReply);
    } catch (err) {
      logger.error('ai_response_failed', { error: err, chatId, author });
      await sendBotReply(msg, chatId, 'حصل خطأ في الاتصال بالذكاء الاصطناعي. حاول كمان شوية.');
    }
  }

  const commandRegistry = createCommandRegistry({
    storage,
    ai,
    config,
    logger,
    isAdmin,
  });

  async function processCommandIfAny(msg, chat, chatId, text, author, authorId) {
    const messageId = msg.id?._serialized || null;
    if (isCommandHandled(messageId)) return true;
    const handled = await commandRegistry.handle({
      msg,
      chat,
      chatId,
      text,
      author,
      authorId,
      reply: async (replyText) => sendSystemReply(msg, chatId, replyText),
    });
    if (handled) {
      markHandledCommand(messageId);
      return true;
    }
    return false;
  }

  function safeAsyncEvent(eventName, handler) {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (err) {
        logger.error('client_event_failed', {
          eventName,
          error: err,
        });
      }
    };
  }

  client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    logger.info('qr_ready', {});
  });

  client.on('authenticated', () => {
    logger.info('client_authenticated', {});
  });

  client.on('auth_failure', (msg) => {
    logger.error('client_auth_failure', { message: msg });
  });

  client.on('ready', safeAsyncEvent('ready', async () => {
    logger.info('client_ready', {});
    try {
      if (client.info?.pushname) selfName = normalizeName(client.info.pushname);
      else if (client.info?.wid?.user) selfName = normalizeName(client.info.wid.user);
    } catch {}
    await bootstrapGroupHistory();

    setInterval(async () => {
      try {
        await client.getState();
      } catch {}
    }, 30000);
  }));

  client.on('message_create', safeAsyncEvent('message_create', async (msg) => {
    logger.info('raw_message_event', {
      from: msg.from || null,
      to: msg.to || null,
      fromMe: Boolean(msg.fromMe),
      hasBody: Boolean(msg.body),
      bodyPreview: String(msg.body || '').slice(0, 80),
      type: msg.type || null,
    });
    const text = sanitizeText(msg.body);
    if (!text) return;

    let chat = null;
    try {
      chat = await msg.getChat();
    } catch {}
    const chatId = msg.id?.remote || (msg.fromMe ? msg.to : msg.from) || chat?.id?._serialized || 'unknown';
    if (!isTargetGroup(chat, chatId)) return;
    targetChatIds.add(chatId);

    const authorId = msg.fromMe
      ? client.info?.wid?._serialized || null
      : msg.author || msg.from || null;
    const author = msg.fromMe ? selfName : await getAuthorName(msg);

    if (await processCommandIfAny(msg, chat, chatId, text, author, authorId)) return;

    if (msg.fromMe && consumeSkipOutgoing(chatId)) return;

    const messageId = msg.id?._serialized || null;
    const isAiReply = msg.fromMe && consumePendingAiReply(chatId, messageId, text);
    const quotedInfo = await extractQuotedInfo(msg, chatId);
    const entry = {
      role: isAiReply ? 'model' : 'user',
      source: isAiReply ? 'ai' : 'human',
      authorId,
      author: isAiReply ? config.botName : author,
      text,
      timestamp: toIsoFromWhatsAppTimestamp(msg.timestamp),
      replyTo: quotedInfo,
      messageId,
    };
    storage.addMessage(chatId, entry);

    if (entry.source === 'human') {
      const addressedToBot = extractUserPrompt(text) !== null;
      applyRelationshipFromMessage(storage, {
        chatId,
        author: entry.author,
        text: entry.text,
        addressedToBot,
      });
      extractLongMemoryFacts(storage, {
        chatId,
        author: entry.author,
        text: entry.text,
      });
    }

    if (!isAiReply) {
      const hasTrigger = extractUserPrompt(text) !== null;
      logger.info('message_received', {
        chatId,
        author,
        text,
        fromMe: Boolean(msg.fromMe),
        hasTrigger,
      });
      await enqueueChatTask(chatId, () => handlePrompt(msg, chatId, author, authorId, text));
    }
  }));

  client.on('message_revoke_everyone', safeAsyncEvent('message_revoke_everyone', async (after, before) => {
    const messageId = after?.id?._serialized || before?.id?._serialized || null;
    if (!messageId) return;

    const context = await resolveChatContext(after, before);
    const chatId = context.chatId || null;
    if (!chatId) return;
    if (!isTargetGroup(context.chat, chatId)) return;

    const deleted = storage.deleteMessageById(chatId, messageId);
    if (deleted > 0) {
      logger.info('message_deleted_synced', {
        chatId,
        messageId,
        mode: 'revoke_everyone',
      });
    }
  }));

  client.on('message_revoke_me', safeAsyncEvent('message_revoke_me', async (msg) => {
    const messageId = msg?.id?._serialized || null;
    if (!messageId) return;

    const context = await resolveChatContext(msg);
    const chatId = context.chatId || null;
    if (!chatId) return;
    if (!isTargetGroup(context.chat, chatId)) return;

    const deleted = storage.deleteMessageById(chatId, messageId);
    if (deleted > 0) {
      logger.info('message_deleted_synced', {
        chatId,
        messageId,
        mode: 'revoke_me',
      });
    }
  }));

  logger.info('bot_starting', {
    targetGroupNames: config.targetGroupNames,
    dbPath: config.dbPath,
  });

  await initializeClientWithRetry();
}
