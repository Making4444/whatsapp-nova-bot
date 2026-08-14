import { sleep } from '../../utils/common.js';

export class OpenRouterProvider {
  constructor(options) {
    this.model = options.model || 'openai/gpt-5.6-luna';
    this.apiKey = options.apiKey || options.openrouterApiKey;
    this.logger = options.logger;

    if (!this.apiKey) {
      throw new Error('Missing OpenRouter API key. Set OPENROUTER_API_KEY in .env');
    }
  }

  async generate(request) {
    const maxAttempts = 3;
    let lastErr = null;

    const messages = [];
    if (request.systemInstruction && request.systemInstruction.trim()) {
      messages.push({
        role: 'system',
        content: request.systemInstruction.trim(),
      });
    }

    let userContent = null;
    if (Array.isArray(request.images) && request.images.length > 0) {
      const textContent = typeof request.contents === 'string'
        ? request.contents
        : JSON.stringify(request.contents);

      const contentParts = [{ type: 'text', text: textContent }];
      for (const imgUrl of request.images) {
        if (imgUrl) {
          contentParts.push({
            type: 'image_url',
            image_url: { url: imgUrl },
          });
        }
      }
      userContent = contentParts;
    } else {
      userContent = typeof request.contents === 'string'
        ? request.contents
        : JSON.stringify(request.contents);
    }

    messages.push({
      role: 'user',
      content: userContent,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.logger.info('ai_request', {
        attempt,
        model: this.model,
        hasImages: Boolean(request.images && request.images.length > 0),
        label: request.label || 'chat',
      });

      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'HTTP-Referer': 'https://github.com/Making4444/whatsapp-nova-bot',
            'X-Title': 'WhatsApp Nova Bot',
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: request.temperature ?? 0.85,
            top_p: 0.95,
            frequency_penalty: 0.35,
            presence_penalty: 0.25,
          }),
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => '');
          throw new Error(`OpenRouter API error (HTTP ${res.status}): ${errorText}`);
        }

        const data = await res.json();
        const outputText = data?.choices?.[0]?.message?.content || '';

        return {
          text: outputText.trim(),
          model: this.model,
          raw: data,
        };
      } catch (err) {
        lastErr = err;
        this.logger.warn('ai_request_error', {
          attempt,
          error: err?.message || err,
          label: request.label || '',
        });

        if (attempt < maxAttempts) {
          await sleep(1500 * attempt);
        }
      }
    }

    throw lastErr || new Error('OpenRouter API request failed after retries');
  }
}

export { OpenRouterProvider as GeminiPool, OpenRouterProvider as OpenRouterPool };
