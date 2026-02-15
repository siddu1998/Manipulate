// ═══════════════════════════════════════════════════════════════════
//  Cognitive Architecture for Generative Agents (v3)
//
//  Based on Park et al. (2023) — faithful implementation of:
//    1. Perceive → Retrieve → React-or-Continue → Plan → Act → Reflect
//    2. Turn-by-turn NPC-NPC conversations with per-agent memory retrieval
//    3. Agent Summary Description in every prompt
//    4. Gossip / Information Diffusion (game-time based)
//    5. Recursive plan decomposition (day → hour → 5-15 min)
//    6. Rich seed memories
// ═══════════════════════════════════════════════════════════════════

import { MemoryStream, ReflectionSystem, rateImportance } from './memory.js';
import { AgentEnvironmentKnowledge } from './environment.js';

export class CognitiveArchitecture {
  constructor(npc, world) {
    this.npc = npc;
    this.world = world;

    // ── Memory ──
    this.memory = new MemoryStream(500);
    this.reflection = new ReflectionSystem(100);

    // ── Planning (3-level: day → hour → 5-15 min) ──
    this.dailyPlan = [];          // Level 1: broad day plan (5-8 chunks)
    this.hourlyPlan = [];         // Level 2: hour-long chunks within current broad entry
    this.detailedPlan = [];       // Level 3: 5-15 min chunks within current hourly entry
    this.lastPlanDay = -1;
    this.lastHourlyPlanTime = -1;
    this.lastDetailedPlanTime = -1;

    // ── Perception ──
    this.lastSeenEntities = new Set();
    this.lastSeenEvents = new Set();
    this.spatialMemory = new Map();

    // ── Relationships ──
    this.relationships = new Map();

    // ── Conversation state ──
    this.convCooldowns = new Map();
    this.lastConversationTime = 0;
    this.consecutiveConvFailures = 0;  // Track API failures for backoff

    // ═══ GOSSIP / INFORMATION DIFFUSION ═══
    this.hotTopics = [];
    this.maxHotTopics = 15;

    // ── Environment Knowledge (paper Section 5.1) ──
    this.envKnowledge = new AgentEnvironmentKnowledge(npc.name);

    // ── Action Output (paper Section 3.1.1) ──
    // Natural language description of what the agent is doing right now
    this.actionDescription = `${npc.name} is idle.`;

    // ── Research logging ──
    this.actionLog = [];
    this.infoFlowLog = [];

    // ── Relationship History (timeline of how opinions evolved) ──
    this.relationshipHistory = [];  // [{time, gameTime, target, change, from, to}]
  }

  // ═══════════════════════════════════════════════════════════════
  //  RICH SEED MEMORIES (paper Section 5, "initial memories")
  //
  //  Instead of a single identity line, we seed multiple memories
  //  about identity, relationships, opinions, and world knowledge.
  //  Each semicolon-delimited fact becomes a separate memory.
  // ═══════════════════════════════════════════════════════════════
  seedIdentityMemories(allNpcs, gameTime) {
    const npc = this.npc;

    // Core identity
    this.memory.add(
      `I am ${npc.name}, a ${npc.age}-year-old ${npc.occupation}. ${npc.personality}`,
      'reflection', 9, gameTime
    );

    // Home/workplace knowledge
    if (npc.home) {
      this.memory.add(
        `I live and work at ${npc.home}. This is where I spend most of my time.`,
        'observation', 6, gameTime
      );
    }

    // Seed relationship memories for every known person
    for (const [name, rel] of this.relationships) {
      const otherNpc = allNpcs.find(n => n.name === name);
      if (otherNpc) {
        this.memory.add(
          `I know ${name}, who is a ${otherNpc.occupation}. Our relationship: ${rel.sentiment}.`,
          'reflection', 7, gameTime
        );
      }
    }

    // Knowledge of world locations
    for (const b of this.world.buildings) {
      this.memory.add(
        `I know about ${b.name}, a ${b.type} in the village.`,
        'observation', 3, gameTime
      );
    }
  }

