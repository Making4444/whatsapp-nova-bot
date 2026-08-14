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
  'عسل',
  'سكر',
  'قمر',
  'منور',
  'أحلى',
  'احلى',
  'ممتاز',
  'عبقري',
  'ذكي',
  'محترم',
];

const APOLOGY_WORDS = [
  'اسف',
  'آسف',
  'اعتذر',
  'أعتذر',
  'حقك عليا',
  'حقك علي',
  'متزعلش',
  'ما تزعلش',
  'سامحني',
  'خلاص متزعلش',
  'بهزر معاك',
  'كنت بهزر',
];

const SEVERE_NEGATIVE_WORDS = [
  'غبي',
  'اهبل',
  'أهبل',
  'حمار',
  'كلب',
  'حيوان',
  'متخلف',
  'يا واطي',
  'قذر',
  'شتيمة',
  'ابن ال',
  'يلعن',
  'خرا',
  'يا زفت',
  'يا مقرف',
];

const MODERATE_NEGATIVE_WORDS = [
  'رخم',
  'بارد',
  'سخيف',
  'مالوش لازمة',
  'فاشل',
  'مش فاهم حاجة',
  'زي الزفت',
  'سيء',
  'مقرف',
  'اقفل',
  'اسكت',
  'اخرس',
  'اتكتم',
  'غور',
  'امشي',
  'مش طايقك',
  'كرهتك',
];

const SOFT_NEGATIVE_WORDS = ['متضايق', 'زعلان', 'مش عاجبني', 'مش حلو', 'بطل رغي'];

export function scoreRelationshipDelta(text, options = {}) {
  const normalized = sanitizeText(text).toLowerCase();
  if (!normalized) return { affinityDelta: 0, trustDelta: 0, moodType: 'neutral' };

  let positive = 0;
  let apologies = 0;
  let severeNegative = 0;
  let moderateNegative = 0;
  let softNegative = 0;

  for (const word of POSITIVE_WORDS) {
    if (normalized.includes(word)) positive += 1;
  }
  for (const word of APOLOGY_WORDS) {
    if (normalized.includes(word)) apologies += 1;
  }
  for (const word of SEVERE_NEGATIVE_WORDS) {
    if (normalized.includes(word)) severeNegative += 1;
  }
  for (const word of MODERATE_NEGATIVE_WORDS) {
    if (normalized.includes(word)) moderateNegative += 1;
  }
  for (const word of SOFT_NEGATIVE_WORDS) {
    if (normalized.includes(word)) softNegative += 1;
  }

  let affinityDelta = positive * 3 + apologies * 3 - severeNegative * 12 - moderateNegative * 6 - softNegative * 2;
  let trustDelta = positive * 2 + apologies * 2 - severeNegative * 8 - moderateNegative * 4 - softNegative;

  if (options.addressedToBot && (severeNegative > 0 || moderateNegative > 0)) {
    affinityDelta -= 5;
    trustDelta -= 3;
  }
  if (options.addressedToBot && positive > 0) {
    affinityDelta += 2;
  }

  let moodType = 'neutral';
  if (severeNegative > 0 || moderateNegative > 0) {
    moodType = 'angry_hurt';
  } else if (apologies > 0) {
    moodType = 'apologizing';
  } else if (positive > 0) {
    moodType = 'happy';
  }

  return {
    affinityDelta: clamp(affinityDelta, -25, 25),
    trustDelta: clamp(trustDelta, -15, 15),
    moodType,
  };
}

export function computeMoodDescription(affinity, trust) {
  if (affinity <= -40) {
    return {
      title: 'غضبان وزعلان جداً (مقموص ومجروح)',
      promptRule: 'أنت في قمة الغضب والزعل الشديد منه! ممنوع تسامحه أو تبتسم له أو ترضى بسهولة حتى لو اعتذر بكلمة "اسف" مرة واحدة. خليك بارد، مقموص، وعاتبه بقسوة وسخرية لاذعة وبينله إنه محتاج يراضيك كتير عشان ترجع تكلمه طبيعي.',
    };
  }
  if (affinity <= -15) {
    return {
      title: 'متضايق ومش طايقه (واخد موقف)',
      promptRule: 'أنت متضايق منه ومش مرتاح لكلامه. ردودك معاه تكون ناشفة ومقتضبة وفيها تريقة وتلقيح كلام عشان يعرف غلطه.',
    };
  }
  if (affinity >= 40) {
    return {
      title: 'فرحان ومبسوط جداً (حبيبه وقريب لقلبه)',
      promptRule: 'أنت مبسوط منه وفرحان بيه جداً وبتحبه! كلامك معاه كله طاقة إيجابية وخفة دم ومرح وهزار حبوب.',
    };
  }
  if (affinity >= 15) {
    return {
      title: 'مرتاح ومزاجه رايق معاه',
      promptRule: 'أنت مرتاح معاه ومتقبله، بتهزر معاه بتلقائية ولطافة.',
    };
  }
  return {
    title: 'محايد وطبيعي',
    promptRule: 'علاقة عادية وطبيعية. اتعامل بشخصيتك المصرية الساخرة والذكية بدون زعل مبالغ فيه ولا محبة مبالغ فيها.',
  };
}

export function applyRelationshipFromMessage(storage, payload) {
  const accountName = normalizeName(payload.author);
  const text = sanitizeText(payload.text);
  const delta = scoreRelationshipDelta(text, {
    addressedToBot: Boolean(payload.addressedToBot),
  });
  if (delta.affinityDelta === 0 && delta.trustDelta === 0) return null;
  return storage.adjustRelationship(payload.chatId, accountName, {
    affinityDelta: delta.affinityDelta,
    trustDelta: delta.trustDelta,
  });
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
