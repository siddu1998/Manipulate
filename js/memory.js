// ═══════════════════════════════════════════════════════════════════
//  Memory Stream — Based on Park et al. (2023)
//  "Generative Agents: Interactive Simulacra of Human Behavior"
//
//  Architecture: Memory Stream → Retrieve → Reflect → Plan → Act
//  
//  Each memory has three retrieval scores:
//    • Recency    — exponential decay since last access
//    • Importance — LLM-rated 1-10 at creation
//    • Relevance  — embedding cosine similarity (or keyword fallback)
//  
//  Final score = α·norm(recency) + β·norm(importance) + γ·norm(relevance)
//  Scores are MIN-MAX NORMALIZED before combining (paper Section 4.1)
// ═══════════════════════════════════════════════════════════════════

// Stop words for keyword extraction
const STOP = new Set('the a an is was are were be been being have has had do does did will would could should may might shall can to of in for on with at by from as into through during before after above below between out off over under again further then once here there when where why how all each every both few more most other some such no nor not only own same so than too very just because but and or if while about i me my we our you your he him his she her it its they them their this that these those what am'.split(' '));

export class MemoryEntry {
  constructor(description, type, importance, gameTime) {
    this.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    this.description = description;
    this.type = type;       // observation | reflection | plan | dialogue | event
    this.importance = importance;
    this.createdAt = Date.now();
    this.lastAccessed = Date.now();
    this.gameTimeCreated = gameTime ? `${gameTime.hours}:${String(gameTime.minutes).padStart(2,'0')}` : '';
    this.gameDay = gameTime?.day || 1;
    this.relatedIds = [];   // for reflections: which memories contributed
    this.keywords = extractKeywords(description);
    this.embedding = null;  // float[] — set async by embedding queue
  }
}

