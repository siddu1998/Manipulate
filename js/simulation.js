// ═══════════════════════════════════════════════════════════════════
//  SIMULATION ENGINE — The Core State Machine
//
//  This is the heart of the simulation. Everything is state:
//    • Agent needs decay over time (hunger grows, social need grows)
//    • Traits are persistent personality numbers (not text)
//    • Relationships are multi-dimensional (trust, attraction, respect)
//    • The world has resources, technology, economy
//    • Actions modify state → consequences emerge
//
//  The LLM is NOT used here. This is pure systems simulation.
//  The LLM only provides voice when agents talk.
// ═══════════════════════════════════════════════════════════════════

// ─── Agent State Template ─────────────────────────────────────────
export function createAgentState(npcData) {
  const rng = seededRng(npcData.name || 'default');

  // Parse personality text into trait numbers
  const traits = parseTraits(npcData.personality || '', rng);

  return {
    // ── Needs (0 = fully satisfied, 1 = desperate) ──
    needs: {
      hunger:    0.2 + rng() * 0.2,
      rest:      0.1 + rng() * 0.2,
      social:    0.3 + rng() * 0.3,
      safety:    0.0,
      fun:       0.3 + rng() * 0.2,
      purpose:   0.2 + rng() * 0.2,   // need to feel useful
      romance:   traits.romantic > 0.5 ? 0.3 + rng() * 0.3 : 0.1,
    },

    // ── Traits (0-1, persistent personality) ──
    traits,

    // ── Skills (0-10, grow with practice) ──
    skills: {
      farming:    rng() * 3,
      crafting:   rng() * 3,
      cooking:    rng() * 3,
      trading:    rng() * 3,
      leadership: rng() * 3,
      medicine:   rng() * 2,
      combat:     rng() * 2,
      art:        rng() * 3,
      science:    rng() * 2,
      persuasion: rng() * 3,
    },

    // ── Status ──
    status: {
      health:     85 + rng() * 15,   // 0-100
      wealth:     20 + rng() * 60,   // gold/currency
      reputation: 40 + rng() * 30,   // 0-100, community standing
      happiness:  50 + rng() * 30,   // 0-100
      energy:     70 + rng() * 30,   // 0-100
    },

    // ── Relationships (computed separately) ──
    // Map: name → { trust, attraction, respect, familiarity, fear, rivalry }

    // ── Knowledge (things this agent knows) ──
    knowledge: new Set(),

    // ── Inventory: { name, type, quantity } — food, tools, goods; bakers have bread, etc.
    inventory: getStartingInventory(npcData.occupation, rng),

    // ── Life stage ──
    lifeStage: npcData.age < 18 ? 'child' : npcData.age < 60 ? 'adult' : 'elder',
    partner: null,
    children: [],

    // ── Money transactions (for agent profile display) ──
    transactions: [],  // { amount, reason, gameTime?, day? } — recent earnings/spending
  };
}

// Parse personality description into numeric traits
function parseTraits(personality, rng) {
  const p = personality.toLowerCase();
  return {
    ambition:     hasWord(p, ['ambitious', 'driven', 'determined', 'aspiring']) ? 0.7 + rng()*0.3 : 0.3 + rng()*0.4,
    empathy:      hasWord(p, ['kind', 'caring', 'empathetic', 'gentle', 'warm', 'compassionate']) ? 0.7 + rng()*0.3 : 0.3 + rng()*0.4,
    curiosity:    hasWord(p, ['curious', 'inquisitive', 'fascinated', 'interested', 'creative']) ? 0.7 + rng()*0.3 : 0.3 + rng()*0.4,
    introversion: hasWord(p, ['shy', 'quiet', 'reserved', 'introverted', 'solitary']) ? 0.7 + rng()*0.3 : 0.2 + rng()*0.3,
    bravery:      hasWord(p, ['brave', 'courageous', 'bold', 'fearless']) ? 0.7 + rng()*0.3 : 0.3 + rng()*0.4,
    honesty:      hasWord(p, ['honest', 'truthful', 'sincere', 'trustworthy']) ? 0.7 + rng()*0.3 : 0.4 + rng()*0.3,
    humor:        hasWord(p, ['funny', 'humor', 'witty', 'jokes', 'playful']) ? 0.7 + rng()*0.3 : 0.3 + rng()*0.3,
    romantic:     hasWord(p, ['romantic', 'loving', 'passionate', 'affectionate']) ? 0.7 + rng()*0.3 : 0.3 + rng()*0.4,
    greed:        hasWord(p, ['greedy', 'materialistic', 'selfish', 'stingy']) ? 0.6 + rng()*0.3 : 0.1 + rng()*0.3,
    aggression:   hasWord(p, ['aggressive', 'angry', 'hostile', 'violent', 'gruff']) ? 0.5 + rng()*0.3 : 0.1 + rng()*0.2,
  };
}