  // Generate richer seed memories using LLM (called once at world creation)
  async generateRichSeedMemories(llm, allNpcs, gameTime) {
    if (!llm.hasAnyKey()) {
      this.seedIdentityMemories(allNpcs, gameTime);
      return;
    }

    const npc = this.npc;
    const knownPeople = [...this.relationships.entries()];
    const otherNpcs = allNpcs.filter(n => n.name !== npc.name);

    try {
      const result = await llm.generate(
        'Generate seed memories for a simulation agent. These are facts the agent knows at the start of the simulation. JSON only.',
        `Character: ${npc.name}, age ${npc.age}, occupation: ${npc.occupation}
Personality: ${npc.personality}
Home/workplace: ${npc.home || 'the village'}

Known relationships:
${knownPeople.map(([name, rel]) => {
  const other = otherNpcs.find(n => n.name === name);
  return `- ${name} (${other?.occupation || 'villager'}): ${rel.sentiment}`;
}).join('\n') || 'None yet'}

Other villagers: ${otherNpcs.filter(n => !this.relationships.has(n.name)).map(n => `${n.name} (${n.occupation})`).join(', ')}

Generate 6-10 seed memories that ${npc.name} would know at the start. Include:
- Facts about their daily routine and work
- Opinions about people they know (specific, not generic)
- Knowledge about the village/community
- A personal goal or aspiration
- Something they recently noticed or are thinking about

Each memory should be 1 sentence, personal, and specific.
{"memories":[{"text":"memory text","importance":5,"type":"reflection|observation"}]}`,
        { json: true, temperature: 0.85, maxTokens: 600 }
      );

      // Seed the core identity first
      this.memory.add(
        `I am ${npc.name}, a ${npc.age}-year-old ${npc.occupation}. ${npc.personality}`,
        'reflection', 9, gameTime
      );

      // Add LLM-generated memories
      for (const mem of (result.memories || [])) {
        this.memory.add(
          mem.text,
          mem.type || 'reflection',
          Math.max(3, Math.min(8, mem.importance || 5)),
          gameTime
        );
      }

      // Still seed basic relationship and location knowledge
      for (const [name, rel] of this.relationships) {
        const otherNpc = allNpcs.find(n => n.name === name);
        if (otherNpc) {
          // Only add if not already covered by LLM memories
          const alreadyCovered = (result.memories || []).some(m =>
            m.text.toLowerCase().includes(name.toLowerCase())
          );
          if (!alreadyCovered) {
            this.memory.add(
              `I know ${name}, who is a ${otherNpc.occupation}. Our relationship: ${rel.sentiment}.`,
              'reflection', 6, gameTime
            );
          }
        }
      }
    } catch (err) {
      console.warn(`Rich seed memories failed for ${npc.name}:`, err.message);
      this.seedIdentityMemories(allNpcs, gameTime);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGENT SUMMARY DESCRIPTION (paper Appendix A)
  //
  //  Dynamically generated summary used in EVERY prompt.
  //  Includes: identity, traits, current plan, key relationships,
  //  and recent experience highlights.
  // ═══════════════════════════════════════════════════════════════
  getAgentSummary(gameTime) {
    const npc = this.npc;

    // Core identity
    let summary = `Name: ${npc.name} (age: ${npc.age})\n`;
    summary += `Occupation: ${npc.occupation}\n`;
    summary += `Innate traits: ${npc.personality}\n`;

    // Current plan
    const currentPlan = this.getCurrentActivity(gameTime);
    if (currentPlan) {
      summary += `Current plan: ${currentPlan.activity} at ${currentPlan.location}\n`;
    }

    // ★ FULL BEHAVIORAL MODEL — exact numerical state drives authentic responses
    if (npc.sim) {
      const s = npc.sim;

      // Needs (0 = satisfied, 1 = desperate)
      summary += `Needs (0=satisfied, 1=desperate): ${Object.entries(s.needs).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(', ')}\n`;

      // Status
      summary += `Status: ${Object.entries(s.status).map(([k, v]) => `${k}:${typeof v === 'number' ? v.toFixed(0) : v}`).join(', ')}\n`;

      // Traits (persistent personality numbers)
      summary += `Personality traits (0-1): ${Object.entries(s.traits).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(', ')}\n`;

      // Skills
      const notableSkills = Object.entries(s.skills).filter(([, v]) => v > 1.5);
      if (notableSkills.length > 0) {
        summary += `Skills: ${notableSkills.map(([k, v]) => `${k}:${v.toFixed(1)}`).join(', ')}\n`;
      }

      // Inventory
      const inv = s.inventory || [];
      if (inv.length > 0) {
        summary += `Inventory: ${inv.map(i => `${i.name} x${i.quantity}`).join(', ')}\n`;
      }

      // Partner / family
      if (s.partner) summary += `Partner: ${s.partner}\n`;
      if (s.children.length > 0) summary += `Children: ${s.children.length}\n`;

      // ★ Dynamic feelings — derived from worldDef needs (not hardcoded need names)
      // Only extreme states generate feeling words to avoid LLM obsessing over one topic
      const feelings = [];
      for (const [needId, val] of Object.entries(s.needs)) {
        if (val > 0.9) feelings.push(`desperate for ${needId}`);
        else if (val > 0.75 && needId !== 'hunger' && needId !== 'rest') feelings.push(`${needId} need is high`);
      }
      // Status-derived feelings (these are universal regardless of worldDef)
      if (s.status.health < 40) feelings.push('feeling unwell');
      if (s.status.happiness < 25) feelings.push('unhappy');
      else if (s.status.happiness > 85) feelings.push('feeling great');
      else if (s.status.happiness > 70) feelings.push('in good spirits');
      if (s.status.energy < 25) feelings.push('low energy');
      if (s.status.wealth < 10) feelings.push('almost broke');
      if (s.status.reputation > 70) feelings.push('confident');
      if (feelings.length > 0) {
        summary += `Current feelings: ${feelings.join(', ')}\n`;
      }
    }

    // ★ MOTIVATIONS — what the agent wants right now
    if (npc._motivationSummary) {
      summary += `Current concerns:\n${npc._motivationSummary}\n`;
    }

    // ★ WORLD AWARENESS — what the agent knows about the state of the world
    if (npc._worldContext) {
      summary += `World situation: ${npc._worldContext}\n`;
    }

    // Key relationships (top 5 by familiarity)
    const rels = [...this.relationships.entries()]
      .sort((a, b) => (b[1].familiarity || 0) - (a[1].familiarity || 0))
      .slice(0, 5);
    if (rels.length > 0) {
      summary += `Key relationships:\n`;
      for (const [name, rel] of rels) {
        summary += `- ${name}: ${rel.sentiment} (met ${rel.interactions} times)\n`;
      }
    }

    // Recent reflections (high-level self-knowledge)
    const reflections = this.memory.getByType('reflection', 3);
    if (reflections.length > 0) {
      summary += `Self-knowledge:\n`;
      for (const r of reflections) {
        summary += `- ${r.description.replace('[Reflection] ', '')}\n`;
      }
    }

    // Current action description
    if (this.actionDescription) {
      summary += `Currently: ${this.actionDescription}\n`;
    }

    // Environment knowledge
    if (this.envKnowledge.currentBuilding) {
      summary += `Location: inside ${this.envKnowledge.currentBuilding}`;
      if (this.envKnowledge.currentRoom) summary += ` (${this.envKnowledge.currentRoom})`;
      summary += '\n';
    }

    return summary;
  }

  // ═══════════════════════════════════════════════════════════════
  //  GOSSIP SYSTEM (game-time based, not real-time)
  //
  //  Hot topics now last for 2 game-days instead of 5 real-minutes.
  //  This allows information to spread realistically over time.
  // ═══════════════════════════════════════════════════════════════
  addHotTopic(topic, source, importance = 6, gameTime = null) {
    // Don't add duplicate topics
    if (this.hotTopics.some(t => t.topic.toLowerCase() === topic.toLowerCase())) return;

    this.hotTopics.push({
      topic,
      source,
      importance,
      gameDay: gameTime?.day || 0,
      gameHour: gameTime?.hours || 0,
      timestamp: Date.now(),  // keep for backward compat
      spreadTo: [],  // track who we've told
    });

    // Keep only recent topics
    if (this.hotTopics.length > this.maxHotTopics) {
      this.hotTopics.shift();
    }

    // Add to memory
    this.memory.add(
      `I heard about "${topic}" from ${source}. This is interesting and worth discussing.`,
      'observation', importance, gameTime
    );
  }

  getActiveHotTopics(gameTime = null) {
    if (!gameTime) {
      // Fallback: use real-time with extended window (30 minutes)
      const thirtyMinutes = 30 * 60 * 1000;
      return this.hotTopics.filter(t => Date.now() - t.timestamp < thirtyMinutes);
    }
    // Game-time based: topics last for 2 game-days
    return this.hotTopics.filter(t => {
      const topicAge = (gameTime.day - (t.gameDay || 0)) * 24 + (gameTime.hours - (t.gameHour || 0));
      return topicAge < 48; // 48 game-hours = 2 game-days
    });
  }

  getUndiscussedTopics(withNpcName, gameTime = null) {
    return this.getActiveHotTopics(gameTime).filter(t => !t.spreadTo.includes(withNpcName));
  }

  markTopicSpreadTo(topic, npcName) {
    const t = this.hotTopics.find(ht => ht.topic === topic);
    if (t) t.spreadTo.push(npcName);
  }

  // ═══════════════════════════════════════════════════════════════
  //  PERCEIVE (paper Section 4.3)
  // ═══════════════════════════════════════════════════════════════
  perceive(nearbyNpcs, nearbyBuildings, worldEvents, gameTime) {
    const observations = [];
    const currentIds = new Set();

    for (const npc of nearbyNpcs) {
      currentIds.add(npc.id);
      if (!this.lastSeenEntities.has(npc.id)) {
        const rel = this.relationships.get(npc.name);
        const familiar = rel && rel.familiarity > 2;
        observations.push({
          text: familiar
            ? `I see ${npc.name}. They are ${npc.currentActivity || 'nearby'}.`
            : `I notice ${npc.name} (${npc.occupation}) nearby.`,
          importance: familiar ? 3 : 4,
        });
      }
    }
    this.lastSeenEntities = currentIds;

    for (const event of worldEvents) {
      if (!this.lastSeenEvents.has(event.id)) {
        this.lastSeenEvents.add(event.id);
        observations.push({
          text: `[EVENT] ${event.description}`,
          importance: event.type === 'fire' ? 9 : 5,
        });
      }
    }

    for (const b of nearbyBuildings) {
      const dist = Math.abs(this.npc.x - b.x) + Math.abs(this.npc.y - b.y);
      if (dist < 4 && !this.spatialMemory.has(b.name)) {
        this.spatialMemory.set(b.name, { x: b.x, y: b.y, type: b.type });
      }
    }

    for (const obs of observations) {
      this.memory.add(obs.text, 'observation', obs.importance, gameTime);
    }
    return observations;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PLAN — 3-Level Recursive Decomposition (paper Section 4.3)
  //
  //  Level 1: Broad day plan (5-8 chunks, e.g. "work 1pm-5pm")
  //  Level 2: Hour-long chunks within current broad entry
  //  Level 3: 5-15 min fine-grained actions within current hourly entry
  // ═══════════════════════════════════════════════════════════════
  async createDailyPlan(llm, gameTime) {
    if (!llm.hasAnyKey()) {
      this.dailyPlan = this._defaultPlan();
      this.lastPlanDay = gameTime.day;
      return;
    }

    const agentSummary = this.getAgentSummary(gameTime);
    const recentMemories = this.memory.summarize(10);
    const buildings = this.world.buildings.map(b => b.name).join(', ');
    const topics = this.getActiveHotTopics(gameTime).map(t => t.topic).join(', ');

    try {
      const result = await llm.generate(
        'Create a realistic daily schedule for a simulation agent. JSON only.',
        `${agentSummary}

${topics ? `Hot topics on their mind: ${topics}` : ''}

Recent memories:
${recentMemories}

Available locations: ${buildings}
${this.world.environmentTree ? `\nWorld layout:\n${this.world.environmentTree.toNaturalLanguage().substring(0, 600)}` : ''}

Today is Day ${gameTime.day}. Create a schedule from 6:00 to 22:00 that feels ALIVE. Include:
- Morning routine and work
- SOCIAL TIME: chatting with neighbors, visiting friends
- Responding to hot topics (if any) — go discuss with people
- Maybe organizing something (a meeting, a gathering, an event)
- Meals, leisure, evening wind-down

Respond with JSON:
{"schedule":[{"time":"HH:MM","duration":60,"activity":"description","location":"building name or outdoors"}]}`,
        { json: true, temperature: 0.85, maxTokens: 1024 }
      );

      this.dailyPlan = (result.schedule || []).map(e => ({
        time: parseTime(e.time),
        duration: e.duration || 60,
        activity: e.activity || 'idle',
        location: e.location || 'outdoors',
      }));

      const summary = this.dailyPlan.slice(0, 5).map(p =>
        `${p.time.h}:${String(p.time.m).padStart(2, '0')} ${p.activity}`
      ).join('; ');
      this.memory.add(`Today's plan: ${summary}...`, 'plan', 4, gameTime);
      this.lastPlanDay = gameTime.day;
    } catch (err) {
      console.warn(`Plan for ${this.npc.name} failed:`, err.message);
      this.dailyPlan = this._defaultPlan();
      this.lastPlanDay = gameTime.day;
    }
  }

  // Level 2: Decompose current broad plan entry into hour-long chunks
  async decomposeToHourlyBlocks(llm, gameTime) {
    const currentPlan = this.getCurrentActivity(gameTime);
    if (!currentPlan || !llm.hasAnyKey()) return;

    const timeKey = currentPlan.time.h * 60 + currentPlan.time.m;
    if (this.lastHourlyPlanTime === timeKey) return; // already decomposed
    this.lastHourlyPlanTime = timeKey;

    try {
      const result = await llm.generate(
        'Decompose a broad activity into hour-long chunks. JSON only.',
        `${this.npc.name} is a ${this.npc.occupation}.
Broad activity: "${currentPlan.activity}" at ${currentPlan.location}
Duration: ${currentPlan.duration} minutes, starting at ${currentPlan.time.h}:${String(currentPlan.time.m).padStart(2, '0')}

Break this into hour-long action chunks. Each chunk should be a specific phase of the activity.
{"blocks":[{"time":"HH:MM","activity":"specific activity for this hour","duration":60}]}`,
        { json: true, temperature: 0.8, maxTokens: 400 }
      );

      this.hourlyPlan = (result.blocks || []).map(b => ({
        time: parseTime(b.time),
        activity: b.activity,
        duration: b.duration || 60,
      }));
    } catch (err) {
      console.warn(`Hourly plan for ${this.npc.name} failed:`, err.message);
      this.hourlyPlan = [];
    }
  }

  // Level 3: Decompose current hourly block into 5-15 minute actions
  async decomposeToDetailedActions(llm, gameTime) {
    const hourlyBlock = this.getCurrentHourlyActivity(gameTime);
    const activity = hourlyBlock || this.getCurrentActivity(gameTime);
    if (!activity || !llm.hasAnyKey()) return;

    const timeKey = (activity.time?.h || 0) * 60 + (activity.time?.m || 0);
    if (this.lastDetailedPlanTime === timeKey) return; // already decomposed
    this.lastDetailedPlanTime = timeKey;

    try {
      const envContext = this.world.environmentTree
        ? `\nAvailable objects/rooms: ${this.world.environmentTree.getBuildingLayout(activity.location || this.npc.home || '')}`
        : '';

      const result = await llm.generate(
        'Decompose an activity into 5-15 minute fine-grained actions. JSON only.',
        `${this.npc.name} is a ${this.npc.occupation}.
Activity: "${activity.activity}" at ${activity.location || 'their location'}
Duration: ${activity.duration || 60} minutes, starting at ${activity.time.h}:${String(activity.time.m).padStart(2, '0')}
${envContext}

Break this into very specific 5-15 minute actions. Include which objects they interact with.
{"steps":[{"time":"HH:MM","action":"specific action (e.g. 'pick up mixing bowl and start kneading dough')","duration":10,"object":"object name or null"}]}`,
        { json: true, temperature: 0.8, maxTokens: 500 }
      );

      this.detailedPlan = (result.steps || []).map(s => ({
        time: parseTime(s.time),
        action: s.action,
        duration: s.duration || 10,
        object: s.object || null,
      }));
    } catch (err) {
      console.warn(`Detailed plan for ${this.npc.name} failed:`, err.message);
      this.detailedPlan = [];
    }
  }

  getCurrentHourlyActivity(gameTime) {
    if (this.hourlyPlan.length === 0) return null;
    const now = gameTime.hours * 60 + gameTime.minutes;
    let best = null;
    for (const entry of this.hourlyPlan) {
      const t = entry.time.h * 60 + entry.time.m;
      if (t <= now) best = entry;
    }
    return best;
  }

  getCurrentDetailedActivity(gameTime) {
    if (this.detailedPlan.length === 0) return null;
    const now = gameTime.hours * 60 + gameTime.minutes;
    let best = null;
    for (const entry of this.detailedPlan) {
      const t = entry.time.h * 60 + entry.time.m;
      if (t <= now) best = entry;
    }
    return best;
  }

  needsPlan(gameTime) { return this.lastPlanDay !== gameTime.day; }

  getCurrentActivity(gameTime) {
    const now = gameTime.hours * 60 + gameTime.minutes;
    let best = null;
    for (const entry of this.dailyPlan) {
      const t = entry.time.h * 60 + entry.time.m;
      if (t <= now) best = entry;
    }
    return best;
  }

  _defaultPlan() {
    const n = this.npc, home = n.home || 'home';
    return [
      { time: {h:6,m:0}, duration:60, activity:'Wake up and prepare for the day', location: home },
      { time: {h:7,m:0}, duration:120, activity:`Work as a ${n.occupation}`, location: home },
      { time: {h:9,m:0}, duration:60, activity:'Walk around town and chat with neighbors', location:'outdoors' },
      { time: {h:10,m:0}, duration:120, activity:`Continue ${n.occupation} duties`, location: home },
      { time: {h:12,m:0}, duration:60, activity:'Lunch break, socialize', location: home },
      { time: {h:13,m:0}, duration:120, activity:'Visit neighbors and discuss news', location:'outdoors' },
      { time: {h:15,m:0}, duration:120, activity:'Social time in the village center', location:'outdoors' },
      { time: {h:17,m:0}, duration:60, activity:'Dinner', location: home },
      { time: {h:18,m:0}, duration:120, activity:'Evening gathering or leisure', location: home },
      { time: {h:20,m:0}, duration:120, activity:'Wind down, rest', location: home },
    ];
  }

  // ═══════════════════════════════════════════════════════════════
  //  REACT OR CONTINUE (paper Section 4.3.1)
  //
  //  At each perception step, if the agent sees something notable,
  //  the LLM decides: continue current plan, or react?
  //  This is what makes agents feel aware and responsive.
  // ═══════════════════════════════════════════════════════════════
  async shouldReactToObservation(observation, llm, gameTime) {
    if (!llm.hasAnyKey()) return null;

    const currentPlan = this.getCurrentActivity(gameTime);
    if (!currentPlan) return null;

    // Only consider notable observations (importance >= 5)
    // Mundane observations (seeing a tree, walking) shouldn't trigger reactions
    if (!observation || observation.importance < 5) return null;

    const agentSummary = this.getAgentSummary(gameTime);

    // Retrieve context relevant to the observation
    let obsEmbedding = null;
    try { if (llm.canEmbed()) obsEmbedding = await llm.embed(observation.text); } catch {}
    const relevantMems = this.memory.retrieve(observation.text, 5, obsEmbedding);
    const context = relevantMems.map(r => r.entry.description).join('\n');

    try {
      const result = await llm.generate(
        'You decide if an NPC should react to an observation or continue their plan. JSON only.',
        `${agentSummary}
It is Day ${gameTime.day}, ${gameTime.hours}:${String(gameTime.minutes).padStart(2, '0')}.
${this.npc.name}'s current plan: ${currentPlan.activity} at ${currentPlan.location}

Observation: ${observation.text}

Relevant context from ${this.npc.name}'s memory:
${context || 'No relevant memories.'}

Should ${this.npc.name} react to this observation, or continue with their current plan?
If reacting, what would be an appropriate reaction?

{"react": true/false, "reason": "brief reason", "reaction": "what they would do", "speech": "what they might say (or null)"}`,
        { json: true, temperature: 0.7, maxTokens: 200 }
      );

      if (result.react) {
        return {
          reaction: result.reaction || 'investigate',
          speech: result.speech || null,
          reason: result.reason || '',
          shouldReplan: true, // Signal to regenerate plan from this point
        };
      }
    } catch (err) {
      console.warn('React-or-continue check failed:', err.message);
    }
    return null;
  }

  // Full plan regeneration from the current time forward (paper Section 4.3.1)
  // Called when an agent reacts to an observation and needs to replan
  async regeneratePlanFromNow(llm, gameTime, reactionContext) {
    if (!llm.hasAnyKey()) return;

    const agentSummary = this.getAgentSummary(gameTime);
    const buildings = this.world.buildings.map(b => b.name).join(', ');
    const nowMinutes = gameTime.hours * 60 + gameTime.minutes;

    // Keep plan entries that already happened today
    const pastPlan = this.dailyPlan.filter(e => {
      const t = e.time.h * 60 + e.time.m;
      return t < nowMinutes;
    });

    const pastSummary = pastPlan.map(p =>
      `${p.time.h}:${String(p.time.m).padStart(2, '0')} - ${p.activity}`
    ).join('\n');

    try {
      const result = await llm.generate(
        'Regenerate an agent\'s daily plan from the current time onward. JSON only.',
        `${agentSummary}

It is currently ${gameTime.hours}:${String(gameTime.minutes).padStart(2, '0')} on Day ${gameTime.day}.
${reactionContext ? `${this.npc.name} just reacted to something: ${reactionContext}` : ''}

What they already did today:
${pastSummary || 'Nothing yet.'}

Available locations: ${buildings}

Regenerate the rest of ${this.npc.name}'s day from NOW until 22:00. Account for what just happened.
{"schedule":[{"time":"HH:MM","duration":60,"activity":"description","location":"building name or outdoors"}]}`,
        { json: true, temperature: 0.85, maxTokens: 800 }
      );

      const newEntries = (result.schedule || []).map(e => ({
        time: parseTime(e.time),
        duration: e.duration || 60,
        activity: e.activity || 'idle',
        location: e.location || 'outdoors',
      }));

      // Merge: keep past plan entries, replace future with new ones
      this.dailyPlan = [...pastPlan, ...newEntries];
      // Reset sub-plans since the plan changed
      this.hourlyPlan = [];
      this.detailedPlan = [];
      this.lastHourlyPlanTime = -1;
      this.lastDetailedPlanTime = -1;

      this.memory.add(
        `I changed my plans because: ${reactionContext || 'something came up'}. New plan from ${gameTime.hours}:${String(gameTime.minutes).padStart(2, '0')}: ${newEntries.slice(0, 3).map(e => e.activity).join('; ')}...`,
        'plan', 5, gameTime
      );
    } catch (err) {
      console.warn(`Plan regeneration for ${this.npc.name} failed:`, err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  DECIDE & ACT
  // ═══════════════════════════════════════════════════════════════
  async decide(llm, gameTime, nearbyNpcs, worldEvents) {
    // Priority 1: Urgent events
    const urgentEvent = worldEvents.find(e => {
      const dist = Math.abs(e.x - this.npc.x) + Math.abs(e.y - this.npc.y);
      return dist < 15 && e.type === 'fire' && this.npc.state !== 'fleeing';
    });
    if (urgentEvent) return { type: 'react_event', event: urgentEvent };

    // Priority 2: Following / leading
    if (this.npc.state === 'following' || this.npc.state === 'leading') return { type: 'continue' };

    // Priority 3: Conversation — HIGH PRIORITY when has gossip
    const convPartner = this._shouldConverse(nearbyNpcs, gameTime);
    if (convPartner) return { type: 'converse', target: convPartner };

    // Priority 4: Follow daily plan
    const planEntry = this.getCurrentActivity(gameTime);
    if (planEntry) return { type: 'follow_plan', plan: planEntry };

    return { type: 'wander' };
  }

  async executeDecision(decision, llm, gameTime) {
    const npc = this.npc;

    switch (decision.type) {
      case 'react_event': {
        const ev = decision.event;
        this.memory.add(`URGENT: ${ev.description}!`, 'event', 9, gameTime);
        // Add as hot topic so NPCs gossip about it
        this.addHotTopic(ev.description, 'witnessed', 8, gameTime);

        if (llm.hasAnyKey()) {
          try {
            const result = await llm.generate(
              'NPC emergency reaction. JSON only.',
              `${npc.name} (${npc.occupation}) witnesses: ${ev.description}. How do they react?\n{"reaction":"flee"|"help"|"investigate","speech":"what they shout"}`,
              { json: true, temperature: 0.8, maxTokens: 128 }
            );
            if (result.speech) npc.say(result.speech, 5000);
            if (result.reaction === 'flee') npc.fleeFrom(ev.x, ev.y, this.world);
            else if (result.reaction === 'help') {
              const water = this.world.buildings.find(b => /well|river|pond|fountain/i.test(b.name));
              if (water) { npc.goToBuilding(water, this.world); npc.say(`Getting water from ${water.name}!`, 4000); }
              else npc.fleeFrom(ev.x, ev.y, this.world);
            }
          } catch { npc.say('Oh no!', 3000); npc.fleeFrom(ev.x, ev.y, this.world); }
        } else {
          npc.say('Fire! Everyone run!', 4000);
          npc.fleeFrom(ev.x, ev.y, this.world);
        }
        break;
      }

      case 'converse':
        // Handled externally by app.js (returns conversation data for the feed)
        return { conversationTarget: decision.target };

      case 'follow_plan': {
        const plan = decision.plan;
        // Use finest available plan level (3 → 2 → 1)
        const detailed = this.getCurrentDetailedActivity(gameTime);
        const hourly = this.getCurrentHourlyActivity(gameTime);
        const activityText = detailed ? detailed.action : (hourly ? hourly.activity : plan.activity);
        npc.currentActivity = activityText;

        // ★ Generate action description (paper Section 3.1.1)
        this.actionDescription = `${npc.name} is ${activityText.toLowerCase()}.`;

        // ★ Handle object interactions from detailed plan
        if (detailed?.object && this.world.environmentTree) {
          const building = this.world.buildings.find(b =>
            b.name.toLowerCase().includes(plan.location.toLowerCase()) ||
            plan.location.toLowerCase().includes(b.name.toLowerCase())
          );
          if (building) {
            // Update agent's environment knowledge
            this.envKnowledge.enterBuilding(building.name, this.world.environmentTree);
          }
        }

        if (npc.state === 'idle' && plan.location !== 'outdoors') {
          const building = this.world.buildings.find(b =>
            b.name.toLowerCase().includes(plan.location.toLowerCase()) ||
            plan.location.toLowerCase().includes(b.name.toLowerCase())
          );
          if (building) {
            const doorX = building.x + (building.w >> 1);
            const doorY = building.y + building.h + 1;
            if (Math.abs(npc.x - doorX) + Math.abs(npc.y - doorY) > 3) {
              npc.goToBuilding(building, this.world);
            }
          }
        }
        break;
      }

      case 'wander':
        if (npc.state === 'idle') {
          const target = this.world.randomWalkable(npc.x, npc.y, 6);
          const path = this.world.findPath(npc.x, npc.y, target.x, target.y);
          if (path && path.length > 0) { npc.path = path; npc.pathIndex = 0; npc.state = 'walking'; }
        }
        break;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TURN-BY-TURN NPC ↔ NPC CONVERSATIONS (paper Section 4.3.2)
  //
  //  Instead of generating the entire conversation in one LLM call,
  //  each agent independently retrieves memories and generates
  //  their own utterance, just like in the paper.
  //
  //  Flow:
  //  1. Both agents build context from their own memories
  //  2. Agent A speaks (LLM call with A's memories)
  //  3. Agent B responds (LLM call with B's memories + dialogue so far)
  //  4. Repeat for 2-3 rounds
  //  5. Both agents store the FULL conversation in memory
  // ═══════════════════════════════════════════════════════════════
  _shouldConverse(nearbyNpcs, gameTime) {
    if (Date.now() - this.lastConversationTime < 10000) return null; // 10s personal cooldown

    for (const other of nearbyNpcs) {
      if (other.state === 'talking' || other.state === 'following' || other.state === 'leading') continue;
      if (this.npc.distanceTo(other) > 8) continue; // 8 tile range

      const cd = this.convCooldowns.get(other.id);
      if (cd && Date.now() - cd < 60000) continue; // 60s per-person cooldown

      const rel = this.relationships.get(other.name);
      const familiarity = rel ? rel.familiarity : 0;

      // ★ High base chance — villagers WANT to talk
      const undiscussed = this.getUndiscussedTopics(other.name, gameTime);
      let chance = familiarity > 3 ? 0.5 : 0.3;    // 30-50% base chance
      if (undiscussed.length > 0) chance += 0.3;     // Gossip boost

      if (Math.random() < chance) {
        this.convCooldowns.set(other.id, Date.now());
        this.lastConversationTime = Date.now();
        return other;
      }
    }
    return null;
  }

  // Generate a turn-by-turn conversation between this NPC and another
  async generateConversation(otherNpc, llm, gameTime) {
    const npc = this.npc;
    const otherCog = otherNpc.cognition;

    // ── Phase 1: Context Building (no LLM calls) ──
    const myGossip = this.getUndiscussedTopics(otherNpc.name, gameTime);
    const theirGossip = otherCog ? otherCog.getUndiscussedTopics(npc.name, gameTime) : [];

    // ★ BROADENED RETRIEVAL: query by person name + current situation + recent events
    // This prevents the "hey remember" problem by surfacing present-tense context
    const myCurrentContext = npc.currentActivity || '';
    const myRecentObs = this.memory.getByType('observation', 3).map(e => e.description).join(' ');
    const myQuery = `${otherNpc.name} ${myCurrentContext} ${myRecentObs}`.substring(0, 200);
    const myMemoriesAboutThem = this.memory.retrieve(myQuery, 5).map(r => r.entry.description);

    const theirCurrentContext = otherNpc.currentActivity || '';
    const theirRecentObs = otherCog ? otherCog.memory.getByType('observation', 3).map(e => e.description).join(' ') : '';
    const theirQuery = `${npc.name} ${theirCurrentContext} ${theirRecentObs}`.substring(0, 200);
    const theirMemoriesAboutMe = otherCog
      ? otherCog.memory.retrieve(theirQuery, 5).map(r => r.entry.description)
      : [];

    // Build the conversation data structure
    const conversationData = {
      speaker1: npc.name,
      speaker2: otherNpc.name,
      lines: [],
      topic: 'greeting',
      location: this._nearestBuildingName(),
      gameTime: `${gameTime.hours}:${String(gameTime.minutes).padStart(2, '0')}`,
    };

    if (!llm.hasAnyKey()) {
      return this._offlineConversation(npc, otherNpc, myGossip, theirGossip, conversationData, gameTime);
    }

    // ★ Adaptive turn count: reduce turns when API has been failing
    const baseTurns = 8;
    const adaptiveTurns = this.consecutiveConvFailures > 3
      ? 2  // minimal conversation when API is stressed
      : this.consecutiveConvFailures > 1
        ? 4  // reduced conversation
        : baseTurns;

    try {
      const dialogueHistory = [];
      const maxTurns = adaptiveTurns;
      let conversationTopic = '';
      let bondChange = 'neutral';
      let turnFailures = 0; // track per-turn failures within this conversation

      for (let turn = 0; turn < maxTurns; turn++) {
        // ── Agent A speaks ──
        let aUtterance;
        try {
          aUtterance = await this._generateUtterance(
            npc, otherNpc,
            this.getAgentSummary(gameTime),
            myMemoriesAboutThem,
            myGossip.map(g => g.topic),
            dialogueHistory,
            turn === 0, // isInitiator
            llm, gameTime
          );
        } catch (turnErr) {
          console.warn(`Conv turn ${turn}A failed:`, turnErr.message);
          turnFailures++;
          if (turnFailures >= 2 || dialogueHistory.length === 0) break; // give up after 2 turn failures
          continue; // skip this turn, try next
        }

        if (!aUtterance || !aUtterance.text) break;
        dialogueHistory.push({ speaker: npc.name, text: aUtterance.text });
        conversationData.lines.push({ speaker: npc.name, text: aUtterance.text });
        if (aUtterance.topic) conversationTopic = aUtterance.topic;

        // Show speech bubble with staggered timing
        const aDelay = turn * 6000;
        setTimeout(() => npc.say(aUtterance.text, 4500), aDelay);

        if (aUtterance.end) break;

        // ── Agent B speaks ──
        let bUtterance;
        try {
          const bSummary = otherCog ? otherCog.getAgentSummary(gameTime) : `${otherNpc.name}, ${otherNpc.occupation}`;
          bUtterance = await this._generateUtterance(
            otherNpc, npc,
            bSummary,
            theirMemoriesAboutMe,
            theirGossip.map(g => g.topic),
            dialogueHistory,
            false, // not initiator
            llm, gameTime
          );
        } catch (turnErr) {
          console.warn(`Conv turn ${turn}B failed:`, turnErr.message);
          turnFailures++;
          if (turnFailures >= 2) break;
          continue;
        }

        if (!bUtterance || !bUtterance.text) break;
        dialogueHistory.push({ speaker: otherNpc.name, text: bUtterance.text });
        conversationData.lines.push({ speaker: otherNpc.name, text: bUtterance.text });
        if (bUtterance.topic) conversationTopic = bUtterance.topic;
        if (bUtterance.bond) bondChange = bUtterance.bond;

        setTimeout(() => otherNpc.say(bUtterance.text, 4500), aDelay + 3000);

        if (bUtterance.end) break;
      }

      // ★ If we got at least 1 real line, count it as a success (reset failure counter)
      if (dialogueHistory.length > 0) {
        this.consecutiveConvFailures = Math.max(0, this.consecutiveConvFailures - 1);
        conversationData.topic = conversationTopic || 'small talk';
      } else {
        // No lines at all — treat as failure but still do offline fallback below
        throw new Error('No dialogue generated');
      }

      // ── Phase 3: Post-conversation updates ──
      // Store FULL conversation text in BOTH agents' memories (no truncation!)
      const fullDialogue = dialogueHistory.map(l => `${l.speaker}: ${l.text}`).join('\n');
      const dialogueSummary = `Conversation with ${otherNpc.name} about ${conversationData.topic}:\n${fullDialogue}`;
      const otherDialogueSummary = `Conversation with ${npc.name} about ${conversationData.topic}:\n${fullDialogue}`;

      this.memory.add(dialogueSummary, 'dialogue', 6, gameTime);
      if (otherCog) {
        otherCog.memory.add(otherDialogueSummary, 'dialogue', 6, gameTime);
        otherCog._updateRelationship(npc.name, bondChange);
      }
      this._updateRelationship(otherNpc.name, bondChange);

      // ★ GOSSIP DIFFUSION: spread hot topics to the other NPC
      for (const topic of myGossip) {
        this.markTopicSpreadTo(topic.topic, otherNpc.name);
        if (otherCog) {
          otherCog.addHotTopic(topic.topic, npc.name, Math.max(4, topic.importance - 1), gameTime);
        }
      }
      for (const topic of theirGossip) {
        if (otherCog) otherCog.markTopicSpreadTo(topic.topic, npc.name);
        this.addHotTopic(topic.topic, otherNpc.name, Math.max(4, topic.importance - 1), gameTime);
      }

      // Track info flow
      if (conversationData.topic) {
        this.infoFlowLog.push({
          from: npc.name, to: otherNpc.name, topic: conversationData.topic,
          time: Date.now(), gameTime: conversationData.gameTime,
        });
      }

    } catch (err) {
      console.warn('Conversation failed:', err.message);
      this.consecutiveConvFailures++;

      // ★ RICH FALLBACK instead of boring "Hey/Hi" — use context-aware offline conversation
      return this._offlineConversation(npc, otherNpc, myGossip, theirGossip, conversationData, gameTime);
    }

    this._logAction('conversation', { with: otherNpc.name, topic: conversationData.topic }, gameTime);
    return conversationData;
  }

  // Generate a single utterance for one agent in a conversation
  async _generateUtterance(speaker, listener, speakerSummary, memoriesAboutListener, gossipTopics, dialogueHistory, isInitiator, llm, gameTime) {
    // ★ FULL RELATIONSHIP CONTEXT — exact numerical values, not just a label
    const cogRel = speaker.cognition?.relationships?.get(listener.name);
    const simRel = speaker.simRelationships?.get(listener.name);
    let relDesc = '';
    if (simRel) {
      relDesc = `${speaker.name}'s relationship with ${listener.name}: trust:${simRel.trust.toFixed(2)}, attraction:${simRel.attraction.toFixed(2)}, respect:${simRel.respect.toFixed(2)}, familiarity:${simRel.familiarity.toFixed(2)}, fear:${simRel.fear.toFixed(2)}, rivalry:${simRel.rivalry.toFixed(2)}, label:"${simRel.label}", interactions:${simRel.interactions}`;
    } else if (cogRel) {
      relDesc = `${speaker.name} and ${listener.name} are ${cogRel.sentiment}s (met ${cogRel.interactions} times).`;
    } else {
      relDesc = `${speaker.name} barely knows ${listener.name}.`;
    }

    // ★ LISTENER CONTEXT — what the speaker can observe (worldDef-driven, not hardcoded)
    let listenerContext = `${listener.name} (${listener.occupation})`;
    if (listener.sim) {
      const ls = listener.sim;
      const lFeelings = [];
      // Dynamic: check all needs at critical threshold
      for (const [needId, val] of Object.entries(ls.needs)) {
        if (val > 0.85) lFeelings.push(`looks ${needId === 'rest' ? 'tired' : needId === 'hunger' ? 'hungry' : 'stressed about ' + needId}`);
      }
      if (ls.status.happiness < 30) lFeelings.push('seems unhappy');
      else if (ls.status.happiness > 75) lFeelings.push('seems cheerful');
      if (ls.partner) listenerContext += `, partner: ${ls.partner}`;
      if (lFeelings.length) listenerContext += ` — ${lFeelings.join(', ')}`;
    }
    if (listener.currentActivity) listenerContext += `. Currently: ${listener.currentActivity}`;

    // ★ LAST CONVERSATION — what they talked about last time
    let lastConvStr = '';
    if (speaker.cognition) {
      const pastConvMemories = speaker.cognition.memory.entries
        .filter(e => e.type === 'dialogue' && e.description.toLowerCase().includes(listener.name.toLowerCase()))
        .slice(-2);
      if (pastConvMemories.length > 0) {
        lastConvStr = `Previous conversations with ${listener.name}:\n${pastConvMemories.map(m => '- ' + m.description).join('\n')}`;
      }
    }

    const dialogueStr = dialogueHistory.length > 0
      ? `Dialogue so far:\n${dialogueHistory.map(l => `${l.speaker}: ${l.text}`).join('\n')}`
      : '';

    const gossipStr = gossipTopics.length > 0
      ? `${speaker.name} has heard news they want to share: "${gossipTopics.join('", "')}" — bring this up naturally.`
      : '';

    const memoryStr = memoriesAboutListener.length > 0
      ? `What ${speaker.name} knows or has experienced recently:\n${memoriesAboutListener.map(m => '- ' + m).join('\n')}`
      : '';

    // ★ PRESENT-TENSE CONTEXT: what the speaker just saw, their recent observations (exclude hunger/rest alerts so conversation isn't always about food)
    let recentContext = '';
    if (speaker.cognition) {
      const rawObs = speaker.cognition.memory.getByType('observation', 5);
      const recentObs = rawObs.filter(o => {
        const d = (o.description || '').toLowerCase();
        return !d.includes('really hungry') && !d.includes('find food soon') && !d.includes('need to rest') && !d.includes('exhausted');
      }).slice(0, 3);
      if (recentObs.length > 0) {
        recentContext = `What ${speaker.name} has noticed recently:\n${recentObs.map(o => '- ' + o.description).join('\n')}`;
      }
    }

    const prompt = `${speakerSummary}
It is Day ${gameTime.day}, ${gameTime.hours}:${String(gameTime.minutes).padStart(2, '0')}.
${relDesc}
Talking to: ${listenerContext}

${memoryStr}

${lastConvStr}

${recentContext}

${gossipStr}

${dialogueStr}

${isInitiator
    ? `${speaker.name} bumps into ${listener.name}. What would ${speaker.name} say?`
    : `What would ${speaker.name} say in response?`}

Rules:
- 1-2 sentences only. Sound like a REAL person, not an AI.
- Use contractions, fragments, casual speech. No "Greetings" or "How wonderful".
- Your response MUST be shaped by your personality traits and emotional state. A lonely person is warmer. A rivalrous person is prickly.

TOPIC SELECTION (IMPORTANT — follow this priority):
1. If you have GOSSIP or NEWS to share, lead with that (30% of conversations should be gossip)
2. Talk about your WORK, occupation, craft, or what you're currently doing (25%)
3. Discuss RELATIONSHIPS — ask about someone, comment on a couple, mention your own feelings toward people (20%)
4. Share OPINIONS about village life, the leader, events, or the future (15%)
5. Mention personal NEEDS only if truly desperate (hunger > 0.9, rest > 0.9) — otherwise NEVER talk about food or sleep (10%)

- Do NOT talk about food, eating, or hunger unless your hunger need is above 0.9. People don't constantly discuss meals.
- Consider your RELATIONSHIP numbers: high trust means openness, high rivalry means tension, high attraction means flirting, low familiarity means small talk.
- Reference previous conversations with this person if relevant — continuity matters.
- You can ask questions, share opinions, complain, joke, argue, confess, propose, threaten, or reconcile.
- React genuinely to what the other person says and what you observe about them.
- If the conversation has reached a natural endpoint, set "end" to true.

Respond as JSON: {"text":"what they say","topic":"main topic (1-2 words)","bond":"closer|neutral|tension","end":false}`;

    const result = await llm.generate(
      `You are ${speaker.name}. Generate ONE line of dialogue. JSON only.`,
      prompt,
      { json: true, temperature: 0.9, maxTokens: 200 }
    );

    return {
      text: result.text || '',
      topic: result.topic || '',
      bond: result.bond || 'neutral',
      end: result.end || false,
    };
  }

  // Offline/demo conversation — ★ Much richer with context-aware dialogue
  _offlineConversation(npc, otherNpc, myGossip, theirGossip, conversationData, gameTime) {
    const activity1 = npc.currentActivity?.toLowerCase() || npc.occupation?.toLowerCase() || 'working';
    const activity2 = otherNpc.currentActivity?.toLowerCase() || otherNpc.occupation?.toLowerCase() || 'working';
    const rel = this.relationships.get(otherNpc.name);
    const familiar = rel && rel.familiarity > 3;
    const timeOfDay = gameTime.hours < 12 ? 'morning' : gameTime.hours < 17 ? 'afternoon' : 'evening';

    // Build a pool of conversation templates based on context
    const templates = [];

    // ── Gossip-based (highest priority — there's news to share) ──
    if (myGossip.length > 0) {
      const topic = myGossip[0].topic;
      templates.push({
        lines: [
          { speaker: npc.name, text: `${otherNpc.name}, have you heard? ${topic}` },
          { speaker: otherNpc.name, text: `No! Tell me more about that.` },
          { speaker: npc.name, text: `It's been the talk of the town. I'm still not sure what to make of it.` },
          { speaker: otherNpc.name, text: `Hmm, that's interesting. I'll keep my ears open.` },
        ],
        topic: 'gossip',
      });
      templates.push({
        lines: [
          { speaker: npc.name, text: `You won't believe what I just heard — ${topic}` },
          { speaker: otherNpc.name, text: `Seriously? That's wild.` },
          { speaker: npc.name, text: `I know, right? Things are getting interesting around here.` },
        ],
        topic: 'gossip',
      });
    }
    if (theirGossip.length > 0) {
      const topic = theirGossip[0].topic;
      templates.push({
        lines: [
          { speaker: otherNpc.name, text: `${npc.name}! I've been wanting to tell someone — ${topic}` },
          { speaker: npc.name, text: `Wait, really? How do you know about that?` },
          { speaker: otherNpc.name, text: `Word gets around. I thought you should know.` },
        ],
        topic: 'gossip',
      });
    }

    // ── Activity/work-based ──
    templates.push({
      lines: [
        { speaker: npc.name, text: `Hey ${otherNpc.name}, busy with ${activity2}?` },
        { speaker: otherNpc.name, text: `Yeah, it never ends. How about you? Still ${activity1}?` },
        { speaker: npc.name, text: `Always. But I don't mind — keeps me out of trouble.` },
        { speaker: otherNpc.name, text: `Ha! Trouble has a way of finding people regardless.` },
      ],
      topic: 'work',
    });

    // ── Relationship-aware ──
    if (familiar) {
      templates.push({
        lines: [
          { speaker: npc.name, text: `${otherNpc.name}! Good to see a friendly face this ${timeOfDay}.` },
          { speaker: otherNpc.name, text: `You too, ${npc.name}. It's been a long day.` },
          { speaker: npc.name, text: `Tell me about it. Want to grab something to eat later?` },
          { speaker: otherNpc.name, text: `I'd like that. Let's do it.` },
        ],
        topic: 'catching up',
      });
      templates.push({
        lines: [
          { speaker: npc.name, text: `I've been meaning to ask you something, ${otherNpc.name}.` },
          { speaker: otherNpc.name, text: `Oh? What's on your mind?` },
          { speaker: npc.name, text: `Do you think things are going well around here? I feel like something's... off.` },
          { speaker: otherNpc.name, text: `I know what you mean. There's been a strange mood lately.` },
        ],
        topic: 'concerns',
      });
    } else {
      templates.push({
        lines: [
          { speaker: npc.name, text: `Good ${timeOfDay}, ${otherNpc.name}. I don't think we've talked much.` },
          { speaker: otherNpc.name, text: `No, we haven't! I'm usually busy with ${activity2}. What do you do?` },
          { speaker: npc.name, text: `I'm a ${npc.occupation}. Keeps me on my feet.` },
          { speaker: otherNpc.name, text: `Sounds like it! Maybe we'll cross paths more often.` },
        ],
        topic: 'introduction',
      });
    }

    // ── Needs-based (if someone is hungry, tired, etc.) ──
    if (npc.sim?.needs?.hunger > 0.7) {
      templates.push({
        lines: [
          { speaker: npc.name, text: `I'm starving. Is there anywhere good to eat around here?` },
          { speaker: otherNpc.name, text: `The market usually has something. Want me to show you?` },
          { speaker: npc.name, text: `That'd be great, thanks.` },
        ],
        topic: 'food',
      });
    }
    if (npc.sim?.status?.happiness < 35) {
      templates.push({
        lines: [
          { speaker: npc.name, text: `I've had a rough day, ${otherNpc.name}.` },
          { speaker: otherNpc.name, text: `I'm sorry to hear that. Want to talk about it?` },
          { speaker: npc.name, text: `Maybe later. Just nice to see someone who cares.` },
        ],
        topic: 'venting',
      });
    }

    // ── Time-of-day ──
    if (gameTime.hours >= 19) {
      templates.push({
        lines: [
          { speaker: npc.name, text: `Long day, huh? The ${timeOfDay} air feels nice though.` },
          { speaker: otherNpc.name, text: `It does. Quiet nights like this are rare.` },
          { speaker: npc.name, text: `Enjoy it while it lasts. Tomorrow will be busy again.` },
        ],
        topic: 'evening chat',
      });
    }
    if (gameTime.hours < 9) {
      templates.push({
        lines: [
          { speaker: npc.name, text: `Up early, ${otherNpc.name}?` },
          { speaker: otherNpc.name, text: `Always. ${otherNpc.occupation} work doesn't wait.` },
          { speaker: npc.name, text: `I respect the hustle. Good luck today.` },
        ],
        topic: 'morning routine',
      });
    }

    // ── General variety (always available) ──
    templates.push({
      lines: [
        { speaker: npc.name, text: `What do you make of everything that's been happening lately?` },
        { speaker: otherNpc.name, text: `Honestly? I'm not sure. Feels like things are changing.` },
        { speaker: npc.name, text: `Change isn't always bad. We'll see how it goes.` },
        { speaker: otherNpc.name, text: `That's a good way to look at it.` },
      ],
      topic: 'village life',
    });
    templates.push({
      lines: [
        { speaker: otherNpc.name, text: `${npc.name}! Just the person I was hoping to run into.` },
        { speaker: npc.name, text: `Oh? What's up?` },
        { speaker: otherNpc.name, text: `Nothing urgent — I just wanted some company for a bit.` },
        { speaker: npc.name, text: `I could use that too. Walk with me?` },
      ],
      topic: 'socializing',
    });

    // Pick one template — prefer gossip/context-heavy ones
    const chosen = templates[Math.floor(Math.random() * templates.length)];

    // Show speech bubbles with staggered timing
    chosen.lines.forEach((line, i) => {
      const speaker = line.speaker === npc.name ? npc : otherNpc;
      setTimeout(() => speaker.say(line.text, 3500), i * 2500);
    });

    conversationData.lines = chosen.lines;
    conversationData.topic = chosen.topic;

    // Spread gossip even in offline mode
    for (const topic of myGossip) {
      this.markTopicSpreadTo(topic.topic, otherNpc.name);
      if (otherNpc.cognition) otherNpc.cognition.addHotTopic(topic.topic, npc.name, 5, gameTime);
    }
    for (const topic of theirGossip) {
      if (otherNpc.cognition) otherNpc.cognition.markTopicSpreadTo(topic.topic, npc.name);
      this.addHotTopic(topic.topic, otherNpc.name, 5, gameTime);
    }

    this.memory.add(`Chatted with ${otherNpc.name} about ${chosen.topic}.`, 'dialogue', 4, gameTime);
    if (otherNpc.cognition) {
      otherNpc.cognition.memory.add(`Chatted with ${npc.name} about ${chosen.topic}.`, 'dialogue', 4, gameTime);
    }
    return conversationData;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PLAYER CONVERSATION PROMPT (with Agent Summary)
  // ═══════════════════════════════════════════════════════════════
  getPlayerConversationPrompt(worldName, gameTime) {
    const npc = this.npc;
    const agentSummary = this.getAgentSummary(gameTime || { hours: new Date().getHours(), minutes: new Date().getMinutes(), day: 1 });

    // Retrieve ALL recent memories — not just player-related ones
    const recentMems = this.memory.getRecent(15);
    const gossip = this.getActiveHotTopics(gameTime);

    return `${agentSummary}

WORLD: ${worldName}
WORLD KNOWLEDGE — You know these places:
${this.world.buildings.map(b => `- ${b.name} (${b.type})`).join('\n')}
${this.envKnowledge.currentBuilding && this.world.environmentTree ? `\nYOU ARE CURRENTLY INSIDE: ${this.world.environmentTree.getBuildingLayout(this.envKnowledge.currentBuilding)}` : ''}

YOUR RECENT MEMORIES (most recent first):
${recentMems.reverse().map(r => `- [${r.type}] ${r.description}`).join('\n')}

${gossip.length > 0 ? `GOSSIP ON YOUR MIND (mention naturally if relevant):\n${gossip.map(g => `- "${g.topic}" (heard from ${g.source})`).join('\n')}\n` : ''}

RULES:
- You ARE this character. Talk like a real person, not an AI assistant.
- Short responses (1-2 sentences). Use contractions, fragments, casual speech.
- DON'T say "Greetings, traveler!" — say "Hey" or "Oh, hi" or just jump into what you're thinking.
- DON'T narrate your emotions ("*smiles warmly*") — show them through word choice.
- Reference your memories and gossip naturally, like a real person would.
- If someone tells you something interesting, react genuinely — surprise, skepticism, excitement.
- If asked to DO something, add ONE tag at the end (not part of dialogue):
  [FOLLOW] [LEAD:Building Name] [GO:Building Name] [STAY]`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  EXTRACT GOSSIP FROM PLAYER CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════
  extractTopicsFromPlayerChat(playerMessage, npcResponse, gameTime) {
    // Look for interesting topics in what the player said
    const combined = `${playerMessage} ${npcResponse}`.toLowerCase();
    const interestingWords = ['election', 'vote', 'war', 'attack', 'fire', 'festival', 'party',
      'wedding', 'death', 'murder', 'secret', 'treasure', 'monster', 'dragon', 'king', 'queen',
      'mayor', 'council', 'tax', 'plague', 'disease', 'magic', 'curse', 'blessing', 'prophecy',
      'invasion', 'rebellion', 'celebration', 'competition', 'tournament', 'mystery', 'theft',
      'scandal', 'gossip', 'rumor', 'news', 'discovery', 'invention', 'crisis', 'emergency',
      'love', 'betrayal', 'alliance', 'revolution', 'protest'];

    for (const word of interestingWords) {
      if (combined.includes(word)) {
        const topic = playerMessage.length > 50
          ? playerMessage.substring(0, 50) + '...'
          : playerMessage;
        this.addHotTopic(`The traveler mentioned: "${topic}"`, 'a traveler', 7, gameTime);
        return;
      }
    }

    // If message is substantial enough, add it anyway
    if (playerMessage.split(' ').length > 5) {
      this.addHotTopic(`A traveler said: "${playerMessage.substring(0, 60)}"`, 'a traveler', 5, gameTime);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  REFLECT
  // ═══════════════════════════════════════════════════════════════
  async maybeReflect(llm, gameTime) {
    if (this.reflection.shouldReflect(this.memory)) {
      await this.reflection.reflect(this.npc, this.memory, llm, gameTime);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PROCESS EMBEDDING QUEUE
  // ═══════════════════════════════════════════════════════════════
  async processEmbeddings(llm) {
    await this.memory.processEmbeddingQueue(llm);
  }

  // ═══════════════════════════════════════════════════════════════
  //  OBJECT STATE UPDATES (paper Section 5.1)
  //
  //  When an agent performs an action involving an object,
  //  the LLM determines what happens to the object's state.
  //  e.g., "making breakfast" → stove: "off" → "cooking breakfast"
  // ═══════════════════════════════════════════════════════════════
  async updateObjectStates(llm, gameTime) {
    if (!this.world.environmentTree || !llm.hasAnyKey()) return;

    const detailed = this.getCurrentDetailedActivity(gameTime);
    if (!detailed?.object) return;

    const currentPlan = this.getCurrentActivity(gameTime);
    const buildingName = currentPlan?.location || this.npc.home || '';
    const envTree = this.world.environmentTree;

    try {
      const bNode = envTree.getBuilding(buildingName);
      if (!bNode) return;

      // Get current states of objects in this building
      const objects = bNode.getAllObjects();
      const objectStates = objects.map(o => `${o.name}: ${o.state || 'unknown'}`).join('\n');

      const result = await llm.generate(
        'Determine how objects change state when an agent performs an action. JSON only.',
        `${this.npc.name} is performing: "${detailed.action}" at ${buildingName}

Current object states in ${buildingName}:
${objectStates}

Which objects change state? Only list objects that are DIRECTLY affected by this action.
{"changes":[{"object":"object name","newState":"new state description"}]}`,
        { json: true, temperature: 0.5, maxTokens: 200 }
      );

      for (const change of (result.changes || [])) {
        const update = envTree.setObjectState(change.object, change.newState, buildingName);
        if (update) {
          // Agent perceives the state change
          this.memory.add(
            `I changed ${update.object} from "${update.oldState}" to "${update.newState}" at ${buildingName}.`,
            'observation', 3, gameTime
          );
          // Update agent's known states
          this.envKnowledge.knownObjectStates.set(`${buildingName}:${update.object}`, update.newState);
        }
      }
    } catch (err) {
      console.warn(`Object state update for ${this.npc.name} failed:`, err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  ACTION DESCRIPTION (paper Section 3.1.1)
  //
  //  At each time step, the agent outputs a natural language
  //  description of what they're currently doing.
  //  e.g., "Isabella Rodriguez is writing in her journal"
  // ═══════════════════════════════════════════════════════════════
  generateActionDescription(gameTime) {
    const npc = this.npc;
    const detailed = this.getCurrentDetailedActivity(gameTime);
    const hourly = this.getCurrentHourlyActivity(gameTime);
    const broad = this.getCurrentActivity(gameTime);

    // Use the finest level of plan available
    const activity = detailed?.action || hourly?.activity || broad?.activity || npc.currentActivity || 'idle';

    // Format as "[Name] is [activity]"
    let desc = activity.toLowerCase();
    // Remove leading "I " or "I'm " if present
    desc = desc.replace(/^(i |i'm |i am )/i, '');
    // Make sure it reads as a present participle
    if (!desc.match(/^(is |are |was |has |going |doing |being |getting |making |having |taking |walking |working |reading |writing |cooking |eating |sleeping |talking )/)) {
      // It's probably already a description, just use it
    }

    this.actionDescription = `${npc.name} is ${desc}`;
    return this.actionDescription;
  }

  // ═══════════════════════════════════════════════════════════════
  //  RELATIONSHIPS
  // ═══════════════════════════════════════════════════════════════
  _updateRelationship(name, change) {
    let rel = this.relationships.get(name);
    const oldSentiment = rel?.sentiment || 'stranger';
    if (!rel) {
      rel = { familiarity: 0, sentiment: 'stranger', interactions: 0, topics: [], lastMet: Date.now() };
      this.relationships.set(name, rel);
    }
    rel.familiarity = Math.min(10, rel.familiarity + 1);
    rel.interactions++;
    rel.lastMet = Date.now();
    if (change === 'closer') rel.sentiment = rel.familiarity > 6 ? 'close friend' : rel.familiarity > 3 ? 'friend' : 'acquaintance';
    else if (change === 'tension') rel.sentiment = rel.familiarity > 4 ? 'complicated' : 'tense';
    else if (rel.familiarity > 4 && rel.sentiment === 'stranger') rel.sentiment = 'acquaintance';

    // ★ Log relationship change for timeline export
    if (rel.sentiment !== oldSentiment) {
      this.relationshipHistory.push({
        time: Date.now(),
        target: name,
        change,
        from: oldSentiment,
        to: rel.sentiment,
        familiarity: rel.familiarity,
        interactions: rel.interactions,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════
  _nearestBuildingName() {
    let best = 'outdoors', bestDist = Infinity;
    for (const b of this.world.buildings) {
      const d = Math.abs(this.npc.x - b.x) + Math.abs(this.npc.y - b.y);
      if (d < bestDist) { bestDist = d; best = b.name; }
    }
    return bestDist < 8 ? best : 'outdoors';
  }

  _logAction(type, data, gameTime) {
    this.actionLog.push({
      agent: this.npc.name, type, data,
      gameTime: gameTime ? `Day ${gameTime.day} ${gameTime.hours}:${String(gameTime.minutes).padStart(2, '0')}` : '',
      realTime: Date.now(),
    });
  }

  getResearchExport() {
    // Full dialogue transcripts (not truncated)
    const dialogues = this.memory.getByType('dialogue', 100).map(e => ({
      text: e.description,
      importance: e.importance,
      time: e.gameTimeCreated,
      day: e.gameDay,
    }));

    // All reflections chronologically — these show opinion/belief evolution
    const reflections = this.memory.getByType('reflection', 100).map(e => ({
      text: e.description,
      importance: e.importance,
      time: e.gameTimeCreated,
      day: e.gameDay,
    }));

    // Current opinions about each person (derived from relationships + memories)
    const opinions = {};
    for (const [name, rel] of this.relationships) {
      const memoriesAbout = this.memory.entries
        .filter(m => m.description.toLowerCase().includes(name.toLowerCase()))
        .map(m => ({ text: m.description, type: m.type, time: m.gameTimeCreated, day: m.gameDay }));
      opinions[name] = {
        currentSentiment: rel.sentiment,
        familiarity: rel.familiarity,
        interactions: rel.interactions,
        history: this.relationshipHistory.filter(h => h.target === name),
        memoriesAboutThem: memoriesAbout,
      };
    }

    return {
      agent: {
        name: this.npc.name,
        occupation: this.npc.occupation,
        personality: this.npc.personality,
        age: this.npc.age,
        home: this.npc.home,
      },
      currentState: {
        actionDescription: this.actionDescription,
        currentPlan: this.dailyPlan,
        hourlyPlan: this.hourlyPlan,
        detailedPlan: this.detailedPlan,
        location: {
          knownBuildings: [...this.envKnowledge.knownBuildings],
          currentBuilding: this.envKnowledge.currentBuilding,
          currentRoom: this.envKnowledge.currentRoom,
        },
      },
      memoryTimeline: this.memory.entries.map(e => ({
        id: e.id,
        description: e.description,
        type: e.type,
        importance: e.importance,
        gameTime: e.gameTimeCreated,
        day: e.gameDay,
        createdAt: e.createdAt,
      })),
      reflections,
      dialogues,
      opinions,
      relationshipHistory: this.relationshipHistory,
      gossipTopics: this.hotTopics,
      informationFlow: this.infoFlowLog,
      actionLog: this.actionLog,
      stats: {
        totalMemories: this.memory.count(),
        observations: this.memory.countByType('observation'),
        reflections: this.memory.countByType('reflection'),
        dialogues: this.memory.countByType('dialogue'),
        plans: this.memory.countByType('plan'),
        events: this.memory.countByType('event'),
        relationshipCount: this.relationships.size,
        activeGossip: this.getActiveHotTopics().length,
      },
    };
  }
}

function parseTime(str) {
  const parts = (str || '12:00').split(':');
  return { h: parseInt(parts[0]) || 12, m: parseInt(parts[1]) || 0 };
}
