// ─── Main Application ─────────────────────────────────────────────
import { TILE, TILE_SIZE } from './config.js';
import { LLM } from './llm.js';
import { World } from './world.js';
import { Player, NPC } from './entities.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { CognitiveArchitecture } from './cognition.js';
import { CommunityEvent, detectEventType } from './events.js';
import { createAgentState, createWorldState, createRelationship, simulationTick, applyConsequence, applyGenericAction, getOrCreateRelationship, generateOccupationProduction, setSimulationWorldDef, worldEvolutionTick } from './simulation.js';
import { getTopGoal, getMotivationSummary, generateGoalLLM, generateGoals, applyConsequenceLLM, applyGenerativeConsequences, setGoalsWorldDef } from './goals.js';
import { generateWorldDef, DEFAULT_WORLDDEF } from './worlddef.js';
import { setVisualStyle } from './sprites.js';
// AI asset generation removed — procedural sprites are cleaner

class App {
  constructor() {
    this.llm = new LLM();
    this.ui = new UI();
    this.input = new Input();
    this.world = null;
    this.worldDef = DEFAULT_WORLDDEF;  // ★ Schema-driven world definition
    this.player = null;
    this.npcs = [];
    this.renderer = null;
    this.running = false;
    this.lastTime = 0;
    this.chatNpc = null;

    // Game time
    this.gameTime = { hours: 8, minutes: 0, day: 1, totalMinutes: 480 };
    this.gameTimeAccum = 0;

    // ── Cognitive Architecture Timers ──
    this.cognitiveTimer = 0;
    this.cognitiveInterval = 3500;   // ★ Run cognitive cycle every 3.5s (was 8s)
    this.baseCognitiveInterval = 3500;
    this.cognitiveQueue = [];
    this.planningQueue = [];
    this.apiFailureCount = 0;        // Track recent API failures for adaptive backoff
    this.apiFailureResetTimer = 0;

    // ── Conversation Feed (visible to player) ──
    this.conversationFeed = [];
    this.maxFeedEntries = 20;

    // ── Community Events ──
    this.communityEvent = null;

    // ── Simulation State Engine ──
    this.worldSim = null;            // WorldState object
    this.simTickTimer = 0;
    this.simTickInterval = 1000;     // tick every 1 second (= 1 game minute)
    this.simLog = [];                // state change log

    // ── World Events System ──
    this.worldEvents = [];

    // ── Research Data ──
    this.researchLog = [];
    this.simulationStartTime = Date.now();

    this._bindGlobalEvents();
    this.ui.loadKeysIntoUI(this.llm);
  }

