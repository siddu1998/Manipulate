// ═══════════════════════════════════════════════════════════════════
//  WorldDef — The Constitution of a Generated World
//
//  Instead of hardcoded enums in config.js / simulation.js, the
//  architect LLM generates a WorldDef at creation time.  Every
//  subsystem (simulation, goals, renderer, commands) reads from
//  this schema generically.  Demo mode uses DEFAULT_WORLDDEF which
//  mirrors the old hardcoded values so nothing breaks without an
//  API key.
// ═══════════════════════════════════════════════════════════════════

// ─── WorldDef Class ──────────────────────────────────────────────

export class WorldDef {
  constructor(raw = {}) {
    this.terrain      = (raw.terrain      || []).map(t => normalizeTerrain(t));
    this.resources    = (raw.resources    || []).map(r => normalizeResource(r));
    this.needs        = (raw.needs        || []).map(n => normalizeNeed(n));
    this.traits       = (raw.traits       || []).map(t => normalizeTrait(t));
    this.skills       = (raw.skills       || []).map(s => normalizeSkill(s));
    this.status       = (raw.status       || []).map(s => normalizeStatus(s));
    this.occupations  = (raw.occupations  || []).map(o => normalizeOccupation(o));
    this.actions      = (raw.actions      || []).map(a => normalizeAction(a));
    this.buildingTypes = (raw.buildingTypes || []).map(b => normalizeBuildingType(b));
    this.visualStyle  = normalizeVisualStyle(raw.visualStyle || {});
    this.economy      = normalizeEconomy(raw.economy || {});
    this.evolution    = normalizeEvolution(raw.evolution || {});
    this.culture      = raw.culture || '';

    // Build lookup maps for O(1) access
    this._actionMap     = new Map(this.actions.map(a => [a.id, a]));
    this._occupationMap = new Map(this.occupations.map(o => [o.id, o]));
    this._needMap       = new Map(this.needs.map(n => [n.id, n]));
    this._resourceMap   = new Map(this.resources.map(r => [r.id, r]));
    this._skillMap      = new Map(this.skills.map(s => [s.id, s]));
    this._buildingMap   = new Map(this.buildingTypes.map(b => [b.id, b]));
  }

  // ─── Lookups ───────────────────────────────────────────────────
  findAction(id)      { return this._actionMap.get(id)     || this._actionMap.get(id?.toLowerCase()) || null; }
  findOccupation(id)  { return this._occupationMap.get(id) || this._occupationMap.get(id?.toLowerCase()) || null; }
  findNeed(id)        { return this._needMap.get(id)       || this._needMap.get(id?.toLowerCase()) || null; }
  findResource(id)    { return this._resourceMap.get(id)   || this._resourceMap.get(id?.toLowerCase()) || null; }
  findSkill(id)       { return this._skillMap.get(id)      || this._skillMap.get(id?.toLowerCase()) || null; }
  findBuilding(id)    { return this._buildingMap.get(id)   || this._buildingMap.get(id?.toLowerCase()) || null; }

  // What actions can you do at a specific building type?
  getActionsForLocation(buildingType) {
    const bt = (buildingType || '').toLowerCase();
    return this.actions.filter(a => {
      if (!a.location) return false;
      const loc = a.location.toLowerCase();
      return loc === bt || loc.includes(bt) || bt.includes(loc);
    });
  }

  // Who produces this resource? Who needs it as input?
  getSupplyChain(resourceId) {
    const rid = (resourceId || '').toLowerCase();
    const producers = this.occupations.filter(o =>
      o.outputs.some(out => out.resource.toLowerCase() === rid)
    );
    const consumers = this.occupations.filter(o =>
      o.inputs.some(inp => inp.resource.toLowerCase() === rid)
    );
    return { producers, consumers };
  }

  // What actions or resources satisfy a need?
  getNeedSatisfiers(needId) {
    const need = this.findNeed(needId);
    if (!need) return { actions: [], resources: [] };
    const satisfyingActions = this.actions.filter(a =>
      a.effects && a.effects[needId] !== undefined && a.effects[needId] < 0
    );
    return {
      actions: satisfyingActions,
      resources: need.satisfiedBy || [],
    };
  }

