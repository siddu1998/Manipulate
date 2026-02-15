// ═══════════════════════════════════════════════════════════════════
//  Hierarchical Environment Tree (Paper Section 5.1)
//
//  The sandbox environment is represented as a tree:
//    World → Areas → Buildings → Rooms → Objects
//
//  Each object has a mutable state (e.g. "stove: off" → "stove: cooking").
//  Agents build individual subgraphs as they explore.
//  This tree is converted to natural language for LLM prompts.
// ═══════════════════════════════════════════════════════════════════

export class EnvironmentNode {
  constructor(name, type, parent = null) {
    this.name = name;
    this.type = type;       // 'world' | 'area' | 'building' | 'room' | 'object'
    this.parent = parent;
    this.children = [];
    this.state = null;      // only for objects: "idle", "in use", etc.
  }

  addChild(name, type, state = null) {
    const child = new EnvironmentNode(name, type, this);
    if (state) child.state = state;
    this.children.push(child);
    return child;
  }

  // Get full containment path: "World: Area: Building: Room: Object"
  getPath() {
    const parts = [];
    let node = this;
    while (node) {
      parts.unshift(node.name);
      node = node.parent;
    }
    return parts.join(': ');
  }

  // Convert subtree to natural language for LLM prompts
  toNaturalLanguage(depth = 0) {
    const indent = '  '.repeat(depth);
    let text = '';

    if (this.type === 'object') {
      text += `${indent}- ${this.name}` + (this.state ? ` (${this.state})` : '') + '\n';
    } else if (this.type === 'room') {
      text += `${indent}${this.name} contains: `;
      if (this.children.length > 0) {
        text += this.children.map(c => c.name + (c.state ? ` (${c.state})` : '')).join(', ');
      } else {
        text += 'nothing notable';
      }
      text += '\n';
    } else if (this.type === 'building') {
      text += `${indent}${this.name} has: ${this.children.map(c => c.name).join(', ')}\n`;
      for (const child of this.children) {
        text += child.toNaturalLanguage(depth + 1);
      }
    } else {
      // world or area
      text += `${indent}${this.name}:\n`;
      for (const child of this.children) {
        text += child.toNaturalLanguage(depth + 1);
      }
    }
    return text;
  }

  // Find a node by name (recursive search)
  find(name) {
    if (this.name.toLowerCase() === name.toLowerCase()) return this;
    for (const child of this.children) {
      const found = child.find(name);
      if (found) return found;
    }
    return null;
  }

  // Find all objects in this subtree
  getAllObjects() {
    const objects = [];
    if (this.type === 'object') objects.push(this);
    for (const child of this.children) {
      objects.push(...child.getAllObjects());
    }
    return objects;
  }