function extractKeywords(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

// ─── Cosine Similarity ───────────────────────────────────────────
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Memory Stream ────────────────────────────────────────────────
export class MemoryStream {
  constructor(maxEntries = 500) {
    this.entries = [];
    this.maxEntries = maxEntries;
    this.decayFactor = 0.995;  // per game-hour of last-access age (paper uses 0.995)

    // Embedding queue: memories waiting to be embedded
    this._embeddingQueue = [];
    this._embeddingInProgress = false;
  }

  // Add a new memory
  add(description, type = 'observation', importance = 5, gameTime = null) {
    const entry = new MemoryEntry(description, type, Math.max(1, Math.min(10, importance)), gameTime);
    this.entries.push(entry);
    // Queue for embedding if important enough
    if (importance >= 3) {
      this._embeddingQueue.push(entry);
    }
    if (this.entries.length > this.maxEntries) this._prune();
    return entry;
  }

  // ─── Async embedding processing ─────────────────────────────────
  // Call this periodically from the app with the LLM instance
  async processEmbeddingQueue(llm) {
    if (this._embeddingInProgress || this._embeddingQueue.length === 0) return;
    if (!llm || !llm.canEmbed()) return;

    this._embeddingInProgress = true;
    try {
      // Process up to 20 at a time
      const batch = this._embeddingQueue.splice(0, 20);
      const texts = batch.map(e => e.description);
      const embeddings = await llm.embedBatch(texts);
      for (let i = 0; i < batch.length; i++) {
        if (embeddings[i]) batch[i].embedding = embeddings[i];
      }
    } catch (err) {
      console.warn('Embedding batch failed:', err.message);
    }
    this._embeddingInProgress = false;
  }

  // ─── Core Retrieval (paper Section 4.1) ─────────────────────────
  // Returns top-k memories scored by recency × importance × relevance
  // Uses MIN-MAX NORMALIZATION as specified in the paper
  retrieve(query, count = 10, queryEmbedding = null) {
    if (this.entries.length === 0) return [];

    const qkw = extractKeywords(query);

    // Step 1: Compute raw scores for each memory
    const raw = this.entries.map(entry => {
      const recency    = this._recency(entry);
      const importance = entry.importance / 10;        // already 0-1
      const relevance  = queryEmbedding && entry.embedding
        ? cosineSimilarity(queryEmbedding, entry.embedding)
        : this._relevance(entry, qkw);

      return { entry, recency, importance, relevance };
    });

    // Step 2: Min-max normalize each dimension to [0, 1]
    const recencies   = raw.map(r => r.recency);
    const importances = raw.map(r => r.importance);
    const relevances  = raw.map(r => r.relevance);

    const normRecency   = minMaxNormalize(recencies);
    const normImportance = minMaxNormalize(importances);
    const normRelevance = minMaxNormalize(relevances);

    // Step 3: Weighted combination (α = β = γ = 1, as in the paper)
    const scored = raw.map((r, i) => ({
      entry: r.entry,
      score: normRecency[i] + normImportance[i] + normRelevance[i],
      recency: normRecency[i],
      importance: normImportance[i],
      relevance: normRelevance[i],
    }));

    scored.sort((a, b) => b.score - a.score);

    // Mark top results as accessed (affects future recency)
    const results = scored.slice(0, count);
    const now = Date.now();
    for (const r of results) r.entry.lastAccessed = now;
    return results;
  }

  _recency(entry) {
    // Exponential decay based on GAME HOURS since last access
    // Paper uses 0.995 per game-hour
    const hoursAgo = (Date.now() - entry.lastAccessed) / (60000); // real minutes = game hours (1s = 1min, 60s = 1hr)
    return Math.pow(this.decayFactor, hoursAgo);
  }

  _relevance(entry, queryKeywords) {
    if (queryKeywords.length === 0 || entry.keywords.length === 0) return 0;
    const eSet = new Set(entry.keywords);
    let overlap = 0;
    for (const w of queryKeywords) {
      if (eSet.has(w)) {
        overlap++;
      } else {
        // Partial/stem matching: check if any entry keyword starts with query word or vice versa
        for (const ew of eSet) {
          if ((ew.length > 3 && w.length > 3) && (ew.startsWith(w.substring(0, 4)) || w.startsWith(ew.substring(0, 4)))) {
            overlap += 0.5;
            break;
          }
        }
      }
    }
    // Normalized overlap (geometric mean of set sizes)
    return overlap / Math.sqrt(eSet.size * queryKeywords.length);
  }

  // ─── Accessors ──────────────────────────────────────────────────
  getRecent(count = 20)             { return this.entries.slice(-count); }
  getByType(type, count = 20)       { return this.entries.filter(e => e.type === type).slice(-count); }

  importanceSumSince(timestamp) {
    return this.entries.filter(e => e.createdAt >= timestamp).reduce((s, e) => s + e.importance, 0);
  }

  count()      { return this.entries.length; }
  countByType(type) { return this.entries.filter(e => e.type === type).length; }

  // Compact description for LLM context
  summarize(count = 8) {
    return this.entries.slice(-count).map(e =>
      `[${e.gameTimeCreated || '?'}, ${e.type}] ${e.description}`
    ).join('\n');
  }

  // ─── Pruning ────────────────────────────────────────────────────
  _prune() {
    // Keep reflections + high-importance + recent
    const keep = new Map();
    // Always keep reflections
    for (const e of this.entries) {
      if (e.type === 'reflection') keep.set(e.id, e);
    }
    // Keep high importance
    const byImportance = [...this.entries].sort((a, b) => b.importance - a.importance);
    for (const e of byImportance.slice(0, this.maxEntries * 0.5)) keep.set(e.id, e);
    // Keep recent
    for (const e of this.entries.slice(-Math.floor(this.maxEntries * 0.4))) keep.set(e.id, e);

    this.entries = [...keep.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  // ─── Research Export ────────────────────────────────────────────
  toJSON() {
    return this.entries.map(e => ({
      id: e.id, description: e.description, type: e.type,
      importance: e.importance, gameTime: e.gameTimeCreated, day: e.gameDay,
      keywords: e.keywords, relatedIds: e.relatedIds,
    }));
  }
}

// ─── Min-Max Normalization ───────────────────────────────────────
// Normalizes an array of values to [0, 1] range
function minMaxNormalize(values) {
  if (values.length === 0) return [];
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return values.map(() => 1); // all same value → all 1
  return values.map(v => (v - min) / range);
}

// ═══════════════════════════════════════════════════════════════════
//  Reflection System (paper Section 4.2)
//
//  Triggered when cumulative importance since last reflection
//  exceeds a threshold. Generates higher-level insights by:
//    1. Asking "what are the 3 most salient questions?"
//    2. Retrieving memories relevant to each question
//    3. Synthesizing a reflection from those memories
//    4. Storing reflections back in the memory stream
// ═══════════════════════════════════════════════════════════════════

export class ReflectionSystem {
  constructor(threshold = 100) {
    this.threshold = threshold;
    this.lastReflectionTime = Date.now();
  }

  shouldReflect(stream) {
    return stream.importanceSumSince(this.lastReflectionTime) >= this.threshold;
  }

  async reflect(agent, stream, llm, gameTime) {
    this.lastReflectionTime = Date.now();

    if (!llm.hasAnyKey()) {
      // Offline reflection: create a simple synthesis
      this._offlineReflect(agent, stream, gameTime);
      return;
    }

    // Paper: use 100 most recent memories; we use 30 for context window
    const recentObs = stream.getRecent(30).map(e => e.description);
    if (recentObs.length < 5) return;

    try {
      // Step 1: Generate salient questions (paper Section 4.2)
      const qResult = await llm.generate(
        'You generate introspective questions for a simulation agent. JSON only.',
        `${agent.name} (${agent.occupation}) has had these recent experiences:\n${recentObs.slice(-15).map(d => '- ' + d).join('\n')}\n\nGiven only the information above, what are 3 most salient high-level questions we can answer about the subjects in the statements? Focus on relationships, personal growth, and community dynamics.\nRespond: {"questions":["q1","q2","q3"]}`,
        { json: true, temperature: 0.8, maxTokens: 256 }
      );

      const questions = (qResult.questions || []).slice(0, 3);

      // Step 2: For each question, retrieve relevant memories + synthesize
      for (const question of questions) {
        // Try to embed the question for better retrieval
        let qEmb = null;
        try { if (llm.canEmbed()) qEmb = await llm.embed(question); } catch {}

        const relevant = stream.retrieve(question, 10, qEmb);
        if (relevant.length < 2) continue;

        const rResult = await llm.generate(
          'You synthesize reflections for a simulation agent. JSON only.',
          `Statements about ${agent.name}:\n${relevant.map((r, i) => `${i + 1}. ${r.entry.description}`).join('\n')}\n\nWhat 3 high-level insights can you infer from the above statements? Be specific, personal, and grounded in the memories. Cite which statements support each insight.\nRespond: {"reflections":[{"insight":"text","importance":7,"because":[1,3,5]}]}`,
          { json: true, temperature: 0.7, maxTokens: 400 }
        );

        const reflections = rResult.reflections || (rResult.reflection ? [{ insight: rResult.reflection, importance: rResult.importance || 7 }] : []);
        for (const ref of reflections.slice(0, 3)) {
          if (ref.insight) {
            const entry = stream.add(
              `[Reflection] ${ref.insight}`,
              'reflection',
              Math.min(9, ref.importance || 7),
              gameTime
            );
            entry.relatedIds = (ref.because || []).map(i => relevant[i - 1]?.entry?.id).filter(Boolean);
          }
        }
      }
    } catch (err) {
      console.warn('Reflection failed:', err.message);
      this._offlineReflect(agent, stream, gameTime);
    }
  }

  _offlineReflect(agent, stream, gameTime) {
    // Simple heuristic reflections without LLM
    const dialogues = stream.getByType('dialogue', 5);
    const events = stream.getByType('event', 3);

    if (dialogues.length >= 2) {
      const names = [...new Set(dialogues.map(d => {
        const match = d.description.match(/(?:Talked to|conversation with|talked to me)\s+(\w+)/i);
        return match ? match[1] : null;
      }).filter(Boolean))];
      if (names.length > 0) {
        stream.add(
          `[Reflection] I've been talking with ${names.join(' and ')} recently. These social connections are important to me.`,
          'reflection', 6, gameTime
        );
      }
    }
    if (events.length > 0) {
      stream.add(
        `[Reflection] Recent events in the village have been eventful. I should be more aware of what's happening around me.`,
        'reflection', 5, gameTime
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Importance Rating
//  Rates how memorable/significant an observation is (1-10)
//  Falls back to heuristics when no LLM is available
// ═══════════════════════════════════════════════════════════════════

export async function rateImportance(description, llm, agentContext) {
  // Fast heuristic fallback (always available)
  const heuristic = heuristicImportance(description);

  if (!llm || !llm.hasAnyKey()) return heuristic;

  // ★ Always use LLM when available — personalized importance scoring
  try {
    const agentInfo = agentContext
      ? `This is from the perspective of ${agentContext.name} (${agentContext.occupation}, personality: ${agentContext.personality || 'unknown'}).`
      : '';
    const result = await llm.generate(
      `Rate how memorable/significant this observation is for a specific person in a village simulation.
${agentInfo}
Consider: Would THIS person find this important based on their personality, role, and relationships?
1=completely mundane, 3=mildly interesting, 5=notable event, 7=very significant, 10=life-changing.
JSON: {"importance":N}`,
      description,
      { json: true, temperature: 0.2, maxTokens: 32 }
    );
    return Math.max(1, Math.min(10, result.importance || heuristic));
  } catch {
    return heuristic;
  }
}

function heuristicImportance(text) {
  const t = text.toLowerCase();
  if (/fire|emergency|danger|death|attack|destroy/.test(t)) return 8;
  if (/reflection|realized|understand|insight/.test(t)) return 7;
  if (/election|won|lost|leader|voted|campaign/.test(t)) return 7;
  if (/met|introduced|first time|new person/.test(t)) return 6;
  if (/talked|conversation|discussed|told me/.test(t)) return 5;
  if (/plan|decided|going to|will/.test(t)) return 4;
  if (/walked|saw|noticed|observed/.test(t)) return 3;
  if (/idle|standing|waiting/.test(t)) return 2;
  return 3;
}
