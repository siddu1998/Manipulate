// ─── Entity System: Player & NPCs ─────────────────────────────────
import { TILE_SIZE, HAIR_COLORS, SHIRT_COLORS, PANTS_COLORS } from './config.js';
import { getCharacterSprites } from './sprites.js';

// ─── Base Entity ──────────────────────────────────────────────────
class Entity {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.px = x * TILE_SIZE;
    this.py = y * TILE_SIZE;
    this.direction = 'down';
    this.moving = false;
    this.animFrame = 0;
    this.animTimer = 0;
    this.speed = 3;
    this.colors = { hair: '#2c1810', skin: '#f5c49c', shirt: '#3498db', pants: '#2c3e50' };
    this.sprites = null;
  }

  initSprites(isPlayer = false) {
    this.sprites = getCharacterSprites(this.colors, isPlayer);
  }

  getSprite() {
    if (!this.sprites) return null;
    return this.sprites[this.direction][this.animFrame];
  }

  updateAnimation(dt) {
    if (this.moving) {
      this.animTimer += dt;
      if (this.animTimer > 200) {
        this.animFrame = (this.animFrame + 1) % 2;
        this.animTimer = 0;
      }
    } else {
      this.animFrame = 0;
      this.animTimer = 0;
    }
  }

  get centerX() { return this.px + TILE_SIZE / 2; }
  get centerY() { return this.py + TILE_SIZE / 2; }

  distanceTo(other) {
    return Math.abs(this.x - other.x) + Math.abs(this.y - other.y);
  }
}

// ─── Player ───────────────────────────────────────────────────────
export class Player extends Entity {
  constructor(x, y) {
    super(x, y);
    this.speed = 4;
    this.colors = { hair: '#1a1a2e', skin: '#f5c49c', shirt: '#2ecc71', pants: '#2c3e50' };
    this.initSprites(true);
    this.targetX = x;
    this.targetY = y;
    this.isMoving = false;
  }

  update(dt, input, world) {
    const { dx, dy } = input.getMovement();

    if (!this.isMoving) {
      if (dx !== 0 || dy !== 0) {
        if (dy < 0) this.direction = 'up';
        else if (dy > 0) this.direction = 'down';
        else if (dx < 0) this.direction = 'left';
        else if (dx > 0) this.direction = 'right';

        const nx = this.x + dx;
        const ny = this.y + dy;
        if (world.isWalkable(nx, ny)) {
          this.targetX = nx;
          this.targetY = ny;
          this.isMoving = true;
          this.moving = true;
        }
      } else {
        this.moving = false;
      }
    }

    if (this.isMoving) {
      const tx = this.targetX * TILE_SIZE;
      const ty = this.targetY * TILE_SIZE;
      const ddx = tx - this.px;
      const ddy = ty - this.py;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist < this.speed) {
        this.px = tx; this.py = ty;
        this.x = this.targetX; this.y = this.targetY;
        this.isMoving = false;
      } else {
        this.px += (ddx / dist) * this.speed;
        this.py += (ddy / dist) * this.speed;
      }
    }

    this.updateAnimation(dt);
  }
}