  // Can an agent perform an action? (check prerequisites + inputs)
  canAgentDoAction(agent, actionId) {
    const action = this.findAction(actionId);
    if (!action) return { can: false, reason: 'Unknown action' };

    // Check requires
    if (action.requires) {
      for (const req of Array.isArray(action.requires) ? action.requires : [action.requires]) {
        if (typeof req === 'string') {
          // Building requirement
          // (checked by caller against nearby buildings)
        }
        if (typeof req === 'object' && req.minWealth && (agent.sim?.status?.wealth || 0) < req.minWealth) {
          return { can: false, reason: `Need ${req.minWealth} wealth` };
        }
      }
    }

    // Check input resources in inventory
    if (action.inputs) {
      for (const inp of action.inputs) {
        const has = agent.sim?.inventory?.reduce((s, i) =>
          i.type === inp.resource || i.name.toLowerCase() === inp.resource.toLowerCase() ? s + i.quantity : s, 0) || 0;
        if (has < inp.qty) {
          return { can: false, reason: `Need ${inp.qty} ${inp.resource} (have ${has})` };
        }
      }
    }

    return { can: true, reason: null };
  }

  // Get a compact summary for LLM prompts
  getSummaryForLLM() {
    const needIds = this.needs.map(n => n.id).join(', ');
    const skillIds = this.skills.map(s => s.id).join(', ');
    const statusIds = this.status.map(s => `${s.id}(${s.min}-${s.max})`).join(', ');
    const resourceIds = this.resources.map(r => r.id).join(', ');
    const actionSummary = this.actions.map(a => `${a.id}: ${a.description || ''}`).join('\n  ');
    const occSummary = this.occupations.map(o => {
      const ins = o.inputs.length ? ` needs [${o.inputs.map(i => `${i.qty} ${i.resource}`).join(', ')}]` : '';
      const outs = o.outputs.length ? ` produces [${o.outputs.map(i => `${i.qty} ${i.resource}`).join(', ')}]` : '';
      return `${o.id}:${ins}${outs}`;
    }).join('\n  ');

    return `WORLD SCHEMA:
  Needs (0=satisfied, 1=desperate): ${needIds}
  Skills (0-10): ${skillIds}
  Status: ${statusIds}
  Resources: ${resourceIds}
  Currency: ${this.economy.currency}
  Actions:
  ${actionSummary}
  Occupations:
  ${occSummary}`;
  }

  // Create initial agent needs/skills/traits from worldDef
  createAgentNeeds(rng) {
    const r = rng || Math.random;
    const needs = {};
    for (const n of this.needs) {
      needs[n.id] = (n.startMin ?? 0.1) + r() * ((n.startMax ?? 0.4) - (n.startMin ?? 0.1));
    }
    return needs;
  }

  createAgentSkills(rng) {
    const r = rng || Math.random;
    const skills = {};
    for (const s of this.skills) {
      skills[s.id] = r() * 3;
    }
    return skills;
  }

  createAgentTraits(rng) {
    const r = rng || Math.random;
    const traits = {};
    for (const t of this.traits) {
      traits[t.id] = r();
    }
    return traits;
  }

  createAgentStatus(rng) {
    const r = rng || Math.random;
    const status = {};
    for (const s of this.status) {
      const range = (s.max - s.min) * 0.4;
      status[s.id] = s.default + (r() - 0.5) * range;
    }
    return status;
  }

  createWorldResources() {
    const resources = {};
    for (const r of this.resources) {
      resources[r.id] = r.startAmount ?? 50;
    }
    return resources;
  }
}


// ─── Normalizers (ensure every field has a sane default) ─────────

function normalizeTerrain(t) {
  return {
    id: t.id || 'ground',
    walkable: t.walkable !== false,
    color: t.color || '#5b8c3e',
    variants: t.variants || 1,
    solid: t.solid || false,
  };
}

function normalizeResource(r) {
  return {
    id: (r.id || r.name || 'unknown').toLowerCase(),
    renewable: r.renewable !== false,
    baseProduction: r.baseProduction ?? 0.1,
    unit: r.unit || 'units',
    category: r.category || 'material',
    startAmount: r.startAmount ?? 50,
  };
}

