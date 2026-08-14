import { normalizeWhitespace, sanitizeText } from '../../utils/text.js';

function toSearchTextFromTavily(data) {
  const answer = normalizeWhitespace(data?.answer);
  const items = Array.isArray(data?.results) ? data.results : [];
  const lines = items.slice(0, 6).map((item, idx) => {
    const title = normalizeWhitespace(item?.title) || 'No title';
    const url = normalizeWhitespace(item?.url) || '';
    const content = normalizeWhitespace(item?.content).slice(0, 350);
    return `${idx + 1}. ${title}\nURL: ${url}\nSnippet: ${content}`;
  });
  if (!answer && lines.length === 0) return '';
  return `${answer ? `Answer: ${answer}\n\n` : ''}${lines.join('\n\n')}`.trim();
}

function toSearchTextFromSerper(data) {
  const answerBox = normalizeWhitespace(data?.answerBox?.answer || data?.answerBox?.snippet || '');
  const organic = Array.isArray(data?.organic) ? data.organic : [];
  const lines = organic.slice(0, 6).map((item, idx) => {
    const title = normalizeWhitespace(item?.title) || 'No title';
    const url = normalizeWhitespace(item?.link) || '';
    const snippet = normalizeWhitespace(item?.snippet).slice(0, 350);
    return `${idx + 1}. ${title}\nURL: ${url}\nSnippet: ${snippet}`;
  });
  if (!answerBox && lines.length === 0) return '';
  return `${answerBox ? `Answer: ${answerBox}\n\n` : ''}${lines.join('\n\n')}`.trim();
}

export function needsWebSearch(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  const text = prompt.toLowerCase();

  // 1. Explicit search triggers
  const explicitSearch = /(ابحث|دور|فتش|سيرش|جوجل|جوجله|على النت|على الانترنت|الانترنت|search|google|lookup)/i;

  // 2. Real-time & News triggers
  const newsAndEvents = /(خبر|اخبار|ايه اللي حصل|تريند|ترند|حادث|مؤتمر|قرار|بيان|زلزال|حرب|وفاة|مات|وفاه|news|latest)/i;

  // 3. Temporal triggers (today, yesterday, now, 2025/2026)
  const temporal = /(النهارده|النهاردة|اليوم|امبارح|امس|أمس|بكرة|بكرا|غدا|دلوقتي|حاليا|الان|السنة دي|2025|2026|احدث|أحدث|آخر اخبار|اخر اخبار)/i;

  // 4. Prices, currencies, financial, commodities
  const pricesAndFinance = /(سعر|اسعار|أسعار|الدولار|الذهب|الريال|اليورو|العملات|بكام|كام سعر|بورصة|اسهم|أسهم|بيتكوين|crypto|price|سعر جرام)/i;

  // 5. Sports, scores, matches, tournaments
  const sports = /(ماتش|مباراة|مباريات|نتيجة|دوري|اهداف|أهداف|ترتيب|كأس|مين كسب|مين فاز|تشكيل|الاهلي|الأهلي|الزمالك|ريال مدريد|برشلونة|ليفربول|مانشستر|صلاح|ميسي|رونالدو)/i;

  // 6. Weather & Temperature
  const weather = /(طقس|درجة الحرارة|درجه الحراره|الجو|مطر|أخبار الطقس)/i;

  // 7. Product releases, movies, releases
  const releases = /(موعد نزول|تاريخ نزول|سعر تليفون|مواصفات|ايفون|سامسونج|شاومي|فيلم|مسلسل|اغنية|أغنية)/i;

  return (
    explicitSearch.test(text) ||
    newsAndEvents.test(text) ||
    (temporal.test(text) && (pricesAndFinance.test(text) || sports.test(text) || newsAndEvents.test(text) || weather.test(text) || /(مين|ايه|كام|فين|ازاي)/i.test(text))) ||
    pricesAndFinance.test(text) ||
    sports.test(text) ||
    weather.test(text) ||
    releases.test(text)
  );
}

export function extractSearchQuery(prompt) {
  const cleaned = sanitizeText(prompt)
    .replace(/^(يا\s*نوفا|ي\s*نوفا|نوفا)/i, '')
    .replace(/(يا\s*نوفا|ي\s*نوفا|نوفا)$/i, '')
    .replace(/^(يا\s*عم|بقولك\s*ايه|قولي|عايز\s*اعرف|هو|هي|لو\s*سمحت|بالله\s*عليك)\s*/i, '')
    .replace(/^(ابحث|دور|فتش|سيرش|جوجل)\s*(عن|على|لي)?\s*/i, '')
    .replace(/على\s*(ال)?(نت|الانترنت|جوجل)/i, '')
    .trim();
  return cleaned || sanitizeText(prompt);
}

async function fetchJsonWithTimeout(url, payload, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export class SearchProvider {
  constructor(options) {
    this.tavilyKeys = options.tavilyKeys || [];
    this.serperKeys = options.serperKeys || [];
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
    this.tavilyIndex = 0;
    this.serperIndex = 0;
  }

  #nextTavilyKey() {
    if (!this.tavilyKeys.length) return null;
    const index = this.tavilyIndex % this.tavilyKeys.length;
    const key = this.tavilyKeys[index];
    this.tavilyIndex = (this.tavilyIndex + 1) % this.tavilyKeys.length;
    return { key, index: index + 1 };
  }

  #nextSerperKey() {
    if (!this.serperKeys.length) return null;
    const index = this.serperIndex % this.serperKeys.length;
    const key = this.serperKeys[index];
    this.serperIndex = (this.serperIndex + 1) % this.serperKeys.length;
    return { key, index: index + 1 };
  }

  async #searchWithTavily(query) {
    const next = this.#nextTavilyKey();
    if (!next) return null;
    this.logger.info('search_try', { provider: 'tavily', keyIndex: next.index, query });
    const data = await fetchJsonWithTimeout(
      'https://api.tavily.com/search',
      {
        api_key: next.key,
        query,
        search_depth: 'basic',
        max_results: 6,
        include_answer: true,
        include_raw_content: false,
      },
      this.timeoutMs,
    );
    const context = toSearchTextFromTavily(data);
    return context ? { provider: 'Tavily', context, keyIndex: next.index } : null;
  }

  async #searchWithSerper(query) {
    const next = this.#nextSerperKey();
    if (!next) return null;
    this.logger.info('search_try', { provider: 'serper', keyIndex: next.index, query });
    const data = await fetchJsonWithTimeout(
      'https://google.serper.dev/search',
      {
        q: query,
        num: 6,
        gl: 'eg',
        hl: 'ar',
      },
      this.timeoutMs,
      {
        'X-API-KEY': next.key,
      },
    );
    const context = toSearchTextFromSerper(data);
    return context ? { provider: 'Serper', context, keyIndex: next.index } : null;
  }

  async run(prompt) {
    if (!needsWebSearch(prompt)) return { used: false, provider: '', context: '' };
    const query = extractSearchQuery(prompt);
    const providers = [() => this.#searchWithTavily(query), () => this.#searchWithSerper(query)];
    for (const attempt of providers) {
      try {
        const result = await attempt();
        if (result) {
          this.logger.info('search_ok', {
            provider: result.provider,
            keyIndex: result.keyIndex,
            query,
          });
          return { used: true, provider: result.provider, context: result.context };
        }
      } catch (err) {
        this.logger.warn('search_fail', { query, error: err });
      }
    }
    return { used: false, provider: '', context: '' };
  }
}
