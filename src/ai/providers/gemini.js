import { GoogleGenAI } from '@google/genai';
import { sleep } from '../../utils/common.js';

export class GeminiProvider {
  constructor(options) {
    this.model = options.model;
    this.logger = options.logger;
    const key = options.apiKey || options.key || (options.keys && options.keys[0]);
    if (!key) {
      throw new Error('Missing Gemini API key. Set GEMINI_API_KEY in .env');
    }
    this.client = new GoogleGenAI({ apiKey: key });
  }

  async generate(request) {
    const maxAttempts = 3;
    let lastErr = null;

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
        label: request.label || 'chat',
      });

      try {
        const response = await this.client.models.generateContent(payload);
        return {
          text: (response.text || '').trim(),
          keyIndex: 1,
          raw: response,
        };
      } catch (err) {
        lastErr = err;
        this.logger.warn('ai_request_error', {
          attempt,
          label: request.label || '',
          error: err,
        });
        if (attempt < maxAttempts) {
          await sleep(2000 * attempt);
        }
      }
    }

    throw lastErr || new Error('Gemini API request failed');
  }
}

export { GeminiProvider as GeminiPool };