function normalizeNeed(n) {
  return {
    id: (n.id || n.name || 'unknown').toLowerCase(),
    label: n.label || n.id || 'Unknown',
    growthRate: n.growthRate ?? 0.001,
    satisfiedBy: n.satisfiedBy || [],
    decayAction: n.decayAction || null,
    startMin: n.startMin ?? 0.1,
    startMax: n.startMax ?? 0.4,
    statusEffects: n.statusEffects || null, // e.g. { health: -0.1, happiness: -0.15 } when > 0.9
    threshold: n.threshold ?? 0.7,          // when to trigger awareness
    critical: n.critical ?? 0.9,            // when status effects kick in
  };
}

function normalizeTrait(t) {
  return {
    id: (t.id || t.name || 'unknown').toLowerCase(),
    label: t.label || t.id || 'Unknown',
    description: t.description || '',
  };
}

function normalizeSkill(s) {
  return {
    id: (s.id || s.name || 'unknown').toLowerCase(),
    label: s.label || s.id || 'Unknown',
  };
}

function normalizeStatus(s) {
  return {
    id: (s.id || s.name || 'unknown').toLowerCase(),
    label: s.label || s.id || 'Unknown',
    min: s.min ?? 0,
    max: s.max ?? 100,
    default: s.default ?? 50,
  };
}

function normalizeOccupation(o) {
  return {
    id: (o.id || o.name || 'unknown').toLowerCase(),
    inputs: (o.inputs || []).map(i => ({ resource: (i.resource || i.name || '').toLowerCase(), qty: i.qty ?? 1 })),
    outputs: (o.outputs || []).map(i => ({ resource: (i.resource || i.name || '').toLowerCase(), qty: i.qty ?? 1 })),
    skill: (o.skill || '').toLowerCase(),
    description: o.description || '',
    building: o.building || null,
  };
}

function normalizeAction(a) {
  return {
    id: (a.id || a.name || 'unknown').toLowerCase(),
    effects: a.effects || {},          // { needId: delta, statusId: delta }
    inputs: (a.inputs || []).map(i => ({ resource: (i.resource || '').toLowerCase(), qty: i.qty ?? 1 })),
    outputs: (a.outputs || []).map(i => ({ resource: (i.resource || '').toLowerCase(), qty: i.qty ?? 1 })),
    requires: a.requires || null,      // string (building) or [{ minWealth: N }]
    description: a.description || '',
    location: a.location || null,
    worldEffects: a.worldEffects || null, // { 'resources.food': -1 }
    social: a.social || false,         // involves another agent
    target: a.target || null,          // 'agent' | 'building' | null
  };
}

function normalizeBuildingType(b) {
  return {
    id: (b.id || b.name || 'unknown').toLowerCase(),
    w: b.w || 5,
    h: b.h || 4,
    shape: b.shape || 'default',
    color: b.color || '#8B7355',
    roofColor: b.roofColor || '#6b5335',
    rooms: b.rooms || [],
  };
}

function normalizeVisualStyle(v) {
  return {
    palette: v.palette || ['#5b8c3e', '#c9b48c', '#3a7bd5', '#8B7355', '#e8d5a3'],
    groundTexture: v.groundTexture || 'organic',
    buildingMaterial: v.buildingMaterial || 'wood_plank',
    vegetationType: v.vegetationType || 'deciduous',
    waterStyle: v.waterStyle || 'still',
  };
}

function normalizeEconomy(e) {
  return {
    currency: e.currency || e.currencyName || 'gold',
    taxRate: e.taxRate ?? 0.1,
    prices: e.prices || {},
  };
}

function normalizeEvolution(e) {
  return {
    seasons: e.seasons || null,  // [{ id: 'spring', duration: 7, productionMod: 1.2, needMods: {} }]
    techTree: e.techTree || null,
    agingRate: e.agingRate ?? 0,  // game-days per real year of aging (0 = off)
  };
}


// ─── Generate a WorldDef from architect LLM output ──────────────

