import {
  isMemberBuildCommand,
  parseEditCommand,
  parseHelpCommand,
  parseMoodCommand,
  parseSetCommand,
  parseStatusCommand,
} from '../utils/text.js';
import { buildMembersFromAi } from '../services/memberBuilder.js';

export function createCommandRegistry(deps) {
  const {
    storage,
    ai,
    config,
    logger,
    isAdmin,
  } = deps;

  function formatBootstrapSetting(setting) {
    if (setting?.type === 'disabled') return 'false';
    if (setting?.type === 'all') return 'all';
    return String(setting?.count || config.bootstrapLimit);
  }

  async function handleEdit(text, ctx) {
    const parsed = parseEditCommand(text);
    if (!parsed) return false;

    if (!isAdmin(ctx.authorId)) {
      await ctx.reply('الامر ده للادمن بس.');
      return true;
    }

    if (parsed.type === 'all') {
      storage.setContextLimit(0);
      await ctx.reply('تمام، هستخدم كل الرسائل المتاحة كسياق (مع حدود الامان الداخلية).');
      return true;
    }

    storage.setContextLimit(parsed.count);
    await ctx.reply(`تمام، هستخدم آخر ${parsed.count} رسالة كسياق.`);
    return true;
  }

  async function handleSet(text, ctx) {
    const parsed = parseSetCommand(text);
    if (!parsed) return false;

    if (!isAdmin(ctx.authorId)) {
      await ctx.reply('This command is admin only.');
      return true;
    }

    if (parsed.type === 'invalid') {
      await ctx.reply('Usage: /set false | /set all | /set <number>');
      return true;
    }

    const updated = storage.setBootstrapSyncSetting(parsed);
    await ctx.reply(`Done. startup sync is now: ${formatBootstrapSetting(updated)} (applies after restart).`);
    return true;
  }

  async function handleMember(text, ctx) {
    if (!isMemberBuildCommand(text)) return false;

    if (!isAdmin(ctx.authorId)) {
      await ctx.reply('الامر ده للادمن بس.');
      return true;
    }

    try {
      await ctx.reply(`بدأت بناء ملف الاعضاء من آخر ${config.membersBootstrapLimit} رسالة...`);
      const result = await buildMembersFromAi({
        storage,
        ai,
        chatId: ctx.chatId,
        limit: config.membersBootstrapLimit,
        chunkSize: config.membersChunkSize,
        systemInstruction: config.systemPrompt,
        logger,
      });
      await ctx.reply(
        `تم إنشاء ملف الاعضاء. الاعضاء: ${result.count} | chunks: ${result.chunks} | الرسائل المستخدمة: ${result.sourceMessages}`,
      );
    } catch (err) {
      logger.error('member_build_failed', { error: err });
      await ctx.reply(`فشل إنشاء ملف الاعضاء: ${err.message}`);
    }
    return true;
  }

  async function handleStatus(text, ctx) {
    if (!parseStatusCommand(text)) return false;
    const totalMessages = storage.getMessageCount(ctx.chatId);
    const humanMessages = storage.getHumanMessageCount(ctx.chatId);
    const contextLimit = storage.getContextLimit(config.defaultContextLimit);
    const bootstrapSetting = storage.getBootstrapSyncSetting(config.bootstrapLimit);
    const membersCount = storage.getMembersCount();
    const relation = storage.getRelationship(ctx.chatId, ctx.author);
    const mood = relation.affinity >= 25 ? 'مرتاح' : relation.affinity <= -25 ? 'متضايق' : 'محايد';
    await ctx.reply(
      `Status\ncontextLimit: ${contextLimit === 0 ? 'all' : contextLimit}\nstartupSync: ${formatBootstrapSetting(bootstrapSetting)}\nmessages: ${totalMessages}\nhumanMessages: ${humanMessages}\nmembers: ${membersCount}\nyourAffinity: ${Math.round(
        relation.affinity,
      )}\nyourTrust: ${Math.round(relation.trust)}\nmyMoodWithYou: ${mood}`,
    );
    return true;
  }

  async function handleMood(text, ctx) {
    const parsed = parseMoodCommand(text);
    if (!parsed) return false;

    if (parsed.type === 'show') {
      const relation = storage.getRelationship(ctx.chatId, ctx.author);
      await ctx.reply(`mood with you: affinity=${Math.round(relation.affinity)} | trust=${Math.round(relation.trust)}`);
      return true;
    }

    if (!isAdmin(ctx.authorId)) {
      await ctx.reply('تعديل المزاج يدويًا للادمن بس.');
      return true;
    }

    const updated = storage.setRelationship(ctx.chatId, parsed.accountName, {
      affinity: parsed.value,
    });
    await ctx.reply(`تم تعديل affinity لـ ${updated.accountName} الى ${Math.round(updated.affinity)}.`);
    return true;
  }

  async function handleHelp(text, ctx) {
    if (!parseHelpCommand(text)) return false;
    await ctx.reply(
      '/edit <number|all>\n/set false|all|<number>\n/member\n/status\n/mood\n/mood <accountName> <value -100..100>\n/help',
    );
    return true;
  }

  return {
    async handle(ctx) {
      const text = ctx.text;
      const handlers = [handleEdit, handleSet, handleMember, handleStatus, handleMood, handleHelp];
      for (const handler of handlers) {
        const handled = await handler(text, ctx);
        if (handled) return true;
      }
      return false;
    },
  };
}