function hasWord(text, words) {
  return words.some(w => text.includes(w));
}

// ─── Inventory: occupation-based starting items + helpers ──────────
const INV_MAX_QUANTITY = 40;

function getStartingInventory(occupation, rng) {
  const occ = (occupation || '').toLowerCase();
  if (/baker|bakery/.test(occ)) return [{ name: 'Bread', type: 'food', quantity: 3 + Math.floor(rng() * 3) }];
  if (/blacksmith|smith/.test(occ)) return [{ name: 'Simple tool', type: 'tool', quantity: 1 }, { name: 'Iron ingot', type: 'material', quantity: 2 }];
  if (/farmer|farm/.test(occ)) return [{ name: 'Grain', type: 'food', quantity: 4 }, { name: 'Vegetables', type: 'food', quantity: 2 }];
  if (/herbalist|healer|medicine/.test(occ)) return [{ name: 'Herbs', type: 'material', quantity: 5 }];
  if (/fisherman|fisher/.test(occ)) return [{ name: 'Fish', type: 'food', quantity: 3 }];
  if (/merchant|trader|innkeeper/.test(occ)) return [{ name: 'Trade goods', type: 'material', quantity: 2 }];
  return [];
}

export function addItem(sim, name, type, quantity = 1) {
  if (!sim.inventory) sim.inventory = [];
  const total = sim.inventory.reduce((s, i) => s + i.quantity, 0);
  if (total + quantity > INV_MAX_QUANTITY) quantity = Math.max(0, INV_MAX_QUANTITY - total);
  if (quantity <= 0) return 0;
  const existing = sim.inventory.find(i => i.name === name && i.type === type);
  if (existing) existing.quantity += quantity;
  else sim.inventory.push({ name, type, quantity });
  return quantity;
}

export function removeItem(sim, type, quantity = 1) {
  if (!sim.inventory) return 0;
  let left = quantity;
  for (const entry of sim.inventory) {
    if (entry.type !== type) continue;
    const take = Math.min(entry.quantity, left);
    entry.quantity -= take;
    left -= take;
    if (left <= 0) break;
  }
  sim.inventory = sim.inventory.filter(i => i.quantity > 0);
  return quantity - left;
}

export function removeItemByName(sim, name, quantity = 1) {
  if (!sim.inventory) return 0;
  const entry = sim.inventory.find(i => i.name === name);
  if (!entry) return 0;
  const take = Math.min(entry.quantity, quantity);
  entry.quantity -= take;
  if (entry.quantity <= 0) sim.inventory = sim.inventory.filter(i => i.name !== name || i.quantity > 0);
  return take;
}

export function countItem(sim, type) {
  if (!sim.inventory) return 0;
  return sim.inventory.filter(i => i.type === type).reduce((s, i) => s + i.quantity, 0);
}

export function hasFood(sim) {
  return countItem(sim, 'food') > 0;
}

// ─── Relationship State ───────────────────────────────────────────
export function createRelationship(initialSentiment) {
  const base = initialSentiment || 'stranger';
  const isPositive = /friend|close|love|partner|mentor|trust/i.test(base);
  const isNegative = /rival|enemy|tense|hate|distrust/i.test(base);
  return {
    trust:       isPositive ? 0.5 + Math.random()*0.3 : isNegative ? 0.1 : 0.3,
    attraction:  0.1 + Math.random() * 0.2,
    respect:     isPositive ? 0.5 + Math.random()*0.2 : 0.3 + Math.random()*0.2,
    familiarity: isPositive ? 0.6 : 0.2,
    fear:        isNegative ? 0.3 : 0.0,
    rivalry:     isNegative ? 0.4 : 0.0,
    interactions: isPositive ? 5 : 1,
    label:       base,
  };
}

// Derive relationship label from numbers
export function getRelationshipLabel(rel) {
  if (rel.attraction > 0.7 && rel.trust > 0.6) return 'in love';
  if (rel.attraction > 0.5 && rel.trust > 0.5) return 'romantic interest';
  if (rel.trust > 0.7 && rel.familiarity > 0.7) return 'close friend';
  if (rel.trust > 0.5 && rel.familiarity > 0.4) return 'friend';
  if (rel.rivalry > 0.5) return 'rival';
  if (rel.fear > 0.5) return 'fearful';
  if (rel.familiarity > 0.3) return 'acquaintance';
  return 'stranger';
}