export function generateWorldDef(architectOutput) {
  if (!architectOutput) return new WorldDef(DEFAULT_WORLDDEF_RAW);
  // Merge architect output onto defaults for any missing sections
  const merged = { ...DEFAULT_WORLDDEF_RAW };
  for (const key of Object.keys(architectOutput)) {
    if (architectOutput[key] !== undefined && architectOutput[key] !== null) {
      if (Array.isArray(architectOutput[key]) && architectOutput[key].length > 0) {
        merged[key] = architectOutput[key];
      } else if (typeof architectOutput[key] === 'object' && !Array.isArray(architectOutput[key])) {
        merged[key] = { ...(merged[key] || {}), ...architectOutput[key] };
      } else {
        merged[key] = architectOutput[key];
      }
    }
  }
  return new WorldDef(merged);
}


// ═══════════════════════════════════════════════════════════════════
//  DEFAULT WORLDDEF — mirrors existing hardcoded values exactly
//  so demo mode (no API key) behaves identically to before
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_WORLDDEF_RAW = {
  terrain: [
    { id: 'grass',       walkable: true,  color: '#5b8c3e' },
    { id: 'grass_dark',  walkable: true,  color: '#4a7a32' },
    { id: 'grass_flower',walkable: true,  color: '#5b8c3e' },
    { id: 'path',        walkable: true,  color: '#c9b48c' },
    { id: 'water',       walkable: false, color: '#3a7bd5' },
    { id: 'sand',        walkable: true,  color: '#e8d5a3' },
    { id: 'floor_wood',  walkable: true,  color: '#b8860b' },
    { id: 'floor_stone', walkable: true,  color: '#999999' },
  ],
  resources: [
    { id: 'food',  renewable: true,  baseProduction: 0.12, unit: 'rations', category: 'consumable', startAmount: 80 },
    { id: 'gold',  renewable: false, baseProduction: 0,    unit: 'coins',   category: 'currency',   startAmount: 100 },
    { id: 'wood',  renewable: true,  baseProduction: 0.05, unit: 'logs',    category: 'material',   startAmount: 40 },
    { id: 'stone', renewable: true,  baseProduction: 0.03, unit: 'blocks',  category: 'material',   startAmount: 30 },
  ],
  needs: [
    { id: 'hunger',  label: 'Hunger',  growthRate: 0.0004, satisfiedBy: ['food', 'bread', 'fish', 'vegetables'], decayAction: 'eat', critical: 0.9, statusEffects: { health: -0.1, happiness: -0.15 } },
    { id: 'rest',    label: 'Rest',    growthRate: 0.002,  satisfiedBy: ['bed', 'sleep'],     decayAction: 'sleep',     critical: 0.9 },
    { id: 'social',  label: 'Social',  growthRate: 0.003,  satisfiedBy: ['conversation'],     decayAction: 'socialize', critical: 0.8, statusEffects: { happiness: -0.15 } },
    { id: 'safety',  label: 'Safety',  growthRate: 0,      satisfiedBy: [],                   decayAction: null },
    { id: 'fun',     label: 'Fun',     growthRate: 0.002,  satisfiedBy: ['entertainment'],    decayAction: 'have_fun' },
    { id: 'purpose', label: 'Purpose', growthRate: 0.001,  satisfiedBy: ['work', 'craft'],    decayAction: 'work' },
    { id: 'romance', label: 'Romance', growthRate: 0.001,  satisfiedBy: ['partner', 'flirt'], decayAction: 'flirt',  threshold: 0.6 },
  ],
  traits: [
    { id: 'romantic',     label: 'Romantic' },
    { id: 'ambition',     label: 'Ambitious' },
    { id: 'introversion', label: 'Introverted' },
    { id: 'aggression',   label: 'Aggressive' },
    { id: 'empathy',      label: 'Empathetic' },
    { id: 'curiosity',    label: 'Curious' },
    { id: 'bravery',      label: 'Brave' },
    { id: 'creativity',   label: 'Creative' },
  ],
  skills: [
    { id: 'farming',    label: 'Farming' },
    { id: 'crafting',   label: 'Crafting' },
    { id: 'cooking',    label: 'Cooking' },
    { id: 'trading',    label: 'Trading' },
    { id: 'leadership', label: 'Leadership' },
    { id: 'medicine',   label: 'Medicine' },
    { id: 'combat',     label: 'Combat' },
    { id: 'art',        label: 'Art' },
    { id: 'science',    label: 'Science' },
    { id: 'persuasion', label: 'Persuasion' },
  ],
  status: [
    { id: 'health',     label: 'Health',     min: 0, max: 100, default: 90 },
    { id: 'wealth',     label: 'Wealth',     min: 0, max: 9999, default: 40 },
    { id: 'reputation', label: 'Reputation', min: 0, max: 100, default: 50 },
    { id: 'happiness',  label: 'Happiness',  min: 0, max: 100, default: 60 },
    { id: 'energy',     label: 'Energy',     min: 0, max: 100, default: 80 },
  ],
  occupations: [
    { id: 'farmer',     inputs: [],                                   outputs: [{ resource: 'food', qty: 1 }],         skill: 'farming',    description: 'Grows food' },
    { id: 'baker',      inputs: [{ resource: 'food', qty: 1 }],      outputs: [{ resource: 'bread', qty: 2 }],        skill: 'cooking',    description: 'Bakes bread' },
    { id: 'blacksmith', inputs: [{ resource: 'stone', qty: 1 }],     outputs: [{ resource: 'tool', qty: 1 }],         skill: 'crafting',   description: 'Forges tools' },
    { id: 'merchant',   inputs: [],                                   outputs: [],                                      skill: 'trading',    description: 'Trades goods' },
    { id: 'healer',     inputs: [],                                   outputs: [{ resource: 'medicine', qty: 1 }],     skill: 'medicine',   description: 'Heals the sick' },
    { id: 'guard',      inputs: [],                                   outputs: [],                                      skill: 'combat',     description: 'Protects the village' },
    { id: 'bard',       inputs: [],                                   outputs: [],                                      skill: 'art',        description: 'Entertains people' },
    { id: 'scholar',    inputs: [],                                   outputs: [],                                      skill: 'science',    description: 'Researches knowledge' },
    { id: 'carpenter',  inputs: [{ resource: 'wood', qty: 1 }],      outputs: [{ resource: 'furniture', qty: 1 }],    skill: 'crafting',   description: 'Builds with wood' },
    { id: 'fisherman',  inputs: [],                                   outputs: [{ resource: 'food', qty: 1 }],         skill: 'farming',    description: 'Catches fish' },
    { id: 'innkeeper',  inputs: [{ resource: 'food', qty: 1 }],      outputs: [],                                      skill: 'trading',    description: 'Runs the inn' },
    { id: 'priest',     inputs: [],                                   outputs: [],                                      skill: 'persuasion', description: 'Spiritual leader' },
    { id: 'teacher',    inputs: [],                                   outputs: [],                                      skill: 'science',    description: 'Educates others' },
    { id: 'hunter',     inputs: [],                                   outputs: [{ resource: 'food', qty: 1 }],         skill: 'combat',     description: 'Hunts game' },
    { id: 'tailor',     inputs: [{ resource: 'material', qty: 1 }],  outputs: [{ resource: 'clothing', qty: 1 }],     skill: 'crafting',   description: 'Makes clothes' },
  ],
  actions: [
    { id: 'eat',            effects: { hunger: -0.7 },        inputs: [{ resource: 'food', qty: 1 }], description: 'Eat a meal',              worldEffects: null },
    { id: 'sleep',          effects: { rest: -1, energy: 100 }, description: 'Rest and recover energy' },
    { id: 'work',           effects: { purpose: -0.4 },       description: 'Work at your occupation',  location: null },
    { id: 'socialize',      effects: { social: -0.3 },        description: 'Chat with someone',        social: true, target: 'agent' },
    { id: 'flirt',          effects: { romance: -0.2 },       description: 'Flirt with someone',       social: true, target: 'agent' },
    { id: 'give_gift',      effects: {},                       inputs: [{ resource: 'gold', qty: 5 }], description: 'Give a gift',     social: true, target: 'agent' },
    { id: 'buy_food',       effects: { hunger: -0.5 },        inputs: [{ resource: 'gold', qty: 3 }], outputs: [{ resource: 'food', qty: 1 }], description: 'Buy food', worldEffects: { 'resources.food': -1 } },
    { id: 'buy_item',       effects: {},                       inputs: [{ resource: 'gold', qty: 12 }], outputs: [{ resource: 'tool', qty: 1 }], description: 'Buy a tool' },
    { id: 'sell_item',      effects: {},                       description: 'Sell goods for gold' },
    { id: 'discover',       effects: { reputation: 5 },       description: 'Make a discovery or invention' },
    { id: 'open_business',  effects: {},                       inputs: [{ resource: 'gold', qty: 50 }], description: 'Open a new business', requires: [{ minWealth: 50 }] },
    { id: 'betray',         effects: { reputation: -10 },     description: 'Betray someone',            social: true, target: 'agent' },
    { id: 'become_leader',  effects: { purpose: -1, reputation: 15 }, description: 'Become the village leader' },
    { id: 'have_child',     effects: { romance: -0.3, happiness: 20 }, description: 'Have a child with your partner', social: true },
    { id: 'call_event',     effects: {},                       description: 'Organize a community event' },
    { id: 'have_fun',       effects: { fun: -0.4, happiness: 5 }, description: 'Do something enjoyable' },
    { id: 'pray',           effects: { purpose: -0.2, happiness: 3 }, description: 'Pray or meditate', location: 'temple' },
    { id: 'trade',          effects: {},                       description: 'Trade goods with another person', social: true, target: 'agent', location: 'market' },
    { id: 'explore',        effects: { fun: -0.2 },           description: 'Explore the surroundings' },
    { id: 'craft',          effects: { purpose: -0.3 },       description: 'Craft something',            location: 'workshop' },
  ],
  buildingTypes: [
    { id: 'house',      w: 5, h: 4, shape: 'default', rooms: ['bedroom', 'kitchen', 'living room'] },
    { id: 'tavern',     w: 7, h: 5, shape: 'default', rooms: ['main hall', 'kitchen', 'cellar'] },
    { id: 'shop',       w: 5, h: 4, shape: 'default', rooms: ['storefront', 'back room'] },
    { id: 'blacksmith', w: 6, h: 4, shape: 'default', rooms: ['forge', 'workshop'] },
    { id: 'church',     w: 6, h: 6, shape: 'default', rooms: ['sanctuary', 'office'] },
    { id: 'farm',       w: 7, h: 5, shape: 'default', rooms: ['barn', 'field'] },
    { id: 'market',     w: 6, h: 3, shape: 'default', rooms: ['stalls', 'storage'] },
    { id: 'townhall',   w: 7, h: 6, shape: 'default', rooms: ['meeting hall', 'office'] },
    { id: 'temple',     w: 6, h: 6, shape: 'default', rooms: ['prayer hall', 'meditation room'] },
    { id: 'hospital',   w: 6, h: 5, shape: 'default', rooms: ['reception', 'ward'] },
  ],
  visualStyle: {
    palette: ['#5b8c3e', '#c9b48c', '#3a7bd5', '#8B7355', '#e8d5a3'],
    groundTexture: 'organic',
    buildingMaterial: 'wood_plank',
    vegetationType: 'deciduous',
    waterStyle: 'still',
  },
  economy: {
    currency: 'gold',
    taxRate: 0.1,
    prices: { food: 3, tool: 12, lodging: 8, healing: 15, gift: 5, marketStall: 50 },
  },
  evolution: {
    seasons: [
      { id: 'spring', duration: 7, productionMod: 1.2, needMods: {} },
      { id: 'summer', duration: 7, productionMod: 1.0, needMods: { rest: 1.3 } },
      { id: 'autumn', duration: 7, productionMod: 0.8, needMods: {} },
      { id: 'winter', duration: 7, productionMod: 0.4, needMods: { hunger: 1.5 } },
    ],
    techTree: null,
    agingRate: 0,
  },
};

export const DEFAULT_WORLDDEF = new WorldDef(DEFAULT_WORLDDEF_RAW);
