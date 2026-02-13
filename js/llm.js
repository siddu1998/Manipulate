// ─── LLM API Abstraction Layer ────────────────────────────────────
export class LLM {
  constructor() {
    this.keys = { openai: '', anthropic: '', gemini: '', grok: '' };
    this.provider = 'openai';
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(localStorage.getItem('pixelworld_api_keys') || '{}');
      Object.assign(this.keys, saved);
      this.provider = localStorage.getItem('pixelworld_provider') || this._autoDetectProvider();
    } catch (e) { /* ignore */ }
  }

  save() {
    localStorage.setItem('pixelworld_api_keys', JSON.stringify(this.keys));
    localStorage.setItem('pixelworld_provider', this.provider);
  }

  setKey(provider, key) {
    this.keys[provider] = key;
    this.save();
  }

  setProvider(provider) {
    this.provider = provider;
    this.save();
  }

  _autoDetectProvider() {
    if (this.keys.openai) return 'openai';
    if (this.keys.gemini) return 'gemini';
    if (this.keys.grok) return 'grok';
    if (this.keys.anthropic) return 'anthropic';
    return 'openai';
  }

  hasAnyKey() {
    return Object.values(this.keys).some(k => k && k.trim().length > 0);
  }

  getActiveKey() {
    return this.keys[this.provider];
  }

  // ─── Main generation method ─────────────────────────────────────
  async generate(systemPrompt, userPrompt, options = {}) {
    const { json = false, temperature = 0.8, maxTokens = 4096 } = options;
    const key = this.getActiveKey();
    if (!key) throw new Error('No API key configured. Please add one in Settings.');

    const handler = {
      openai: () => this._callOpenAI(key, systemPrompt, userPrompt, json, temperature, maxTokens),
      anthropic: () => this._callAnthropic(key, systemPrompt, userPrompt, json, temperature, maxTokens),
      gemini: () => this._callGemini(key, systemPrompt, userPrompt, json, temperature, maxTokens),
      grok: () => this._callGrok(key, systemPrompt, userPrompt, json, temperature, maxTokens),
    }[this.provider];

    if (!handler) throw new Error(`Unknown provider: ${this.provider}`);

    const text = await handler();
    if (json) {
      return this._parseJSON(text);
    }
    return text;
  }

  // ─── Chat method (multi-turn) ───────────────────────────────────
  async chat(systemPrompt, messages, options = {}) {
    const { temperature = 0.8, maxTokens = 1024 } = options;
    const key = this.getActiveKey();
    if (!key) throw new Error('No API key configured.');

    const handler = {
      openai: () => this._chatOpenAI(key, systemPrompt, messages, temperature, maxTokens),
      anthropic: () => this._chatAnthropic(key, systemPrompt, messages, temperature, maxTokens),
      gemini: () => this._chatGemini(key, systemPrompt, messages, temperature, maxTokens),
      grok: () => this._chatGrok(key, systemPrompt, messages, temperature, maxTokens),
    }[this.provider];

    return handler();
  }

  // ─── OpenAI ─────────────────────────────────────────────────────
  async _callOpenAI(key, system, user, json, temp, maxTokens) {
    const body = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: temp,
      max_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;
  }

  async _chatOpenAI(key, system, messages, temp, maxTokens) {
    const msgs = [{ role: 'system', content: system }, ...messages];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: msgs, temperature: temp, max_tokens: maxTokens }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;
  }

  // ─── Anthropic ──────────────────────────────────────────────────
  async _callAnthropic(key, system, user, json, temp, maxTokens) {
    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: system + (json ? '\n\nRespond with valid JSON only.' : ''),
      messages: [{ role: 'user', content: user }],
      temperature: temp,
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content[0].text;
  }

  async _chatAnthropic(key, system, messages, temp, maxTokens) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages, temperature: temp,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content[0].text;
  }

  // ─── Gemini ─────────────────────────────────────────────────────
  async _callGemini(key, system, user, json, temp, maxTokens) {
    const body = {
      system_instruction: { parts: [{ text: system + (json ? '\n\nRespond with valid JSON only, no markdown.' : '') }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { temperature: temp, maxOutputTokens: maxTokens },
    };
    if (json) body.generationConfig.responseMimeType = 'application/json';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates[0].content.parts[0].text;
  }

  async _chatGemini(key, system, messages, temp, maxTokens) {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: temp, maxOutputTokens: maxTokens },
        }),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates[0].content.parts[0].text;
  }

  // ─── Grok (xAI - OpenAI compatible) ────────────────────────────
  async _callGrok(key, system, user, json, temp, maxTokens) {
    const body = {
      model: 'grok-3-mini-fast',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: temp,
      max_tokens: maxTokens,
    };
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;
  }

  async _chatGrok(key, system, messages, temp, maxTokens) {
    const msgs = [{ role: 'system', content: system }, ...messages];
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'grok-3-mini-fast', messages: msgs, temperature: temp, max_tokens: maxTokens }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;
  }

  // ─── Image Generation ────────────────────────────────────────────
  // Fallback chain: Nano Banana (Gemini) → DALL-E (OpenAI) → null
  async generateImage(prompt, size = '256x256') {
    // Try Nano Banana first (uses existing Gemini key)
    if (this.keys.gemini) {
      try {
        return await this._generateImageNanoBanana(this.keys.gemini, prompt);
      } catch (err) {
        console.warn('Nano Banana image gen failed:', err.message);
      }
    }
    // Fallback to DALL-E
    if (this.keys.openai) {
      try {
        return await this._generateImageDallE(this.keys.openai, prompt, size);
      } catch (err) {
        console.warn('DALL-E image gen failed:', err.message);
      }
    }
    return null; // No image API available — caller should use procedural fallback
  }

  async _generateImageNanoBanana(key, prompt) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    // Extract base64 image from response
    const parts = data.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        return `data:${mime};base64,${part.inlineData.data}`;
      }
    }
    throw new Error('No image in Nano Banana response');
  }

  async _generateImageDallE(key, prompt, size) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024', // DALL-E 3 minimum
        response_format: 'b64_json',
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('No image in DALL-E response');
    return `data:image/png;base64,${b64}`;
  }

  canGenerateImages() {
    return !!(this.keys.gemini || this.keys.openai);
  }

  // ─── Embedding API (for memory relevance) ─────────────────────
  // Returns a float[] vector, or null if no embedding API available.
  // Prefers OpenAI text-embedding-3-small, falls back to Gemini.
  canEmbed() {
    return !!(this.keys.openai || this.keys.gemini);
  }

  async embed(text) {
    if (this.keys.openai) return this._embedOpenAI(this.keys.openai, text);
    if (this.keys.gemini) return this._embedGemini(this.keys.gemini, text);
    return null;
  }

  async embedBatch(texts) {
    if (texts.length === 0) return [];
    if (this.keys.openai) return this._embedBatchOpenAI(this.keys.openai, texts);
    if (this.keys.gemini) return this._embedBatchGemini(this.keys.gemini, texts);
    return texts.map(() => null);
  }

  async _embedOpenAI(key, text) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.data[0].embedding;
  }

  async _embedBatchOpenAI(key, texts) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }

  async _embedGemini(key, text) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.embedding.values;
  }

  async _embedBatchGemini(key, texts) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map(text => ({
            model: 'models/text-embedding-004',
            content: { parts: [{ text }] },
          })),
        }),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return (data.embeddings || []).map(e => e.values);
  }

  // ─── JSON parsing helper ────────────────────────────────────────
  _parseJSON(text) {
    // Try direct parse first
    try { return JSON.parse(text); } catch (e) { /* continue */ }
    // Try extracting from markdown code block
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch (e) { /* continue */ }
    }
    // Try finding first { to last }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { /* continue */ }
    }
    throw new Error('Failed to parse JSON from LLM response');
  }
}