// ─── World State ──────────────────────────────────────────────────
export function createWorldState(worldName, buildings) {
  return {
    name: worldName,

    // Resources (community-level)
    resources: {
      food:     150 + Math.random() * 100,
      wood:     100 + Math.random() * 80,
      stone:    60  + Math.random() * 40,
      iron:     20  + Math.random() * 20,
      gold:     200 + Math.random() * 300,
      herbs:    30  + Math.random() * 20,
    },

    // Technology levels (0-10)
    technology: {
      farming:      1 + Math.random(),
      construction: 1 + Math.random(),
      medicine:     0.5 + Math.random() * 0.5,
      smithing:     1 + Math.random(),
      education:    0.5 + Math.random() * 0.5,
      trade:        1 + Math.random(),
      arts:         0.5 + Math.random(),
    },

    // Economy — currency drives prices, taxes, and who gets ahead
    economy: {
      currencyName: 'gold',
      foodPrice:    2 + Math.random(),
      woodPrice:    3 + Math.random(),
      toolPrice:    10 + Math.random() * 5,
      // Priced goods and services (in currency)
      prices: {
        food:    2.5,
        tool:    12,
        lodging: 8,
        healing: 15,
        gift:    5,
        marketStall: 50,  // cost to open a new shop
      },
      taxRate:      0.1,   // fraction of income/wealth collected periodically
      treasury:     30 + Math.random() * 70,  // community coffers (taxes)
      prosperity:   50 + Math.random() * 20, // 0-100
    },

    // Bank — community savings; agents can deposit/withdraw (future: loans)
    bank: {
      balance: 0,  // total deposits (optional: per-agent ledger)
    },

    // Governance — politics; leader can be influenced by wealth/reputation
    governance: {
      leader:       null,  // NPC name; high wealth + reputation can claim leadership
      councilMembers: [],
      laws:         ['No theft', 'Respect elders', 'Share water'],
      unrest:       10 + Math.random() * 15, // 0-100
    },

    // Environment
    environment: {
      season:       'spring',
      weather:      'clear',
      fertility:    0.7 + Math.random() * 0.3,  // crop yield multiplier
      diseaseRisk:  0.05,
    },

    // Stats
    population:   0,  // set from NPC count
    day:          1,
    history:      [],  // [{day, event}]
  };
}

// ═══════════════════════════════════════════════════════════════════
//  SIMULATION TICK — Runs every game-minute
//
//  This is where emergent behavior comes from:
//  needs grow → agents become motivated → take actions → world changes
// ═══════════════════════════════════════════════════════════════════