  // ─── Event Bindings ─────────────────────────────────────────────
  _bindGlobalEvents() {
    // Settings
    document.querySelector('#settings-modal .close-btn').addEventListener('click', () => this.ui.closeSettings());
    document.querySelector('#settings-modal .btn.primary').addEventListener('click', () => this._saveSettings());
    document.getElementById('settings-modal').addEventListener('click', e => {
      if (e.target.id === 'settings-modal') this.ui.closeSettings();
    });

    // Setup screen — Enter in textarea to generate
    document.getElementById('setup-settings-btn')?.addEventListener('click', () => this.ui.openSettings());
    const worldDesc = document.getElementById('world-description');
    if (worldDesc) {
      worldDesc.addEventListener('input', () => {
        worldDesc.style.height = 'auto';
        worldDesc.style.height = Math.min(worldDesc.scrollHeight, 200) + 'px';
      });
      worldDesc.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.generateWorld();
        }
      });
    }

    // HUD buttons
    document.querySelectorAll('.hud-btn').forEach(btn => {
      const title = btn.getAttribute('title');
      if (title === 'Settings') btn.addEventListener('click', () => this.ui.openSettings());
      else if (title === 'Minimap') btn.addEventListener('click', () => this.renderer?.toggleMinimap());
      else if (title === 'State Inspector') btn.addEventListener('click', () => this._switchToTab('tab-agents'));
    });

    // Chat (in sidebar)
    document.getElementById('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.sendChat(); });
    document.querySelector('#tab-chat .btn.small')?.addEventListener('click', () => this.sendChat());
    document.querySelector('#npc-info .btn')?.addEventListener('click', () => this.startChat());

    // Command bar (always visible at bottom)
    document.getElementById('command-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.executeCommand();
    });

    // Export
    document.getElementById('export-btn')?.addEventListener('click', () => this.exportResearchData());

    // ── Research Tab ──
    this.researchHistory = [];
    const researchInput = document.getElementById('research-input');
    const researchSendBtn = document.getElementById('research-send-btn');
    if (researchInput) {
      researchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._handleResearchQuery(); }
      });
    }
    if (researchSendBtn) {
      researchSendBtn.addEventListener('click', () => this._handleResearchQuery());
    }
    // Suggestion buttons
    document.querySelectorAll('.research-suggestion').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.q;
        if (researchInput) researchInput.value = q;
        this._handleResearchQuery();
      });
    });

    // Agent selector (in Agents tab)
    document.getElementById('state-agent-select')?.addEventListener('change', e => {
      this._renderAgentState(e.target.value);
    });

    // Global shortcuts
    window.addEventListener('keydown', e => {
      if (this.ui.isAnyInputFocused() || this.ui.isModalOpen()) return;
      if (e.key === '/') { e.preventDefault(); this.ui.openCommandBar(); }
      if (e.key === 'm') this.renderer?.toggleMinimap();
      if (e.key === 'Escape' && this.ui.isChatOpen()) this.closeChat();
    });
  }

  _switchToTab(tabId) {
    document.querySelectorAll('#sidebar-tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#sidebar .tab-content').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');
    document.getElementById(tabId)?.classList.add('active');
  }

  _saveSettings() {
    const { keys, provider } = this.ui.getKeysFromUI();
    Object.entries(keys).forEach(([k, v]) => this.llm.setKey(k, v));
    this.llm.setProvider(provider);
    this.llm.save();
    this.ui.closeSettings();
    this.ui.notify('Settings saved!', 'success');
  }

  // ═══════════════════════════════════════════════════════════════
  //  WORLD GENERATION
  // ═══════════════════════════════════════════════════════════════
  async generateWorld() {
    const desc = this.ui.els.worldDesc.value.trim();
    if (!desc) { this.ui.setStatus('Please describe your world first!', true); return; }
    const raw = parseInt(document.getElementById('inhabitant-count')?.value, 10);
    this.inhabitantCount = (raw >= 3 && raw <= 20) ? raw : 8;

    this.ui.showLoading('Imagining your world...');

    try {
      let worldData;
      if (!this.llm.hasAnyKey()) {
        this.ui.setLoadingText('No API key found — generating demo world...');
        await this._sleep(500);
        worldData = this._getDemoWorld(desc);
        this.worldDef = DEFAULT_WORLDDEF;
      } else {
        // ★ Phase 1: Architect analyzes prompt → culture, landmarks, visual theme, shapes, AND full worldDef
        this.ui.setLoadingText('Architect designing world systems...');
        const blueprint = await this._architectWorld(desc);

        // ★ Build WorldDef from architect output
        this.worldDef = generateWorldDef(blueprint?.worldDef || blueprint);

        // ★ Phase 2: World builder uses blueprint to generate full world
        this.ui.setLoadingText('Building the world from blueprint...');
        worldData = await this._generateWorldData(desc, blueprint);
      }

      // ★ Set the worldDef on all subsystems
      setSimulationWorldDef(this.worldDef);
      setGoalsWorldDef(this.worldDef);
      setVisualStyle(this.worldDef.visualStyle);

      this.ui.setLoadingText('Building the landscape...');
      await this._sleep(300);
      this.world = new World();
      this.world.buildFromDescription(worldData);

      this.ui.setLoadingText('Creating characters...');
      await this._sleep(300);
      this.player = new Player(this.world.playerSpawn.x, this.world.playerSpawn.y);

      this.npcs = [];
      const chars = worldData.characters || [];
      for (let i = 0; i < chars.length; i++) {
        const spawn = this.world.npcSpawnPoints[i] || this.world.playerSpawn;
        const npc = new NPC(spawn.x, spawn.y, {
          ...chars[i], id: `npc_${i}`, homeBuilding: spawn.building,
        });

        // ★ Attach cognitive architecture
        npc.cognition = new CognitiveArchitecture(npc, this.world);

        // ★ Attach simulation state
        npc.sim = createAgentState(chars[i], this.worldDef);
        npc.simRelationships = new Map();

        // Boost skills based on occupation (from worldDef)
        const occDef = this.worldDef?.findOccupation(chars[i].occupation?.toLowerCase());
        if (occDef?.skill && npc.sim.skills[occDef.skill] !== undefined) {
          npc.sim.skills[occDef.skill] = Math.min(10, npc.sim.skills[occDef.skill] + 3 + Math.random() * 2);
        }

        // Seed initial relationships
        if (chars[i].relationships) {
          for (const [name, desc] of Object.entries(chars[i].relationships)) {
            npc.cognition.relationships.set(name, {
              familiarity: 5, sentiment: desc, interactions: 3, topics: [], lastMet: Date.now(),
            });
            // Also seed simulation relationships
            npc.simRelationships.set(name, createRelationship(desc));
          }
        }

        this.npcs.push(npc);
      }

      // ★ Create world simulation state
      this.worldSim = createWorldState(this.world.name, this.world.buildings, this.worldDef);
      this.worldSim.population = this.npcs.length;
      if (worldData.economy) {
        this.worldSim.economy = { ...this.worldSim.economy, ...worldData.economy };
        if (worldData.economy.prices) this.worldSim.economy.prices = { ...this.worldSim.economy.prices, ...worldData.economy.prices };
      }

      // ★ RICH SEED MEMORIES — Generate detailed starting memories for each NPC
      this.ui.setLoadingText('Seeding agent memories...');
      await this._sleep(200);

      const seedPromises = this.npcs.map(npc =>
        npc.cognition.generateRichSeedMemories(this.llm, this.npcs, this.gameTime)
      );
      await Promise.allSettled(seedPromises);

      this.ui.setLoadingText('Generating daily plans...');
      await this._sleep(200);

      // Generate initial daily plans for all NPCs
      const planPromises = this.npcs.map(npc =>
        npc.cognition.createDailyPlan(this.llm, this.gameTime)
      );
      await Promise.allSettled(planPromises);

      this.ui.setLoadingText('Starting simulation...');
      await this._sleep(300);

      const canvas = document.getElementById('game-canvas');
      this.renderer = new Renderer(canvas);
      this.renderer.followTarget(this.player.px, this.player.py);
      this.renderer.camX = this.renderer.camTargetX;
      this.renderer.camY = this.renderer.camTargetY;

      this.ui.hideLoading();
      this.ui.showGame();
      this.ui.setWorldName(this.world.name);
      this._initSidebar();
      this.ui.notify(`Welcome to ${this.world.name}!`, 'success', 5000);
      if (!this.llm.hasAnyKey()) {
        this.ui.notify('Demo mode — add API keys in Settings for AI conversations!', 'info', 8000);
      }

      this.running = true;
      this.lastTime = performance.now();
      this._gameLoop(this.lastTime);

      // Initial greetings
      for (let i = 0; i < this.npcs.length; i++) {
        const npc = this.npcs[i];
        setTimeout(() => npc.say(`Hello! I'm ${npc.name}, the ${npc.occupation}.`, 5000), 1000 + i * 2000);
      }

      // ★ Kick off initial conversations so the feed isn't empty
      setTimeout(() => {
        for (let i = 0; i < this.npcs.length - 1; i += 2) {
          const a = this.npcs[i], b = this.npcs[i + 1];
          if (a?.cognition && b) {
            a.cognition.generateConversation(b, this.llm, this.gameTime).then(async convData => {
              if (convData?.lines?.length > 0) {
                convData.stateChanges = await this._applyConversationConsequences(convData, a, b);
                this._addToConversationFeed(convData);
              }
            });
          }
        }
      }, 5000);
    } catch (err) {
      console.error('World generation failed:', err);
      this.ui.hideLoading();
      this.ui.setStatus(`Error: ${err.message}`, true);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  ARCHITECT LLM — Phase 1: Analyze prompt → culture, visual, AND full world schema
  // ═══════════════════════════════════════════════════════════════
  async _architectWorld(description) {
    const systemPrompt = `You are a world ARCHITECT for a 2D simulation game. Analyze the user's description and output a COMPLETE BLUEPRINT including culture, visuals, landmarks, AND the full world schema (resources, needs, occupations, actions, traits, skills).

Return JSON:
{
  "culture": "culture/era identifier",
  "era": "ancient|medieval|modern|futuristic",
  "visual": {
    "ground": "grass|stone|sand|dirt|marble|metal|concrete|wood|tile",
    "paths": "paved|dirt|stone|wood|cobblestone|metal|gravel",
    "vegetation": "none|sparse|moderate|lush",
    "buildingStyle": "rustic|modern|futuristic|medieval|industrial|colorful|natural",
    "culturePalette": "egyptian|indian|japanese|chinese|greek|roman|arabian|african|mesoamerican|nordic|scifi|fantasy|rustic|modern|medieval|industrial|colorful|natural",
    "roadLayout": "cross|radial|organic",
    "palette": {"primary": "#hex", "secondary": "#hex", "accent": "#hex"}
  },
  "landmarks": [{"name":"...", "role":"...", "shape":"pyramid|dome|obelisk|minaret|step_pyramid|pagoda|colosseum|tent|hut|tower|monument", "color":"#hex", "roofColor":"#hex"}],
  "suggestedBuildings": [{"name":"...", "type":"...", "shape":"default|pyramid|dome|...", "landmark":false, "color":"#hex", "roofColor":"#hex"}],
  "suggestedAreas": [{"name":"...", "type":"forest|water|park|desert|sand|plaza|ruins|rocky|farm|swamp|garden|courtyard|indoor"}],
  "specialShapes": [],

  "worldDef": {
    "resources": [
      {"id": "grain", "renewable": true, "baseProduction": 0.1, "unit": "bushels", "category": "consumable", "startAmount": 60},
      {"id": "gold", "renewable": false, "unit": "coins", "category": "currency", "startAmount": 100}
    ],
    "needs": [
      {"id": "hunger", "label": "Hunger", "growthRate": 0.0004, "satisfiedBy": ["bread","grain","fish"], "decayAction": "eat", "critical": 0.9},
      {"id": "rest", "label": "Rest", "growthRate": 0.002, "decayAction": "sleep"},
      {"id": "social", "label": "Social", "growthRate": 0.003, "decayAction": "socialize"}
    ],
    "traits": [{"id": "trait_name", "label": "Display Name"}],
    "skills": [{"id": "skill_name", "label": "Display Name"}],
    "occupations": [
      {"id": "baker", "inputs": [{"resource": "grain", "qty": 1}], "outputs": [{"resource": "bread", "qty": 2}], "skill": "cooking", "description": "Bakes bread"}
    ],
    "actions": [
      {"id": "eat", "effects": {"hunger": -0.7}, "inputs": [{"resource": "food", "qty": 1}], "description": "Eat a meal"},
      {"id": "pray", "effects": {"purpose": -0.3, "happiness": 5}, "description": "Pray at the temple", "location": "temple"}
    ],
    "visualStyle": {
      "palette": ["#hex1","#hex2","#hex3","#hex4","#hex5"],
      "groundTexture": "grainy|smooth|organic|block",
      "buildingMaterial": "stone_block|wood_plank|mud_brick|metal_panel",
      "vegetationType": "deciduous|palm|pine|cactus|mushroom|bamboo",
      "waterStyle": "still|river|ocean"
    },
    "economy": {"currency": "deben", "taxRate": 0.1}
  }
}

WORLD SCHEMA RULES:
- "resources": 3-6 culturally appropriate resources. Always include a food type and a currency. Egypt: grain, gold/deben, papyrus, linen. Japan: rice, yen, silk, bamboo. Sci-fi: energy_cells, credits, alloy.
- "needs": 5-8 needs appropriate to the world. Always include hunger, rest, social. Add culture-specific ones: "faith" for religious worlds, "honor" for samurai, "oxygen" for space, "mana" for fantasy.
- "traits": 5-8 personality dimensions. "piety" for religious, "bushido" for Japanese, "rationality" for sci-fi.
- "skills": 6-10 skills. Match the world: "hieroglyphics" for Egypt, "sword_fighting" for medieval, "hacking" for cyberpunk.
- "occupations": 8-15 with inputs/outputs for supply chains. Farmer produces grain (no input). Baker needs grain → bread. Blacksmith needs ore → tools. NOT all occupations need inputs.
- "actions": 10-20 things agents can do. Include eat, sleep, work, socialize, plus culturally specific: "pray", "meditate", "duel", "hack", "mine", "fish", etc. Each has "effects" (need/status deltas), optional "inputs"/"outputs", optional "location".
- "visualStyle": palette of 5 hex colors matching the culture. groundTexture/buildingMaterial/vegetationType/waterStyle drive the renderer.
- "economy": currency name matching culture, tax rate 0.05-0.15.

VISUAL RULES (same as before):
- Match culture: Egypt → sand, stone, sparse, egyptian. Japan → grass, stone, lush, japanese. Sci-fi → metal, metal, none, scifi.
- 1-3 landmarks with special shapes. Rest are default.
- 3-5 areas. 6-10 buildings.`;

    try {
      const blueprint = await this.llm.generate(systemPrompt, description, { json: true, temperature: 0.7, maxTokens: 3500 });
      return blueprint;
    } catch (err) {
      console.warn('Architect LLM failed, using basic blueprint:', err.message);
      return this._fallbackBlueprint(description);
    }
  }

  _fallbackBlueprint(description) {
    // Simple keyword-based fallback when architect LLM fails
    const d = description.toLowerCase();
    let culture = 'medieval', visual = { ground: 'grass', paths: 'dirt', vegetation: 'moderate', buildingStyle: 'rustic', culturePalette: 'rustic', roadLayout: 'cross' };

    if (d.includes('egypt') || d.includes('pyramid') || d.includes('pharaoh') || d.includes('nile')) {
      culture = 'ancient egypt';
      visual = { ground: 'sand', paths: 'stone', vegetation: 'sparse', buildingStyle: 'natural', culturePalette: 'egyptian', roadLayout: 'radial' };
    } else if (d.includes('india') || d.includes('taj') || d.includes('mughal') || d.includes('hindi')) {
      culture = 'mughal india';
      visual = { ground: 'stone', paths: 'stone', vegetation: 'moderate', buildingStyle: 'natural', culturePalette: 'indian', roadLayout: 'radial' };
    } else if (d.includes('japan') || d.includes('tokyo') || d.includes('samurai') || d.includes('shogun')) {
      culture = 'feudal japan';
      visual = { ground: 'grass', paths: 'stone', vegetation: 'lush', buildingStyle: 'natural', culturePalette: 'japanese', roadLayout: 'organic' };
    } else if (d.includes('rome') || d.includes('roman') || d.includes('colosseum') || d.includes('gladiator')) {
      culture = 'roman empire';
      visual = { ground: 'stone', paths: 'stone', vegetation: 'moderate', buildingStyle: 'natural', culturePalette: 'roman', roadLayout: 'cross' };
    } else if (d.includes('space') || d.includes('mars') || d.includes('planet') || d.includes('sci-fi') || d.includes('cyber')) {
      culture = 'sci-fi';
      visual = { ground: 'metal', paths: 'metal', vegetation: 'none', buildingStyle: 'futuristic', culturePalette: 'scifi', roadLayout: 'cross' };
    } else if (d.includes('arab') || d.includes('persian') || d.includes('desert') || d.includes('oasis')) {
      culture = 'arabian';
      visual = { ground: 'sand', paths: 'stone', vegetation: 'sparse', buildingStyle: 'natural', culturePalette: 'arabian', roadLayout: 'radial' };
    } else if (d.includes('china') || d.includes('chinese') || d.includes('dynasty')) {
      culture = 'imperial china';
      visual = { ground: 'grass', paths: 'stone', vegetation: 'moderate', buildingStyle: 'natural', culturePalette: 'chinese', roadLayout: 'cross' };
    } else if (d.includes('norse') || d.includes('viking') || d.includes('nordic')) {
      culture = 'norse viking';
      visual = { ground: 'grass', paths: 'dirt', vegetation: 'moderate', buildingStyle: 'rustic', culturePalette: 'nordic', roadLayout: 'organic' };
    } else if (d.includes('greek') || d.includes('athens') || d.includes('olymp')) {
      culture = 'ancient greece';
      visual = { ground: 'stone', paths: 'stone', vegetation: 'moderate', buildingStyle: 'natural', culturePalette: 'greek', roadLayout: 'cross' };
    } else if (d.includes('aztec') || d.includes('maya') || d.includes('inca') || d.includes('mesoamerican')) {
      culture = 'mesoamerican';
      visual = { ground: 'grass', paths: 'stone', vegetation: 'lush', buildingStyle: 'natural', culturePalette: 'mesoamerican', roadLayout: 'radial' };
    } else if (d.includes('africa') || d.includes('tribal') || d.includes('savanna')) {
      culture = 'african';
      visual = { ground: 'dirt', paths: 'dirt', vegetation: 'sparse', buildingStyle: 'natural', culturePalette: 'african', roadLayout: 'organic' };
    }

    return { culture, era: 'ancient', visual, landmarks: [], suggestedBuildings: [], suggestedAreas: [], specialShapes: [] };
  }

  // ═══════════════════════════════════════════════════════════════
  //  WORLD BUILDER LLM — Phase 2: Use blueprint to generate full world
  // ═══════════════════════════════════════════════════════════════
  async _generateWorldData(description, blueprint = null) {
    const bp = blueprint || {};
    const bpContext = blueprint ? `
ARCHITECT BLUEPRINT (use this to guide your output):
- Culture: ${bp.culture || 'generic'}
- Era: ${bp.era || 'medieval'}
- Visual theme: ${JSON.stringify(bp.visual || {})}
- Landmarks to include: ${JSON.stringify(bp.landmarks || [])}
- Suggested buildings: ${JSON.stringify(bp.suggestedBuildings || [])}
- Suggested areas: ${JSON.stringify(bp.suggestedAreas || [])}
- Special shapes: ${JSON.stringify(bp.specialShapes || [])}

YOU MUST use the blueprint's landmarks, visual theme, and culture. Include ALL landmarks from the blueprint as buildings with their exact shape, color, and roofColor. Use the suggested buildings and areas, but you can add more.` : '';

    const systemPrompt = `You are a world builder for a 2D simulation game. Generate a world that MATCHES the user's description.
${bpContext}

Return JSON with this structure:
{
  "name": "World Name",
  "description": "Brief description",
  "culture": "${bp.culture || 'the culture/era of this world'}",
  "economy": {
    "currencyName": "gold",
    "taxRate": 0.1,
    "prices": { "food": 2.5, "tool": 12, "lodging": 8, "healing": 15, "gift": 5, "marketStall": 50 }
  },
  "visual": {
    "ground": "grass|stone|sand|dirt|marble|metal|concrete|wood|tile",
    "paths": "paved|dirt|stone|wood|cobblestone|metal|gravel",
    "vegetation": "none|sparse|moderate|lush",
    "buildingStyle": "rustic|modern|futuristic|medieval|industrial|colorful|natural",
    "culturePalette": "egyptian|indian|japanese|chinese|greek|roman|arabian|african|mesoamerican|nordic|scifi|fantasy|rustic|modern|futuristic|medieval|industrial",
    "roadLayout": "cross|radial|organic",
    "palette": {"primary": "#hex", "secondary": "#hex", "accent": "#hex"}
  },
  "areas": [{"name": "Area Name", "type": "forest|water|park|desert|sand|plaza|ruins|rocky|farm|swamp|garden|courtyard|indoor"}],
  "buildings": [
    {
      "name": "Building Name",
      "type": "pyramid|dome|obelisk|minaret|step_pyramid|pagoda|colosseum|tent|hut|tower|monument|house|tavern|shop|blacksmith|church|school|library|cafe|hospital|farm|market|townhall|bakery|inn|temple|castle|stable|fountain|palace|ziggurat|sphinx|barracks",
      "shape": "pyramid|dome|obelisk|minaret|step_pyramid|pagoda|colosseum|tent|hut|tower|monument|default",
      "landmark": true/false,
      "color": "#hex (culturally appropriate wall/body color)",
      "roofColor": "#hex (culturally appropriate roof/accent color)"
    }
  ],
  "specialShapes": [],
  "characters": [
    {
      "name": "Full Name", "age": 30, "occupation": "Job Title",
      "personality": "2-3 sentences, specific personality traits and quirks",
      "home": "Building Name where they work/live",
      "appearance": {"hairColor": "#hex", "shirtColor": "#hex"},
      "relationships": {"Other Name": "relationship description with opinion"}
    }
  ]
}

CRITICAL RULES:
- EVERY building MUST have "shape" set. Use "default" for normal rectangular buildings, or a special shape for landmarks.
- Landmarks (pyramids, domes, temples, etc.) MUST have shape set to the correct parametric shape (pyramid, dome, obelisk, minaret, step_pyramid, pagoda, colosseum, tent, hut, tower, monument).
- Building colors MUST match the culture. Egyptian buildings should use sandy/gold colors. Indian buildings should use cream/red/gold. Japanese should use red/black/cream. etc.
- Character names MUST be culturally appropriate (Egyptian: Imhotep, Nefertari; Indian: Arjun, Priya; Japanese: Takeshi, Yuki; etc.)
- Areas should reflect the world's geography (Egyptian: "Nile Banks", "Desert Dunes"; Indian: "Palace Gardens", "Sacred River")
- Generate 3-5 areas, 6-10 buildings (1-3 landmarks + regular buildings), and EXACTLY ${this.inhabitantCount} characters with RICH relationships

CHARACTER RELATIONSHIP RULES (VERY IMPORTANT):
- Each character MUST have 2-4 relationships with OTHER characters in the list
- Relationships should be SPECIFIC with opinions: "close friend, thinks she's very creative" not just "friend"
- Include a MIX: family ties, friendships, professional connections, rivalries, crushes
- Some characters should have SHARED history: "they used to work together", "neighbors for years"
- Relationships should be BIDIRECTIONAL — if A knows B, B should know A
- Include both positive and negative relationships for drama

ECONOMY (optional): If you include "economy", use currencyName appropriate to the culture (e.g. "deben" for Egypt, "rupee" for India, "denarius" for Rome).`;

    return await this.llm.generate(systemPrompt, description, { json: true, temperature: 0.9, maxTokens: 4096 });
  }

  // ═══════════════════════════════════════════════════════════════
  //  GAME LOOP
  // ═══════════════════════════════════════════════════════════════
  _gameLoop(timestamp) {
    if (!this.running) return;
    const dt = Math.min(timestamp - this.lastTime, 50);
    this.lastTime = timestamp;
    this._update(dt);
    this._render();
    requestAnimationFrame(t => this._gameLoop(t));
  }

  _update(dt) {
    const inputActive = this.ui.isAnyInputFocused() || this.ui.isModalOpen() || this.ui.isChatOpen();

    // Game time
    this.gameTimeAccum += dt;
    if (this.gameTimeAccum >= 1000) {
      this.gameTimeAccum -= 1000;
      this.gameTime.totalMinutes++;
      this.gameTime.minutes = this.gameTime.totalMinutes % 60;
      this.gameTime.hours = Math.floor(this.gameTime.totalMinutes / 60) % 24;
      if (this.gameTime.hours === 0 && this.gameTime.minutes === 0) {
        this.gameTime.day++;
        // ★ Daily world evolution tick (seasons, tech, cultural drift)
        if (this.worldSim && this.worldDef) {
          const evoChanges = worldEvolutionTick(this.worldSim, this.worldDef, this.npcs, this.gameTime);
          for (const c of evoChanges) this.ui.notify(c, 'info', 5000);
        }
      }
      this.ui.updateGameTime(this.gameTime.hours, this.gameTime.minutes, this.gameTime.day);
    }

    // Player
    if (!inputActive) {
      this.player.update(dt, this.input, this.world);
      if (this.input.wasPressed('e')) this._tryInteract();
    }

    // NPCs (pass player so followers can track)
    for (const npc of this.npcs) {
      npc.update(dt, this.world, this.player);
    }

    // Camera
    this.renderer.followTarget(this.player.px, this.player.py);
    this.input.updateWorldMouse(this.renderer.camX, this.renderer.camY);

    // NPC proximity
    this._checkNpcProximity();

    // World events lifecycle
    this._updateWorldEvents(dt);

    // ★ SIMULATION TICK — needs decay, relationships drift, emergent events
    this.simTickTimer += dt;
    if (this.simTickTimer >= this.simTickInterval && this.worldSim) {
      this.simTickTimer = 0;
      // ★ Sync game time to worldSim so goals/simulation can use it
      this.worldSim.hour = this.gameTime.hours;
      this.worldSim.day = this.gameTime.day;
      const simEvents = simulationTick(this.npcs, this.worldSim, this.gameTime);
      this._processSimEvents(simEvents);
      // ★ Update agent world awareness every tick
      this._updateAgentWorldContext();
    }

    // ★ Community event update (election, festival, etc.)
    if (this.communityEvent?.active) {
      this.communityEvent.update(dt);
    }

    // ★ Adaptive API failure recovery: gradually reset failure count
    this.apiFailureResetTimer += dt;
    if (this.apiFailureResetTimer > 15000) { // every 15s, decay failure count
      this.apiFailureResetTimer = 0;
      if (this.apiFailureCount > 0) {
        this.apiFailureCount = Math.max(0, this.apiFailureCount - 1);
        // Gradually restore cognitive interval toward base
        this.cognitiveInterval = this.baseCognitiveInterval + this.apiFailureCount * 2000;
      }
    }

    // ★ Cognitive cycle (Perceive → Plan → Decide → Act → Reflect)
    this.cognitiveTimer += dt;
    if (this.cognitiveTimer > this.cognitiveInterval) {
      this.cognitiveTimer = 0;
      this._runCognitiveCycle();
    }

    this.input.endFrame();
  }

  _render() {
    this.renderer.render(this.world, this.player, this.npcs, this.gameTime, this.worldEvents);
  }

  // ═══════════════════════════════════════════════════════════════
  //  WORLD EVENTS SYSTEM
  // ═══════════════════════════════════════════════════════════════
  addWorldEvent(type, x, y, data = {}) {
    const event = {
      type,
      x, y,
      location: data.location || '',
      description: data.description || type,
      message: data.message || '',
      duration: data.duration || 30000, // default 30 seconds
      elapsed: 0,
      handled: false,
      reactedNpcs: new Set(),           // track who already reacted
      lastBroadcast: 0,                 // for periodic re-broadcast
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    };
    this.worldEvents.push(event);
    this.ui.notify(`Event: ${event.description}`, 'info', 4000);

    // Apply immediate simulation consequences, then post to feed WITH the changes
    this._applyEventConsequences(event).then(stateChanges => {
      const formatted = (stateChanges || []).map(c => this._formatStateChange(c));
      this._addToConversationFeed({
        speaker1: 'World', speaker2: '',
        lines: [{ speaker: 'World', text: event.description }],
        stateChanges: formatted,
        topic: type,
        location: event.location,
        gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
      });
    });

    // Broadcast to ALL NPCs (urgent events affect everyone)
    this._broadcastEventToNpcs(event);

    return event;
  }

  _updateWorldEvents(dt) {
    for (let i = this.worldEvents.length - 1; i >= 0; i--) {
      const ev = this.worldEvents[i];
      ev.elapsed += dt;

      // Periodic re-broadcast: NPCs that wander close should also react
      ev.lastBroadcast += dt;
      if (ev.lastBroadcast > 5000) {
        ev.lastBroadcast = 0;
        this._broadcastEventToNpcs(ev);

        // Ongoing consequences — every active event keeps affecting nearby NPCs
        const severity = ev.severity || 'moderate';
        const safetyTick = severity === 'catastrophic' ? 0.08 : severity === 'major' ? 0.05 : severity === 'moderate' ? 0.02 : 0;
        const happyTick = severity === 'catastrophic' ? -1.5 : severity === 'major' ? -1 : severity === 'moderate' ? -0.5 : 0;
        if (safetyTick > 0 || happyTick !== 0) {
          for (const npc of this.npcs) {
            if (!npc.sim) continue;
            const dist = Math.abs(npc.x - ev.x) + Math.abs(npc.y - ev.y);
            if (dist < 30) {
              if (safetyTick > 0) npc.sim.needs.safety = Math.min(1, (npc.sim.needs.safety || 0) + safetyTick);
              if (happyTick !== 0) npc.sim.status.happiness = Math.max(0, Math.min(100, npc.sim.status.happiness + happyTick));
            }
          }
        }
      }

      if (ev.elapsed >= ev.duration) {
        this.worldEvents.splice(i, 1);
        this.ui.notify(`Event ended: ${ev.description}`, 'info', 2000);
        this._addToConversationFeed({
          speaker1: 'World', speaker2: '',
          lines: [{ speaker: 'World', text: `${ev.description} has ended.` }],
          topic: 'event ended', location: ev.location,
          gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
        });
      }
    }
  }

  // Apply immediate simulation-level consequences for ANY world event.
  // Returns an array of human-readable state change strings for display in the feed.
  async _applyEventConsequences(event) {
    const changes = [];

    // ── LLM-driven consequences for any event ──
    if (this.llm.hasAnyKey()) {
      try {
        const npcList = this.npcs.map(n => `${n.name} (${n.occupation})`).join(', ');
        const resources = this.worldSim ? JSON.stringify(this.worldSim.resources) : '{}';
        const result = await this.llm.generate(
          `You are the consequence engine for a world simulation. Given an event, determine REALISTIC consequences. Output JSON.

CRITICAL — understand the value semantics:
- "safety" is a NEED (0 = feeling safe, 1 = feeling terrified). A terrorist attack INCREASES safety need (makes people feel UNSAFE), so safety delta should be POSITIVE (e.g. +0.3).
- "happiness" is a STATUS (0 = miserable, 100 = ecstatic). A terrorist attack DECREASES happiness, so happiness delta should be NEGATIVE (e.g. -15).
- "hunger" is a NEED (0 = full, 1 = starving). Events that destroy food INCREASE hunger (positive delta).
- "social" is a NEED (0 = socially fulfilled, 1 = lonely). Traumatic events might increase social need (people seek comfort).

Think about what REALISTICALLY happens to people during this event:
- Disasters, attacks, plagues → safety UP (more afraid), happiness DOWN, resources DOWN
- Festivals, celebrations → happiness UP, social DOWN (less lonely), fun DOWN
- Economic crises → happiness DOWN, resources DOWN`,
          `Event: "${event.description}" (type: ${event.type}) at ${event.location || 'the village'}.
NPCs: ${npcList}
World resources: ${resources}

Return JSON:
{
  "npcEffects": { "all": { "safety": +0.3, "happiness": -15 } },
  "resourceEffects": { "resourceName": -10 },
  "logMessage": "one-line summary",
  "severity": "minor"|"moderate"|"major"|"catastrophic"
}
Only include fields that actually change.
Needs deltas (safety, hunger, social): range 0-1. Positive = need INCREASES (bad). Typical: ±0.05 to ±0.4.
Happiness delta: range 0-100. Negative = people get sadder. Typical: ±2 to ±20.
Resource deltas: negative = destroyed/consumed. Typical: ±5 to ±30.`,
          { json: true, temperature: 0.7, maxTokens: 400 }
        );

        // Apply NPC effects and collect change descriptions
        if (result.npcEffects) {
          for (const [target, effects] of Object.entries(result.npcEffects)) {
            const affected = target === 'all' ? this.npcs : this.npcs.filter(n => n.name.toLowerCase().includes(target.toLowerCase()));
            const label = target === 'all' ? 'All villagers' : target;
            for (const npc of affected) {
              if (!npc.sim) continue;
              if (effects.safety !== undefined) {
                npc.sim.needs.safety = Math.max(0, Math.min(1, (npc.sim.needs.safety || 0) + effects.safety));
              }
              if (effects.happiness !== undefined) {
                npc.sim.status.happiness = Math.max(0, Math.min(100, npc.sim.status.happiness + effects.happiness));
              }
              if (effects.social !== undefined) {
                npc.sim.needs.social = Math.max(0, Math.min(1, npc.sim.needs.social + effects.social));
              }
              if (effects.hunger !== undefined) {
                npc.sim.needs.hunger = Math.max(0, Math.min(1, npc.sim.needs.hunger + effects.hunger));
              }
            }
            // Build readable change line
            const parts = [];
            if (effects.safety !== undefined)   parts.push(`safety ${effects.safety > 0 ? '+' : ''}${effects.safety.toFixed(2)}`);
            if (effects.happiness !== undefined) parts.push(`happiness ${effects.happiness > 0 ? '+' : ''}${effects.happiness}`);
            if (effects.social !== undefined)    parts.push(`social ${effects.social > 0 ? '+' : ''}${effects.social.toFixed(2)}`);
            if (effects.hunger !== undefined)    parts.push(`hunger ${effects.hunger > 0 ? '+' : ''}${effects.hunger.toFixed(2)}`);
            if (parts.length > 0) changes.push(`${label}: ${parts.join(', ')}`);
          }
        }

        // Apply resource effects
        if (result.resourceEffects && this.worldSim) {
          for (const [res, delta] of Object.entries(result.resourceEffects)) {
            if (this.worldSim.resources[res] !== undefined) {
              this.worldSim.resources[res] = Math.max(0, this.worldSim.resources[res] + delta);
              changes.push(`${res}: ${delta > 0 ? '+' : ''}${delta}`);
            }
          }
        }

        // Log
        if (result.logMessage) {
          this.simLog.push({ time: Date.now(), text: result.logMessage });
        }

        event.severity = result.severity || 'moderate';
        return changes;
      } catch (err) {
        console.warn('LLM event consequences failed, using fallback:', err.message);
      }
    }

    // ── Fallback: hardcoded consequences for common types ──
    const severity = this._estimateEventSeverity(event.type);
    event.severity = severity;
    const happinessDelta = severity === 'catastrophic' ? -10 : severity === 'major' ? -5 : severity === 'moderate' ? -3 : -1;
    const safetyDelta = severity === 'catastrophic' ? 0.4 : severity === 'major' ? 0.25 : severity === 'moderate' ? 0.1 : 0;

    for (const npc of this.npcs) {
      if (!npc.sim) continue;
      if (safetyDelta > 0) npc.sim.needs.safety = Math.min(1, (npc.sim.needs.safety || 0) + safetyDelta);
      npc.sim.status.happiness = Math.max(0, npc.sim.status.happiness + happinessDelta);
    }
    if (safetyDelta > 0) changes.push(`All villagers: safety +${safetyDelta.toFixed(2)}`);
    if (happinessDelta !== 0) changes.push(`All villagers: happiness ${happinessDelta}`);

    if (this.worldSim) {
      const res = this.worldSim.resources;
      if (event.type === 'fire') {
        if (res.wood !== undefined) { res.wood = Math.max(0, res.wood - 15); changes.push('wood: -15'); }
        if (res.food !== undefined) { res.food = Math.max(0, res.food - 10); changes.push('food: -10'); }
        this.simLog.push({ time: Date.now(), text: `Fire at ${event.location} destroyed resources (wood -15, food -10)` });
      } else if (event.type === 'rain') {
        if (res.water !== undefined) { res.water = Math.min(999, (res.water || 0) + 20); changes.push('water: +20'); }
        if (res.food !== undefined) { res.food = Math.min(999, res.food + 5); changes.push('food: +5'); }
        this.simLog.push({ time: Date.now(), text: `Rain replenished water (+20) and crops (+5)` });
      } else {
        this.simLog.push({ time: Date.now(), text: `${event.description} is affecting the village` });
      }
    }

    return changes;
  }

  _estimateEventSeverity(type) {
    const catastrophic = ['fire', 'earthquake', 'plague', 'invasion', 'war', 'flood', 'volcano'];
    const major = ['storm', 'famine', 'riot', 'collapse', 'explosion', 'drought', 'raid'];
    const moderate = ['rain', 'theft', 'accident', 'protest', 'strike', 'illness'];
    if (catastrophic.includes(type)) return 'catastrophic';
    if (major.includes(type)) return 'major';
    if (moderate.includes(type)) return 'moderate';
    return 'minor';
  }

  async _broadcastEventToNpcs(event) {
    for (const npc of this.npcs) {
      // Skip NPCs who already reacted to this event
      if (event.reactedNpcs.has(npc.name)) continue;

      const dist = Math.abs(npc.x - event.x) + Math.abs(npc.y - event.y);
      // All events broadcast village-wide; every NPC should know
      const radius = 100;

      if (dist < radius && npc.state !== 'talking') {
        event.reactedNpcs.add(npc.name);
        npc.perceiveEvent(event);

        // If we have an API key, get an intelligent reaction
        if (this.llm.hasAnyKey()) {
          this._getNpcEventReaction(npc, event);
        } else {
          // Default reactions without API — context-aware
          if (event.type === 'fire') {
            npc.say('Oh no, fire! We need to get away!', 4000);
            npc.fleeFrom(event.x, event.y, this.world);
          } else {
            npc.say(`Did you hear? ${event.description}`, 3000);
          }
        }
      }
    }
  }

  async _getNpcEventReaction(npc, event) {
    try {
      const prompt = npc.getEventReactionPrompt(event, this.world.name, this.world.buildings);
      const result = await this.llm.generate(
        'You are an NPC reaction engine. Respond ONLY with JSON.',
        prompt,
        { json: true, temperature: 0.85, maxTokens: 256 }
      );

      if (result.speech) npc.say(result.speech, 5000);
      if (result.thought) npc.currentActivity = result.thought;

      if (result.reaction === 'flee' || result.reaction === 'panic') {
        npc.fleeFrom(event.x, event.y, this.world);
      } else if (result.reaction === 'help') {
        // Try to go to water source or help location
        const waterBuilding = this.world.buildings.find(b =>
          b.name.toLowerCase().includes('well') || b.name.toLowerCase().includes('river') ||
          b.name.toLowerCase().includes('pond') || b.name.toLowerCase().includes('fountain')
        );
        if (waterBuilding) {
          npc.goToBuilding(waterBuilding, this.world);
          npc.say(`I'll get water from ${waterBuilding.name}!`, 4000);
        } else {
          // Go toward the event to help
          const helpPath = this.world.findPath(npc.x, npc.y, event.x, event.y + 2);
          if (helpPath) {
            npc.path = helpPath;
            npc.pathIndex = 0;
            npc.state = 'walking';
            npc.currentActivity = 'Rushing to help!';
          }
        }
      } else if (result.reaction === 'investigate') {
        const invPath = this.world.findPath(npc.x, npc.y, event.x, event.y + 2);
        if (invPath) {
          npc.path = invPath;
          npc.pathIndex = 0;
          npc.state = 'walking';
        }
      }
    } catch (err) {
      console.warn('NPC event reaction failed:', err.message);
      // Fallback: just flee from fire
      if (event.type === 'fire') {
        npc.say('Fire! Run!', 3000);
        npc.fleeFrom(event.x, event.y, this.world);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  NPC PROXIMITY & INTERACTION
  // ═══════════════════════════════════════════════════════════════
  _checkNpcProximity() {
    let nearestNpc = null;
    let nearestDist = Infinity;

    for (const npc of this.npcs) {
      const dist = this.player.distanceTo(npc);
      if (dist < 3 && dist < nearestDist) {
        nearestDist = dist;
        nearestNpc = npc;
      }
    }

    if (nearestNpc) {
      this.ui.showNpcInfo(nearestNpc);
      if (nearestDist <= 2) this.ui.showInteractionHint();
      else this.ui.hideInteractionHint();
      this.nearestNpc = nearestNpc;
    } else {
      this.ui.hideNpcInfo();
      this.ui.hideInteractionHint();
      this.nearestNpc = null;
    }
  }

  _tryInteract() {
    if (this.nearestNpc && this.player.distanceTo(this.nearestNpc) <= 2) {
      this.startChat();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  CHAT SYSTEM (with persistent history & action parsing)
  // ═══════════════════════════════════════════════════════════════
  startChat() {
    if (!this.nearestNpc) return;
    this.chatNpc = this.nearestNpc;

    // ★ DON'T clear chatHistory! Keep it persistent across conversations.
    // Just increment conversation count and add a context memory.
    this.chatNpc.conversationCount++;
    if (this.chatNpc.cognition) {
      this.chatNpc.cognition.memory.add(
        `A traveler approached me to talk (conversation #${this.chatNpc.conversationCount}).`,
        'dialogue', 4, this.gameTime
      );
    }

    this.ui.openChat(this.chatNpc);
    this.chatNpc.state = 'talking';
    this.chatNpc.moving = false;
    this.chatNpc.isMoving = false;

    // Re-display recent chat history in the UI
    if (this.chatNpc.chatHistory.length > 0) {
      // Show last few exchanges for context
      const recentMsgs = this.chatNpc.chatHistory.slice(-6);
      for (const msg of recentMsgs) {
        if (msg.role === 'user') {
          this.ui.addChatMessage('You (earlier)', msg.content, 'player');
        } else {
          this.ui.addChatMessage(this.chatNpc.name, msg.content, 'npc');
        }
      }
      if (recentMsgs.length > 0) {
        this.ui.addChatMessage('', '─── new conversation ───', 'system');
      }
    }

    // Face the player
    const dx = this.player.x - this.chatNpc.x;
    const dy = this.player.y - this.chatNpc.y;
    if (Math.abs(dx) > Math.abs(dy)) this.chatNpc.direction = dx > 0 ? 'right' : 'left';
    else this.chatNpc.direction = dy > 0 ? 'down' : 'up';
  }

  closeChat() {
    if (this.chatNpc) {
      // Only go back to idle if not following
      if (this.chatNpc.state === 'talking') {
        this.chatNpc.state = this.chatNpc.followTarget ? 'following' : 'idle';
        this.chatNpc.waitTimer = 2000;
      }

      // Save FULL conversation to cognitive memory (no truncation)
      if (this.chatNpc.chatHistory.length > 0 && this.chatNpc.cognition) {
        const lastExchanges = this.chatNpc.chatHistory.slice(-6);
        const summary = lastExchanges
          .map(m => `${m.role === 'user' ? 'Traveler' : this.chatNpc.name}: ${m.content}`)
          .join('\n');
        this.chatNpc.cognition.memory.add(`Conversation with traveler:\n${summary}`, 'dialogue', 6, this.gameTime);
      }
    }
    this.chatNpc = null;
    this.ui.closeChat();
  }

  async sendChat() {
    if (!this.chatNpc) return;
    const text = this.ui.getChatInput();
    if (!text) return;

    this.ui.addChatMessage('You', text, 'player');
    this.chatNpc.chatHistory.push({ role: 'user', content: text });
    this.ui.setChatLoading(true);

    try {
      if (!this.llm.hasAnyKey()) {
        // Demo mode: simple canned responses
        await this._sleep(500);
        const response = this._getDemoResponse(this.chatNpc, text);
        this.chatNpc.chatHistory.push({ role: 'assistant', content: response });
        this.ui.addChatMessage(this.chatNpc.name, response, 'npc');
        this.chatNpc.say(response.substring(0, 60) + (response.length > 60 ? '...' : ''), 4000);
      } else {
        const systemPrompt = this.chatNpc.getSystemPrompt(this.world.name, this.gameTime);
        const response = await this.llm.chat(systemPrompt, this.chatNpc.chatHistory, { temperature: 0.85 });

        // ★ Parse action tags from response
        const { cleanText, action } = this._parseActionTags(response);

        this.chatNpc.chatHistory.push({ role: 'assistant', content: cleanText });
        this.ui.addChatMessage(this.chatNpc.name, cleanText, 'npc');
        this.chatNpc.say(cleanText.substring(0, 60) + (cleanText.length > 60 ? '...' : ''), 4000);

        // ★ Execute parsed action
        this._executeNpcAction(this.chatNpc, action);

        // ★ GOSSIP: Extract interesting topics from what the player said
        if (this.chatNpc.cognition) {
          this.chatNpc.cognition.extractTopicsFromPlayerChat(text, cleanText, this.gameTime);
        }

        // ★ Auto-detect community events from conversation
        const chatEventType = detectEventType(text);
        if (chatEventType && !this.communityEvent?.active) {
          setTimeout(() => {
            this.ui.notify(`💡 "${text}" sounds like it could be an event! Starting ${chatEventType}...`, 'info', 4000);
            this._startCommunityEvent(chatEventType, text);
          }, 2000);
        }
      }
    } catch (err) {
      console.error('Chat error:', err);
      this.ui.addChatMessage('System', `Error: ${err.message}`, 'system');
    }

    this.ui.setChatLoading(false);
  }

  // Parse [FOLLOW], [LEAD:place], [GO:location], [STAY] tags
  _parseActionTags(text) {
    let action = null;
    let cleanText = text;

    const leadMatch = text.match(/\[LEAD:\s*(.+?)\]/i);
    if (leadMatch) {
      action = { type: 'lead', target: leadMatch[1].trim() };
      cleanText = text.replace(/\[LEAD:\s*.+?\]/i, '').trim();
    }

    const followMatch = text.match(/\[FOLLOW\]/i);
    if (!action && followMatch) {
      action = { type: 'follow' };
      cleanText = text.replace(/\[FOLLOW\]/i, '').trim();
    }

    const goMatch = text.match(/\[GO:\s*(.+?)\]/i);
    if (!action && goMatch) {
      action = { type: 'go', target: goMatch[1].trim() };
      cleanText = text.replace(/\[GO:\s*.+?\]/i, '').trim();
    }

    const stayMatch = text.match(/\[STAY\]/i);
    if (!action && stayMatch) {
      action = { type: 'stay' };
      cleanText = text.replace(/\[STAY\]/i, '').trim();
    }

    return { cleanText, action };
  }

  _executeNpcAction(npc, action) {
    if (!action) return;

    if (action.type === 'lead') {
      // ★ NPC walks TO the building (leading the player there)
      const building = this.world.buildings.find(b =>
        b.name.toLowerCase().includes(action.target.toLowerCase())
      );
      if (building) {
        this.ui.notify(`${npc.name} is leading you to ${building.name}! Follow them.`, 'success', 5000);
        setTimeout(() => {
          npc.state = 'leading';
          npc.goToBuilding(building, this.world);
          npc.currentActivity = `Leading the traveler to ${building.name}`;
          // After reaching destination, stop leading
          const checkArrival = setInterval(() => {
            if (npc.state !== 'walking' && npc.state !== 'leading') {
              clearInterval(checkArrival);
              npc.say(`Here we are — ${building.name}!`, 4000);
              npc.state = 'idle';
            }
          }, 1000);
        }, 500);
      }
    } else if (action.type === 'follow') {
      npc.startFollowing(this.player);
      this.ui.notify(`${npc.name} is now following you!`, 'success', 3000);
    } else if (action.type === 'go') {
      const building = this.world.buildings.find(b =>
        b.name.toLowerCase().includes(action.target.toLowerCase())
      );
      if (building) {
        setTimeout(() => {
          npc.goToBuilding(building, this.world);
          this.ui.notify(`${npc.name} is heading to ${building.name}`, 'info', 3000);
        }, 500);
      }
    }
  }

  _getDemoResponse(npc, text) {
    const lower = text.toLowerCase();
    if (lower.includes('follow') || lower.includes('come with')) {
      return `Sure, I'd be happy to come along with you! Lead the way.`;
    }
    if (lower.includes('name')) {
      return `I'm ${npc.name}! Nice to meet you. I work as a ${npc.occupation} here.`;
    }
    if (lower.includes('how are') || lower.includes('doing')) {
      return `I'm doing well, thank you! Just ${npc.currentActivity.toLowerCase()}. How about you?`;
    }
    return `That's interesting! I'm just a ${npc.occupation} here in this village. Is there something I can help you with?`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  COGNITIVE CYCLE  (Perceive → Plan → Decide → Act → Reflect)
  //
  //  Runs for ONE NPC per cycle to spread API costs.
  //  Most work is algorithmic (no API calls):
  //    - Perception is pure code
  //    - Memory retrieval is algorithmic scoring
  //    - Plan following is code
  //    - Only decision/conversation/reflection may call LLM
  // ═══════════════════════════════════════════════════════════════
  async _runCognitiveCycle() {
    // ★ Skip cognitive cycle during community events (NPCs are busy with the event)
    if (this.communityEvent?.active) return;

    // ★ Priority NPCs: process any NPC flagged for immediate re-evaluation (user changed their state)
    for (const npc of this.npcs) {
      if (npc._priorityCogCycle && npc.cognition && npc.state !== 'talking') {
        npc._priorityCogCycle = false;
        this._runSingleNpcCycle(npc);
        // Remove from regular queue so they don't get processed twice
        const idx = this.cognitiveQueue.indexOf(npc);
        if (idx >= 0) this.cognitiveQueue.splice(idx, 1);
      }
    }

    // ★ Adaptive NPC processing: reduce when API is stressed or rate-limited
    const rateLimited = this.llm?.isRateLimited?.();
    const count = rateLimited ? 1 : this.apiFailureCount > 4 ? 1 : this.apiFailureCount > 2 ? 2 : 3;
    for (let i = 0; i < count; i++) {
      if (this.cognitiveQueue.length === 0) {
        this.cognitiveQueue = [...this.npcs].sort(() => Math.random() - 0.5);
      }
      const npc = this.cognitiveQueue.shift();
      if (!npc || !npc.cognition || npc.state === 'talking') continue;

      this._runSingleNpcCycle(npc);
    }
  }

  async _runSingleNpcCycle(npc) {
    const cog = npc.cognition;
    const CONVERSE_RANGE = 8;

    try {
      // ★ 0. SEEK-OUT CONVERSATION: arrived at someone we wanted to talk to
      if (npc.pendingConversationTarget) {
        const target = npc.pendingConversationTarget;
        if (npc.distanceTo(target) <= CONVERSE_RANGE) {
          npc.state = 'talking';
          target.state = 'talking';
          const convData = await cog.generateConversation(target, this.llm, this.gameTime);
          if (npc.state === 'talking') npc.state = 'idle';
          if (target.state === 'talking') target.state = 'idle';
          // ★ Generative conversation consequences based on what was discussed
          const stateChanges = await this._applyConversationConsequences(convData, npc, target);
          if (convData?.lines?.length) {
            convData.stateChanges = stateChanges;
            this._addToConversationFeed(convData);
          }
          npc.pendingConversationTarget = null;
          npc.currentActivity = `Talked to ${target.name}`;
        }
        if (npc.pendingConversationTarget) {
          // Still pathing to them — ensure we have a path and skip goal block so we don't overwrite
          const target = npc.pendingConversationTarget;
          if (npc.state !== 'walking' || !npc.path?.length) {
            const path = this.world.findPath(npc.x, npc.y, target.x, target.y, 80);
            if (path?.length) {
              npc.path = path;
              npc.pathIndex = 0;
              npc.state = 'walking';
              npc.currentActivity = `Going to talk to ${target.name}`;
            }
          }
          const decision = await cog.decide(this.llm, this.gameTime, this.npcs.filter(n => n !== npc && npc.distanceTo(n) < 10), this.worldEvents);
          await cog.executeDecision(decision, this.llm, this.gameTime);
          cog.generateActionDescription(this.gameTime);
          return;
        }
      }

      // 1. PERCEIVE (no API)
      const nearbyNpcs = this.npcs.filter(n => n !== npc && npc.distanceTo(n) < 10);
      const nearbyBuildings = this.world.buildings.filter(b => {
        const dist = Math.abs(npc.x - (b.x + b.w/2)) + Math.abs(npc.y - (b.y + b.h/2));
        return dist < 12;
      });
      const observations = cog.perceive(nearbyNpcs, nearbyBuildings, this.worldEvents, this.gameTime);

      // 1.5. ★ REACT OR CONTINUE (paper Section 4.3.1)
      // If agent observed something notable, ask LLM if they should react
      if (observations.length > 0) {
        const mostImportant = observations.reduce((best, obs) =>
          obs.importance > best.importance ? obs : best, observations[0]);

        const reaction = await cog.shouldReactToObservation(mostImportant, this.llm, this.gameTime);
        if (reaction) {
          npc.currentActivity = reaction.reaction;
          if (reaction.speech) npc.say(reaction.speech, 4000);
          cog.memory.add(
            `I reacted to: ${mostImportant.text}. ${reaction.reason}`,
            'observation', 5, this.gameTime
          );
          // ★ FULL PLAN REGENERATION when reacting (paper Section 4.3.1)
          if (reaction.shouldReplan) {
            await cog.regeneratePlanFromNow(this.llm, this.gameTime, reaction.reason);
          }
        }
      }

      // 2. PLAN (1 API call per game-day)
      if (cog.needsPlan(this.gameTime)) {
        this.planningQueue.push(npc);
        if (this.planningQueue.length === 1) this._processPlanningQueue();
      }

      // 2.5. ★ 3-LEVEL PLAN DECOMPOSITION (paper Section 4.3)
      // Level 2: Decompose broad plan into hourly blocks
      if (Math.random() < 0.15) {
        await cog.decomposeToHourlyBlocks(this.llm, this.gameTime);
      }
      // Level 3: Decompose hourly blocks into 5-15 min actions
      if (Math.random() < 0.1) {
        await cog.decomposeToDetailedActions(this.llm, this.gameTime);
      }

      // 2.7. ★ GENERATIVE GOAL-DRIVEN BEHAVIOR
      // Try LLM-generated goals first, fall back to algorithmic
      let goals = null;
      if (this.llm.hasAnyKey()) {
        goals = await generateGoalLLM(npc, this.npcs, this.worldSim, this.llm);
      }
      // Fallback to algorithmic goals if LLM fails or is unavailable
      if (!goals || goals.length === 0) {
        const algoGoal = getTopGoal(npc, this.npcs, this.worldSim);
        if (algoGoal && algoGoal.priority > 0.55) goals = [algoGoal];
      }
      // ★ At night (22:00–06:00): merge in algorithmic sleep goal so agents actually go to sleep
      const hour = this.gameTime.hours ?? this.worldSim?.hour;
      if (goals && goals.length > 0 && (hour >= 22 || hour < 6)) {
        const algoGoals = generateGoals(npc, this.npcs, this.worldSim);
        const sleepGoals = algoGoals.filter(g => g.action === 'sleep');
        if (sleepGoals.length > 0) {
          goals = [...goals, ...sleepGoals].sort((a, b) => b.priority - a.priority);
        }
      }

      const goal = goals?.[0];
      if (goal && goal.priority > 0.3) {
        const isGenerative = goal._isGenerative;
        const isNight = (hour >= 22 || hour < 6);

        // ── NIGHT: If goal was socialize/seek_person, do sleep instead (no chatting at night) ──
        if (isNight && (goal.type === 'seek_person' || goal.action === 'socialize')) {
          applyConsequence('sleep', npc, null, this.worldSim, this.npcs);
          npc.currentActivity = 'Sleeping — it\'s late at night';
        // ── SEEK_PERSON: Walk to a target agent and interact ──
        } else if ((goal.type === 'seek_person' || goal.action === 'socialize') && goal.target) {
          const inRange = npc.distanceTo(goal.target) <= CONVERSE_RANGE;
          if (inRange) {
            npc.state = 'talking';
            goal.target.state = 'talking';
            const convData = await cog.generateConversation(goal.target, this.llm, this.gameTime);
            if (npc.state === 'talking') npc.state = 'idle';
            if (goal.target.state === 'talking') goal.target.state = 'idle';

            // ★ Generative consequences based on what was ACTUALLY discussed
            let stateChanges = await this._applyConversationConsequences(convData, npc, goal.target);

            if (convData?.lines?.length) {
              convData.stateChanges = stateChanges;
              this._addToConversationFeed(convData);
            }
            npc.currentActivity = goal.description;
          } else {
            // Path to target
            npc.pendingConversationTarget = goal.target;
            const path = this.world.findPath(npc.x, npc.y, goal.target.x, goal.target.y, 80);
            if (path?.length) {
              npc.path = path;
              npc.pathIndex = 0;
              npc.state = 'walking';
              npc.currentActivity = goal.description;
              this._addToConversationFeed({
                speaker1: `🚶 ${npc.name}`,
                speaker2: goal.target.name,
                lines: [{ speaker: npc.name, text: goal.description }],
                topic: 'seeking',
                location: '',
                gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
              });
            }
          }

        // ── CALL_EVENT: Start a community event ──
        } else if (goal.type === 'call_event' || goal.action === 'call_event') {
          const details = goal.eventDetails || goal.details || { type: 'gathering', topic: goal.description };
          applyConsequence('call_event', npc, null, this.worldSim, this.npcs, details);
          await this._startCommunityEventFromAgent({ ...details, caller: npc.name, topic: details.topic || goal.description });
          npc.currentActivity = goal.description;

        // ── GO_TO_BUILDING: Walk to a building ──
        } else if (goal.type === 'go_to_building' && goal.targetBuilding) {
          const building = this.world.buildings.find(b =>
            b.name.toLowerCase().includes(goal.targetBuilding.toLowerCase())
          );
          if (building) {
            const doorX = building.x + (building.w >> 1);
            const doorY = building.y + building.h + 1;
            const path = this.world.findPath(npc.x, npc.y, doorX, doorY, 60);
            if (path?.length) {
              npc.path = path;
              npc.pathIndex = 0;
              npc.state = 'walking';
            }
          }
          npc.currentActivity = goal.description;

        // ── STAY_HERE / WANDER / ANY OTHER ACTION ──
        } else {
          // ★ Generative consequences for any action
          if (isGenerative && this.llm.hasAnyKey()) {
            const effects = await applyConsequenceLLM(goal.description, npc, goal.target, this.worldSim, this.npcs, this.llm);
            if (effects) {
              const out = applyGenerativeConsequences(effects, npc, goal.target, this.worldSim, this.npcs);
              const formattedChanges = out.changes.map(c => this._formatStateChange(c));
              for (const c of out.changes) this.simLog.push({ time: Date.now(), text: c });

              // Show in feed
              if (out.changes.length > 0) {
                this._addToConversationFeed({
                  speaker1: `⚡ ${npc.name}`,
                  speaker2: goal.target?.name || '',
                  lines: [{ speaker: npc.name, text: out.summary || goal.description }],
                  stateChanges: formattedChanges,
                  topic: 'action',
                  location: '',
                  gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
                });
              }
              if (out.summary) npc.currentActivity = out.summary;
            }
          } else {
            // Algorithmic fallback
            if (goal.action === 'work' && npc.occupation && this.llm.hasAnyKey()) {
              generateOccupationProduction(npc.occupation, this.llm);
            }
            const out = applyConsequence(goal.action, npc, goal.target, this.worldSim, this.npcs, goal.details);
            const changes = Array.isArray(out) ? out : (out.changes || []);
            const worldChanges = Array.isArray(out) ? [] : (out.worldChanges || []);
            const formattedChanges = changes.map(c => this._formatStateChange(c));
            for (const c of changes) {
              this.simLog.push({ time: Date.now(), text: c });
              if (c.includes('partner') || c.includes('child') || c.includes('leader') || c.includes('betray') || c.includes('discover') || c.includes('opened a new business')) {
                this._addToConversationFeed({
                  speaker1: 'World', speaker2: '',
                  lines: [{ speaker: 'World', text: c }],
                  stateChanges: formattedChanges,
                  topic: 'emergent event', location: '',
                  gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2,'0')}`,
                });
                this.ui.notify(c, 'success', 5000);
              }
            }
            for (const t of out.transactions || []) {
              const who = this.npcs.find(n => n.name === t.agentName);
              if (who?.sim) {
                who.sim.transactions = who.sim.transactions || [];
                who.sim.transactions.push({ amount: t.amount, reason: t.reason, gameTime: this.gameTime });
                if (who.sim.transactions.length > 50) who.sim.transactions.shift();
              }
              this._showTransactionAnimation(who || npc, t);
            }
            for (const wc of worldChanges) {
              if (wc.action === 'add_building' && wc.details) this._addBuildingFromSimulation(wc.details, npc);
              if (wc.action === 'start_community_event' && wc.details) await this._startCommunityEventFromAgent(wc.details);
            }
          }
          npc.currentActivity = goal.description;
          if (goal.type === 'wander' && npc.state === 'idle') {
            const wx = npc.x + Math.floor(Math.random() * 16 - 8);
            const wy = npc.y + Math.floor(Math.random() * 16 - 8);
            const path = this.world.findPath(npc.x, npc.y, wx, wy, 20);
            if (path?.length) { npc.path = path; npc.pathIndex = 0; npc.state = 'walking'; }
          }
        }
      }

      // 3. DECIDE & ACT (cognitive layer for complex decisions)
      const decision = await cog.decide(this.llm, this.gameTime, nearbyNpcs, this.worldEvents);
      const result = await cog.executeDecision(decision, this.llm, this.gameTime);

      // ★ Handle NPC-NPC conversations — turn-by-turn generation
      if (result?.conversationTarget) {
        // Set both NPCs to talking state during the conversation
        npc.state = 'talking';
        result.conversationTarget.state = 'talking';

        const convData = await cog.generateConversation(
          result.conversationTarget, this.llm, this.gameTime
        );

        // Reset states after conversation
        if (npc.state === 'talking') npc.state = 'idle';
        if (result.conversationTarget.state === 'talking') result.conversationTarget.state = 'idle';

        if (convData && convData.lines.length > 0) {
          // ★ Generative conversation consequences based on what was discussed
          convData.stateChanges = await this._applyConversationConsequences(convData, npc, result.conversationTarget);
          this._addToConversationFeed(convData);
        }
      }

      // 4. ★ GENERATE ACTION DESCRIPTION (paper Section 3.1.1)
      cog.generateActionDescription(this.gameTime);

      // 5. ★ OBJECT STATE UPDATES (paper Section 5.1)
      // Only run occasionally to save API calls
      if (Math.random() < 0.05) {
        await cog.updateObjectStates(this.llm, this.gameTime);
      }

      // 6. ★ ENVIRONMENT KNOWLEDGE — update when near buildings
      if (this.world.environmentTree) {
        const nearBuilding = nearbyBuildings.find(b => {
          const doorX = b.x + (b.w >> 1);
          const doorY = b.y + b.h;
          return Math.abs(npc.x - doorX) + Math.abs(npc.y - doorY) <= 2;
        });
        if (nearBuilding && cog.envKnowledge.currentBuilding !== nearBuilding.name) {
          cog.envKnowledge.enterBuilding(nearBuilding.name, this.world.environmentTree);
        } else if (!nearBuilding && cog.envKnowledge.currentBuilding) {
          cog.envKnowledge.leaveBuilding();
        }
      }

      // 7. REFLECT
      await cog.maybeReflect(this.llm, this.gameTime);

      // 8. ★ PROCESS EMBEDDING QUEUE (async, won't block)
      await cog.processEmbeddings(this.llm);

    } catch (err) {
      console.warn(`Cognitive cycle for ${npc.name} failed:`, err.message);
    }
  }

  // ─── Process Simulation Events ────────────────────────────────────
  _processSimEvents(simEvents) {
    for (const ev of simEvents) {
      const npc = this.npcs.find(n => n.name === ev.agent);
      if (!npc) continue;

      if (ev.type === 'seek_company') {
        // NPC actively walks toward another NPC
        const others = this.npcs.filter(n => n !== npc && npc.distanceTo(n) > 3);
        if (others.length > 0 && npc.state === 'idle') {
          const target = others[Math.floor(Math.random() * others.length)];
          const path = this.world.findPath(npc.x, npc.y, target.x, target.y, 30);
          if (path && path.length > 0) {
            npc.path = path; npc.pathIndex = 0; npc.state = 'walking';
            npc.currentActivity = `Going to talk to ${target.name}`;
            // ★ Show in feed
            this._addToConversationFeed({
              speaker1: `🚶 ${npc.name}`,
              speaker2: target.name,
              lines: [{ speaker: npc.name, text: `Feeling lonely — going to find ${target.name}` }],
              topic: 'seeking',
              location: '',
              gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
            });
          }
        }
      }

      if (ev.type === 'seek_romance') {
        const prospects = this.npcs.filter(a => {
          if (a.name === npc.name || a.sim?.partner) return false;
          const rel = npc.simRelationships?.get(a.name);
          return rel && rel.attraction > 0.3;
        });
        if (prospects.length > 0 && npc.state === 'idle') {
          const target = prospects[0];
          npc.currentActivity = `Thinking about ${target.name}...`;
        }
      }

      if (ev.type === 'buy_food' && ev.auto) {
        const out = applyConsequence('buy_food', npc, null, this.worldSim, this.npcs);
        const changes = Array.isArray(out) ? out : (out.changes || []);
        for (const c of changes) this.simLog.push({ time: Date.now(), text: c });
        for (const t of out.transactions || []) {
          const who = this.npcs.find(n => n.name === t.agentName);
          if (who?.sim) {
            who.sim.transactions = who.sim.transactions || [];
            who.sim.transactions.push({ amount: t.amount, reason: t.reason, gameTime: this.gameTime });
            if (who.sim.transactions.length > 50) who.sim.transactions.shift();
          }
          // ★ Transaction animation
          this._showTransactionAnimation(who || npc, t);
        }
      }

      // ★ AWARENESS EVENTS — simulation state becomes agent memories
      if (ev.type === 'awareness' && npc.cognition) {
        npc.cognition.memory.add(ev.text, 'observation', ev.importance || 5, this.gameTime);
        // Also add as hot topic so they'll talk about it
        npc.cognition.addHotTopic(ev.text, 'personal experience', ev.importance || 5, this.gameTime);
      }

      if (ev.type === 'world_awareness' && npc.cognition) {
        npc.cognition.memory.add(ev.text, 'event', ev.importance || 7, this.gameTime);
        npc.cognition.addHotTopic(ev.text, 'village situation', ev.importance || 7, this.gameTime);
      }
    }
  }

  // ★ Show floating text + gold particles for a transaction
  _showTransactionAnimation(npc, transaction) {
    if (!this.renderer || !npc) return;
    const px = npc.px + TILE_SIZE / 2;
    const py = npc.py - 8;
    const amt = transaction.amount;

    if (amt < 0) {
      // Spending money — red text, gold particles flying away
      this.renderer.addFloatingText(px, py, `${amt.toFixed(0)}g`, '#ff6b6b', 13, 2.2);
      // Item gained text (slightly offset)
      if (transaction.reason) {
        this.renderer.addFloatingText(px, py - 18, `+ ${transaction.reason.replace('bought ', '')}`, '#7bed9f', 11, 2.0);
      }
      // Gold coin particles scatter outward
      for (let i = 0; i < 6; i++) {
        this.renderer.addParticle(
          px + (Math.random() - 0.5) * 16,
          py + Math.random() * 8,
          'gold'
        );
      }
    } else if (amt > 0) {
      // Earning money — green/gold text, gold particles gathering
      this.renderer.addFloatingText(px, py, `+${amt.toFixed(0)}g`, '#FFD700', 14, 2.2);
      if (transaction.reason && transaction.reason !== 'work') {
        this.renderer.addFloatingText(px, py - 18, transaction.reason, '#ffd32a', 10, 2.0);
      }
      // Gold sparkle particles
      for (let i = 0; i < 8; i++) {
        this.renderer.addParticle(
          px + (Math.random() - 0.5) * 24,
          py + (Math.random() - 0.5) * 12,
          'gold'
        );
      }
    }

    // Speech bubble for significant transactions
    if (Math.abs(amt) >= 5 && !npc.speechBubble) {
      const phrases = amt < 0
        ? ['Worth every coin.', 'I needed that.', 'Money well spent.', 'A fair price.']
        : ['Good deal!', 'Business is good!', 'Ka-ching!', 'Nice profit!'];
      npc.say(phrases[Math.floor(Math.random() * phrases.length)], 3000);
    }

    // ★ Add to conversation feed with state change info
    const sign = amt < 0 ? '' : '+';
    const verb = transaction.reason || (amt < 0 ? 'spent gold' : 'earned gold');
    const wealthNow = npc.sim?.status?.wealth?.toFixed(0) || '?';
    this._addToConversationFeed({
      speaker1: `💰 ${npc.name}`,
      speaker2: '',
      lines: [{ speaker: npc.name, text: `${verb} (${sign}${amt.toFixed(0)} gold)` }],
      stateChanges: [`${npc.name}: wealth ${sign}${amt.toFixed(0)} → ${wealthNow}`],
      topic: 'transaction',
      location: npc.currentActivity || '',
      gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
    });
  }

  // ★ Update agent motivation summaries and world context (called periodically)
  _updateAgentWorldContext() {
    if (!this.worldSim) return;
    const ws = this.worldSim;

    // ★ Build RICH world context — mix of crises, neutral facts, and positive observations
    //    so conversations aren't always about food shortages
    const facts = [];

    // Leadership
    if (ws.governance.leader) facts.push(`${ws.governance.leader} leads the village`);

    // Economy — describe it in words, not just crisis alerts
    if (ws.economy.prosperity > 70) facts.push('The village is thriving economically');
    else if (ws.economy.prosperity > 45) facts.push('The economy is stable');
    else if (ws.economy.prosperity < 30) facts.push('The economy is struggling');

    // Unrest
    if (ws.governance.unrest > 60) facts.push(`Tension is high among the villagers (${ws.governance.unrest.toFixed(0)}% unrest)`);
    else if (ws.governance.unrest < 15) facts.push('The village is peaceful and harmonious');

    // Food — only mention if truly critical (not mild shortage)
    if (ws.resources.food < this.npcs.length * 1.5) {
      facts.push(`Food reserves are dangerously low`);
    } else if (ws.resources.food > this.npcs.length * 8) {
      facts.push('Food is plentiful');
    }

    // Recent partnerships/relationships — social flavor
    for (const npc of this.npcs) {
      if (npc.sim?.partner) {
        facts.push(`${npc.name} and ${npc.sim.partner} are partners`);
        break; // only mention one to keep it short
      }
    }

    // Recent community events
    if (this.worldEvents.length > 0) {
      facts.push(`Current events: ${this.worldEvents.map(e => e.description).join('; ')}`);
    }

    // Population
    facts.push(`Population: ${ws.population}`);

    const worldContext = facts.join('. ') + '.';

    for (const npc of this.npcs) {
      // Set world context on each NPC (read by getAgentSummary)
      npc._worldContext = worldContext;

      // Set motivation summary on each NPC
      npc._motivationSummary = getMotivationSummary(npc, this.npcs, this.worldSim);
    }
  }

  // ─── Generative Conversation Consequences ───────────────────────
  // After any conversation, ask the LLM what changed based on
  // what was ACTUALLY said. A heated argument reduces trust.
  // A heartfelt confession increases attraction. Gossip spreads knowledge.
  async _applyConversationConsequences(convData, npc, otherNpc) {
    if (!this.llm.hasAnyKey() || !convData?.lines?.length) {
      // Fallback: basic socialize effect
      const out = applyConsequence('socialize', npc, otherNpc, this.worldSim, this.npcs);
      return (out.changes || []).map(c => this._formatStateChange(c));
    }

    // Summarize what was discussed
    const transcript = convData.lines.slice(0, 8).map(l => `${l.speaker}: ${l.text}`).join('\n');

    try {
      const effects = await this.llm.generate(
        `You are the consequence engine for a village simulation. Two agents just had a conversation. Based on what was ACTUALLY SAID, determine what state changes should occur. A friendly chat boosts trust. An argument increases rivalry. A confession of love increases attraction. Gossip about a third person spreads knowledge.

AVAILABLE STATE FIELDS:
- Agent needs (0=satisfied, 1=desperate): hunger, rest, social, safety, fun, purpose, romance
- Agent status (0-100): health, wealth, reputation, happiness, energy
- Agent fields: partner (name string or null)
- Relationships: trust, attraction, respect, familiarity, fear, rivalry (0-1), label (string)
- World: governance.unrest (0-100), economy.prosperity (0-100)

OUTPUT (JSON):
{
  "speaker1_effects": {"needs":{"social":-0.2},"status":{"happiness":3}},
  "speaker2_effects": {"needs":{"social":-0.15},"status":{"happiness":2}},
  "relationship": {"trust":0.05,"familiarity":0.04,"label":"friend"},
  "speaker1_set": {},
  "speaker2_set": {},
  "world": {},
  "knowledge_all": null,
  "summary": "Brief summary of what changed and why"
}

RULES:
- Read the actual conversation. What did they talk about?
- Positive conversations boost trust, familiarity, happiness
- Arguments reduce trust, increase rivalry
- Romantic conversations boost attraction
- Gossip about others can spread knowledge_all
- Keep changes proportional to the conversation length and intensity
- Both speakers' social need should decrease (they just socialized)`,

        `CONVERSATION between ${npc.name} (${npc.occupation}) and ${otherNpc.name} (${otherNpc.occupation}):
${transcript}

Topic: ${convData.topic || 'general'}

What state changes result from this conversation?`,
        { json: true, temperature: 0.6, maxTokens: 400 }
      );

      const stateChanges = [];
      const clamp01 = v => Math.max(0, Math.min(1, v));
      const clamp100 = v => Math.max(0, Math.min(100, v));
      const clampD = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

      // Apply speaker1 (npc) effects
      if (effects.speaker1_effects && npc.sim) {
        const e = effects.speaker1_effects;
        if (e.needs) for (const [k, d] of Object.entries(e.needs)) {
          if (typeof d === 'number' && k in npc.sim.needs) {
            npc.sim.needs[k] = clamp01(npc.sim.needs[k] + clampD(d, -0.5, 0.5));
            stateChanges.push(`${npc.name}: ${k} ${d > 0 ? '+' : ''}${d.toFixed(2)}`);
          }
        }
        if (e.status) for (const [k, d] of Object.entries(e.status)) {
          if (typeof d === 'number' && k in npc.sim.status) {
            npc.sim.status[k] = clamp100(npc.sim.status[k] + clampD(d, -25, 25));
            stateChanges.push(`${npc.name}: ${k} ${d > 0 ? '+' : ''}${d.toFixed(0)}`);
          }
        }
      }

      // Apply speaker2 (otherNpc) effects
      if (effects.speaker2_effects && otherNpc.sim) {
        const e = effects.speaker2_effects;
        if (e.needs) for (const [k, d] of Object.entries(e.needs)) {
          if (typeof d === 'number' && k in otherNpc.sim.needs) {
            otherNpc.sim.needs[k] = clamp01(otherNpc.sim.needs[k] + clampD(d, -0.5, 0.5));
            stateChanges.push(`${otherNpc.name}: ${k} ${d > 0 ? '+' : ''}${d.toFixed(2)}`);
          }
        }
        if (e.status) for (const [k, d] of Object.entries(e.status)) {
          if (typeof d === 'number' && k in otherNpc.sim.status) {
            otherNpc.sim.status[k] = clamp100(otherNpc.sim.status[k] + clampD(d, -25, 25));
            stateChanges.push(`${otherNpc.name}: ${k} ${d > 0 ? '+' : ''}${d.toFixed(0)}`);
          }
        }
      }

      // Apply set fields
      if (effects.speaker1_set && npc.sim) for (const [k, v] of Object.entries(effects.speaker1_set)) {
        if (k === 'partner') { npc.sim.partner = v; stateChanges.push(`${npc.name}: partner → ${v}`); }
      }
      if (effects.speaker2_set && otherNpc.sim) for (const [k, v] of Object.entries(effects.speaker2_set)) {
        if (k === 'partner') { otherNpc.sim.partner = v; stateChanges.push(`${otherNpc.name}: partner → ${v}`); }
      }

      // Apply relationship changes
      if (effects.relationship) {
        const rel = npc.simRelationships?.get(otherNpc.name) || { trust: 0.3, attraction: 0.1, respect: 0.3, familiarity: 0.2, fear: 0, rivalry: 0, interactions: 1, label: 'stranger' };
        if (!npc.simRelationships) npc.simRelationships = new Map();
        if (!npc.simRelationships.has(otherNpc.name)) npc.simRelationships.set(otherNpc.name, rel);

        const tRel = otherNpc.simRelationships?.get(npc.name) || { trust: 0.3, attraction: 0.1, respect: 0.3, familiarity: 0.2, fear: 0, rivalry: 0, interactions: 1, label: 'stranger' };
        if (!otherNpc.simRelationships) otherNpc.simRelationships = new Map();
        if (!otherNpc.simRelationships.has(npc.name)) otherNpc.simRelationships.set(npc.name, tRel);

        const rc = effects.relationship;
        for (const dim of ['trust', 'attraction', 'respect', 'familiarity', 'fear', 'rivalry']) {
          if (typeof rc[dim] === 'number') {
            rel[dim] = clamp01(rel[dim] + clampD(rc[dim], -0.4, 0.4));
            tRel[dim] = clamp01(tRel[dim] + clampD(rc[dim], -0.4, 0.4));
            stateChanges.push(`${npc.name} ↔ ${otherNpc.name}: ${dim} ${rc[dim] > 0 ? '+' : ''}${rc[dim].toFixed(2)}`);
          }
        }
        if (rc.label) {
          rel.label = rc.label;
          tRel.label = rc.label;
          stateChanges.push(`${npc.name} ↔ ${otherNpc.name}: label → ${rc.label}`);
        }
        rel.interactions++;
        tRel.interactions++;
      }

      // World + knowledge
      if (effects.knowledge_all && typeof effects.knowledge_all === 'string') {
        for (const a of this.npcs) { if (a.sim) a.sim.knowledge.add(effects.knowledge_all); }
        stateChanges.push(`Everyone learned: "${effects.knowledge_all}"`);
      }

      return stateChanges.map(c => this._formatStateChange(c));
    } catch (err) {
      console.warn('Conversation consequence gen failed:', err.message);
      const out = applyConsequence('socialize', npc, otherNpc, this.worldSim, this.npcs);
      return (out.changes || []).map(c => this._formatStateChange(c));
    }
  }

  // ─── Format state change strings with color markup ─────────────
  _formatStateChange(text) {
    // Highlight increases in green, decreases in red, assignments in yellow
    return text
      .replace(/\+[\d.]+/g, m => `<span class="up">${m}</span>`)
      .replace(/-[\d.]+/g, m => `<span class="down">${m}</span>`)
      .replace(/→\s*(.+?)(?=,|$|\))/g, (m, val) => `→ <span class="set">${val}</span>`);
  }

  // ─── Conversation Feed ──────────────────────────────────────────
  _addToConversationFeed(convData) {
    convData.timestamp = Date.now();

    // ★ Track conversation quality for adaptive rate limiting
    this._trackConversationResult(convData);

    // ★ Deduplicate: skip if same pair + same SPECIFIC topic in last 90 seconds
    // Don't dedup on generic topics like 'greeting', 'small talk', 'seeking' —
    // these are common and blocking them starves the feed.
    const pair = [convData.speaker1, convData.speaker2].sort().join('+');
    const genericTopics = new Set(['greeting', 'small talk', 'seeking', 'gossip', 'socializing', 'work', 'catching up']);
    const isSpecificTopic = convData.topic && !genericTopics.has(convData.topic);

    if (isSpecificTopic) {
      const isDupe = this.conversationFeed.some(c => {
        const cPair = [c.speaker1, c.speaker2].sort().join('+');
        return cPair === pair && c.topic === convData.topic && (Date.now() - c.timestamp) < 90000;
      });
      if (isDupe) return;
    } else {
      // For generic topics: dedup same pair within 30 seconds
      // ★ For 'seeking' specifically: also dedup by initiator — one seeking entry per agent per 45s
      const seekWindow = convData.topic === 'seeking' ? 45000 : 30000;
      const isDupe = this.conversationFeed.some(c => {
        const cPair = [c.speaker1, c.speaker2].sort().join('+');
        if (cPair === pair && (Date.now() - c.timestamp) < seekWindow) return true;
        // Same initiator (e.g. 🚶 Kito) seeking anyone — throttle agent-level seeking spam
        if (convData.topic === 'seeking' && c.topic === 'seeking') {
          const init = (convData.speaker1 || '').replace(/^🚶\s*/, '').trim();
          const cInit = (c.speaker1 || '').replace(/^🚶\s*/, '').trim();
          if (init && init === cInit && (Date.now() - c.timestamp) < 45000) return true;
        }
        return false;
      });
      if (isDupe) return;
    }

    this.conversationFeed.push(convData);
    if (this.conversationFeed.length > this.maxFeedEntries) {
      this.conversationFeed.shift();
    }
    this._updateConversationFeedUI();
  }

  // ★ Track conversation quality and adapt cognitive cycle speed
  _trackConversationResult(convData) {
    const lineCount = convData.lines?.length || 0;
    const isRich = lineCount >= 3 && convData.topic !== 'greeting';

    if (isRich) {
      // Good conversation — decrease failure count, speed up cycle
      this.apiFailureCount = Math.max(0, this.apiFailureCount - 1);
    } else if (lineCount <= 2) {
      // Thin/failed conversation — increase failure count, slow down
      this.apiFailureCount++;
    }

    // Adapt cognitive interval: base + 2s per failure, max 15s
    this.cognitiveInterval = Math.min(15000,
      this.baseCognitiveInterval + this.apiFailureCount * 2000
    );

    // Log for debugging
    if (this.apiFailureCount > 2) {
      console.warn(`API stress detected: ${this.apiFailureCount} thin conversations, cognitive interval → ${this.cognitiveInterval}ms`);
    }
  }

  _updateConversationFeedUI() {
    const feed = document.getElementById('conv-feed-list');
    if (!feed) return;

    // Populate both filter dropdowns with NPC names (once)
    const selA = document.getElementById('feed-filter-a');
    const selB = document.getElementById('feed-filter-b');
    if (selA && selA.options.length <= 1 && this.npcs.length > 0) {
      for (const npc of this.npcs) {
        const optA = document.createElement('option');
        optA.value = npc.name; optA.textContent = npc.name;
        selA.appendChild(optA);
        const optB = document.createElement('option');
        optB.value = npc.name; optB.textContent = npc.name;
        selB.appendChild(optB);
      }
      selA.onchange = () => this._updateConversationFeedUI();
      selB.onchange = () => this._updateConversationFeedUI();
    }

    // Filter by selected pair
    const filterA = selA?.value || 'all';
    const filterB = selB?.value || 'all';
    let entries = this.conversationFeed;

    // Match by partial name (LLM might use "Rachel" vs "Rachel Stein")
    function matchesName(speaker, filter) {
      if (!speaker || !filter) return false;
      const s = speaker.toLowerCase();
      const f = filter.toLowerCase();
      return s === f || s.includes(f) || f.includes(s) || s.startsWith(f.split(' ')[0]);
    }

    function conversationInvolves(c, name) {
      if (matchesName(c.speaker1, name) || matchesName(c.speaker2, name)) return true;
      return c.lines?.some(l => matchesName(l.speaker, name));
    }

    if (filterA !== 'all' && filterB !== 'all') {
      entries = entries.filter(c => conversationInvolves(c, filterA) && conversationInvolves(c, filterB));
    } else if (filterA !== 'all') {
      entries = entries.filter(c => conversationInvolves(c, filterA));
    } else if (filterB !== 'all') {
      entries = entries.filter(c => conversationInvolves(c, filterB));
    }

    const recent = entries.slice(-15).reverse();
    const now = Date.now();

    // ★ PRESERVE EXPANDED STATE: remember which entries the user has open
    const expandedEntries = new Set();
    feed.querySelectorAll('.feed-entry:not(.collapsed)').forEach(el => {
      if (el.id) expandedEntries.add(el.id);
    });

    feed.innerHTML = recent.map((c, idx) => {
      const lines = c.lines.map(l =>
        `<div class="feed-line"><b>${l.speaker}:</b> ${l.text}</div>`
      ).join('');
      const lineCount = c.lines.length;

      // Status: "happening now" if < 30s old, otherwise "finished"
      const age = now - (c.timestamp || 0);
      const isLive = age < 30000;
      const statusClass = isLive ? 'feed-status-live' : 'feed-status-done';
      const statusText = isLive ? 'happening now' : 'finished';

      // ★ Special topic tag styling for transactions, seeking, state changes, actions
      const topicClass = c.topic === 'transaction' ? 'feed-topic-tag feed-topic-transaction'
        : c.topic === 'seeking' ? 'feed-topic-tag feed-topic-seeking'
        : c.topic === 'state change' ? 'feed-topic-tag feed-topic-state'
        : c.topic === 'action' ? 'feed-topic-tag feed-topic-action'
        : 'feed-topic-tag';

      const entryId = `feed-entry-${c.timestamp || idx}`;

      // ★ Preserve expanded state: if user had this entry open, keep it open
      const wasExpanded = expandedEntries.has(entryId);
      const collapsedClass = wasExpanded ? '' : 'collapsed';

      // Preview: first line truncated
      const preview = c.lines.length > 0
        ? `<b>${c.lines[0].speaker}:</b> ${c.lines[0].text.substring(0, 60)}${c.lines[0].text.length > 60 ? '...' : ''}`
        : '';

      // ★ State changes section (behavioral value deltas)
      const stateChangesHtml = (c.stateChanges && c.stateChanges.length > 0)
        ? `<div class="feed-state-changes">
            <div class="feed-state-header">State changes:</div>
            ${c.stateChanges.map(sc => `<div class="feed-state-line">${sc}</div>`).join('')}
          </div>`
        : '';

      return `<div class="feed-entry ${collapsedClass}" id="${entryId}">
        <div class="feed-header" onclick="document.getElementById('${entryId}').classList.toggle('collapsed')">
          <div class="feed-header-left">
            <span class="feed-chevron">▾</span>
            <span class="feed-speakers">${c.speaker1}${c.speaker2 ? ' & ' + c.speaker2 : ''}</span>
            <span class="${topicClass}">${c.topic || ''}</span>
          </div>
          <div class="feed-header-right">
            <span class="feed-line-count">${lineCount} line${lineCount !== 1 ? 's' : ''}</span>
            <span class="feed-status ${statusClass}">${statusText}</span>
          </div>
        </div>
        <div class="feed-meta">${c.gameTime || ''} · ${c.location || ''}</div>
        <div class="feed-preview">${preview}</div>
        <div class="feed-lines">${lines}${stateChangesHtml}</div>
      </div>`;
    }).join('') || `<div class="empty-state">${filterA !== 'all' || filterB !== 'all' ? 'No conversations between these two yet' : 'Conversations will appear here...'}</div>`;
  }

  async _processPlanningQueue() {
    while (this.planningQueue.length > 0) {
      const npc = this.planningQueue.shift();
      if (npc.cognition) {
        await npc.cognition.createDailyPlan(this.llm, this.gameTime);
      }
    }
  }

  // ─── Research Data Export ────────────────────────────────────────
  async exportResearchData() {
    this.ui.notify('Generating export...', 'info', 3000);

    const agents = this.npcs.map(npc =>
      npc.cognition ? npc.cognition.getResearchExport() : { agent: { name: npc.name } }
    );
    const network = this._buildRelationshipNetwork();
    const emergent = this._detectEmergentPhenomena();
    const conversationLog = this.conversationFeed.map(c => ({
      speakers: [c.speaker1, c.speaker2].filter(Boolean),
      topic: c.topic,
      location: c.location,
      gameTime: c.gameTime,
      lines: c.lines,
    }));

    // Generate LLM narrative summary if available
    let narrativeSummary = null;
    if (this.llm.hasAnyKey()) {
      try {
        const agentSummaries = agents.map(a => {
          const refs = (a.reflections || []).map(r => r.text).join('; ');
          const rels = Object.entries(a.opinions || {}).map(([name, o]) =>
            `${name}: ${o.currentSentiment} (${o.interactions} interactions${o.history?.length > 0 ? `, evolved: ${o.history.map(h => `${h.from}→${h.to}`).join(', ')}` : ''})`
          ).join('; ');
          return `${a.agent.name} (${a.agent.occupation}): Reflections: [${refs.substring(0, 200)}] Relationships: [${rels.substring(0, 200)}]`;
        }).join('\n');

        const emergentStr = emergent.map(e => `- ${e.type}: ${e.description}`).join('\n');

        narrativeSummary = await this.llm.generate(
          'You are a social scientist analyzing a simulation of autonomous AI agents. Write an engaging narrative report.',
          `Analyze this simulation of ${this.npcs.length} agents in "${this.world?.name}" over ${this.gameTime.day} day(s).

AGENT SUMMARIES:
${agentSummaries}

EMERGENT PHENOMENA DETECTED:
${emergentStr || 'None detected yet.'}

TOTAL CONVERSATIONS: ${conversationLog.length}
INFORMATION FLOW EVENTS: ${this.npcs.reduce((s, n) => s + (n.cognition?.infoFlowLog.length || 0), 0)}

Write a 3-5 paragraph narrative report covering:
1. KEY SOCIAL DYNAMICS: How did relationships evolve? Who became friends? Who had tension?
2. INFORMATION CASCADES: How did news/gossip spread through the community?
3. EMERGENT BEHAVIORS: Did any unexpected social structures, shared beliefs, traditions, power dynamics, or cultural phenomena emerge?
4. NOTABLE MOMENTS: What were the most significant events or conversations?
5. AGENT EVOLUTION: How did individual agents grow or change based on their experiences?

Write it as an engaging story, not a dry report.`,
          { temperature: 0.8, maxTokens: 1500 }
        );
      } catch (err) {
        console.warn('Narrative generation failed:', err.message);
      }
    }

    const data = {
      simulation: {
        worldName: this.world?.name,
        startTime: new Date(this.simulationStartTime).toISOString(),
        exportTime: new Date().toISOString(),
        gameTime: `Day ${this.gameTime.day}, ${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
        duration: `${((Date.now() - this.simulationStartTime) / 60000).toFixed(1)} real minutes`,
        totalAgents: this.npcs.length,
      },
      narrativeSummary,
      emergentPhenomena: emergent,
      agents,
      conversationLog,
      relationshipNetwork: network,
      worldState: this.worldSim ? {
        resources: this.worldSim.resources,
        economy: this.worldSim.economy,
        governance: this.worldSim.governance,
        technology: this.worldSim.technology,
      } : null,
      worldEvents: this.worldEvents.map(e => ({
        type: e.type, location: e.location, description: e.description,
      })),
      informationFlow: this.npcs.flatMap(npc =>
        npc.cognition ? npc.cognition.infoFlowLog : []
      ),
    };

    // Download JSON
    const jsonBlob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const jsonUrl = URL.createObjectURL(jsonBlob);
    const jsonA = document.createElement('a');
    jsonA.href = jsonUrl;
    jsonA.download = `simulation_${this.world?.name || 'world'}_${Date.now()}.json`;
    jsonA.click();
    URL.revokeObjectURL(jsonUrl);

    // Also generate and download an HTML report
    const html = this._generateHTMLReport(data);
    const htmlBlob = new Blob([html], { type: 'text/html' });
    const htmlUrl = URL.createObjectURL(htmlBlob);
    const htmlA = document.createElement('a');
    htmlA.href = htmlUrl;
    htmlA.download = `simulation_report_${this.world?.name || 'world'}_${Date.now()}.html`;
    setTimeout(() => { htmlA.click(); URL.revokeObjectURL(htmlUrl); }, 500);

    this.ui.notify('Exported JSON + HTML report!', 'success');
    return data;
  }

  _buildRelationshipNetwork() {
    const nodes = this.npcs.map(n => ({
      id: n.name, occupation: n.occupation,
      memoryCount: n.cognition?.memory.count() || 0,
      reflectionCount: n.cognition?.memory.countByType('reflection') || 0,
    }));
    const edges = [];
    for (const npc of this.npcs) {
      if (!npc.cognition) continue;
      for (const [name, rel] of npc.cognition.relationships) {
        edges.push({
          from: npc.name, to: name,
          familiarity: rel.familiarity,
          sentiment: rel.sentiment,
          interactions: rel.interactions,
        });
      }
    }
    return { nodes, edges };
  }

  // ─── Emergent Phenomena Detection ─────────────────────────────────
  _detectEmergentPhenomena() {
    const phenomena = [];

    // 1. Shared beliefs: find reflections that appear across multiple agents
    const allReflections = new Map(); // reflection text → [agent names]
    for (const npc of this.npcs) {
      if (!npc.cognition) continue;
      const refs = npc.cognition.memory.getByType('reflection', 50);
      for (const r of refs) {
        const key = r.description.replace('[Reflection] ', '').toLowerCase().trim();
        const keywords = key.split(/\s+/).filter(w => w.length > 4);
        // Check if any other agent has a similar reflection (shared keywords)
        for (const [existingKey, agents] of allReflections) {
          const existingWords = new Set(existingKey.split(/\s+/).filter(w => w.length > 4));
          const overlap = keywords.filter(w => existingWords.has(w)).length;
          if (overlap >= 3 && !agents.includes(npc.name)) {
            agents.push(npc.name);
          }
        }
        if (!allReflections.has(key)) allReflections.set(key, [npc.name]);
      }
    }
    for (const [belief, agents] of allReflections) {
      if (agents.length >= 2) {
        phenomena.push({
          type: 'shared_belief',
          description: `${agents.join(', ')} share a similar belief: "${belief.substring(0, 80)}..."`,
          agents,
          significance: agents.length / this.npcs.length,
        });
      }
    }

    // 2. Social clusters: groups of agents with mutual high trust
    const clusters = [];
    const visited = new Set();
    for (const npc of this.npcs) {
      if (visited.has(npc.name) || !npc.cognition) continue;
      const cluster = [npc.name];
      visited.add(npc.name);
      for (const [name, rel] of npc.cognition.relationships) {
        if (rel.familiarity > 5 && rel.sentiment.includes('friend')) {
          cluster.push(name);
          visited.add(name);
        }
      }
      if (cluster.length >= 3) {
        clusters.push(cluster);
        phenomena.push({
          type: 'social_cluster',
          description: `A social group has formed: ${cluster.join(', ')}`,
          agents: cluster,
          significance: cluster.length / this.npcs.length,
        });
      }
    }

    // 3. Power dynamics: agents with high influence (many interactions, leadership)
    for (const npc of this.npcs) {
      if (!npc.cognition) continue;
      const totalInteractions = [...npc.cognition.relationships.values()]
        .reduce((s, r) => s + r.interactions, 0);
      if (totalInteractions > this.npcs.length * 3) {
        phenomena.push({
          type: 'social_influence',
          description: `${npc.name} is a social hub with ${totalInteractions} total interactions`,
          agents: [npc.name],
          significance: totalInteractions / (this.npcs.length * 5),
        });
      }
    }

    // 4. Information cascades: topics that reached most agents
    const topicReach = new Map();
    for (const npc of this.npcs) {
      if (!npc.cognition) continue;
      for (const topic of npc.cognition.hotTopics) {
        const key = topic.topic.substring(0, 50);
        if (!topicReach.has(key)) topicReach.set(key, new Set());
        topicReach.get(key).add(npc.name);
        for (const spread of topic.spreadTo) topicReach.get(key).add(spread);
      }
    }
    for (const [topic, agents] of topicReach) {
      if (agents.size >= Math.ceil(this.npcs.length * 0.6)) {
        phenomena.push({
          type: 'information_cascade',
          description: `"${topic}" spread to ${agents.size}/${this.npcs.length} agents`,
          agents: [...agents],
          significance: agents.size / this.npcs.length,
        });
      }
    }

    // 5. Relationship evolution: dramatic shifts
    for (const npc of this.npcs) {
      if (!npc.cognition) continue;
      for (const change of npc.cognition.relationshipHistory) {
        if ((change.from === 'stranger' && (change.to === 'friend' || change.to === 'close friend')) ||
            (change.from === 'friend' && change.to === 'complicated')) {
          phenomena.push({
            type: 'relationship_shift',
            description: `${npc.name}'s relationship with ${change.target} evolved: ${change.from} → ${change.to}`,
            agents: [npc.name, change.target],
            significance: 0.5,
          });
        }
      }
    }

    return phenomena.sort((a, b) => b.significance - a.significance);
  }

  // ═══════════════════════════════════════════════════════════════
  //  RESEARCH TAB — Query simulation data with LLM + RAG
  // ═══════════════════════════════════════════════════════════════

  async _handleResearchQuery() {
    const input = document.getElementById('research-input');
    const query = input?.value?.trim();
    if (!query) return;
    input.value = '';

    // Remove welcome message on first query
    const welcome = document.querySelector('.research-welcome');
    if (welcome) welcome.remove();

    // Show user message
    this._addResearchMessage(query, 'user');

    // Show thinking indicator
    const thinkingEl = this._addResearchThinking();

    try {
      // ★ RAG: Gather relevant context based on the query
      const context = this._gatherResearchContext(query);

      if (!this.llm.hasAnyKey()) {
        // No API key — show raw data dump
        thinkingEl.remove();
        this._addResearchMessage(this._formatOfflineResearchAnswer(query, context), 'system');
        return;
      }

      // ★ LLM call with gathered context
      const answer = await this.llm.generate(
        `You are a simulation researcher analyzing a living world simulation called "${this.world?.name || 'Unknown'}". 
You have access to detailed data about every agent's memories, goals, relationships, and the world state.
Answer the user's research question using ONLY the provided simulation data. Be specific — cite agent names, exact events, and timeline details.
Format your answer with clear structure. Use **bold** for agent names and key findings. Use bullet points for lists.
If the data doesn't contain enough info to answer, say so honestly.`,

        `RESEARCH QUESTION: "${query}"

${context}

Answer the research question based on the simulation data above. Be analytical and specific.`,
        { temperature: 0.5, maxTokens: 1500 }
      );

      thinkingEl.remove();
      this._addResearchMessage(answer, 'system');
    } catch (err) {
      thinkingEl.remove();
      this._addResearchMessage(`Error: ${err.message}. Try a simpler question or check your API key.`, 'system');
    }

    // Scroll to bottom
    const container = document.getElementById('research-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  // ★ RAG context builder — gathers relevant data based on the query
  _gatherResearchContext(query) {
    const q = query.toLowerCase();
    const sections = [];
    const fmt = (v, d = 0) => (typeof v === 'number' ? v.toFixed(d) : v ?? '?');

    // ── Always include: world overview ──
    if (this.worldSim) {
      const ws = this.worldSim;
      const res = ws.resources || {};
      const resStr = Object.entries(res).map(([k, v]) => `${k}: ${fmt(v, 0)}`).join(', ') || 'none';
      sections.push(`WORLD STATE:
- Name: ${this.world?.name}, Day ${this.gameTime.day}, ${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}
- Resources: ${resStr}
- Leader: ${ws.governance?.leader || 'None'}, Unrest: ${fmt(ws.governance?.unrest, 1)}%, Prosperity: ${fmt(ws.economy?.prosperity, 1)}
- Population: ${ws.population ?? '?'}, Treasury: ${fmt(ws.economy?.treasury, 0)}`);
    }

    // ── Detect which agents the query is about ──
    const mentionedAgents = this.npcs.filter(npc =>
      q.includes(npc.name.toLowerCase()) || q.includes(npc.name.split(' ')[0].toLowerCase())
    );
    const targetAgents = mentionedAgents.length > 0 ? mentionedAgents : this.npcs;

    // ── Agent memories (if query is about memories, evolution, timeline) ──
    const wantsMemories = /memor|remember|evolv|timeline|history|changed|grew|develop|over time|progression/i.test(q);
    if (wantsMemories) {
      for (const npc of targetAgents) {
        if (!npc.cognition) continue;
        const mems = npc.cognition.memory.entries.slice(-30); // last 30 memories
        if (mems.length === 0) continue;
        const memStr = mems.map(m =>
          `  [${m.type}${m.gameDay ? ` Day${m.gameDay}` : ''}${m.gameTimeCreated ? ` ${m.gameTimeCreated}` : ''}] ${m.description.substring(0, 150)}`
        ).join('\n');
        sections.push(`MEMORIES OF ${npc.name.toUpperCase()} (${npc.occupation}):\n${memStr}`);
      }
    }

    // ── Goals and motivations ──
    const wantsGoals = /goal|motiv|want|plan|intend|doing|action|purpose|concern|aspir/i.test(q);
    if (wantsGoals) {
      for (const npc of targetAgents) {
        if (!npc.cognition) continue;
        const parts = [];
        if (npc.currentActivity) parts.push(`Current: ${npc.currentActivity}`);
        if (npc._motivationSummary) parts.push(`Motivations:\n${npc._motivationSummary}`);
        if (npc.cognition.dailyPlan?.length > 0) {
          parts.push(`Daily plan: ${npc.cognition.dailyPlan.map(p => p.activity || p).join(' → ')}`);
        }
        if (npc.sim) {
          const urgentNeeds = Object.entries(npc.sim.needs || {}).filter(([,v]) => typeof v === 'number' && v > 0.6).map(([k,v]) => `${k}:${fmt(v, 2)}`);
          if (urgentNeeds.length) parts.push(`Urgent needs: ${urgentNeeds.join(', ')}`);
        }
        if (parts.length > 0) {
          sections.push(`GOALS OF ${npc.name.toUpperCase()} (${npc.occupation}):\n${parts.join('\n')}`);
        }
      }
    }

    // ── Relationships ──
    const wantsRelationships = /relation|friend|enemy|rival|trust|love|partner|social|between|connect|interact|bond/i.test(q);
    if (wantsRelationships) {
      for (const npc of targetAgents) {
        if (!npc.simRelationships || npc.simRelationships.size === 0) continue;
        const rels = [];
        for (const [name, rel] of npc.simRelationships) {
          const r = rel || {};
          rels.push(`  ${name}: ${r.label || '?'} (trust:${fmt(r.trust, 2)}, attraction:${fmt(r.attraction, 2)}, respect:${fmt(r.respect, 2)}, rivalry:${fmt(r.rivalry, 2)}, interactions:${r.interactions ?? '?'})`);
        }
        if (npc.cognition?.relationshipHistory?.length > 0) {
          const evolutions = npc.cognition.relationshipHistory.map(h =>
            `  ${h.target}: ${h.from} → ${h.to} (Day ${h.day || '?'})`
          );
          rels.push(`Relationship changes:\n${evolutions.join('\n')}`);
        }
        sections.push(`RELATIONSHIPS OF ${npc.name.toUpperCase()}:\n${rels.join('\n')}`);
      }
    }

    // ── Emergent behaviors ──
    const wantsEmergent = /emergen|pattern|cluster|group|shared|belief|cascade|spread|phenomen|behavio|dynamic|structure/i.test(q);
    if (wantsEmergent) {
      const phenomena = this._detectEmergentPhenomena();
      if (phenomena.length > 0) {
        sections.push(`EMERGENT PHENOMENA:\n${phenomena.map(p => `- [${p.type}] ${p.description}`).join('\n')}`);
      } else {
        sections.push('EMERGENT PHENOMENA: None detected yet.');
      }
    }

    // ── Conversations ──
    const wantsConversations = /convers|talk|discuss|said|chat|dialogue|spoke|told/i.test(q);
    if (wantsConversations) {
      const relevant = mentionedAgents.length > 0
        ? this.conversationFeed.filter(c =>
            mentionedAgents.some(a => c.speaker1?.includes(a.name) || c.speaker2?.includes(a.name))
          )
        : this.conversationFeed;
      const recentConvs = relevant.slice(-10);
      if (recentConvs.length > 0) {
        const convStr = recentConvs.map(c => {
          const lines = c.lines.map(l => `    ${l.speaker}: ${l.text.substring(0, 100)}`).join('\n');
          return `  [${c.gameTime || '?'}, topic: ${c.topic}] ${c.speaker1} & ${c.speaker2}\n${lines}`;
        }).join('\n');
        sections.push(`RECENT CONVERSATIONS:\n${convStr}`);
      }
    }

    // ── Reflections ──
    const wantsReflections = /reflect|insight|think|believe|opinion|realiz|learn|wisdom/i.test(q);
    if (wantsReflections) {
      for (const npc of targetAgents) {
        if (!npc.cognition) continue;
        const refs = npc.cognition.memory.getByType('reflection', 10);
        if (refs.length === 0) continue;
        const refStr = refs.map(r => `  - ${r.description.substring(0, 150)}`).join('\n');
        sections.push(`REFLECTIONS OF ${npc.name.toUpperCase()}:\n${refStr}`);
      }
    }

    // ── Information flow / gossip ──
    const wantsGossip = /gossip|information|spread|news|topic|rumor|flow|diffus/i.test(q);
    if (wantsGossip) {
      for (const npc of targetAgents) {
        if (!npc.cognition) continue;
        const topics = npc.cognition.hotTopics;
        if (topics.length === 0) continue;
        const topicStr = topics.map(t =>
          `  - "${(t.topic || '').substring(0, 80)}" (from: ${t.source || '?'}, spread to: ${Array.isArray(t.spreadTo) ? t.spreadTo.length : 0} people)`
        ).join('\n');
        sections.push(`GOSSIP OF ${npc.name.toUpperCase()}:\n${topicStr}`);
      }
    }

    // ── Agent status overview (if asking general or "who" questions) ──
    const wantsOverview = /who|everyone|all character|all agent|overview|summary|each|status|state/i.test(q);
    if (wantsOverview || sections.length <= 1) {
      // Include a compact overview of all agents
      const agentOverviews = this.npcs.map(npc => {
        const parts = [`${npc.name} (${npc.occupation})`];
        if (npc.currentActivity) parts.push(`doing: ${npc.currentActivity}`);
        if (npc.sim) {
          const s = npc.sim, st = s.status || {}, nd = s.needs || {};
          if (s.partner) parts.push(`partner: ${s.partner}`);
          parts.push(`happiness: ${fmt(st.happiness, 0)}`);
          parts.push(`wealth: ${fmt(st.wealth, 0)}`);
          const topNeed = Object.entries(nd).sort((a,b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
          if (topNeed && typeof topNeed[1] === 'number' && topNeed[1] > 0.5) parts.push(`urgent need: ${topNeed[0]}(${fmt(topNeed[1], 2)})`);
        }
        if (npc.cognition) {
          parts.push(`memories: ${npc.cognition.memory.count()}`);
          parts.push(`relationships: ${npc.cognition.relationships.size}`);
        }
        return `- ${parts.join(', ')}`;
      }).join('\n');
      sections.push(`AGENT OVERVIEW:\n${agentOverviews}`);
    }

    return sections.join('\n\n');
  }

  // Offline answer when no API key
  _formatOfflineResearchAnswer(query, context) {
    return `**No API key configured** — showing raw simulation data for your query.\n\nTo get AI-analyzed answers, add an API key in Settings.\n\n---\n\n${context}`;
  }

  _addResearchMessage(text, type) {
    const container = document.getElementById('research-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `research-msg research-msg-${type}`;

    if (type === 'system') {
      // Light markdown rendering: **bold**, bullet lists, newlines
      let html = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/^(\d+)\. (.+)$/gm, '<li>$1. $2</li>')
        .replace(/\n/g, '<br>');
      // Wrap consecutive <li> in <ul>
      html = html.replace(/((?:<li>.*?<\/li><br>?)+)/g, '<ul>$1</ul>');
      html = html.replace(/<br><\/ul>/g, '</ul>');
      html = html.replace(/<ul><br>/g, '<ul>');
      div.innerHTML = html;
    } else {
      div.textContent = text;
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    this.researchHistory.push({ role: type, text });
    return div;
  }

  _addResearchThinking() {
    const container = document.getElementById('research-messages');
    if (!container) return document.createElement('div');
    const div = document.createElement('div');
    div.className = 'research-thinking';
    div.innerHTML = '<div class="spinner" style="display:inline-block;width:12px;height:12px;margin:0 6px 0 0;vertical-align:middle"></div>Analyzing simulation data...';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  // ─── HTML Report Generation ────────────────────────────────────
  _generateHTMLReport(data) {
    const agents = data.agents || [];
    const emergent = data.emergentPhenomena || [];
    const convs = data.conversationLog || [];

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Simulation Report — ${data.simulation.worldName}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;padding:40px;max-width:900px;margin:0 auto;line-height:1.7}
h1{font-size:28px;font-weight:700;margin-bottom:8px;color:#fff}
h2{font-size:20px;font-weight:600;margin:32px 0 12px;color:#fff;border-bottom:1px solid #222;padding-bottom:8px}
h3{font-size:15px;font-weight:600;margin:20px 0 8px;color:#ccc}
.meta{font-size:12px;color:#666;margin-bottom:24px}
.narrative{background:#111;border-left:3px solid #4a9eff;padding:16px 20px;margin:16px 0;border-radius:0 8px 8px 0;line-height:1.8;font-size:14px;white-space:pre-line}
.card{background:#111;border:1px solid #1a1a2a;border-radius:8px;padding:16px;margin:12px 0}
.card-title{font-size:13px;font-weight:600;color:#fff;margin-bottom:8px}
.card-subtitle{font-size:10px;color:#666;margin-bottom:8px}
.badge{display:inline-block;font-size:9px;padding:2px 8px;border-radius:10px;margin-right:4px;font-weight:500}
.badge-belief{background:rgba(167,139,250,.15);color:#a78bfa}
.badge-cluster{background:rgba(46,204,113,.15);color:#2ecc71}
.badge-influence{background:rgba(241,196,15,.15);color:#f1c40f}
.badge-cascade{background:rgba(74,158,255,.15);color:#4a9eff}
.badge-shift{background:rgba(231,76,60,.15);color:#e74c3c}
.timeline{border-left:2px solid #222;padding-left:16px;margin:8px 0}
.timeline-item{margin:8px 0;font-size:11px;position:relative}
.timeline-item::before{content:'';position:absolute;left:-20px;top:6px;width:8px;height:8px;background:#333;border-radius:50%}
.timeline-item.reflection::before{background:#a78bfa}
.timeline-item.dialogue::before{background:#4a9eff}
.timeline-item.event::before{background:#e74c3c}
.timeline-item.plan::before{background:#2ecc71}
.timeline-time{color:#555;font-size:9px;margin-right:6px}
.rel-evolution{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px}
.rel-arrow{color:#555}
.conv-block{background:#0d0d14;border:1px solid #1a1a2a;border-radius:6px;padding:12px;margin:8px 0;font-size:11px}
.conv-line{margin:2px 0}.conv-line b{color:#ccc;font-weight:500}
.conv-meta{font-size:9px;color:#555;margin-bottom:6px}
.stat{display:inline-block;margin:4px 8px 4px 0;font-size:11px;color:#888}
.stat b{color:#ccc}
</style></head><body>
<h1>${data.simulation.worldName} — Simulation Report</h1>
<div class="meta">${data.simulation.gameTime} · ${data.simulation.duration} · ${data.simulation.totalAgents} agents · Exported ${new Date(data.simulation.exportTime).toLocaleString()}</div>

${data.narrativeSummary ? `<h2>Narrative Summary</h2><div class="narrative">${data.narrativeSummary}</div>` : ''}

<h2>Emergent Phenomena</h2>
${emergent.length > 0 ? emergent.map(e => `<div class="card">
  <span class="badge badge-${e.type === 'shared_belief' ? 'belief' : e.type === 'social_cluster' ? 'cluster' : e.type === 'social_influence' ? 'influence' : e.type === 'information_cascade' ? 'cascade' : 'shift'}">${e.type.replace('_', ' ')}</span>
  <div style="margin-top:6px;font-size:12px">${e.description}</div>
</div>`).join('') : '<div style="color:#555;font-size:12px">No major emergent phenomena detected yet. Run the simulation longer for patterns to develop.</div>'}

<h2>Agent Profiles</h2>
${agents.map(a => `<div class="card">
  <div class="card-title">${a.agent.name}</div>
  <div class="card-subtitle">${a.agent.occupation}, age ${a.agent.age} · ${a.agent.personality?.substring(0, 100) || ''}</div>
  <div style="margin:8px 0">
    <span class="stat"><b>${a.stats?.totalMemories || 0}</b> memories</span>
    <span class="stat"><b>${a.stats?.reflections || 0}</b> reflections</span>
    <span class="stat"><b>${a.stats?.dialogues || 0}</b> dialogues</span>
    <span class="stat"><b>${a.stats?.relationshipCount || 0}</b> relationships</span>
  </div>

  ${(a.reflections || []).length > 0 ? `<h3>Reflections (Beliefs & Insights)</h3>
  <div class="timeline">${(a.reflections || []).map(r => `<div class="timeline-item reflection">
    <span class="timeline-time">Day ${r.day || '?'} ${r.time || ''}</span> ${r.text.replace('[Reflection] ', '')}
  </div>`).join('')}</div>` : ''}

  ${Object.keys(a.opinions || {}).length > 0 ? `<h3>Opinions & Relationship Evolution</h3>
  ${Object.entries(a.opinions || {}).map(([name, o]) => `<div style="margin:6px 0">
    <div style="font-size:11px"><b>${name}</b>: ${o.currentSentiment} (${o.interactions} interactions)</div>
    ${(o.history || []).length > 0 ? o.history.map(h => `<div class="rel-evolution">
      <span class="timeline-time">interaction</span>
      <span>${h.from}</span> <span class="rel-arrow">→</span> <span style="color:${h.to.includes('friend') ? '#2ecc71' : h.to.includes('tense') ? '#e74c3c' : '#ccc'}">${h.to}</span>
    </div>`).join('') : '<div style="font-size:10px;color:#555;margin-left:8px">No changes yet</div>'}
  </div>`).join('')}` : ''}
</div>`).join('')}

<h2>Conversation Log (${convs.length} conversations)</h2>
${convs.slice(-20).map(c => `<div class="conv-block">
  <div class="conv-meta">${c.gameTime || ''} · ${c.location || ''} · ${c.topic || ''}</div>
  ${(c.lines || []).map(l => `<div class="conv-line"><b>${l.speaker}:</b> ${l.text}</div>`).join('')}
</div>`).join('') || '<div style="color:#555">No conversations recorded.</div>'}

<h2>Relationship Network</h2>
<div class="card">
${(data.relationshipNetwork?.edges || []).map(e =>
  `<div style="font-size:11px;margin:3px 0"><b>${e.from}</b> → <b>${e.to}</b>: ${e.sentiment} (familiarity: ${e.familiarity?.toFixed?.(1) || e.familiarity}, ${e.interactions} interactions)</div>`
).join('')}
</div>

</body></html>`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  COMMAND SYSTEM (world modification with events)
  // ═══════════════════════════════════════════════════════════════
  async executeCommand() {
    const text = this.ui.getCommandInput();
    if (!text) return;
    this.ui.closeCommandBar();

    // ★ Check for community events FIRST (works with or without API)
    const eventType = detectEventType(text);
    if (eventType) {
      this._startCommunityEvent(eventType, text);
      return;
    }

    if (!this.llm.hasAnyKey()) {
      this._handleDemoCommand(text);
      return;
    }

    this.ui.notify('Processing command...', 'info', 2000);

    try {
      // ★ Build available actions list from worldDef
      const wdActions = this.worldDef ? this.worldDef.actions.map(a => `"${a.id}": ${a.description}`).join('\n  ') : '';
      const wdResources = this.worldDef ? Object.keys(this.worldSim?.resources || {}).join(', ') : 'food, gold, wood, stone';

      const systemPrompt = `You are a world modification engine for a 2D pixel world called "${this.world.name}".

Buildings: ${this.world.buildings.map(b => `${b.name} (${b.type})`).join(', ')}
Characters: ${this.npcs.map(n => `${n.name} (${n.occupation})`).join(', ')}
Active events: ${this.worldEvents.map(e => e.description).join(', ') || 'none'}
Resources: ${wdResources}

The user wants to modify the world. Interpret their request and respond with JSON:
{
  "action": "agent_action" | "add_building" | "add_character" | "modify_terrain" | "event_fire" | "event_rain" | "event_magic" | "world_event" | "announce" | "npc_action" | "stop_event" | "custom",
  "details": {
    "name": "optional name",
    "type": "building/terrain/event type",
    "target": "building name or NPC name if relevant",
    "actionId": "action ID from world schema if using agent_action",
    "message": "announcement text if relevant",
    "description": "what is happening",
    "severity": "minor|moderate|major|catastrophic",
    "duration": 30000
  },
  "response": "Brief description of what happened (shown to player)"
}

ACTION TYPES:
- "agent_action": Make a CHARACTER perform a world action. Set details.target to the NPC name, details.actionId to one of the available actions below.
- "world_event": ANY dramatic event affecting the whole village (earthquake, plague, invasion, economic crisis, etc.)
- "event_fire"/"event_rain"/"event_magic": specific visual events
- "npc_action": make an NPC say/go_to/follow (details.type = "say"|"go_to"|"follow")
- "add_building"/"add_character"/"modify_terrain": physical world changes
- "announce": minor announcements only
- "custom": anything not covered above — describe the desired effect in details.description

AVAILABLE WORLD ACTIONS (for agent_action):
  ${wdActions}

RULES:
- If the user says "Elena opens a shop" → agent_action, target:"Elena", actionId:"open_business"
- If the user says "earthquake" → world_event with severity and description
- If the user says something not in the action list → "custom" with a clear description
- Use "world_event" for dramatic events, NOT "announce"
For "event_fire", set details.target to the building name.`;

      const result = await this.llm.generate(systemPrompt, text, { json: true, temperature: 0.7, maxTokens: 512 });
      this._applyCommand(result);
      this.ui.notify(result.response || 'Done!', 'success', 4000);
    } catch (err) {
      console.error('Command error:', err);
      this.ui.notify(`Error: ${err.message}`, 'error');
    }
  }

  _handleDemoCommand(text) {
    const lower = text.toLowerCase();

    // ★ Check for community events first
    const eventType = detectEventType(lower);
    if (eventType) {
      this._startCommunityEvent(eventType, text);
      return;
    }

    if (lower.includes('fire') || lower.includes('burn')) {
      const building = this.world.buildings[0];
      if (building) {
        this.addWorldEvent('fire', building.x + building.w / 2, building.y + building.h / 2, {
          location: building.name,
          description: `${building.name} is on fire!`,
          duration: 20000,
        });
      }
    } else if (lower.includes('rain') || lower.includes('storm')) {
      this.addWorldEvent('rain', this.player.x, this.player.y, {
        description: 'A rainstorm has started!',
        duration: 15000,
      });
    } else {
      this.ui.notify('Try: "election", "festival", "meeting", "fire", "rain"', 'info', 4000);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  COMMUNITY EVENT LAUNCHER
  // ═══════════════════════════════════════════════════════════════
  async _startCommunityEvent(type, topic) {
    if (this.communityEvent?.active) {
      this.ui.notify('An event is already in progress! Wait for it to finish.', 'error', 3000);
      return;
    }

    const eventBuilding = this._pickEventBuilding(type, this.player.x, this.player.y);
    if (!eventBuilding) {
      this.ui.notify('No suitable building found for the event!', 'error');
      return;
    }

    // ★ For dynamic events (wedding, funeral, duel, etc.) — generate phases via LLM
    let opts = {};
    if ((type === 'dynamic' || type === 'gathering') && this.llm.hasAnyKey()) {
      try {
        opts = await this._generateEventPhases(this.llm, topic, null);
      } catch (e) { console.warn('Generate event phases failed:', e); }
    }

    // Use 'gathering' as the fallback template for dynamic events
    const templateType = type === 'dynamic' ? 'gathering' : type;
    this.communityEvent = new CommunityEvent(templateType, eventBuilding, topic, this.npcs, this, opts);
    this.ui.notify(`${this.communityEvent.name} starting at ${eventBuilding.name}!`, 'success', 6000);
  }

  // Agent-initiated: pick building by world center (no player position)
  async _startCommunityEventFromAgent(details) {
    if (this.communityEvent?.active) return;
    const type = details.type || 'meeting';
    const topic = details.topic || (details.caller ? `${type} called by ${details.caller}` : type);
    const cx = this.world.cols >> 1;
    const cy = this.world.rows >> 1;
    const eventBuilding = this._pickEventBuilding(type, cx, cy);
    if (!eventBuilding) return;
    // ★ Generate phases for ANY event type via LLM (not just gatherings)
    let opts = {};
    if (this.llm.hasAnyKey()) {
      try {
        opts = await this._generateEventPhases(this.llm, topic, details.caller);
      } catch (e) { console.warn('Generate event phases failed:', e); }
    }
    this.communityEvent = new CommunityEvent(type, eventBuilding, topic, this.npcs, this, opts);
    this.ui.notify(`${details.caller || 'Someone'} initiated: "${this.communityEvent.name}" at ${eventBuilding.name}.`, 'success', 6000);
  }

  async _generateEventPhases(llm, topic, caller) {
    const result = await llm.generate(
      'Generate a structured event for a village simulation. JSON only.',
      `A community event is happening in the village.
Topic: "${topic}" (initiated by: ${caller || 'the community'}).

Generate an appropriate event name and 3-6 phases. The event can be ANYTHING — a wedding, funeral, coronation, tournament, feast, ritual, duel, auction, celebration, trial, or something entirely new. Design phases that fit the topic naturally.

Each phase: id (short key), label (one descriptive sentence), duration (milliseconds, 5000-25000).
First phase should always be "announce" (spreading the word). Last phase should be a conclusion/wind-down.

Examples:
- Wedding: announce → gather → vows → celebrate → farewell
- Funeral: announce → procession → eulogy → mourning → farewell
- Tournament: announce → gather → competition → finals → awards

Reply: {"name":"Event Name","phases":[{"id":"announce","label":"...","duration":5000},...]}`,
      { json: true, temperature: 0.8, maxTokens: 400 }
    );
    if (!result.name || !result.phases?.length) return {};
    return {
      customName: result.name,
      customPhases: result.phases.map(p => ({ id: p.id || 'phase', duration: Math.min(35000, p.duration || 15000), label: p.label || p.id })),
    };
  }

  _pickEventBuilding(type, nearX, nearY) {
    const formal = this.world.buildings.find(b =>
      /townhall|hall|library|church|temple|school/i.test(b.type)
    );
    const formalTypes = ['election', 'meeting', 'trial', 'debate', 'rally', 'protest'];
    // 'gathering' can be anywhere; use nearest building
    if (formal && formalTypes.includes(type)) return formal;
    let eventBuilding = null;
    let bestDist = Infinity;
    for (const b of this.world.buildings) {
      const dist = Math.abs(nearX - (b.x + b.w / 2)) + Math.abs(nearY - (b.y + b.h / 2));
      if (dist < bestDist) { bestDist = dist; eventBuilding = b; }
    }
    return eventBuilding || this.world.buildings[0];
  }

  _applyCommand(result) {
    const { action, details } = result;

    switch (action) {
      // ★ Agent performs a worldDef action (e.g. "Elena opens a shop")
      case 'agent_action': {
        const targetNpc = details.target
          ? this.npcs.find(n => n.name.toLowerCase().includes((details.target || '').toLowerCase()))
          : null;
        if (!targetNpc) { this.ui.notify('NPC not found', 'error'); break; }
        const actionId = details.actionId || details.type;
        if (!actionId) { this.ui.notify('No action specified', 'error'); break; }

        const actionResult = applyGenericAction(actionId, targetNpc, null, this.worldDef, this.worldSim, this.npcs, details);
        for (const c of actionResult.changes || []) this.ui.notify(c, 'info', 4000);

        // Add to feed
        this._addToConversationFeed({
          speaker1: targetNpc.name, speaker2: '',
          lines: [{ speaker: targetNpc.name, text: details.description || `Performed ${actionId}` }],
          stateChanges: (actionResult.changes || []).map(c => this._formatStateChange(c)),
          topic: 'action', location: '',
          gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
        });

        // NPC says something about it
        targetNpc.say(details.description || `I just ${actionId}!`, 4000);
        if (targetNpc.cognition) {
          targetNpc.cognition.memory.add(`I ${details.description || actionId}.`, 'event', 6, this.gameTime);
        }
        break;
      }

      // ★ Custom action — LLM determines consequences
      case 'custom': {
        const desc = details.description || details.message || 'Something happened';
        // Treat as a world event with LLM-driven consequences
        this.addWorldEvent('custom', this.player.x, this.player.y, {
          location: this.world.name,
          description: desc,
          duration: details.duration || 15000,
          severity: details.severity || 'moderate',
        });
        // Inject into all NPC cognition
        for (const npc of this.npcs) {
          if (npc.cognition) {
            npc.cognition.memory.add(`[EVENT] ${desc}`, 'event', 6, this.gameTime);
            npc.cognition.addHotTopic(desc, 'world event', 6, this.gameTime);
          }
        }
        break;
      }

      case 'event_fire': {
        const building = this.world.buildings.find(b =>
          b.name.toLowerCase().includes((details.target || '').toLowerCase())
        ) || this.world.buildings[0];

        if (building) {
          this.addWorldEvent('fire', building.x + Math.floor(building.w / 2), building.y + Math.floor(building.h / 2), {
            location: building.name,
            description: `${building.name} is on fire!`,
            duration: 25000,
          });
        }
        break;
      }

      case 'event_rain': {
        this.addWorldEvent('rain', this.player.x, this.player.y, {
          description: 'A rainstorm has started!',
          duration: 20000,
        });
        break;
      }

      case 'event_magic':
      case 'event_sparkle': {
        const x = details.target ? this.world.buildings.find(b =>
          b.name.toLowerCase().includes(details.target.toLowerCase()))?.x || this.player.x : this.player.x;
        const y = details.target ? this.world.buildings.find(b =>
          b.name.toLowerCase().includes(details.target.toLowerCase()))?.y || this.player.y : this.player.y;
        this.addWorldEvent('sparkle', x, y, {
          description: details.description || 'Magical energy swirls!',
          duration: 15000,
        });
        break;
      }

      case 'stop_event': {
        this.worldEvents = [];
        this.ui.notify('All events cleared.', 'info');
        break;
      }

      case 'world_event': {
        // ★ Major world events (earthquake, plague, invasion, etc.)
        // Creates a real world event that changes simulation state and NPCs react to
        const desc = details.description || details.message || 'Something dramatic happened!';
        const duration = details.duration || 30000;
        const severity = details.severity || 'major';

        // Create the world event (triggers _applyEventConsequences + NPC broadcast)
        const event = this.addWorldEvent(severity === 'catastrophic' ? 'disaster' : 'crisis',
          this.player.x, this.player.y, {
            location: details.target || this.world.name,
            description: desc,
            duration,
            severity,
          }
        );

        // ★ Inject into EVERY NPC's cognition memory + hot topics (not just entity memory)
        for (const npc of this.npcs) {
          if (npc.cognition) {
            const importance = severity === 'catastrophic' ? 9 : severity === 'major' ? 8 : severity === 'moderate' ? 6 : 4;
            npc.cognition.memory.add(`[MAJOR EVENT] ${desc}`, 'event', importance, this.gameTime);
            npc.cognition.addHotTopic(desc, 'world event', importance, this.gameTime);
          }
          // Visual reaction
          const reactions = [
            'What was that?!', 'Did you feel that?', 'This is terrible!',
            'Everyone stay calm!', 'We need to do something!', 'Is everyone okay?',
          ];
          const delay = Math.random() * 4000;
          setTimeout(() => npc.say(reactions[Math.floor(Math.random() * reactions.length)], 4000), delay);
        }

        // Spawn visual particles
        if (this.renderer) {
          for (let i = 0; i < 15; i++) {
            this.renderer.spawnEffect(
              this.player.x + (Math.random() - 0.5) * 20,
              this.player.y + (Math.random() - 0.5) * 15,
              severity === 'catastrophic' ? 'fire' : 'smoke', 3
            );
          }
        }
        break;
      }

      case 'announce': {
        // ★ Fixed: announcements now also register in cognition memory + hot topics
        const msg = details.message || details.description || 'Attention everyone!';
        this.ui.notify(msg, 'info', 5000);
        for (const npc of this.npcs) {
          npc.perceiveEvent({ type: 'announcement', message: msg });
          if (npc.cognition) {
            npc.cognition.memory.add(`Heard announcement: "${msg}"`, 'event', 5, this.gameTime);
            npc.cognition.addHotTopic(msg, 'announcement', 5, this.gameTime);
          }
          const delay = Math.random() * 2000;
          setTimeout(() => npc.say('Did you hear that?', 3000), delay);
        }
        break;
      }

      case 'add_building': {
        const target = this.world.randomWalkable(this.player.x, this.player.y, 15);
        this._pushBuilding(details, target.x, target.y);
        break;
      }

      case 'add_character': {
        const spawn = this.world.randomWalkable(this.player.x, this.player.y, 5);
        const charData = {
          id: `npc_${this.npcs.length}`,
          name: details.name || 'New Character',
          age: details.age || 25,
          occupation: details.type || details.occupation || 'Wanderer',
          personality: details.description || details.personality || 'Friendly and curious',
          home: details.home || null,
          appearance: details.appearance || {},
          relationships: {},
        };
        const npc = new NPC(spawn.x, spawn.y, charData);

        // ★ Attach full cognitive architecture (so they can think, plan, converse)
        npc.cognition = new CognitiveArchitecture(npc, this.world);

        // ★ Attach simulation state (needs, traits, skills, status)
        npc.sim = createAgentState(charData, this.worldDef);
        npc.simRelationships = new Map();

        // ★ Boost skills based on occupation (from worldDef, not hardcoded)
        const occDef = this.worldDef?.findOccupation(charData.occupation?.toLowerCase());
        const occSkill = occDef?.skill;
        if (occSkill && npc.sim.skills[occSkill] !== undefined) {
          npc.sim.skills[occSkill] = Math.min(10, npc.sim.skills[occSkill] + 3 + Math.random() * 2);
        }

        this.npcs.push(npc);

        // ★ Update world population
        if (this.worldSim) this.worldSim.population = this.npcs.length;

        // ★ Add to agent selector in Agents tab
        const select = document.getElementById('state-agent-select');
        if (select) {
          const opt = document.createElement('option');
          opt.value = npc.id;
          opt.textContent = `${npc.name} (${npc.occupation})`;
          select.appendChild(opt);
        }

        // ★ Everyone learns about the new arrival
        for (const other of this.npcs) {
          if (other === npc) continue;
          if (other.cognition) {
            other.cognition.memory.add(`A newcomer arrived: ${npc.name}, a ${npc.occupation}.`, 'event', 6, this.gameTime);
            other.cognition.addHotTopic(`${npc.name} the ${npc.occupation} just arrived in the village`, 'new arrival', 6, this.gameTime);
          }
          if (other.sim) {
            other.sim.knowledge.add(`${npc.name} is a new ${npc.occupation} in the village`);
          }
        }

        // ★ New NPC gets basic knowledge of the world
        npc.sim.knowledge.add(`I just arrived in ${this.world.name}`);
        for (const b of this.world.buildings) {
          npc.sim.knowledge.add(`There is a ${b.type} called ${b.name}`);
        }
        if (npc.cognition) {
          npc.cognition.memory.add(`I just arrived in ${this.world.name}. Everything is new to me.`, 'event', 7, this.gameTime);
        }

        npc.say(`Hello everyone! I'm ${npc.name}, I just arrived!`, 5000);

        // ★ Post to feed
        this._addToConversationFeed({
          speaker1: 'World', speaker2: '',
          lines: [{ speaker: 'World', text: `${npc.name} the ${npc.occupation} has arrived in the village!` }],
          topic: 'new arrival', location: this.world.name,
          gameTime: `${this.gameTime.hours}:${String(this.gameTime.minutes).padStart(2, '0')}`,
        });

        break;
      }

      case 'modify_terrain': {
        const radius = 3;
        const tileType = {
          forest: TILE.TREE, water: TILE.WATER, park: TILE.GRASS_FLOWER,
          sand: TILE.SAND, path: TILE.PATH_CROSS,
        }[details.type] || TILE.GRASS;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy <= radius * radius) {
              this.world.setTile(this.player.x + dx, this.player.y + dy, tileType);
            }
          }
        }
        break;
      }

      case 'add_decoration': {
        const decoType = {
          tree: TILE.TREE, bench: TILE.BENCH, lamp: TILE.LAMP,
          well: TILE.WELL, rock: TILE.ROCK, bush: TILE.BUSH, fence: TILE.FENCE_H,
        }[details.type] || TILE.TREE;
        const spot = this.world.randomWalkable(this.player.x, this.player.y, 5);
        this.world.setTile(spot.x, spot.y, decoType);
        break;
      }

      case 'npc_action': {
        const targetNpc = this.npcs.find(n =>
          n.name.toLowerCase().includes((details.target || '').toLowerCase())
        );
        if (targetNpc) {
          if (details.type === 'say') {
            targetNpc.say(details.message || 'Hello!', 5000);
          } else if (details.type === 'go_to') {
            const building = this.world.buildings.find(b =>
              b.name.toLowerCase().includes((details.name || '').toLowerCase())
            );
            if (building) targetNpc.goToBuilding(building, this.world);
          } else if (details.type === 'follow') {
            targetNpc.startFollowing(this.player);
            this.ui.notify(`${targetNpc.name} is now following you!`, 'success');
          }
        }
        break;
      }
    }
  }

  // ─── Add building (used by command + agent open_business) ───────
  _pushBuilding(details, x, y) {
    const bType = (details.type || 'house').toLowerCase();
    const bw = bType.includes('tavern') || bType.includes('hall') ? 7 : bType.includes('shop') ? 5 : 5;
    const bh = bType.includes('church') || bType.includes('hall') ? 6 : bType.includes('shop') ? 4 : 4;
    this.world.buildings.push({
      name: details.name || 'New Building',
      type: bType, shape: details.shape || 'default',
      x, y, w: bw, h: bh,
      color: details.color || '#8B7355',
      roofColor: details.roofColor || '#654321',
      owner: details.owner || null,
    });
  }

  // Agent opened a business → add shop to world (no player position; use world center)
  _addBuildingFromSimulation(details, npc) {
    const cx = this.world.cols >> 1;
    const cy = this.world.rows >> 1;
    const refX = npc ? npc.x : cx;
    const refY = npc ? npc.y : cy;
    const target = this.world.randomWalkable(refX, refY, 20);
    this._pushBuilding(details, target.x, target.y);
  }

  // ═══════════════════════════════════════════════════════════════
  //  DEMO WORLD
  // ═══════════════════════════════════════════════════════════════
  _getDemoWorld(description) {
    const count = this.inhabitantCount || 8;
    const allChars = this._getDemoCharacters();
    // Slice to requested count (cycle if more than available)
    const chars = [];
    for (let i = 0; i < count; i++) {
      chars.push(allChars[i % allChars.length]);
    }
    // Deduplicate names if we cycled
    const seen = new Set();
    for (const c of chars) {
      if (seen.has(c.name)) {
        c.name = c.name + ' Jr.';
      }
      seen.add(c.name);
    }
    // ★ Infer basic culture from description for demo worlds too
    const dl = (description || '').toLowerCase();
    let demoWorld = null;

    if (dl.includes('egypt') || dl.includes('pyramid') || dl.includes('pharaoh')) {
      demoWorld = {
        name: 'The Kingdom of Kemet',
        description: description || 'An ancient Egyptian settlement along the banks of the Nile.',
        culture: 'ancient egypt',
        visual: { ground: 'sand', paths: 'stone', vegetation: 'sparse', buildingStyle: 'natural', culturePalette: 'egyptian', roadLayout: 'radial', palette: { primary: '#c4a574', secondary: '#daa520', accent: '#8B7355' } },
        areas: [
          { name: 'Nile Banks', type: 'water' },
          { name: 'Sacred Grove', type: 'park' },
          { name: 'Desert Dunes', type: 'desert' },
          { name: 'Ancient Ruins', type: 'ruins' },
        ],
        buildings: [
          { name: 'Great Pyramid of Khufu', type: 'pyramid', shape: 'pyramid', landmark: true, color: '#c4a574', roofColor: '#daa520' },
          { name: 'Temple of Amun-Ra', type: 'temple', shape: 'dome', landmark: true, color: '#e8d5b0', roofColor: '#daa520' },
          { name: 'Obelisk of the Sun', type: 'obelisk', shape: 'obelisk', landmark: true, color: '#d4c5a0', roofColor: '#daa520' },
          { name: 'Royal Palace', type: 'palace', shape: 'dome', color: '#f5f0e0', roofColor: '#c9a227' },
          { name: 'Market of Thebes', type: 'market', shape: 'default', color: '#c4a574', roofColor: '#8B7355' },
          { name: 'Scribe House', type: 'house', shape: 'default', color: '#d4c5a0', roofColor: '#b0a080' },
          { name: 'Healer Lodge', type: 'hospital', shape: 'default', color: '#e8d5b0', roofColor: '#c4a574' },
          { name: 'Artisan Workshop', type: 'blacksmith', shape: 'default', color: '#8B7355', roofColor: '#6b5335' },
        ],
      };
    } else if (dl.includes('india') || dl.includes('taj') || dl.includes('mughal')) {
      demoWorld = {
        name: 'Agra — The City of Marble',
        description: description || 'A magnificent Mughal city centered around the Taj Mahal.',
        culture: 'mughal india',
        visual: { ground: 'stone', paths: 'stone', vegetation: 'moderate', buildingStyle: 'natural', culturePalette: 'indian', roadLayout: 'radial', palette: { primary: '#f5f5dc', secondary: '#c9a227', accent: '#c0392b' } },
        areas: [
          { name: 'Yamuna River', type: 'water' },
          { name: 'Palace Gardens', type: 'garden' },
          { name: 'Spice Market Square', type: 'plaza' },
        ],
        buildings: [
          { name: 'Taj Mahal', type: 'dome', shape: 'dome', landmark: true, color: '#f5f5dc', roofColor: '#c9a227' },
          { name: 'Red Fort Gate', type: 'castle', shape: 'default', landmark: true, color: '#c0392b', roofColor: '#962d22' },
          { name: 'Mosque Tower', type: 'minaret', shape: 'minaret', landmark: true, color: '#f0e6d0', roofColor: '#c9a227' },
          { name: 'Spice Bazaar', type: 'market', shape: 'default', color: '#e8d5b0', roofColor: '#c9a227' },
          { name: 'Mughal Palace', type: 'palace', shape: 'dome', color: '#f5f0e0', roofColor: '#daa520' },
          { name: 'Tea House', type: 'cafe', shape: 'default', color: '#d4a574', roofColor: '#a0785a' },
          { name: 'Weaver Cottage', type: 'house', shape: 'default', color: '#e8d5b0', roofColor: '#c4a574' },
          { name: 'Healing Temple', type: 'hospital', shape: 'default', color: '#f5f5dc', roofColor: '#d4c5a0' },
        ],
      };
    } else if (dl.includes('japan') || dl.includes('samurai') || dl.includes('shogun')) {
      demoWorld = {
        name: 'Sakura Village',
        description: description || 'A serene Japanese village surrounded by cherry blossoms and bamboo.',
        culture: 'feudal japan',
        visual: { ground: 'grass', paths: 'stone', vegetation: 'lush', buildingStyle: 'natural', culturePalette: 'japanese', roadLayout: 'organic', palette: { primary: '#8b0000', secondary: '#2c2c2c', accent: '#f5f5dc' } },
        areas: [
          { name: 'Cherry Blossom Garden', type: 'park' },
          { name: 'Koi Pond', type: 'water' },
          { name: 'Bamboo Forest', type: 'forest' },
        ],
        buildings: [
          { name: 'Golden Pagoda', type: 'pagoda', shape: 'pagoda', landmark: true, color: '#8b0000', roofColor: '#4a0000' },
          { name: 'Shogun Castle', type: 'castle', shape: 'default', landmark: true, color: '#2c2c2c', roofColor: '#1a1a1a' },
          { name: 'Tea Ceremony House', type: 'cafe', shape: 'hut', color: '#f5f5dc', roofColor: '#8B6914' },
          { name: 'Samurai Dojo', type: 'barracks', shape: 'default', color: '#bc8f8f', roofColor: '#8b6969' },
          { name: 'Market Street', type: 'market', shape: 'default', color: '#8b0000', roofColor: '#4a0000' },
          { name: 'Zen Temple', type: 'temple', shape: 'dome', color: '#f5f5dc', roofColor: '#daa520' },
          { name: 'Rice Paddy Farm', type: 'farm', shape: 'default', color: '#556b2f', roofColor: '#3b4a20' },
          { name: 'Healer Hut', type: 'hospital', shape: 'default', color: '#f5f5dc', roofColor: '#d4c5a0' },
        ],
      };
    }

    if (demoWorld) {
      demoWorld.economy = { currencyName: 'gold', taxRate: 0.1, prices: { food: 2.5, tool: 12, lodging: 8, healing: 15, gift: 5, marketStall: 50 } };
      demoWorld.characters = chars;
      demoWorld.specialShapes = [];
      return demoWorld;
    }

    // Default demo world (medieval village)
    return {
      name: 'Willowbrook Village',
      description: description || 'A charming village nestled between rolling hills and a gentle river.',
      culture: 'medieval',
      visual: { ground: 'grass', paths: 'dirt', vegetation: 'lush', buildingStyle: 'rustic', culturePalette: 'rustic', roadLayout: 'cross' },
      economy: {
        currencyName: 'gold',
        taxRate: 0.1,
        prices: { food: 2.5, tool: 12, lodging: 8, healing: 15, gift: 5, marketStall: 50 },
      },
      areas: [
        { name: 'Whispering Woods', type: 'forest' },
        { name: 'Town Park', type: 'park' },
        { name: 'River Bend', type: 'water' },
        { name: 'Sandy Shore', type: 'desert' },
      ],
      buildings: [
        { name: 'The Golden Tankard', type: 'tavern', shape: 'default' },
        { name: 'Ironforge Smithy', type: 'blacksmith', shape: 'default' },
        { name: 'Village Church', type: 'church', shape: 'default' },
        { name: 'Morning Bread Bakery', type: 'bakery', shape: 'default' },
        { name: 'Town Hall', type: 'townhall', shape: 'default' },
        { name: 'Willow Cottage', type: 'house', shape: 'default' },
        { name: 'Maple House', type: 'house', shape: 'default' },
        { name: 'The Curious Cat Shop', type: 'shop', shape: 'default' },
      ],
      specialShapes: [],
      characters: chars,
    };
  }

  _getDemoCharacters() {
    return [
      { name: 'Elena Hartwood', age: 34, occupation: 'Tavern Owner', personality: 'Warm and outgoing, loves to hear travelers\' stories. Secretly writes poetry at night.', home: 'The Golden Tankard', appearance: { hairColor: '#8B4513', shirtColor: '#e74c3c' }, relationships: { 'Gareth Stone': 'old friend', 'Mira Chen': 'regular customer' } },
      { name: 'Gareth Stone', age: 45, occupation: 'Blacksmith', personality: 'Gruff exterior but heart of gold. Passionate craftsman and mentor.', home: 'Ironforge Smithy', appearance: { hairColor: '#1a1a2e', shirtColor: '#34495e' }, relationships: { 'Elena Hartwood': 'childhood friend', 'Tom Birch': 'apprentice' } },
      { name: 'Mira Chen', age: 28, occupation: 'Herbalist', personality: 'Gentle and observant. Fascinated by nature, always collecting herbs.', home: 'The Curious Cat Shop', appearance: { hairColor: '#2c1810', shirtColor: '#2ecc71' }, relationships: { 'Father Aldric': 'philosophical debates', 'Elena Hartwood': 'close friend' } },
      { name: 'Father Aldric', age: 62, occupation: 'Village Priest', personality: 'Wise and contemplative. Surprising sense of humor. Loves long walks.', home: 'Village Church', appearance: { hairColor: '#c0c0c0', shirtColor: '#ecf0f1' }, relationships: { 'Mira Chen': 'intellectual sparring partner' } },
      { name: 'Tom Birch', age: 19, occupation: 'Blacksmith Apprentice', personality: 'Eager, enthusiastic, clumsy. Dreams of becoming a master craftsman.', home: 'Ironforge Smithy', appearance: { hairColor: '#D2691E', shirtColor: '#f39c12' }, relationships: { 'Gareth Stone': 'mentor', 'Lily Frost': 'crush' } },
      { name: 'Lily Frost', age: 22, occupation: 'Baker', personality: 'Creative perfectionist about pastries. Early riser, sings while working.', home: 'Morning Bread Bakery', appearance: { hairColor: '#f5deb3', shirtColor: '#9b59b6' }, relationships: { 'Tom Birch': 'friend', 'Elena Hartwood': 'supplies pastries' } },
      { name: 'Mayor Thornton', age: 55, occupation: 'Mayor', personality: 'Pragmatic, well-spoken. Cares deeply about the village but gets lost in bureaucracy.', home: 'Town Hall', appearance: { hairColor: '#4a2c17', shirtColor: '#1abc9c' }, relationships: { 'Father Aldric': 'trusted advisor' } },
      { name: 'Rose Whitfield', age: 31, occupation: 'Teacher', personality: 'Patient and nurturing but has a fierce competitive streak. Organizes village trivia nights.', home: 'Village Church', appearance: { hairColor: '#8b0000', shirtColor: '#3498db' }, relationships: { 'Lily Frost': 'best friend', 'Mayor Thornton': 'respects but challenges' } },
      { name: 'Old Wynn', age: 78, occupation: 'Retired Fisherman', personality: 'Cantankerous storyteller with a heart of gold. Claims to have seen a sea monster once.', home: 'Willow Cottage', appearance: { hairColor: '#ddd', shirtColor: '#607D8B' }, relationships: { 'Elena Hartwood': 'favorite tavern', 'Tom Birch': 'reminds him of his youth' } },
      { name: 'Sable Voss', age: 26, occupation: 'Traveling Merchant', personality: 'Charming and shrewd. Always has a deal to offer. Nobody knows where she\'s from.', home: 'The Curious Cat Shop', appearance: { hairColor: '#1a1a1a', shirtColor: '#8e44ad' }, relationships: { 'Gareth Stone': 'business partner', 'Mayor Thornton': 'tense, owes taxes' } },
    ];
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════
  //  STATE INSPECTOR PANEL
  // ═══════════════════════════════════════════════════════════════
  // Initialize sidebar panels after world generation
  _initSidebar() {
    const select = document.getElementById('state-agent-select');
    if (!select) return;
    select.innerHTML = '<option value="">Select agent...</option>';
    for (const npc of this.npcs) {
      const opt = document.createElement('option');
      opt.value = npc.id;
      opt.textContent = `${npc.name} (${npc.occupation})`;
      select.appendChild(opt);
    }

    if (this.npcs.length > 0) {
      select.value = this.npcs[0].id;
      this._renderAgentState(this.npcs[0].id);
      this._lastRenderedAgentId = this.npcs[0].id;
    }
    this._renderWorldState();
    this._lastRenderedWorldState = true;

    // Auto-refresh: only update non-slider content (memory, status, relationships)
    // Don't rebuild sliders — that overwrites user edits
    clearInterval(this._stateRefreshInterval);
    this._stateRefreshInterval = setInterval(() => {
      const val = document.getElementById('state-agent-select')?.value;
      if (val) this._softRefreshAgentState(val);
      this._softRefreshWorldState();
    }, 3000);
  }

  // Soft refresh: update read-only displays without rebuilding slider HTML
  _softRefreshAgentState(npcId) {
    const npc = this.npcs.find(n => n.id === npcId);
    if (!npc?.sim) return;
    const s = npc.sim;

    // Update slider value labels only (not the sliders themselves)
    document.querySelectorAll('#needs-sliders .slider-val').forEach(el => {
      const input = el.previousElementSibling;
      if (input?.dataset?.field) {
        const [, key] = input.dataset.field.split('.');
        if (s.needs[key] !== undefined) el.textContent = s.needs[key].toFixed(2);
      }
    });
    document.querySelectorAll('#traits-sliders .slider-val').forEach(el => {
      const input = el.previousElementSibling;
      if (input?.dataset?.field) {
        const [, key] = input.dataset.field.split('.');
        if (s.traits[key] !== undefined) el.textContent = s.traits[key].toFixed(2);
      }
    });

    // Rebuild read-only sections (status, relationships, memory, inventory, money)
    const statusDiv = document.getElementById('status-display');
    if (statusDiv) {
      statusDiv.innerHTML =
        Object.entries(s.status).map(([k, v]) =>
          `<div class="status-row"><span class="status-label">${k}</span><span class="status-val">${typeof v === 'number' ? v.toFixed(1) : v}</span></div>`
        ).join('') +
        (s.partner ? `<div class="status-row"><span class="status-label">Partner</span><span class="status-val" style="color:var(--red)">♥ ${s.partner}</span></div>` : '');
    }
    const inv = s.inventory || [];
    const invDivEl = document.getElementById('agent-inventory-display');
    if (invDivEl) {
      invDivEl.innerHTML = inv.length > 0
        ? inv.map(i => `<div class="status-row" style="font-size:11px"><span class="status-label">${i.name}</span><span class="status-val">${i.quantity} (${i.type})</span></div>`).join('')
        : '<div class="empty-state" style="font-size:10px;color:var(--t4)">Empty. Work to produce items, or buy food/tools.</div>';
    }
    const currency = this.worldSim?.economy?.currencyName || 'gold';
    const txList = s.transactions || [];
    const recentTx = txList.slice(-25).reverse();
    const txDiv = document.getElementById('agent-transactions-display');
    if (txDiv) {
      txDiv.innerHTML =
        `<div class="status-row" style="margin-bottom:8px"><span class="status-label">Wealth</span><span class="status-val" style="font-weight:600">${s.status.wealth.toFixed(1)} ${currency}</span></div>` +
        (s.ownsBusiness ? `<div class="status-row" style="margin-bottom:6px;font-size:10px;color:var(--text-muted)">Owns: ${s.ownsBusiness}</div>` : '') +
        (recentTx.length > 0
          ? '<div class="section-label" style="margin-top:8px;font-size:10px">Recent transactions</div>' +
            recentTx.map(t => {
              const amt = t.amount;
              const sign = amt >= 0 ? '+' : '';
              const color = amt >= 0 ? '#2ecc71' : '#e74c3c';
              const time = t.gameTime ? `Day ${t.gameTime.day || '?'} ${t.gameTime.hours ?? ''}:${String(t.gameTime.minutes ?? 0).padStart(2,'0')}` : (t.day ? `Day ${t.day}` : '');
              return `<div class="status-row" style="font-size:10px;margin:2px 0"><span style="color:${color};min-width:52px">${sign}${amt.toFixed(1)}</span> <span style="color:var(--text-muted)">${t.reason}</span> ${time ? `<span style="color:var(--t4)">${time}</span>` : ''}</div>`;
            }).join('')
          : '<div class="empty-state" style="font-size:10px;color:var(--t4)">No transactions yet. Work, buy food, give gifts, or pay taxes to see activity.</div>');
    }

    // Relationships — only update slider value labels, don't rebuild HTML
    document.querySelectorAll('#sim-relationships .slider-val').forEach(el => {
      const input = el.previousElementSibling;
      if (!input?.dataset?.dim) return;
      const targetName = input.dataset.target;
      const dim = input.dataset.dim;
      const rel = npc.simRelationships?.get(targetName);
      if (rel) el.textContent = rel[dim].toFixed(2);
    });

    // ★ Action Description
    const actionDiv = document.getElementById('agent-action-display');
    if (actionDiv && npc.cognition) {
      actionDiv.textContent = npc.cognition.actionDescription || `${npc.name} is idle.`;
    }

    // ★ Agent Summary
    const summaryDiv = document.getElementById('agent-summary-display');
    if (summaryDiv && npc.cognition) {
      summaryDiv.textContent = npc.cognition.getAgentSummary(this.gameTime);
    }

    // ★ Reflections
    const refDiv = document.getElementById('agent-reflections');
    if (refDiv && npc.cognition) {
      const reflections = npc.cognition.memory.getByType('reflection', 10).reverse();
      refDiv.innerHTML = reflections.length > 0
        ? reflections.map(r =>
          `<div class="reflection-entry">${r.description.replace('[Reflection] ', '')}
            <span class="ref-time">${r.gameTimeCreated || ''} Day ${r.gameDay || ''} · ★${r.importance}</span>
          </div>`
        ).join('')
        : '<div class="empty-state" style="font-size:10px;color:var(--t4)">No reflections yet.</div>';
    }

    // Memory — only update if filter is set to "all" (don't override user's filter selection)
    const activeFilter = document.querySelector('.mem-filter-btn.active')?.dataset?.type || 'all';
    this._renderMemoryList(npc, activeFilter);
  }

  _softRefreshWorldState() {
    if (!this.worldSim) return;
    const ws = this.worldSim;

    // Update slider values AND labels — but only if user isn't actively dragging
    document.querySelectorAll('#world-resources .slider-row').forEach(row => {
      const input = row.querySelector('input[type="range"]');
      const label = row.querySelector('.slider-val');
      if (!input?.dataset?.field) return;
      const [, key] = input.dataset.field.split('.');
      if (ws.resources[key] === undefined) return;
      const val = ws.resources[key];
      label.textContent = val.toFixed(0);
      // Only update slider position if not frozen (user not actively editing)
      if (!ws._frozen?.['resources.' + key] || Date.now() >= ws._frozen['resources.' + key]) {
        input.value = val | 0;
      }
    });
    document.querySelectorAll('#world-tech .slider-row').forEach(row => {
      const input = row.querySelector('input[type="range"]');
      const label = row.querySelector('.slider-val');
      if (!input?.dataset?.field) return;
      const [, key] = input.dataset.field.split('.');
      if (ws.technology[key] === undefined) return;
      const val = ws.technology[key];
      label.textContent = val.toFixed(1);
      if (!ws._frozen?.['technology.' + key] || Date.now() >= ws._frozen['technology.' + key]) {
        input.value = (val * 10) | 0;
      }
    });

    // Update economy/governance (read-only)
    const econDiv = document.getElementById('world-economy');
    if (econDiv) {
      const currency = ws.economy.currencyName || 'gold';
      const treasury = (ws.economy.treasury ?? 0).toFixed(0);
      econDiv.innerHTML =
        `<div class="status-row"><span class="status-label">Currency</span><span class="status-val">${currency}</span></div>
         <div class="status-row"><span class="status-label">Treasury</span><span class="status-val">${treasury}</span></div>
         <div class="status-row"><span class="status-label">Prosperity</span><span class="status-val">${ws.economy.prosperity.toFixed(1)}</span></div>
         <div class="status-row"><span class="status-label">Tax Rate</span><span class="status-val">${((ws.economy.taxRate ?? 0.1) * 100).toFixed(0)}%</span></div>
         <div class="status-row"><span class="status-label">Leader</span><span class="status-val">${ws.governance.leader || 'None'}</span></div>
         <div class="status-row"><span class="status-label">Unrest</span><span class="status-val" style="color:${ws.governance.unrest > 50 ? 'var(--red)' : 'var(--blue)'}">${ws.governance.unrest.toFixed(1)}%</span></div>
         <div class="status-row"><span class="status-label">Population</span><span class="status-val">${ws.population}</span></div>`;
    }

    // Sim log
    const logDiv = document.getElementById('sim-log');
    if (logDiv) logDiv.innerHTML = this.simLog.slice(-6).map(e => `<div style="margin-bottom:2px;font-size:10px;color:var(--t3)">${e.text}</div>`).join('') || '';
  }

  _renderAgentState(npcId) {
    const npc = this.npcs.find(n => n.id === npcId);
    if (!npc?.sim) return;
    const s = npc.sim;

    // ★ Agent Profile Header
    const headerDiv = document.getElementById('agent-profile-header');
    if (headerDiv) {
      headerDiv.innerHTML = `
        <div class="agent-profile-name">${npc.name}</div>
        <div class="agent-profile-role">${npc.occupation}, age ${npc.age}</div>
        <div class="agent-profile-personality">${npc.personality}</div>
      `;
    }

    // ★ Current Action
    const actionDiv = document.getElementById('agent-action-display');
    if (actionDiv && npc.cognition) {
      actionDiv.textContent = npc.cognition.actionDescription || `${npc.name} is idle.`;
    }

    // ★ Agent Summary (paper Appendix A)
    const summaryDiv = document.getElementById('agent-summary-display');
    if (summaryDiv && npc.cognition) {
      summaryDiv.textContent = npc.cognition.getAgentSummary(this.gameTime);
    }

    // ★ Reflections
    const refDiv = document.getElementById('agent-reflections');
    if (refDiv && npc.cognition) {
      const reflections = npc.cognition.memory.getByType('reflection', 10).reverse();
      refDiv.innerHTML = reflections.length > 0
        ? reflections.map(r =>
          `<div class="reflection-entry">${r.description.replace('[Reflection] ', '')}
            <span class="ref-time">${r.gameTimeCreated || ''} Day ${r.gameDay || ''} · ★${r.importance}</span>
          </div>`
        ).join('')
        : '<div class="empty-state" style="font-size:10px;color:var(--t4)">No reflections yet — agent will reflect after accumulating enough experiences.</div>';
    }

    // ★ Memory filter buttons
    document.querySelectorAll('.mem-filter-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.mem-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._renderMemoryList(npc, btn.dataset.type);
      };
    });

    // Needs sliders (editable!)
    const needsDiv = document.getElementById('needs-sliders');
    needsDiv.innerHTML = Object.entries(s.needs).map(([k, v]) =>
      `<div class="slider-row">
        <label>${k}</label>
        <input type="range" min="0" max="100" value="${(v*100)|0}"
          data-agent="${npc.id}" data-field="needs.${k}"
          oninput="App._setSimValue(this)">
        <span class="slider-val">${v.toFixed(2)}</span>
      </div>`
    ).join('');

    // Traits sliders (editable!)
    const traitsDiv = document.getElementById('traits-sliders');
    traitsDiv.innerHTML = Object.entries(s.traits).map(([k, v]) =>
      `<div class="slider-row">
        <label>${k}</label>
        <input type="range" min="0" max="100" value="${(v*100)|0}"
          data-agent="${npc.id}" data-field="traits.${k}"
          oninput="App._setSimValue(this)">
        <span class="slider-val">${v.toFixed(2)}</span>
      </div>`
    ).join('');

    // Status & Skills
    const statusDiv = document.getElementById('status-display');
    statusDiv.innerHTML =
      Object.entries(s.status).map(([k, v]) =>
        `<div class="status-row"><span class="status-label">${k}</span><span class="status-val">${typeof v === 'number' ? v.toFixed(1) : v}</span></div>`
      ).join('') +
      '<h4 style="margin-top:6px;font-size:10px;color:var(--text-muted)">Skills</h4>' +
      Object.entries(s.skills).map(([k, v]) =>
        `<div class="status-row"><span class="status-label">${k}</span><span class="status-val">${v.toFixed(1)}</span></div>`
      ).join('') +
      (s.partner ? `<div class="status-row"><span class="status-label">Partner</span><span class="status-val" style="color:#e74c3c">💕 ${s.partner}</span></div>` : '') +
      (s.children.length > 0 ? `<div class="status-row"><span class="status-label">Children</span><span class="status-val">${s.children.length}</span></div>` : '');

    // Inventory (items they have / can sell)
    const invDiv = document.getElementById('agent-inventory-display');
    const inv = s.inventory || [];
    if (invDiv) {
      invDiv.innerHTML = inv.length > 0
        ? inv.map(i => `<div class="status-row" style="font-size:11px"><span class="status-label">${i.name}</span><span class="status-val">${i.quantity} (${i.type})</span></div>`).join('')
        : '<div class="empty-state" style="font-size:10px;color:var(--t4)">Empty. Work to produce items, or buy food/tools.</div>';
    }

    // Money & Transactions (wealth + recent transactions)
    const currency = this.worldSim?.economy?.currencyName || 'gold';
    const txList = s.transactions || [];
    const recentTx = txList.slice(-25).reverse();
    const txDiv = document.getElementById('agent-transactions-display');
    if (txDiv) {
      txDiv.innerHTML =
        `<div class="status-row" style="margin-bottom:8px"><span class="status-label">Wealth</span><span class="status-val" style="font-weight:600">${s.status.wealth.toFixed(1)} ${currency}</span></div>` +
        (s.ownsBusiness ? `<div class="status-row" style="margin-bottom:6px;font-size:10px;color:var(--text-muted)">Owns: ${s.ownsBusiness}</div>` : '') +
        (recentTx.length > 0
          ? '<div class="section-label" style="margin-top:8px;font-size:10px">Recent transactions</div>' +
            recentTx.map(t => {
              const amt = t.amount;
              const sign = amt >= 0 ? '+' : '';
              const color = amt >= 0 ? '#2ecc71' : '#e74c3c';
              const time = t.gameTime ? `Day ${t.gameTime.day || '?'} ${t.gameTime.hours ?? ''}:${String(t.gameTime.minutes ?? 0).padStart(2,'0')}` : (t.day ? `Day ${t.day}` : '');
              return `<div class="status-row" style="font-size:10px;margin:2px 0"><span style="color:${color};min-width:52px">${sign}${amt.toFixed(1)}</span> <span style="color:var(--text-muted)">${t.reason}</span> ${time ? `<span style="color:var(--t4)">${time}</span>` : ''}</div>`;
            }).join('')
          : '<div class="empty-state" style="font-size:10px;color:var(--t4)">No transactions yet. Work, buy food, give gifts, or pay taxes to see activity.</div>');
    }

    // Relationships — show ALL other NPCs with editable sliders
    const relDiv = document.getElementById('sim-relationships');
    if (!npc.simRelationships) npc.simRelationships = new Map();
    // Ensure all NPCs have a relationship entry
    for (const other of this.npcs) {
      if (other.id === npc.id) continue;
      if (!npc.simRelationships.has(other.name)) {
        npc.simRelationships.set(other.name, {
          trust: 0.3, attraction: 0.1, respect: 0.3, familiarity: 0.2, fear: 0, rivalry: 0,
          interactions: 0, label: 'stranger',
        });
      }
    }
    const dims = ['trust', 'attraction', 'respect', 'familiarity', 'fear', 'rivalry'];
    relDiv.innerHTML = [...npc.simRelationships.entries()].map(([name, r]) =>
      `<div class="sim-rel-entry">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span class="rel-name">${name}</span>
          <span style="font-size:8px;color:var(--t3)">${r.label}</span>
        </div>
        ${dims.map(d =>
          `<div class="slider-row">
            <label>${d}</label>
            <input type="range" min="0" max="100" value="${(r[d]*100)|0}"
              data-agent="${npc.id}" data-target="${name}" data-dim="${d}"
              oninput="App._setRelValue(this)">
            <span class="slider-val">${r[d].toFixed(2)}</span>
          </div>`
        ).join('')}
      </div>`
    ).join('') || '<div style="color:var(--text-muted)">No relationships yet</div>';

    // ★ Memory Stream — render with default "all" filter
    this._renderMemoryList(npc, 'all');
  }

  _renderMemoryList(npc, filterType) {
    const memList = document.getElementById('memory-list');
    if (!memList || !npc?.cognition) return;

    let mems;
    if (filterType === 'all') {
      mems = npc.cognition.memory.getRecent(30).reverse();
    } else {
      mems = npc.cognition.memory.getByType(filterType, 30).reverse();
    }

    const totalByType = {
      all: npc.cognition.memory.count(),
      reflection: npc.cognition.memory.countByType('reflection'),
      dialogue: npc.cognition.memory.countByType('dialogue'),
      observation: npc.cognition.memory.countByType('observation'),
      plan: npc.cognition.memory.countByType('plan'),
      event: npc.cognition.memory.countByType('event'),
    };

    // Update filter button counts
    document.querySelectorAll('.mem-filter-btn').forEach(btn => {
      const type = btn.dataset.type;
      const count = totalByType[type] || 0;
      btn.textContent = `${type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)} (${count})`;
    });

    memList.innerHTML = mems.length > 0
      ? mems.map(m =>
        `<div class="mem-entry ${m.type}">
          <span class="mem-type">${m.type}</span>
          <span class="mem-imp">★${m.importance}</span>
          ${m.description}
          <span class="mem-time">Day ${m.gameDay || '?'} ${m.gameTimeCreated || ''}</span>
        </div>`
      ).join('')
      : `<div class="empty-state" style="font-size:10px;color:var(--t4)">No ${filterType === 'all' ? '' : filterType + ' '}memories yet</div>`;
  }

  _renderWorldState() {
    if (!this.worldSim) return;
    const ws = this.worldSim;

    document.getElementById('world-resources').innerHTML = Object.entries(ws.resources).map(([k, v]) =>
      `<div class="slider-row">
        <label>${k}</label>
        <input type="range" min="0" max="500" value="${v|0}"
          data-field="resources.${k}"
          oninput="App._setWorldValue(this)">
        <span class="slider-val">${v.toFixed(0)}</span>
      </div>`
    ).join('');

    document.getElementById('world-tech').innerHTML = Object.entries(ws.technology).map(([k, v]) =>
      `<div class="slider-row">
        <label>${k}</label>
        <input type="range" min="0" max="100" value="${(v*10)|0}"
          data-field="technology.${k}"
          oninput="App._setWorldValue(this)">
        <span class="slider-val">${v.toFixed(1)}</span>
      </div>`
    ).join('');

    const currency = ws.economy.currencyName || 'gold';
    const treasury = (ws.economy.treasury ?? 0).toFixed(0);
    document.getElementById('world-economy').innerHTML =
      `<div class="status-row"><span class="status-label">Currency</span><span class="status-val">${currency}</span></div>
       <div class="status-row"><span class="status-label">Treasury</span><span class="status-val">${treasury}</span></div>
       <div class="status-row"><span class="status-label">Prosperity</span><span class="status-val">${ws.economy.prosperity.toFixed(1)}</span></div>
       <div class="status-row"><span class="status-label">Tax Rate</span><span class="status-val">${((ws.economy.taxRate ?? 0.1)*100).toFixed(0)}%</span></div>
       <div class="status-row"><span class="status-label">Leader</span><span class="status-val">${ws.governance.leader || 'None'}</span></div>
       <div class="status-row"><span class="status-label">Unrest</span><span class="status-val" style="color:${ws.governance.unrest > 50 ? '#e74c3c' : 'var(--accent)'}">${ws.governance.unrest.toFixed(1)}%</span></div>
       <div class="status-row"><span class="status-label">Season</span><span class="status-val">${ws.environment.season}</span></div>
       <div class="status-row"><span class="status-label">Population</span><span class="status-val">${ws.population}</span></div>
       <div class="status-row"><span class="status-label">Laws</span><span class="status-val" style="font-size:9px">${ws.governance.laws.join(', ')}</span></div>`;
  }

  static _setWorldValue(input) {
    const field = input.dataset.field;
    const [cat, key] = field.split('.');
    const ws = window.App?.worldSim;
    if (!ws) return;
    let oldVal, newVal;
    if (cat === 'technology') {
      oldVal = ws[cat][key];
      ws[cat][key] = parseInt(input.value) / 10;
      newVal = ws[cat][key];
      input.nextElementSibling.textContent = (parseInt(input.value) / 10).toFixed(1);
    } else {
      oldVal = ws[cat][key];
      ws[cat][key] = parseInt(input.value);
      newVal = ws[cat][key];
      input.nextElementSibling.textContent = parseInt(input.value);
    }
    // Freeze sim updates on this field for 10 seconds so the user's value sticks
    if (!ws._frozen) ws._frozen = {};
    ws._frozen[`${cat}.${key}`] = Date.now() + 10000;

    // ★ Make agents notice significant world changes immediately
    App._reactToWorldChange(cat, key, newVal, oldVal);
  }

  // ★ Agents visibly react when world variables change significantly
  static _reactToWorldChange(cat, key, newVal, oldVal) {
    const app = window.App;
    if (!app?.npcs?.length) return;
    const delta = newVal - oldVal;
    if (Math.abs(delta) < 5) return; // ignore tiny changes

    let announcement = null;
    let importance = 6;
    let speechLines = [];

    if (cat === 'resources' && key === 'food') {
      if (newVal < app.npcs.length * 2) {
        announcement = `The village food supply has dropped critically low! Only ${newVal.toFixed(0)} left!`;
        speechLines = ['We\'re running out of food!', 'The food stores are empty!', 'We need to find food!', 'This is bad — no food left.'];
        importance = 8;
      } else if (delta > 30) {
        announcement = `The village food supply has increased significantly to ${newVal.toFixed(0)}!`;
        speechLines = ['Look at all this food!', 'We have plenty to eat now!', 'The stores are full!'];
        importance = 5;
      } else if (delta < -30) {
        announcement = `The village food supply has dropped sharply to ${newVal.toFixed(0)}.`;
        speechLines = ['Where did all the food go?', 'Our food supply is shrinking!', 'We need to grow more food.'];
        importance = 7;
      }
    } else if (cat === 'resources' && key === 'gold') {
      if (delta > 50) {
        announcement = `The village gold reserves have surged to ${newVal.toFixed(0)}!`;
        speechLines = ['We\'re rich!', 'So much gold!'];
      } else if (delta < -50) {
        announcement = `The village gold reserves have fallen to ${newVal.toFixed(0)}.`;
        speechLines = ['Where did the gold go?', 'We\'re running low on gold...'];
      }
    }

    if (!announcement) return;

    // A few random agents react visibly
    const shuffled = [...app.npcs].sort(() => Math.random() - 0.5);
    const reactors = shuffled.slice(0, Math.min(3, shuffled.length));
    for (const npc of reactors) {
      const line = speechLines[Math.floor(Math.random() * speechLines.length)];
      npc.say(line, 4500);
      if (npc.cognition) {
        npc.cognition.memory.add(announcement, 'event', importance, app.gameTime);
        npc.cognition.addHotTopic(announcement, 'village situation', importance, app.gameTime);
      }
    }

    // Also notify in the UI
    if (app.ui) app.ui.notify(announcement, importance > 6 ? 'danger' : 'info', 4000);
  }

  static _setSimValue(input) {
    const npcId = input.dataset.agent;
    const field = input.dataset.field;
    const val = parseInt(input.value) / 100;
    const npc = window.App?.npcs?.find(n => n.id === npcId);
    if (!npc?.sim) return;
    const [cat, key] = field.split('.');
    const oldVal = npc.sim[cat]?.[key];
    if (npc.sim[cat] && key in npc.sim[cat]) {
      npc.sim[cat][key] = val;
      input.nextElementSibling.textContent = val.toFixed(2);
    }
    // Freeze sim updates for this agent's field
    if (!npc.sim._frozen) npc.sim._frozen = {};
    npc.sim._frozen[`${cat}.${key}`] = Date.now() + 10000;

    // ★ Immediate visible reaction to significant need changes
    if (cat === 'needs' && oldVal !== undefined && Math.abs(val - oldVal) > 0.12) {
      App._reactToNeedChange(npc, key, val, oldVal);
    }

    // ★ Force this NPC to be re-evaluated on the next cognitive cycle
    npc._priorityCogCycle = true;
  }

  // ★ Make agents visibly react when their needs change significantly
  static _reactToNeedChange(npc, need, newVal, oldVal) {
    const satisfied = newVal < oldVal; // need decreased = satisfied
    const reactions = {
      hunger: {
        low:  ['Ahh, I feel so full!', 'My stomach is happy now.', 'Not hungry at all!'],
        high: ['My stomach is growling...', 'I need to find food soon!', 'So hungry...'],
      },
      rest: {
        low:  ['I feel well-rested!', 'Full of energy!', 'Ready for the day!'],
        high: ['I can barely keep my eyes open...', 'I need to sleep...', 'So exhausted...'],
      },
      social: {
        low:  ['I feel connected.', 'Good times with friends!', 'I feel loved.'],
        high: ['I feel so lonely...', 'I wish someone would talk to me.', 'I miss company...'],
      },
      fun: {
        low:  ['That was fun!', 'Life feels good!', 'What a great time!'],
        high: ['I\'m so bored...', 'I need some excitement.', 'Nothing to do...'],
      },
      purpose: {
        low:  ['I feel fulfilled!', 'My work matters.', 'I\'m making a difference!'],
        high: ['What\'s the point?', 'I feel so aimless...', 'I need a purpose.'],
      },
      romance: {
        low:  ['My heart is full.', 'Love is in the air!'],
        high: ['I long for companionship...', 'I wish I had someone special.'],
      },
    };
    const r = reactions[need];
    if (!r) return;
    const lines = satisfied ? r.low : r.high;
    const text = lines[Math.floor(Math.random() * lines.length)];

    // Show speech bubble
    npc.say(text, 4000);

    // Add to memory so the agent remembers the change
    if (npc.cognition) {
      const desc = satisfied
        ? `I suddenly feel much better — my ${need} is satisfied.`
        : `I suddenly feel worse — my ${need} need is urgent.`;
      npc.cognition.memory.add(desc, 'observation', 6, window.App?.gameTime);
      npc.cognition.addHotTopic(desc, 'personal experience', 6, window.App?.gameTime);
    }

    // Update current activity to reflect the change
    if (satisfied && newVal < 0.2) {
      npc.currentActivity = `Feeling content (${need} satisfied)`;
    } else if (!satisfied && newVal > 0.7) {
      npc.currentActivity = `Feeling desperate (${need} is critical)`;
    }
  }

  // Research panel is now merged into the Agents sidebar tab
}

// ─── Initialize ───────────────────────────────────────────────────
const app = new App();

// Expose to window — bind static methods to the instance so HTML oninput handlers work
window.App = app;
window.App._setSimValue = App._setSimValue;
window.App._setWorldValue = App._setWorldValue;
window.App._setRelValue = function(input) {
  const npcId = input.dataset.agent;
  const targetName = input.dataset.target;
  const dim = input.dataset.dim;
  const val = parseInt(input.value) / 100;
  const npc = app.npcs?.find(n => n.id === npcId);
  if (!npc?.simRelationships) return;
  const rel = npc.simRelationships.get(targetName);
  if (!rel) return;
  rel[dim] = val;
  input.nextElementSibling.textContent = val.toFixed(2);
  // Update label based on new values
  if (rel.attraction > 0.7 && rel.trust > 0.6) rel.label = 'in love';
  else if (rel.attraction > 0.5 && rel.trust > 0.5) rel.label = 'romantic interest';
  else if (rel.trust > 0.7 && rel.familiarity > 0.7) rel.label = 'close friend';
  else if (rel.trust > 0.5 && rel.familiarity > 0.4) rel.label = 'friend';
  else if (rel.rivalry > 0.5) rel.label = 'rival';
  else if (rel.fear > 0.5) rel.label = 'fearful';
  else if (rel.familiarity > 0.3) rel.label = 'acquaintance';
  else rel.label = 'stranger';
};
window.UI = app.ui;