  // Find all rooms in this subtree
  getAllRooms() {
    const rooms = [];
    if (this.type === 'room') rooms.push(this);
    for (const child of this.children) {
      rooms.push(...child.getAllRooms());
    }
    return rooms;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Environment Tree — Built from world data
// ═══════════════════════════════════════════════════════════════════

export class EnvironmentTree {
  constructor(worldName) {
    this.root = new EnvironmentNode(worldName, 'world');
  }

  // Build the full tree from world data (buildings, areas)
  buildFromWorld(buildings, areas = []) {
    // Add areas
    for (const area of areas) {
      this.root.addChild(area.name || area.type, 'area');
    }

    // Add buildings with rooms and objects
    // ★ Check worldDef building types for rooms first, then fall back to hardcoded templates
    for (const building of buildings) {
      const bNode = this.root.addChild(building.name, 'building');
      const wdRooms = building._worldDefRooms;  // set by world.js from worldDef.buildingTypes
      const rooms = wdRooms || BUILDING_ROOM_TEMPLATES[building.type] || BUILDING_ROOM_TEMPLATES.house;

      for (const roomName of rooms) {
        const rNode = bNode.addChild(roomName, 'room');
        const objects = ROOM_OBJECT_TEMPLATES[roomName] || [];
        for (const obj of objects) {
          rNode.addChild(obj.name, 'object', obj.state);
        }
      }

      // Store reference back to building data
      bNode._buildingData = building;
    }

    // Add "outdoors" as a catch-all area
    const outdoors = this.root.addChild('outdoors', 'area');
    outdoors.addChild('village square', 'room');
    outdoors.addChild('roads and paths', 'room');
  }

  // Get building node by name
  getBuilding(name) {
    for (const child of this.root.children) {
      if (child.type === 'building' && child.name.toLowerCase().includes(name.toLowerCase())) {
        return child;
      }
      // Also check building children (in case building is nested under area)
      const found = child.find(name);
      if (found && found.type === 'building') return found;
    }
    return null;
  }

  // Get all objects with their states (for prompts)
  getObjectStates() {
    return this.root.getAllObjects().map(o => ({
      name: o.name,
      state: o.state,
      location: o.getPath(),
    }));
  }

  // Update an object's state
  setObjectState(objectName, newState, buildingName = null) {
    let searchRoot = this.root;
    if (buildingName) {
      const bNode = this.getBuilding(buildingName);
      if (bNode) searchRoot = bNode;
    }
    const obj = searchRoot.find(objectName);
    if (obj && obj.type === 'object') {
      const oldState = obj.state;
      obj.state = newState;
      return { object: obj.name, oldState, newState, location: obj.getPath() };
    }
    return null;
  }

  // Convert to natural language description of the full world
  toNaturalLanguage() {
    return this.root.toNaturalLanguage();
  }

  // Get a building's internal layout as natural language
  getBuildingLayout(buildingName) {
    const bNode = this.getBuilding(buildingName);
    if (!bNode) return `${buildingName} (no detailed layout known)`;
    return bNode.toNaturalLanguage();
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Agent's Environment Knowledge (Paper Section 5.1)
//
//  Each agent maintains their own subgraph of the world tree.
//  They only know about places they've visited.
//  Their knowledge may be out of date when they leave an area.
// ═══════════════════════════════════════════════════════════════════

export class AgentEnvironmentKnowledge {
  constructor(agentName) {
    this.agentName = agentName;
    this.knownBuildings = new Set();    // building names the agent has visited
    this.knownObjectStates = new Map(); // "building:object" → last known state
    this.currentBuilding = null;        // which building agent is currently in
    this.currentRoom = null;            // which room within the building
  }

  // Agent enters a building — they now know its layout
  enterBuilding(buildingName, envTree) {
    this.knownBuildings.add(buildingName);
    this.currentBuilding = buildingName;

    // Update known object states from the actual world state
    const bNode = envTree.getBuilding(buildingName);
    if (bNode) {
      for (const obj of bNode.getAllObjects()) {
        this.knownObjectStates.set(`${buildingName}:${obj.name}`, obj.state);
      }
    }
  }

  leaveBuilding() {
    this.currentBuilding = null;
    this.currentRoom = null;
  }

  enterRoom(roomName) {
    this.currentRoom = roomName;
  }

  // Get what the agent knows about the world (for prompts)
  getKnownEnvironment(envTree) {
    let text = '';
    text += `${this.agentName} knows of the following areas: `;
    text += [...this.knownBuildings].join(', ');
    if (this.knownBuildings.size === 0) text += 'none specifically';
    text += '\n';

    if (this.currentBuilding) {
      const bNode = envTree.getBuilding(this.currentBuilding);
      if (bNode) {
        text += `\n${this.agentName} is currently in ${this.currentBuilding}`;
        if (this.currentRoom) text += `: ${this.currentRoom}`;
        text += `\n${bNode.toNaturalLanguage()}`;
      }
    }
    return text;
  }

  // Get last known state of an object
  getKnownObjectState(buildingName, objectName) {
    return this.knownObjectStates.get(`${buildingName}:${objectName}`) || 'unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Building Room Templates
//  Each building type has a set of rooms with default objects
// ═══════════════════════════════════════════════════════════════════

const BUILDING_ROOM_TEMPLATES = {
  house:      ['bedroom', 'kitchen', 'living room', 'bathroom'],
  tavern:     ['main hall', 'kitchen', 'cellar'],
  shop:       ['storefront', 'back room', 'storage'],
  blacksmith: ['forge', 'workshop', 'storage shed'],
  church:     ['sanctuary', 'office'],
  school:     ['classroom', 'library corner'],
  library:    ['reading room', 'study hall', 'archives'],
  cafe:       ['dining area', 'counter', 'kitchen'],
  hospital:   ['reception', 'ward', 'medicine room'],
  farm:       ['barn', 'field', 'farmhouse kitchen'],
  market:     ['stalls', 'storage', 'counter'],
  townhall:   ['meeting hall', 'office', 'records room'],
  bakery:     ['shop front', 'oven room', 'storage'],
  inn:        ['common room', 'kitchen', 'guest rooms'],
  temple:     ['prayer hall', 'meditation room'],
  castle:     ['throne room', 'armory', 'tower'],
  stable:     ['stalls', 'tack room', 'hay loft'],
  fountain:   [],
  // ─── Landmark / parametric building rooms ──────────────────
  pyramid:    ['burial chamber', 'treasure room', 'passage'],
  dome:       ['main hall', 'inner sanctum', 'garden courtyard'],
  obelisk:    [],
  minaret:    ['prayer platform', 'stairwell'],
  step_pyramid: ['ceremonial chamber', 'altar room'],
  pagoda:     ['prayer hall', 'meditation level', 'bell tower'],
  colosseum:  ['arena floor', 'stands', 'gladiator quarters'],
  tent:       ['main area', 'sleeping quarters'],
  hut:        ['living area'],
  tower:      ['lookout', 'guard room', 'armory'],
  monument:   [],
  palace:     ['throne room', 'audience hall', 'royal garden', 'private quarters'],
  ziggurat:   ['temple summit', 'offering chamber'],
  sphinx:     [],
  barracks:   ['training ground', 'bunks', 'armory'],
};

// ═══════════════════════════════════════════════════════════════════
//  Room Object Templates
//  Each room type has default objects with initial states
// ═══════════════════════════════════════════════════════════════════

const ROOM_OBJECT_TEMPLATES = {
  bedroom:        [{ name: 'bed', state: 'made' }, { name: 'closet', state: 'closed' }, { name: 'desk', state: 'clear' }],
  kitchen:        [{ name: 'stove', state: 'off' }, { name: 'counter', state: 'clean' }, { name: 'pantry', state: 'stocked' }],
  'living room':  [{ name: 'couch', state: 'empty' }, { name: 'bookshelf', state: 'full of books' }, { name: 'table', state: 'clear' }],
  bathroom:       [{ name: 'shower', state: 'off' }, { name: 'sink', state: 'off' }],
  'main hall':    [{ name: 'bar counter', state: 'clean' }, { name: 'tables', state: 'available' }, { name: 'fireplace', state: 'crackling' }],
  cellar:         [{ name: 'wine barrels', state: 'full' }, { name: 'shelves', state: 'stocked' }],
  storefront:     [{ name: 'display shelves', state: 'stocked' }, { name: 'cash register', state: 'closed' }],
  'back room':    [{ name: 'work table', state: 'clear' }, { name: 'supplies', state: 'organized' }],
  storage:        [{ name: 'crates', state: 'sealed' }, { name: 'shelves', state: 'full' }],
  'storage shed': [{ name: 'tools', state: 'organized' }, { name: 'raw materials', state: 'piled up' }],
  forge:          [{ name: 'anvil', state: 'cold' }, { name: 'furnace', state: 'banked' }, { name: 'bellows', state: 'idle' }],
  workshop:       [{ name: 'workbench', state: 'clear' }, { name: 'tools', state: 'hanging on wall' }],
  sanctuary:      [{ name: 'altar', state: 'adorned' }, { name: 'pews', state: 'empty' }, { name: 'candles', state: 'lit' }],
  office:         [{ name: 'desk', state: 'covered in papers' }, { name: 'chair', state: 'empty' }],
  classroom:      [{ name: 'desks', state: 'arranged in rows' }, { name: 'chalkboard', state: 'has today\'s lesson' }],
  'library corner': [{ name: 'bookshelves', state: 'full' }, { name: 'reading chair', state: 'empty' }],
  'reading room': [{ name: 'large table', state: 'clear' }, { name: 'bookshelves', state: 'organized' }, { name: 'lamp', state: 'on' }],
  'study hall':   [{ name: 'study desks', state: 'occupied with books' }, { name: 'globe', state: 'on pedestal' }],
  archives:       [{ name: 'filing cabinets', state: 'locked' }, { name: 'old scrolls', state: 'preserved' }],
  'dining area':  [{ name: 'tables', state: 'set' }, { name: 'chairs', state: 'arranged' }],
  counter:        [{ name: 'counter', state: 'clean' }, { name: 'register', state: 'closed' }],
  reception:      [{ name: 'front desk', state: 'staffed' }, { name: 'waiting chairs', state: 'empty' }],
  ward:           [{ name: 'beds', state: 'clean' }, { name: 'medicine cabinet', state: 'locked' }],
  'medicine room': [{ name: 'herbs', state: 'drying' }, { name: 'mortar and pestle', state: 'clean' }],
  barn:           [{ name: 'hay bales', state: 'stacked' }, { name: 'animal pens', state: 'occupied' }],
  field:          [{ name: 'crops', state: 'growing' }, { name: 'tools', state: 'leaning against fence' }],
  'farmhouse kitchen': [{ name: 'hearth', state: 'warm' }, { name: 'table', state: 'set for meal' }],
  stalls:         [{ name: 'vendor displays', state: 'arranged' }, { name: 'goods', state: 'for sale' }],
  'meeting hall':  [{ name: 'long table', state: 'clear' }, { name: 'chairs', state: 'arranged in circle' }, { name: 'podium', state: 'empty' }],
  'records room':  [{ name: 'record books', state: 'on shelves' }, { name: 'writing desk', state: 'ink and quill ready' }],
  'shop front':    [{ name: 'display case', state: 'full of baked goods' }, { name: 'counter', state: 'clean' }],
  'oven room':     [{ name: 'bread oven', state: 'warm' }, { name: 'mixing bowls', state: 'clean' }, { name: 'flour sacks', state: 'open' }],
  'common room':   [{ name: 'fireplace', state: 'crackling' }, { name: 'tables', state: 'available' }, { name: 'board games', state: 'on shelf' }],
  'guest rooms':   [{ name: 'beds', state: 'made' }, { name: 'washbasin', state: 'full' }],
  'prayer hall':   [{ name: 'altar', state: 'adorned' }, { name: 'incense burner', state: 'smoking gently' }],
  'meditation room': [{ name: 'cushions', state: 'arranged' }, { name: 'candles', state: 'flickering' }],
  'throne room':   [{ name: 'throne', state: 'empty' }, { name: 'banners', state: 'hanging' }],
  armory:          [{ name: 'weapon rack', state: 'full' }, { name: 'armor stand', state: 'polished' }],
  tower:           [{ name: 'window', state: 'overlooking village' }, { name: 'telescope', state: 'aimed at horizon' }],
  'tack room':     [{ name: 'saddles', state: 'hung on wall' }, { name: 'bridles', state: 'on hooks' }],
  'hay loft':      [{ name: 'hay', state: 'piled high' }],
  'village square': [{ name: 'well', state: 'accessible' }, { name: 'notice board', state: 'has postings' }],
  'roads and paths': [],
};