// ─── NPC ──────────────────────────────────────────────────────────
export class NPC extends Entity {
  constructor(x, y, data) {
    super(x, y);
    this.id = data.id || Math.random().toString(36).substr(2, 9);
    this.name = data.name || 'Villager';
    this.age = data.age || 25;
    this.occupation = data.occupation || 'Villager';
    this.personality = data.personality || 'Friendly and curious';
    this.home = data.home || '';
    this.relationships = data.relationships || {};
    this.homeBuilding = data.homeBuilding || null;
    this.speed = 1.5;

    // Appearance
    const rng = this._seededRng(this.name);
    this.colors = {
      hair: data.appearance?.hairColor || HAIR_COLORS[(rng() * HAIR_COLORS.length) | 0],
      skin: '#f5c49c',
      shirt: data.appearance?.shirtColor || SHIRT_COLORS[(rng() * SHIRT_COLORS.length) | 0],
      pants: PANTS_COLORS[(rng() * PANTS_COLORS.length) | 0],
    };
    this.initSprites(false);

    // ── AI State ──
    this.state = 'idle'; // idle, walking, talking, following, fleeing, leading, working
    this.currentActivity = 'Standing around';
    this.path = [];
    this.pathIndex = 0;
    this.waitTimer = 2000 + Math.random() * 3000;
    this.behaviorTimer = 0;
    this.isMoving = false;
    this.targetX = x;
    this.targetY = y;

    // Following state
    this.followTarget = null; // reference to player entity
    this.followDistance = 2;   // stay 2 tiles away

    // ── Legacy memory (for backwards compat) ──
    this.memories = [];
    this.chatHistory = [];
    this.conversationCount = 0;

    // ── Cognitive Architecture (set externally by app.js) ──
    this.cognition = null;

    // ── Speech bubble ──
    this.speechBubble = null;
    this.speechTimer = 0;

    // ── Perceived events ──
    this.perceivedEvents = [];
  }

  // ─── Memory ─────────────────────────────────────────────────────
  addMemory(text, importance = 3) {
    this.memories.push({
      text,
      time: new Date().toLocaleTimeString(),
      importance,
      timestamp: Date.now(),
    });
    if (this.memories.length > this.maxMemories) {
      this.memories.sort((a, b) => b.importance - a.importance);
      this.memories = this.memories.slice(0, this.maxMemories);
    }
  }

  getRecentMemories(count = 10) {
    return this.memories
      .slice(-count)
      .map(m => `[${m.time}] ${m.text}`)
      .join('\n');
  }

  // ─── Perceive world events ──────────────────────────────────────
  perceiveEvent(event) {
    this.perceivedEvents.push(event);
    if (event.type === 'fire') {
      this.addMemory(`I noticed a fire at ${event.location || 'nearby'}! This is dangerous!`, 8);
    } else if (event.type === 'announcement') {
      this.addMemory(`I heard an announcement: "${event.message}"`, 5);
    } else {
      this.addMemory(`Something happened nearby: ${event.description || event.type}`, 4);
    }
  }

  getPerceivedEventsText() {
    if (this.perceivedEvents.length === 0) return '';
    const recent = this.perceivedEvents.slice(-5);
    const text = recent.map(e => {
      if (e.type === 'fire') return `There is a FIRE at ${e.location || 'a nearby building'}!`;
      if (e.type === 'announcement') return `Announcement: "${e.message}"`;
      return `Event: ${e.description || e.type}`;
    }).join('\n');
    return `\n\nURGENT EVENTS HAPPENING RIGHT NOW:\n${text}`;
  }

  // ─── Speech ─────────────────────────────────────────────────────
  say(text, duration = 4000) {
    this.speechBubble = text;
    this.speechTimer = duration;
  }

  // ─── State management ───────────────────────────────────────────
  startFollowing(target) {
    this.state = 'following';
    this.followTarget = target;
    this.currentActivity = `Following the traveler`;
    this.addMemory('I agreed to follow the traveler.', 6);
  }

  stopFollowing() {
    if (this.state === 'following') {
      this.state = 'idle';
      this.followTarget = null;
      this.waitTimer = 2000;
      this.currentActivity = 'Standing around after following someone';
      this.addMemory('I stopped following the traveler.', 4);
    }
  }

  goToBuilding(building, world) {
    if (!building) return false;
    const doorX = building.x + (building.w >> 1);
    const doorY = building.y + building.h + 1;
    const path = world.findPath(this.x, this.y, doorX, doorY);
    if (path && path.length > 0) {
      this.path = path;
      this.pathIndex = 0;
      this.state = 'walking';
      this.currentActivity = `Walking to ${building.name}`;
      this.addMemory(`Heading to ${building.name}`, 3);
      return true;
    }
    return false;
  }