export function simulationTick(agents, worldState, gameTime) {
  const events = [];
  const now = Date.now();

  // Helper: check if a field is frozen (user manually set it)
  function isFrozen(obj, field) {
    return obj?._frozen?.[field] && now < obj._frozen[field];
  }

  // ── Update each agent ──
  for (const agent of agents) {
    if (!agent.sim) continue;
    const s = agent.sim;
    const traits = s.traits;

    // 1. NEEDS DECAY (skip frozen fields)
    if (!isFrozen(s, 'needs.hunger'))  s.needs.hunger  = clamp01(s.needs.hunger + 0.003);
    if (!isFrozen(s, 'needs.rest'))    s.needs.rest    = clamp01(s.needs.rest + 0.002);
    if (!isFrozen(s, 'needs.social'))  s.needs.social  = clamp01(s.needs.social + (traits.introversion > 0.6 ? 0.001 : 0.004));
    if (!isFrozen(s, 'needs.fun'))     s.needs.fun     = clamp01(s.needs.fun + 0.002);
    if (!isFrozen(s, 'needs.purpose')) s.needs.purpose = clamp01(s.needs.purpose + 0.001);
    if (!isFrozen(s, 'needs.romance')) s.needs.romance = clamp01(s.needs.romance + (traits.romantic > 0.5 ? 0.002 : 0.0005));

    // 2. STATUS EFFECTS
    // Hunger affects health and happiness
    if (s.needs.hunger > 0.8) {
      s.status.health = Math.max(0, s.status.health - 0.1);
      s.status.happiness = Math.max(0, s.status.happiness - 0.2);
    }
    // Loneliness affects happiness
    if (s.needs.social > 0.7) {
      s.status.happiness = Math.max(0, s.status.happiness - 0.15);
    }
    // Rest affects energy
    if (s.needs.rest > 0.7) {
      s.status.energy = Math.max(0, s.status.energy - 0.2);
    }
    // Purpose fulfilled boosts happiness
    if (s.needs.purpose < 0.3) {
      s.status.happiness = Math.min(100, s.status.happiness + 0.05);
    }

    // 3. RELATIONSHIP DRIFT
    // Relationships slowly decay without interaction
    if (agent.cognition) {
      for (const [name, rel] of agent.simRelationships || new Map()) {
        rel.familiarity = Math.max(0, rel.familiarity - 0.0005);
        if (rel.trust > 0.3) rel.trust -= 0.0002;
        // Update label
        rel.label = getRelationshipLabel(rel);
      }
    }

    // 4. HAPPINESS COMPUTATION
    const needsAvg = Object.values(s.needs).reduce((a, b) => a + b, 0) / Object.keys(s.needs).length;
    const needsSatisfaction = 1 - needsAvg; // higher is better
    s.status.happiness = clamp100(
      s.status.happiness * 0.99 + // slow drift to base
      needsSatisfaction * 0.5 +    // needs contribution
      (s.status.health > 80 ? 0.1 : -0.1) + // health bonus
      (s.partner ? 0.05 : 0)       // partner bonus
    );

    // 5. EMERGENT EVENTS — check thresholds (use economy prices)
    const foodPrice = worldState.economy.prices?.food ?? worldState.economy.foodPrice ?? 5;
    if (s.needs.hunger > 0.9 && s.status.wealth >= foodPrice) {
      events.push({ type: 'buy_food', agent: agent.name, auto: true });
    }
    if (s.needs.social > 0.85 && traits.introversion < 0.5) {
      events.push({ type: 'seek_company', agent: agent.name, auto: true });
    }
    if (s.needs.romance > 0.7 && traits.romantic > 0.5 && !s.partner) {
      events.push({ type: 'seek_romance', agent: agent.name, auto: true });
    }
    if (traits.ambition > 0.7 && s.status.reputation > 60 && !worldState.governance.leader) {
      events.push({ type: 'seek_leadership', agent: agent.name, auto: true });
    }

    // ★ 6. COGNITIVE BRIDGE — generate awareness events when state crosses thresholds
    // These become observations in the agent's memory stream via app.js

    // ── Distress alerts (need is HIGH) ──
    if (s.needs.hunger > 0.8 && !agent._lastHungerAlert) {
      events.push({ type: 'awareness', agent: agent.name, text: `I'm getting really hungry. I need to find food soon.`, importance: 6 });
      agent._lastHungerAlert = true;
    } else if (s.needs.hunger < 0.4) { agent._lastHungerAlert = false; }

    if (s.needs.rest > 0.8 && !agent._lastRestAlert) {
      events.push({ type: 'awareness', agent: agent.name, text: `I'm exhausted. I need to rest.`, importance: 5 });
      agent._lastRestAlert = true;
    } else if (s.needs.rest < 0.4) { agent._lastRestAlert = false; }

    if (s.status.health < 40 && !agent._lastHealthAlert) {
      events.push({ type: 'awareness', agent: agent.name, text: `I'm not feeling well. My health is deteriorating.`, importance: 7 });
      agent._lastHealthAlert = true;
    } else if (s.status.health > 60) { agent._lastHealthAlert = false; }

    if (s.status.happiness < 25 && !agent._lastSadAlert) {
      events.push({ type: 'awareness', agent: agent.name, text: `I feel deeply unhappy. Something needs to change.`, importance: 6 });
      agent._lastSadAlert = true;
    } else if (s.status.happiness > 40) { agent._lastSadAlert = false; }

    // ── Satisfaction alerts (need was HIGH, now LOW — agent notices relief) ──
    if (s.needs.hunger < 0.15 && agent._wasHungry) {
      events.push({ type: 'awareness', agent: agent.name, text: `I feel full and satisfied. No more hunger.`, importance: 4 });
      agent._wasHungry = false;
    } else if (s.needs.hunger > 0.6) { agent._wasHungry = true; }

    if (s.needs.rest < 0.15 && agent._wasTired) {
      events.push({ type: 'awareness', agent: agent.name, text: `I feel well-rested and energized!`, importance: 4 });
      agent._wasTired = false;
    } else if (s.needs.rest > 0.6) { agent._wasTired = true; }

    if (s.needs.social < 0.2 && agent._wasLonely) {
      events.push({ type: 'awareness', agent: agent.name, text: `I feel socially fulfilled. Good to connect with people.`, importance: 3 });
      agent._wasLonely = false;
    } else if (s.needs.social > 0.6) { agent._wasLonely = true; }
  }

  // ★ 7. WORLD-LEVEL AWARENESS — generate observations about world crises
  if (worldState.resources.food < agents.length * 2 && !worldState._foodCrisisAlerted) {
    worldState._foodCrisisAlerted = true;
    for (const agent of agents) {
      events.push({ type: 'world_awareness', agent: agent.name, text: `The village food supply is critically low. People are going hungry.`, importance: 8 });
    }
  } else if (worldState.resources.food > agents.length * 5) { worldState._foodCrisisAlerted = false; }

  if (worldState.governance.unrest > 50 && !worldState._unrestAlerted) {
    worldState._unrestAlerted = true;
    for (const agent of agents) {
      events.push({ type: 'world_awareness', agent: agent.name, text: `There's growing unrest in the village. People are unhappy with how things are going.`, importance: 7 });
    }
  } else if (worldState.governance.unrest < 30) { worldState._unrestAlerted = false; }

  if (worldState.economy.prosperity < 20 && !worldState._prosperityAlerted) {
    worldState._prosperityAlerted = true;
    for (const agent of agents) {
      events.push({ type: 'world_awareness', agent: agent.name, text: `The village economy is struggling. Prosperity is at an all-time low.`, importance: 7 });
    }
  } else if (worldState.economy.prosperity > 40) { worldState._prosperityAlerted = false; }

  // ── Update world ──
  // Resource production (skip if user froze the value)
  if (!isFrozen(worldState, 'resources.food')) {
    worldState.resources.food += worldState.technology.farming * worldState.environment.fertility * 0.1;
    worldState.resources.food -= agents.length * 0.05;
  }

  // Prosperity
  const resourceHealth = Math.min(1, worldState.resources.food / (agents.length * 10));
  worldState.economy.prosperity = clamp100(
    worldState.economy.prosperity * 0.99 + resourceHealth * 50 * 0.01
  );

  // Unrest grows when prosperity is low
  if (worldState.economy.prosperity < 30) {
    worldState.governance.unrest = Math.min(100, worldState.governance.unrest + 0.1);
  } else {
    worldState.governance.unrest = Math.max(0, worldState.governance.unrest - 0.05);
  }

  // ★ TAX COLLECTION — once per day; taxes flow to treasury (politics/economy)
  const day = gameTime?.day ?? worldState.day ?? 1;
  if (day > (worldState._lastTaxDay ?? 0)) {
    worldState._lastTaxDay = day;
    const rate = worldState.economy.taxRate ?? 0.1;
    for (const a of agents) {
      if (!a.sim) continue;
      const tax = Math.min(a.sim.status.wealth * rate * 0.2, a.sim.status.wealth * 0.05);
      if (tax > 0) {
        a.sim.status.wealth -= tax;
        worldState.economy.treasury = (worldState.economy.treasury ?? 0) + tax;
        a.sim.transactions = a.sim.transactions || [];
        a.sim.transactions.push({ amount: -tax, reason: 'tax', day, gameTime });
      }
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════
//  CONSEQUENCE ENGINE
//
//  When an action happens, this computes ripple effects on all state.
//  Returns a list of state changes for logging/display.
// ═══════════════════════════════════════════════════════════════════

export function applyConsequence(action, agent, target, worldState, allAgents, actionDetails = null) {
  const changes = [];
  const worldChanges = [];
  const transactions = [];  // { agentName, amount, reason } for UI
  const s = agent.sim;
  if (!s) return { changes, worldChanges, transactions };

  const currency = worldState.economy?.currencyName ?? 'gold';
  const prices = worldState.economy?.prices ?? {};
  const foodPrice = prices.food ?? worldState.economy?.foodPrice ?? 5;
  const giftPrice = prices.gift ?? 5;
  const details = actionDetails ?? {};

  switch (action) {
    case 'eat': {
      if (hasFood(s)) {
        removeItem(s, 'food', 1);
        s.needs.hunger = Math.max(0, s.needs.hunger - 0.5);
        s.status.happiness = Math.min(100, s.status.happiness + 2);
        changes.push(`${agent.name} ate from inventory (hunger -0.5)`);
      } else if (worldState.resources.food >= 1) {
        worldState.resources.food -= 1;
        s.needs.hunger = Math.max(0, s.needs.hunger - 0.5);
        s.status.happiness = Math.min(100, s.status.happiness + 2);
        changes.push(`${agent.name} ate (hunger -0.5, world food -1)`);
      }
      break;
    }
    case 'buy_food': {
      if (s.status.wealth < foodPrice || worldState.resources.food < 0.5) break;
      s.status.wealth -= foodPrice;
      worldState.economy.treasury = (worldState.economy.treasury ?? 0) + foodPrice * 0.3;
      worldState.resources.food -= 1;
      addItem(s, 'Food', 'food', 1);
      transactions.push({ agentName: agent.name, amount: -foodPrice, reason: 'bought food' });
      changes.push(`${agent.name} bought food (${foodPrice} ${currency}) → inventory`);
      break;
    }
    case 'buy_item': {
      const itemType = details.type || 'tool';
      const price = itemType === 'tool' ? (prices.tool ?? worldState.economy?.toolPrice ?? 12) : foodPrice;
      if (s.status.wealth < price) break;
      s.status.wealth -= price;
      const itemName = itemType === 'tool' ? 'Tool' : 'Food';
      addItem(s, itemName, itemType, 1);
      transactions.push({ agentName: agent.name, amount: -price, reason: `bought ${itemType}` });
      changes.push(`${agent.name} bought ${itemType} (${price} ${currency}) → inventory`);
      break;
    }
    case 'sell_item': {
      const sellType = details.type || 'food';
      const qty = Math.min(details.quantity ?? 1, countItem(s, sellType));
      if (qty <= 0) break;
      const sellPrices = { food: (foodPrice * 0.6), tool: ((prices.tool ?? 12) * 0.5), material: 2 };
      const unitPrice = sellPrices[sellType] ?? 1;
      const total = (unitPrice * qty) | 0;
      removeItem(s, sellType, qty);
      s.status.wealth += total;
      transactions.push({ agentName: agent.name, amount: total, reason: `sold ${qty} ${sellType}` });
      changes.push(`${agent.name} sold ${qty} ${sellType} for ${total} ${currency}`);
      break;
    }
    case 'sleep': {
      s.needs.rest = 0;
      s.status.energy = 100;
      changes.push(`${agent.name} rested (rest=0, energy=100)`);
      break;
    }
    case 'socialize': {
      s.needs.social = Math.max(0, s.needs.social - 0.3);
      s.status.happiness = Math.min(100, s.status.happiness + 3);
      if (target) {
        const rel = getOrCreateRelationship(agent, target.name);
        rel.familiarity = Math.min(1, rel.familiarity + 0.05);
        rel.trust = Math.min(1, rel.trust + 0.02);
        rel.interactions++;
        rel.label = getRelationshipLabel(rel);
        changes.push(`${agent.name} socialized with ${target.name} (familiarity +0.05)`);
      }
      break;
    }
    case 'work': {
      s.needs.purpose = Math.max(0, s.needs.purpose - 0.4);
      const pay = 2 + Math.random() * 3 + (worldState.economy?.prosperity ?? 50) * 0.02;
      s.status.wealth += pay;
      transactions.push({ agentName: agent.name, amount: pay, reason: 'work' });
      const skillKey = occupationSkillMap[agent.occupation?.toLowerCase()] || 'crafting';
      if (s.skills[skillKey] !== undefined) {
        s.skills[skillKey] = Math.min(10, s.skills[skillKey] + 0.02);
      }
      // Occupation-based production: bakers make bread, blacksmiths tools, etc.
      const produced = occupationProduces(agent.occupation);
      if (produced) {
        addItem(s, produced.name, produced.type, produced.quantity);
        changes.push(`${agent.name} worked (purpose -0.4, wealth +${pay.toFixed(1)} ${currency}, produced ${produced.quantity} ${produced.name})`);
      } else {
        changes.push(`${agent.name} worked (purpose -0.4, wealth +${pay.toFixed(1)} ${currency}, ${skillKey} +0.02)`);
      }
      break;
    }
    case 'flirt': {
      if (!target) break;
      const rel = getOrCreateRelationship(agent, target.name);
      const targetRel = getOrCreateRelationship(target, agent.name);
      // Attraction grows based on both agents' romantic trait
      const chemistry = (s.traits.romantic + (target.sim?.traits?.romantic || 0.5)) / 2;
      rel.attraction = Math.min(1, rel.attraction + 0.08 * chemistry);
      targetRel.attraction = Math.min(1, targetRel.attraction + 0.05 * chemistry);
      rel.familiarity = Math.min(1, rel.familiarity + 0.05);
      targetRel.familiarity = Math.min(1, targetRel.familiarity + 0.05);
      rel.interactions++;
      targetRel.interactions++;
      s.needs.romance = Math.max(0, s.needs.romance - 0.2);
      rel.label = getRelationshipLabel(rel);
      targetRel.label = getRelationshipLabel(targetRel);
      changes.push(`${agent.name} flirted with ${target.name} (attraction +${(0.08*chemistry).toFixed(2)})`);
      // Check for partnership
      if (rel.attraction > 0.75 && rel.trust > 0.6 && targetRel.attraction > 0.6) {
        if (!s.partner && !target.sim?.partner) {
          s.partner = target.name;
          if (target.sim) target.sim.partner = agent.name;
          changes.push(`💕 ${agent.name} and ${target.name} became partners!`);
          // All agents learn about it
          for (const a of allAgents) {
            if (a.sim) a.sim.knowledge.add(`${agent.name} and ${target.name} are together`);
          }
        }
      }
      break;
    }
    case 'give_gift': {
      if (!target) break;
      const cost = giftPrice;
      if (s.status.wealth >= cost) {
        s.status.wealth -= cost;
        transactions.push({ agentName: agent.name, amount: -cost, reason: `gift to ${target.name}` });
        const rel = getOrCreateRelationship(agent, target.name);
        const targetRel = getOrCreateRelationship(target, agent.name);
        rel.trust = Math.min(1, rel.trust + 0.05);
        targetRel.trust = Math.min(1, targetRel.trust + 0.08);
        targetRel.respect = Math.min(1, targetRel.respect + 0.03);
        rel.label = getRelationshipLabel(rel);
        targetRel.label = getRelationshipLabel(targetRel);
        changes.push(`${agent.name} gave a gift to ${target.name} (trust +0.08)`);
      }
      break;
    }
    case 'betray': {
      if (!target) break;
      const rel = getOrCreateRelationship(agent, target.name);
      const targetRel = getOrCreateRelationship(target, agent.name);
      targetRel.trust = Math.max(0, targetRel.trust - 0.4);
      targetRel.rivalry = Math.min(1, targetRel.rivalry + 0.3);
      targetRel.respect = Math.max(0, targetRel.respect - 0.2);
      s.status.reputation = Math.max(0, s.status.reputation - 10);
      rel.label = getRelationshipLabel(rel);
      targetRel.label = getRelationshipLabel(targetRel);
      changes.push(`${agent.name} betrayed ${target.name}! (trust -0.4, reputation -10)`);
      // Gossip spreads
      for (const a of allAgents) {
        if (a.sim && a.name !== agent.name) a.sim.knowledge.add(`${agent.name} betrayed ${target.name}`);
      }
      break;
    }
    case 'discover': {
      // Technology advance
      const techKeys = Object.keys(worldState.technology);
      const field = techKeys[Math.floor(Math.random() * techKeys.length)];
      worldState.technology[field] = Math.min(10, worldState.technology[field] + 0.3);
      s.status.reputation += 5;
      changes.push(`${agent.name} made a discovery in ${field}! (+0.3)`);
      for (const a of allAgents) {
        if (a.sim) a.sim.knowledge.add(`${agent.name} discovered something about ${field}`);
      }
      break;
    }
    case 'seek_leadership':
    case 'become_leader': {
      worldState.governance.leader = agent.name;
      s.status.reputation = Math.min(100, s.status.reputation + 15);
      s.needs.purpose = 0;
      changes.push(`${agent.name} became the village leader!`);
      for (const a of allAgents) {
        if (a.sim) a.sim.knowledge.add(`${agent.name} is now the village leader`);
      }
      break;
    }
    case 'have_child': {
      if (!target || !s.partner) break;
      s.children.push(`Child of ${agent.name} & ${target.name}`);
      if (target.sim) target.sim.children.push(`Child of ${agent.name} & ${target.name}`);
      worldState.population++;
      changes.push(`👶 ${agent.name} and ${target.name} had a child!`);
      for (const a of allAgents) {
        if (a.sim) a.sim.knowledge.add(`${agent.name} and ${target.name} had a child`);
      }
      break;
    }

    case 'open_business': {
      const stallCost = prices.marketStall ?? 50;
      if (s.status.wealth < stallCost || s.ownsBusiness) break;
      s.status.wealth -= stallCost;
      transactions.push({ agentName: agent.name, amount: -stallCost, reason: 'opened shop' });
      worldState.economy.treasury = (worldState.economy.treasury ?? 0) + stallCost * 0.2;
      const shopName = details.name ?? `${agent.name}'s Shop`;
      s.ownsBusiness = shopName;
      worldChanges.push({ action: 'add_building', details: { name: shopName, type: 'shop', owner: agent.name } });
      changes.push(`${agent.name} opened a new business: ${shopName}`);
      for (const a of allAgents) {
        if (a.sim) a.sim.knowledge.add(`${agent.name} opened ${shopName}`);
      }
      break;
    }

    case 'call_event': {
      const eventType = details.type || 'gathering';
      const topic = details.topic || `${eventType} called by ${agent.name}`;
      const valid = ['election', 'festival', 'meeting', 'debate', 'trial', 'rally', 'protest', 'gathering'].includes(eventType);
      if (!valid) break;
      s.lastCallEventDay = worldState.day ?? 1;
      worldChanges.push({ action: 'start_community_event', details: { type: eventType, topic, caller: agent.name } });
      s.status.reputation = Math.min(100, s.status.reputation + 2);
      changes.push(`${agent.name} called for a ${eventType}: ${topic}`);
      for (const a of allAgents) {
        if (a.sim) a.sim.knowledge.add(`${agent.name} called for a ${eventType}`);
      }
      break;
    }
  }

  return { changes, worldChanges, transactions };
}

// ─── Helpers ──────────────────────────────────────────────────────
function getOrCreateRelationship(agent, targetName) {
  if (!agent.simRelationships) agent.simRelationships = new Map();
  if (!agent.simRelationships.has(targetName)) {
    agent.simRelationships.set(targetName, createRelationship('stranger'));
  }
  return agent.simRelationships.get(targetName);
}

export { getOrCreateRelationship };

// ─── Occupation Skill Map (fallback for unknown occupations) ──────
const occupationSkillMap = {
  farmer: 'farming', blacksmith: 'crafting', baker: 'cooking',
  merchant: 'trading', mayor: 'leadership', healer: 'medicine',
  herbalist: 'medicine', guard: 'combat', hunter: 'combat',
  bard: 'art', teacher: 'science', scholar: 'science',
  priest: 'persuasion', innkeeper: 'trading', carpenter: 'crafting',
  tailor: 'crafting', fisherman: 'farming',
};

// ─── Generative Occupation Production ────────────────────────────
// Cache of LLM-generated production for each occupation.
// Populated by generateOccupationProduction() on first work action.
const _occupationProductionCache = new Map();

function occupationProduces(occupation) {
  const occ = (occupation || '').toLowerCase();

  // Check LLM-generated cache first
  if (_occupationProductionCache.has(occ)) {
    const items = _occupationProductionCache.get(occ);
    if (!items || items.length === 0) return null;
    // Pick a random production from the generated options
    const pick = items[Math.floor(Math.random() * items.length)];
    if (pick.chance !== undefined && Math.random() > pick.chance) return null;
    return { name: pick.name, type: pick.type, quantity: pick.quantity || 1 };
  }

  // Fallback for common occupations (used before LLM populates the cache)
  if (/baker|bakery/.test(occ)) return { name: 'Bread', type: 'food', quantity: 1 };
  if (/blacksmith|smith/.test(occ)) return Math.random() < 0.4 ? { name: 'Simple tool', type: 'tool', quantity: 1 } : null;
  if (/farmer|farm/.test(occ)) return { name: 'Vegetables', type: 'food', quantity: 1 };
  if (/fisherman|fisher/.test(occ)) return { name: 'Fish', type: 'food', quantity: 1 };
  if (/herbalist|healer/.test(occ)) return Math.random() < 0.5 ? { name: 'Herbs', type: 'material', quantity: 1 } : null;
  return null;
}

// ★ Called from app.js on first work action for each occupation
// Populates the cache with LLM-generated production items
export async function generateOccupationProduction(occupation, llm) {
  const occ = (occupation || '').toLowerCase();
  if (_occupationProductionCache.has(occ)) return; // already generated

  try {
    const result = await llm.generate(
      'You determine what a worker produces in a village simulation. JSON only.',
      `What does a "${occupation}" produce when they work? Return 1-3 items they might create.
Each item: name (specific, e.g. "Fresh bread" not "food"), type (food|tool|material), quantity (1-2), chance (0.0-1.0, how likely per work session).
{"items":[{"name":"...","type":"food","quantity":1,"chance":0.8}]}`,
      { json: true, temperature: 0.7, maxTokens: 200 }
    );
    _occupationProductionCache.set(occ, result.items || []);
  } catch {
    _occupationProductionCache.set(occ, []); // empty = no production
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function clamp100(v) { return Math.max(0, Math.min(100, v)); }

function seededRng(str) {
  let seed = 0;
  for (let i = 0; i < str.length; i++) seed = ((seed << 5) - seed + str.charCodeAt(i)) | 0;
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
