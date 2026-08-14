import { GoogleGenAI } from '@google/genai';
import { sleep } from '../../utils/common.js';

export class GeminiPool {
  constructor(options) {
    this.model = options.model;
    this.logger = options.logger;

    const rawKeys = options.keys || [options.apiKey || options.key].filter(Boolean);
    const uniqueKeys = Array.from(new Set(rawKeys.map((k) => String(k || '').trim()).filter(Boolean)));

    if (uniqueKeys.length === 0) {
      throw new Error('Missing Gemini API keys. Set GEMINI_API_KEY_1..4 in .env');
    }

    this.clients = uniqueKeys.map((apiKey, index) => ({
      index: index + 1,
      client: new GoogleGenAI({ apiKey }),
      apiKeyMasked: `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`,
    }));

    this.currentIndex = 0;
  }

  get keyCount() {
    return this.clients.length;
  }

  #getNextClient() {
    const selected = this.clients[this.currentIndex % this.clients.length];
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
    return selected;
  }

  async generate(request) {
    const totalKeys = this.clients.length;
    const maxAttempts = totalKeys * 2;
    let lastErr = null;

    let clientEntry = this.#getNextClient();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const payload = {
        model: this.model,
        contents: request.contents,
      };
      if (request.systemInstruction && request.systemInstruction.trim()) {
        payload.config = { systemInstruction: request.systemInstruction };
      }

      this.logger.info('ai_request', {
        attempt,
        keyIndex: clientEntry.index,
        keyCount: totalKeys,
        label: request.label || 'chat',
      });

      try {
        const response = await clientEntry.client.models.generateContent(payload);
        return {
          text: (response.text || '').trim(),
          keyIndex: clientEntry.index,
          raw: response,
        };
      } catch (err) {
        lastErr = err;
        this.logger.warn('ai_request_key_failed', {
          attempt,
          keyIndex: clientEntry.index,
          error: err?.message || err,
          label: request.label || '',
        });

        clientEntry = this.#getNextClient();
        if (attempt < maxAttempts) {
          await sleep(1000);
        }
      }
    }

    throw lastErr || new Error('All Gemini API keys in pool failed request');
  }
}

export { GeminiPool as GeminiProvider };