  fleeFrom(x, y, world) {
    // Find a tile away from the danger
    const dx = this.x - x;
    const dy = this.y - y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const fleeX = Math.round(this.x + (dx / dist) * 10);
    const fleeY = Math.round(this.y + (dy / dist) * 10);
    const target = world.randomWalkable(fleeX, fleeY, 5);
    const path = world.findPath(this.x, this.y, target.x, target.y);
    if (path && path.length > 0) {
      this.path = path;
      this.pathIndex = 0;
      this.state = 'fleeing';
      this.currentActivity = 'Fleeing from danger!';
    }
  }

  // ─── Update ─────────────────────────────────────────────────────
  update(dt, world, player) {
    // Speech bubble timer
    if (this.speechTimer > 0) {
      this.speechTimer -= dt;
      if (this.speechTimer <= 0) this.speechBubble = null;
    }

    // ── State-specific logic ──
    if (this.state === 'following' && this.followTarget) {
      this._updateFollowing(dt, world);
    } else if (this.state === 'idle') {
      this.waitTimer -= dt;
      if (this.waitTimer <= 0) {
        this._pickNewTarget(world);
      }
    } else if ((this.state === 'walking' || this.state === 'fleeing' || this.state === 'leading') && this.path.length > 0) {
      this._followPath(dt);
    }

    // ── Move toward current tile target ──
    if (this.isMoving) {
      const tx = this.targetX * TILE_SIZE;
      const ty = this.targetY * TILE_SIZE;
      const ddx = tx - this.px;
      const ddy = ty - this.py;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist < this.speed) {
        this.px = tx; this.py = ty;
        this.x = this.targetX; this.y = this.targetY;
        this.isMoving = false;
      } else {
        this.px += (ddx / dist) * this.speed;
        this.py += (ddy / dist) * this.speed;
      }
    }

