// ═══════════════════════════════════════════════════════════════════
//  GOAL SYSTEM — Drives agent behavior from state
//
//  Two modes:
//    1. Algorithmic (fallback): Fixed goals from thresholds
//    2. Generative (primary): LLM decides what the agent wants
//
//  The LLM can generate ANY goal — not just eat/sleep/work.
//  "I want to warn everyone about the food shortage"
//  "I should propose to my partner"
//  "I need to confront the person who betrayed me"
// ═══════════════════════════════════════════════════════════════════

import { getRelationshipLabel, getOrCreateRelationship, countItem } from './simulation.js';

// ─── Generate goals from current agent state ──────────────────────
export function generateGoals(agent, allAgents, worldState) {
  if (!agent.sim) return [];
  const s = agent.sim;
  const t = s.traits;
  const goals = [];

  // ── SURVIVAL NEEDS ──
  if (s.needs.hunger > 0.6) {
    goals.push({
      type: 'eat',
      priority: s.needs.hunger * 2,  // urgent when hungry
      action: 'eat',
      description: `${agent.name} needs to eat`,
    });
  }

  if (s.needs.rest > 0.7) {
    goals.push({
      type: 'sleep',
      priority: s.needs.rest * 1.8,
      action: 'sleep',
      description: `${agent.name} needs to rest`,
    });
  }

  // ── SOCIAL NEEDS ──
  if (s.needs.social > 0.5 && t.introversion < 0.7) {
    // Pick someone to socialize with
    const candidates = allAgents.filter(a => a.name !== agent.name);
    if (candidates.length > 0) {
      // Prefer friends
      let best = candidates[0];
      let bestScore = 0;
      for (const c of candidates) {
        const rel = agent.simRelationships?.get(c.name);
        const score = rel ? (rel.familiarity + rel.trust) : 0.1;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      goals.push({
        type: 'socialize',
        priority: s.needs.social * 1.5 * (1 - t.introversion),
        action: 'socialize',
        target: best,
        description: `${agent.name} wants to chat with ${best.name}`,
      });
    }
  }

  // ── WORK / PURPOSE ──
  if (s.needs.purpose > 0.4) {
    goals.push({
      type: 'work',
      priority: s.needs.purpose * 1.3 * (0.5 + t.ambition),
      action: 'work',
      description: `${agent.name} wants to do ${agent.occupation} work`,
    });
  }

  // ── ROMANCE ──
  if (s.needs.romance > 0.5 && t.romantic > 0.4 && !s.partner) {
    // Find someone with positive attraction
    const prospects = allAgents.filter(a => {
      if (a.name === agent.name) return false;
      if (a.sim?.partner) return false;
      const rel = agent.simRelationships?.get(a.name);
      return rel && rel.attraction > 0.3;
    });
    if (prospects.length > 0) {
      const best = prospects.reduce((a, b) => {
        const ra = agent.simRelationships?.get(a.name)?.attraction || 0;
        const rb = agent.simRelationships?.get(b.name)?.attraction || 0;
        return ra > rb ? a : b;
      });
      goals.push({
        type: 'flirt',
        priority: s.needs.romance * 1.4 * t.romantic,
        action: 'flirt',
        target: best,
        description: `${agent.name} is attracted to ${best.name}`,
      });
    }
  }

  // ── AMBITION / LEADERSHIP ──
  if (t.ambition > 0.6 && s.status.reputation > 50 && s.skills.leadership > 3) {
    if (!worldState.governance.leader || worldState.governance.unrest > 40) {
      goals.push({
        type: 'seek_leadership',
        priority: t.ambition * 0.8,
        action: 'seek_leadership',
        description: `${agent.name} wants to become a leader`,
      });
    }
  }

  // ── CURIOSITY / DISCOVERY ──
  if (t.curiosity > 0.6 && s.skills.science > 2) {
    goals.push({
      type: 'research',
      priority: t.curiosity * 0.6,
      action: 'discover',
      description: `${agent.name} wants to research and discover`,
    });
  }

  // ── OPEN BUSINESS (currency + world creation) ──
  const stallCost = worldState.economy?.prices?.marketStall ?? 50;
  if (!s.ownsBusiness && s.status.wealth >= stallCost && t.ambition > 0.5 && (agent.occupation?.toLowerCase().includes('merchant') || agent.occupation?.toLowerCase().includes('trader') || t.greed > 0.4)) {
    goals.push({
      type: 'open_business',
      priority: 0.6 + t.ambition * 0.2,
      action: 'open_business',
      details: { name: `${agent.name}'s Shop` },
      description: `${agent.name} wants to open a new shop`,
    });
  }

  // ── FUN ──
  if (s.needs.fun > 0.6) {
    goals.push({
      type: 'have_fun',
      priority: s.needs.fun * 0.9,
      action: 'have_fun',
      description: `${agent.name} wants to have fun`,
    });
  }

  // ── CALL EVENTS (elections, festivals, meetings, rallies, protests) ──
  const day = worldState.day ?? 1;
  const lastCall = s.lastCallEventDay ?? 0;
  const eventCooldown = day - lastCall >= 2; // don't call again for 2+ days
  const unrest = worldState.governance?.unrest ?? 0;
  const prosperity = worldState.economy?.prosperity ?? 50;
  const hasLeader = !!worldState.governance?.leader;

  if (eventCooldown) {
    if (!hasLeader && unrest > 30 && t.ambition > 0.5 && s.status.reputation > 40) {
      goals.push({
        type: 'call_election',
        priority: 0.55 + t.ambition * 0.15,
        action: 'call_event',
        details: { type: 'election', topic: `Election called by ${agent.name}` },
        description: `${agent.name} wants to call for an election`,
      });
    }
    if (prosperity > 55 && (s.needs.fun > 0.5 || s.needs.social > 0.5)) {
      goals.push({
        type: 'organize_festival',
        priority: 0.5 + (s.needs.fun + s.needs.social) * 0.15,
        action: 'call_event',
        details: { type: 'festival', topic: `Festival organized by ${agent.name}` },
        description: `${agent.name} wants to organize a festival`,
      });
    }
    if (unrest > 35 && (t.ambition > 0.4 || s.status.reputation > 35)) {
      goals.push({
        type: 'call_meeting',
        priority: 0.52 + (unrest / 100) * 0.2,
        action: 'call_event',
        details: { type: 'meeting', topic: `Town meeting called by ${agent.name}` },
        description: `${agent.name} wants to call a town meeting`,
      });
    }
    if (unrest > 40 && (t.bravery > 0.5 || t.ambition > 0.5)) {
      goals.push({
        type: 'hold_rally',
        priority: 0.53 + (unrest / 100) * 0.15,
        action: 'call_event',
        details: { type: 'rally', topic: `Rally organized by ${agent.name}` },
        description: `${agent.name} wants to hold a rally`,
      });
    }
    if (unrest > 50 && (t.bravery > 0.5 || t.aggression > 0.4)) {
      goals.push({
        type: 'hold_protest',
        priority: 0.56 + (unrest / 100) * 0.2,
        action: 'call_event',
        details: { type: 'protest', topic: `Protest about village unrest – ${agent.name}` },
        description: `${agent.name} wants to organize a protest`,
      });
    }
    // ── Call for any gathering (potluck, book club, picnic, get-together, etc.) ──
    const gatheringTopics = [
      'Potluck', 'Village get-together', 'Community meal', 'Book club', 'Picnic in the square',
      'Support group', 'Community gathering', 'Block party', 'Storytelling evening', 'Tea at the square',
    ];
    const gatheringTopic = gatheringTopics[Math.floor(Math.random() * gatheringTopics.length)];
    if (s.needs.social > 0.45 || t.empathy > 0.45 || s.skills.leadership > 1.5) {
      goals.push({
        type: 'call_gathering',
        priority: 0.48 + (s.needs.social + t.empathy) * 0.15,
        action: 'call_event',
        details: { type: 'gathering', topic: `${gatheringTopic} – called by ${agent.name}` },
        description: `${agent.name} wants to call a gathering (${gatheringTopic.toLowerCase()})`,
      });
    }
  }

  // ── BUY ITEMS (tool when they have money and none) ──
  const toolPrice = worldState.economy?.prices?.tool ?? 12;
  if (s.status.wealth >= toolPrice && countItem(s, 'tool') === 0 && s.needs.purpose > 0.3) {
    goals.push({
      type: 'buy_tool',
      priority: 0.42,
      action: 'buy_item',
      details: { type: 'tool' },
      description: `${agent.name} wants to buy a tool`,
    });
  }

  // ── SELL ITEMS (inventory → money) ──
  const foodCount = countItem(s, 'food');
  const toolCount = countItem(s, 'tool');
  if ((foodCount >= 3 || toolCount >= 1) && s.status.wealth < 50) {
    const sellType = toolCount >= 1 ? 'tool' : 'food';
    const qty = sellType === 'tool' ? 1 : Math.min(2, foodCount - 1);
    if (qty >= 1) {
      goals.push({
        type: 'sell_item',
        priority: 0.45 + (50 - s.status.wealth) / 100,
        action: 'sell_item',
        details: { type: sellType, quantity: qty },
        description: `${agent.name} wants to sell ${qty} ${sellType}`,
      });
    }
  }

  // ── FAMILY (if has partner) ──
  if (s.partner && s.children.length === 0 && s.status.wealth > 40 && Math.random() < 0.01) {
    const partnerAgent = allAgents.find(a => a.name === s.partner);
    if (partnerAgent) {
      goals.push({
        type: 'have_child',
        priority: 0.5 + t.empathy * 0.3,
        action: 'have_child',
        target: partnerAgent,
        description: `${agent.name} and ${s.partner} want to start a family`,
      });
    }
  }

  // Sort by priority (highest first)
  goals.sort((a, b) => b.priority - a.priority);
  return goals;
}

// ─── Get the single most urgent action ────────────────────────────
export function getTopGoal(agent, allAgents, worldState) {
  const goals = generateGoals(agent, allAgents, worldState);
  return goals.length > 0 ? goals[0] : null;
}

// ─── Get a summary of an agent's motivations (for LLM context) ───
export function getMotivationSummary(agent, allAgents, worldState) {
  const goals = generateGoals(agent, allAgents, worldState);
  if (goals.length === 0) return 'No pressing concerns.';
  return goals.slice(0, 3).map((g, i) =>
    `${i + 1}. ${g.description} (urgency: ${(g.priority * 100).toFixed(0)}%)`
  ).join('\n');
}

// ═══════════════════════════════════════════════════════════════════
//  GENERATIVE GOAL SYSTEM — LLM decides what agents want
//
//  The LLM sees the agent's full context and decides what they
//  should do next. It can invent ANY goal — propose marriage,
//  start a revolution, paint a masterpiece, confront a rival.
// ═══════════════════════════════════════════════════════════════════

export async function generateGoalLLM(agent, allAgents, worldState, llm) {
  if (!agent.sim || !llm?.hasAnyKey()) return null;

  const s = agent.sim;
  const needsStr = Object.entries(s.needs).map(([k, v]) => `${k}: ${v.toFixed(2)} (${v > 0.7 ? 'URGENT' : v > 0.4 ? 'moderate' : 'ok'})`).join(', ');
  const statusStr = Object.entries(s.status).map(([k, v]) => `${k}: ${v.toFixed(0)}`).join(', ');
  const traitsStr = Object.entries(s.traits).map(([k, v]) => `${k}: ${v.toFixed(2)}`).join(', ');
  const skillsStr = Object.entries(s.skills).filter(([, v]) => v > 1).map(([k, v]) => `${k}: ${v.toFixed(1)}`).join(', ');

  // Relationships summary
  const relStr = [];
  if (agent.simRelationships) {
    for (const [name, rel] of agent.simRelationships) {
      if (rel.familiarity > 0.2 || rel.trust > 0.3) {
        relStr.push(`${name} (${rel.label}, trust:${rel.trust.toFixed(2)}, attraction:${rel.attraction.toFixed(2)})`);
      }
    }
  }

  // Recent memories
  const recentMemories = agent.cognition?.memory?.getRecent?.(5)?.map(m => m.description) || [];

  // Inventory
  const invStr = (s.inventory || []).map(i => `${i.name} x${i.quantity}`).join(', ') || 'empty';

  // Nearby agents
  const nearbyStr = allAgents
    .filter(a => a.name !== agent.name && agent.distanceTo?.(a) < 12)
    .map(a => `${a.name} (${a.occupation})`)
    .join(', ') || 'nobody nearby';

  // World context
  const ws = worldState;
  const worldStr = `Food: ${ws.resources.food.toFixed(0)}, Gold: ${ws.resources.gold.toFixed(0)}, Leader: ${ws.governance.leader || 'none'}, Unrest: ${ws.governance.unrest.toFixed(0)}, Prosperity: ${ws.economy.prosperity.toFixed(0)}, Day: ${ws.day}`;

  try {
    const result = await llm.generate(
      `You decide what a villager wants to do RIGHT NOW in a living simulation. You output their top 1-2 goals as structured JSON.

GOAL TYPES (how the goal translates to physical behavior):
- "seek_person": Walk to a specific person and interact (talk, propose, confront, trade, etc.)
- "stay_here": Do something in place (eat, sleep, work, craft, think, pray, etc.)
- "go_to_building": Walk to a specific building and do something there
- "call_event": Organize a community event (any type — wedding, funeral, meeting, festival, protest, etc.)
- "wander": Walk around exploring or doing something while moving

RULES:
- Goals should emerge from the agent's personality, needs, relationships, memories, and world state
- Be creative — agents are people. They have complex motivations beyond survival
- High-urgency needs (>0.7) should usually be addressed first, but personality matters
- An ambitious agent might ignore hunger to pursue power. A romantic might skip work to flirt.
- Consider their relationships: they might want to help a friend, confront a rival, or propose to a lover
- Consider their memories: recent events should influence what they want
- Any goal is valid. "Warn village about food shortage", "Apologize to someone I wronged", "Organize a wedding", "Paint a mural", "Challenge someone to a duel"

OUTPUT (JSON):
{"goals":[{"description":"what they want to do and why","priority":0.0-1.0,"type":"seek_person|stay_here|go_to_building|call_event|wander","target":"AgentName or BuildingName if relevant","event_details":{"type":"event type if call_event","topic":"description"}}]}`,

      `AGENT: ${agent.name} (${agent.occupation}, ${s.lifeStage})
PERSONALITY: ${agent.personality || 'unknown'}
TRAITS: ${traitsStr}
NEEDS: ${needsStr}
STATUS: ${statusStr}
SKILLS: ${skillsStr || 'none notable'}
PARTNER: ${s.partner || 'none'}
CHILDREN: ${s.children.length}
INVENTORY: ${invStr}
RELATIONSHIPS: ${relStr.join('; ') || 'no close relationships yet'}
RECENT MEMORIES: ${recentMemories.join(' | ') || 'none'}
NEARBY: ${nearbyStr}
WORLD: ${worldStr}
KNOWLEDGE: ${[...s.knowledge].slice(-5).join('; ') || 'nothing notable'}

What does ${agent.name} want to do right now?`,
      { json: true, temperature: 0.85, maxTokens: 400 }
    );

    if (!result.goals || !Array.isArray(result.goals) || result.goals.length === 0) return null;

    // Map LLM goals to the internal format
    return result.goals.map(g => ({
      type: g.type || 'stay_here',
      priority: Math.max(0, Math.min(1, g.priority || 0.5)),
      action: g.type || 'stay_here',
      target: g.target ? allAgents.find(a =>
        a.name === g.target || a.name.toLowerCase().includes((g.target || '').toLowerCase())
      ) : null,
      targetBuilding: g.type === 'go_to_building' ? g.target : null,
      description: g.description || 'Do something',
      eventDetails: g.event_details || null,
      _isGenerative: true,
    }));
  } catch (err) {
    console.warn(`LLM goal generation failed for ${agent.name}:`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  GENERATIVE CONSEQUENCE ENGINE — LLM decides what happens
//
//  When an agent acts on a goal, the LLM determines the state
//  changes. "Ravi ate a meal" → hunger -0.5, happiness +2.
//  "Meera proposed to Vinay" → partner set, romance -1, happiness +25.
// ═══════════════════════════════════════════════════════════════════

export async function applyConsequenceLLM(goalDescription, agent, target, worldState, allAgents, llm) {
  if (!agent.sim || !llm?.hasAnyKey()) return null;

  const s = agent.sim;
  const agentStr = `${agent.name} (${agent.occupation}): needs=[${Object.entries(s.needs).map(([k,v])=>`${k}:${v.toFixed(2)}`).join(',')}], status=[${Object.entries(s.status).map(([k,v])=>`${k}:${v.toFixed(0)}`).join(',')}], partner=${s.partner||'none'}`;
  const targetStr = target?.sim
    ? `${target.name} (${target.occupation}): needs=[${Object.entries(target.sim.needs).map(([k,v])=>`${k}:${v.toFixed(2)}`).join(',')}], partner=${target.sim.partner||'none'}`
    : (target ? target.name : 'none');

  try {
    const result = await llm.generate(
      `You are the consequence engine for a village simulation. An agent just performed an action. Determine what REALISTICALLY changes in the simulation state. Output structured JSON.

AVAILABLE STATE FIELDS:
- Agent needs (0=satisfied, 1=desperate): hunger, rest, social, safety, fun, purpose, romance
- Agent status (0-100): health, wealth, reputation, happiness, energy
- Agent skills (0-10): farming, crafting, cooking, trading, leadership, medicine, combat, art, science, persuasion
- Agent fields: partner (name string or null)
- Relationships: trust, attraction, respect, familiarity, fear, rivalry (0-1), label (string)
- World: resources.food, resources.gold, governance.leader, governance.unrest, economy.prosperity

OUTPUT (JSON):
{
  "agent_effects": {"needs":{"hunger":-0.3},"status":{"happiness":5}},
  "target_effects": {"needs":{},"status":{}},
  "relationships": [{"agent":"A","target":"B","changes":{"trust":0.05,"label":"friend"}}],
  "world": {},
  "agent_set": {"partner":"SomeName"},
  "target_set": {"partner":"SomeName"},
  "knowledge_all": "fact everyone learns (or null)",
  "summary": "Brief description of what happened and changed"
}

RULES:
- Be realistic and proportional. A single action shouldn't transform everything.
- Consider the agent's personality and the context.
- "agent_set" / "target_set" are for assigning string fields like partner, NOT for numeric deltas.
- Only include fields that actually change. Omit unchanged ones.`,

      `ACTION: "${goalDescription}"
AGENT: ${agentStr}
TARGET: ${targetStr}
WORLD: Food=${worldState.resources.food.toFixed(0)}, Unrest=${worldState.governance.unrest.toFixed(0)}, Prosperity=${worldState.economy.prosperity.toFixed(0)}, Leader=${worldState.governance.leader||'none'}

What are the realistic consequences of this action?`,
      { json: true, temperature: 0.6, maxTokens: 500 }
    );

    return result;
  } catch (err) {
    console.warn(`LLM consequence generation failed:`, err.message);
    return null;
  }
}

// Apply the LLM-generated consequences to agents and world
export function applyGenerativeConsequences(effects, agent, target, worldState, allAgents) {
  if (!effects) return { changes: [], worldChanges: [], transactions: [] };
  const changes = [];
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const clamp100 = (v) => Math.max(0, Math.min(100, v));
  const clampDelta = (v, min, max) => Math.max(min, Math.min(max, v));

  // Apply agent effects
  if (effects.agent_effects && agent.sim) {
    const ae = effects.agent_effects;
    if (ae.needs) for (const [k, d] of Object.entries(ae.needs)) {
      if (typeof d === 'number' && k in agent.sim.needs) {
        agent.sim.needs[k] = clamp01(agent.sim.needs[k] + clampDelta(d, -0.5, 0.5));
        changes.push(`${agent.name}: ${k} ${d > 0 ? '+' : ''}${d.toFixed(2)}`);
      }
    }
    if (ae.status) for (const [k, d] of Object.entries(ae.status)) {
      if (typeof d === 'number' && k in agent.sim.status) {
        agent.sim.status[k] = clamp100(agent.sim.status[k] + clampDelta(d, -25, 25));
        changes.push(`${agent.name}: ${k} ${d > 0 ? '+' : ''}${d.toFixed(0)}`);
      }
    }
    if (ae.skills) for (const [k, d] of Object.entries(ae.skills)) {
      if (typeof d === 'number' && k in agent.sim.skills) {
        agent.sim.skills[k] = Math.max(0, Math.min(10, agent.sim.skills[k] + clampDelta(d, -1, 1)));
      }
    }
  }

  // Apply agent set fields
  if (effects.agent_set && agent.sim) {
    for (const [k, v] of Object.entries(effects.agent_set)) {
      if (k === 'partner') { agent.sim.partner = v; changes.push(`${agent.name}: partner → ${v}`); }
      else if (k in agent.sim) { agent.sim[k] = v; changes.push(`${agent.name}: ${k} → ${v}`); }
    }
  }

  // Apply target effects
  if (effects.target_effects && target?.sim) {
    const te = effects.target_effects;
    if (te.needs) for (const [k, d] of Object.entries(te.needs)) {
      if (typeof d === 'number' && k in target.sim.needs) {
        target.sim.needs[k] = clamp01(target.sim.needs[k] + clampDelta(d, -0.5, 0.5));
        changes.push(`${target.name}: ${k} ${d > 0 ? '+' : ''}${d.toFixed(2)}`);
      }
    }
    if (te.status) for (const [k, d] of Object.entries(te.status)) {
      if (typeof d === 'number' && k in target.sim.status) {
        target.sim.status[k] = clamp100(target.sim.status[k] + clampDelta(d, -25, 25));
        changes.push(`${target.name}: ${k} ${d > 0 ? '+' : ''}${d.toFixed(0)}`);
      }
    }
  }

  // Apply target set fields
  if (effects.target_set && target?.sim) {
    for (const [k, v] of Object.entries(effects.target_set)) {
      if (k === 'partner') { target.sim.partner = v; changes.push(`${target.name}: partner → ${v}`); }
      else if (k in target.sim) { target.sim[k] = v; changes.push(`${target.name}: ${k} → ${v}`); }
    }
  }

  // Apply relationship changes
  if (effects.relationships && Array.isArray(effects.relationships)) {
    for (const rc of effects.relationships) {
      const a = allAgents.find(n => n.name === rc.agent || n.name.toLowerCase().includes((rc.agent||'').toLowerCase()));
      const b = allAgents.find(n => n.name === rc.target || n.name.toLowerCase().includes((rc.target||'').toLowerCase()));
      if (!a || !b) continue;
      const rel = getOrCreateRelationship(a, b.name);
      const tRel = getOrCreateRelationship(b, a.name);
      const ch = rc.changes || {};
      for (const dim of ['trust','attraction','respect','familiarity','fear','rivalry']) {
        if (typeof ch[dim] === 'number') {
          rel[dim] = clamp01(rel[dim] + clampDelta(ch[dim], -0.4, 0.4));
          tRel[dim] = clamp01(tRel[dim] + clampDelta(ch[dim], -0.4, 0.4));
          changes.push(`${rc.agent} ↔ ${rc.target}: ${dim} ${ch[dim] > 0 ? '+' : ''}${ch[dim].toFixed(2)}`);
        }
      }
      if (ch.label) { rel.label = ch.label; tRel.label = ch.label; changes.push(`${rc.agent} ↔ ${rc.target}: label → ${ch.label}`); }
    }
  }

  // Apply world changes
  if (effects.world && typeof effects.world === 'object') {
    for (const [path, delta] of Object.entries(effects.world)) {
      if (typeof delta !== 'number' && typeof delta !== 'string') continue;
      const parts = path.split('.');
      let obj = worldState;
      for (let i = 0; i < parts.length - 1; i++) obj = obj?.[parts[i]];
      const key = parts[parts.length - 1];
      if (obj && key in obj) {
        if (typeof delta === 'number') {
          obj[key] = clamp100(obj[key] + clampDelta(delta, -15, 15));
        } else {
          obj[key] = delta;
        }
        changes.push(`World ${path} → ${typeof obj[key] === 'number' ? obj[key].toFixed(1) : obj[key]}`);
      }
    }
  }

  // Knowledge
  if (effects.knowledge_all && typeof effects.knowledge_all === 'string') {
    for (const a of allAgents) {
      if (a.sim) a.sim.knowledge.add(effects.knowledge_all);
    }
    changes.push(`Everyone learned: "${effects.knowledge_all}"`);
  }

  return { changes, worldChanges: [], transactions: [], summary: effects.summary || '' };
}