    this.updateAnimation(dt);
    this.behaviorTimer += dt;
  }

  _updateFollowing(dt, world) {
    if (!this.followTarget) { this.stopFollowing(); return; }

    const dist = this.distanceTo(this.followTarget);
    if (dist > this.followDistance && !this.isMoving) {
      // Path toward the player
      const path = world.findPath(this.x, this.y, this.followTarget.x, this.followTarget.y, 50);
      if (path && path.length > 1) {
        // Move to the next step (not all the way to player, keep some distance)
        const step = path[Math.min(path.length - this.followDistance, 1)];
        if (step) {
          this.targetX = step.x;
          this.targetY = step.y;
          this.isMoving = true;
          this.moving = true;
          const dx = step.x - this.x;
          const dy = step.y - this.y;
          if (Math.abs(dx) > Math.abs(dy)) this.direction = dx > 0 ? 'right' : 'left';
          else this.direction = dy > 0 ? 'down' : 'up';
        }
      }
    } else if (dist <= this.followDistance) {
      this.moving = false;
      // Face toward the player
      const dx = this.followTarget.x - this.x;
      const dy = this.followTarget.y - this.y;
      if (Math.abs(dx) > Math.abs(dy)) this.direction = dx > 0 ? 'right' : 'left';
      else if (dy !== 0) this.direction = dy > 0 ? 'down' : 'up';
    }
  }

  _followPath(dt) {
    if (!this.isMoving) {
      if (this.pathIndex < this.path.length) {
        const next = this.path[this.pathIndex];
        this.targetX = next.x;
        this.targetY = next.y;
        this.isMoving = true;
        this.moving = true;
        const dx = next.x - this.x;
        const dy = next.y - this.y;
        if (Math.abs(dx) > Math.abs(dy)) this.direction = dx > 0 ? 'right' : 'left';
        else this.direction = dy > 0 ? 'down' : 'up';
        this.pathIndex++;
      } else {
        this.state = 'idle';
        this.moving = false;
        this.waitTimer = 3000 + Math.random() * 5000;
        this.path = [];
        this.pathIndex = 0;
      }
    }
  }

  _pickNewTarget(world) {
    const target = world.randomWalkable(this.x, this.y, 8);
    const path = world.findPath(this.x, this.y, target.x, target.y);
    if (path && path.length > 0) {
      this.path = path;
      this.pathIndex = 0;
      this.state = 'walking';
    } else {
      this.waitTimer = 1000 + Math.random() * 2000;
    }
  }

  // ─── AI Prompts ─────────────────────────────────────────────────

  // System prompt for CONVERSATIONS with the player
  getSystemPrompt(worldName, gameTime) {
    // Use cognitive architecture prompt if available
    if (this.cognition) {
      return this.cognition.getPlayerConversationPrompt(worldName, gameTime);
    }

    return `You are ${this.name}, a ${this.age}-year-old ${this.occupation} living in ${worldName}.

Personality: ${this.personality}

Your recent memories:
${this.getRecentMemories()}
${this.getPerceivedEventsText()}
${Object.keys(this.relationships).length > 0
  ? '\nYour relationships:\n' + Object.entries(this.relationships).map(([k,v]) => `- ${k}: ${v}`).join('\n')
  : ''}

IMPORTANT RULES:
- Stay in character. Respond naturally and briefly (1-3 sentences).
- Show your personality through your speech.
- Reference your memories when relevant.
- You may express emotions, opinions, and ask questions back.
- If the traveler asks you to DO something (follow them, go somewhere, help with something), and you agree, add EXACTLY ONE of these action tags at the very end of your message on a new line:
  [FOLLOW] — if you agree to follow/accompany the traveler
  [GO:building name] — if you agree to go to a specific place (e.g., [GO:The Bakery])
  [STAY] — if you decline or prefer to stay
- Only add an action tag when the traveler makes a request. For normal conversation, don't add any tag.
- The action tag should NOT be part of your spoken dialogue.`;
  }

  // Prompt for autonomous BEHAVIOR decisions
  getBehaviorPrompt(worldName, buildings, nearbyNpcs) {
    const buildingList = buildings.map(b => b.name).join(', ');
    const nearbyList = nearbyNpcs.map(n => `${n.name} (${n.occupation})`).join(', ');

    return `You are ${this.name}, a ${this.occupation} in ${worldName}.
Personality: ${this.personality}
Current activity: ${this.currentActivity}
Current state: ${this.state}
Nearby buildings: ${buildingList}
Nearby people: ${nearbyList || 'nobody'}
${this.getPerceivedEventsText()}

Recent memories:
${this.getRecentMemories(5)}

What would you like to do next? Consider your personality, the time of day, and any events happening.
Respond ONLY with JSON:
{
  "action": "walk_to" | "idle" | "talk_to" | "flee" | "investigate",
  "target": "building name or person name",
  "thought": "brief internal thought about why",
  "speech": "what you say out loud (or empty string if silent)"
}`;
  }

  // Prompt for REACTING to a world event
  getEventReactionPrompt(event, worldName, buildings) {
    return `You are ${this.name}, a ${this.occupation} in ${worldName}.
Personality: ${this.personality}

URGENT: ${event.description || event.type} is happening!
${event.type === 'fire' ? `There is a fire at ${event.location}! Buildings could be destroyed and people could be hurt.` : ''}

Available buildings: ${buildings.map(b => b.name).join(', ')}

How do you react? Respond ONLY with JSON:
{
  "reaction": "flee" | "help" | "investigate" | "panic" | "ignore",
  "target": "where you want to go (building name, 'water source', or 'away')",
  "speech": "what you shout or say",
  "thought": "brief internal thought"
}`;
  }

  _seededRng(str) {
    let seed = 0;
    for (let i = 0; i < str.length; i++) {
      seed = ((seed << 5) - seed + str.charCodeAt(i)) | 0;
    }
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
}
