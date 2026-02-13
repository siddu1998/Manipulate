// ─── World Generation & Management ────────────────────────────────
import { TILE_SIZE, WORLD_COLS, WORLD_ROWS, TILE, SOLID_TILES, BUILDING_TYPES } from './config.js';
import { EnvironmentTree } from './environment.js';

// ─── Dynamic Theme System ─────────────────────────────────────────
// Instead of hardcoded themes, the LLM outputs visual properties
// and we map them to tiles dynamically. Any world works.

const GROUND_MAP = {
  grass: TILE.GRASS, concrete: TILE.FLOOR_STONE, stone: TILE.FLOOR_STONE,
  sand: TILE.SAND, wood: TILE.FLOOR_WOOD, metal: TILE.FLOOR_STONE,
  dirt: TILE.GRASS_DARK, water: TILE.WATER, snow: TILE.SAND,
  carpet: TILE.FLOOR_WOOD, tile: TILE.FLOOR_STONE, marble: TILE.FLOOR_STONE,
};

const PATH_MAP = {
  paved: TILE.PATH_CROSS, dirt: TILE.PATH_CROSS, stone: TILE.FLOOR_STONE,
  wood: TILE.FLOOR_WOOD, metal: TILE.FLOOR_STONE, gravel: TILE.PATH_CROSS,
  cobblestone: TILE.PATH_CROSS, carpet: TILE.FLOOR_WOOD,
};

const VEGETATION_PRESETS = {
  none:     { tiles: [TILE.LAMP, TILE.BENCH, TILE.SIGN, TILE.ROCK], weights: [0.012, 0.01, 0.006, 0.004] },
  sparse:   { tiles: [TILE.TREE, TILE.BENCH, TILE.LAMP, TILE.SIGN, TILE.BUSH], weights: [0.012, 0.008, 0.01, 0.005, 0.006] },
  moderate: { tiles: [TILE.TREE, TILE.BUSH, TILE.GRASS_FLOWER, TILE.BENCH, TILE.LAMP, TILE.GRASS_DARK], weights: [0.018, 0.01, 0.018, 0.006, 0.006, 0.012] },
  lush:     { tiles: [TILE.TREE, TILE.TREE_PINE, TILE.GRASS_FLOWER, TILE.BUSH, TILE.GRASS_DARK, TILE.ROCK, TILE.BENCH], weights: [0.025, 0.012, 0.025, 0.01, 0.02, 0.006, 0.004] },
};

const BUILDING_PALETTES = {
  rustic:     [['#b5651d','#8B4513'],['#8B6914','#654321'],['#6B3A2A','#4a2818'],['#8B7355','#6b5335']],
  modern:     [['#607D8B','#37474F'],['#455A64','#263238'],['#546E7A','#374F5A'],['#78909C','#455A64'],['#4DB6AC','#2E7D67'],['#5C6BC0','#3949AB']],
  futuristic: [['#1A237E','#0D1B6F'],['#0D47A1','#08306B'],['#006064','#004050'],['#311B92','#200A6F'],['#00695C','#004D40']],
  medieval:   [['#8B7355','#6b5335'],['#ddd','#999'],['#c9302c','#8b0000'],['#BDB76B','#8b864e'],['#b5651d','#8B4513']],
  industrial: [['#555','#333'],['#6b6b6b','#444'],['#808080','#4a4a4a'],['#607D8B','#37474F']],
  colorful:   [['#e74c3c','#c0392b'],['#3498db','#2980b9'],['#2ecc71','#27ae60'],['#f39c12','#e67e22'],['#9b59b6','#8e44ad']],
  natural:    [['#8B7355','#6b5335'],['#d4a574','#a0785a'],['#f4a460','#cd853f'],['#9a7b4f','#6b5335']],
};

function buildThemeConfig(desc) {
  const v = desc.visual || {};
  const ground = GROUND_MAP[v.ground] || GROUND_MAP.grass;
  const path = PATH_MAP[v.paths] || TILE.PATH_CROSS;
  const veg = VEGETATION_PRESETS[v.vegetation] || VEGETATION_PRESETS.moderate;
  const palette = BUILDING_PALETTES[v.buildingStyle] || BUILDING_PALETTES.rustic;
  const accent = veg.tiles[veg.tiles.length > 2 ? 2 : 0] || TILE.BENCH;

  return {
    baseTile: ground,
    pathTile: path,
    decoTiles: veg.tiles,
    decoWeights: veg.weights,
    accentTile: accent,
    buildingPalette: palette,
    primaryColor: v.palette?.primary || null,
    secondaryColor: v.palette?.secondary || null,
  };
}

export class World {
  constructor() {
    this.cols = WORLD_COLS;
    this.rows = WORLD_ROWS;
    this.tiles = [];
    this.collision = [];
    this.buildings = [];
    this.name = '';
    this.description = '';
    this.theme = 'village';
    this.npcSpawnPoints = [];
    this.playerSpawn = { x: 32, y: 24 };
    this.environmentTree = null;  // Hierarchical environment tree (paper Section 5.1)
  }

  // ─── Build world from LLM description ──────────────────────────
  buildFromDescription(desc) {
    this.name = desc.name || 'Unknown World';
    this.description = desc.description || '';

    // ★ Build theme config dynamically from LLM visual properties
    const themeConfig = buildThemeConfig(desc);
    this.themeConfig = themeConfig;

    // Initialize with theme-appropriate base tile
    this.tiles = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => themeConfig.baseTile)
    );
    this.collision = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => false)
    );

    // Step 1: Add terrain zones
    this._addTerrainZones(desc.areas || [], themeConfig);

    // Step 2: Build road network
    this._buildRoads(themeConfig);

    // Step 3: Place buildings
    this._placeBuildings(desc.buildings || []);

    // Step 4: Add theme-appropriate decorations
    this._addDecorations(themeConfig);

    // Step 5: Set player spawn at a path tile near center
    this._setPlayerSpawn();

    // Step 6: Set NPC spawn points near their assigned buildings
    this._setNpcSpawns(desc.characters || []);

    // Update collision map
    this._updateCollision();

    // Step 7: Build hierarchical environment tree (paper Section 5.1)
    this.environmentTree = new EnvironmentTree(this.name);
    this.environmentTree.buildFromWorld(this.buildings, desc.areas || []);
  }

  _addTerrainZones(areas, themeConfig) {
    const rng = this._rng(42);
    for (const area of areas) {
      const type = (area.type || '').toLowerCase();
      let tileType;
      if (type.includes('forest') || type.includes('wood')) tileType = 'forest';
      else if (type.includes('water') || type.includes('lake') || type.includes('river') || type.includes('pond') || type.includes('pool')) tileType = 'water';
      else if (type.includes('park') || type.includes('garden') || type.includes('courtyard') || type.includes('green') || type.includes('lounge')) tileType = 'park';
      else if (type.includes('desert') || type.includes('beach') || type.includes('sand')) tileType = 'sand';
      else if (type.includes('parking') || type.includes('lot') || type.includes('concrete') || type.includes('plaza')) tileType = 'paved';
      else if (type.includes('lobby') || type.includes('hall') || type.includes('atrium') || type.includes('floor')) tileType = 'indoor';
      else continue;

      // Place zone in a random quadrant-ish area
      const zw = 8 + (rng() * 10) | 0;
      const zh = 6 + (rng() * 8) | 0;
      const zx = (rng() * (this.cols - zw - 4)) | 0 + 2;
      const zy = (rng() * (this.rows - zh - 4)) | 0 + 2;

      for (let y = zy; y < zy + zh && y < this.rows; y++) {
        for (let x = zx; x < zx + zw && x < this.cols; x++) {
          if (tileType === 'forest') {
            this.tiles[y][x] = rng() > 0.35 ? TILE.TREE : (rng() > 0.5 ? TILE.TREE_PINE : TILE.GRASS_DARK);
          } else if (tileType === 'water') {
            this.tiles[y][x] = TILE.WATER;
          } else if (tileType === 'park') {
            this.tiles[y][x] = rng() > 0.2 ? (rng() > 0.5 ? TILE.GRASS_FLOWER : TILE.GRASS) : TILE.BUSH;
          } else if (tileType === 'sand') {
            this.tiles[y][x] = TILE.SAND;
          } else if (tileType === 'paved') {
            this.tiles[y][x] = rng() > 0.1 ? TILE.FLOOR_STONE : TILE.BENCH;
          } else if (tileType === 'indoor') {
            this.tiles[y][x] = rng() > 0.05 ? TILE.FLOOR_WOOD : TILE.LAMP;
          }
        }
      }
    }
  }

  _buildRoads(themeConfig) {
    const cx = this.cols >> 1;
    const cy = this.rows >> 1;

    // Main horizontal road
    for (let x = 4; x < this.cols - 4; x++) {
      this._setPath(x, cy);
      this._setPath(x, cy + 1);
    }
    // Main vertical road
    for (let y = 4; y < this.rows - 4; y++) {
      this._setPath(cx, y);
      this._setPath(cx + 1, y);
    }
    // Cross streets
    const offsets = [-12, -6, 6, 12];
    for (const off of offsets) {
      const sx = cx + off;
      const sy = cy + off;
      if (sx > 4 && sx < this.cols - 4) {
        for (let y = Math.max(4, cy - 16); y < Math.min(this.rows - 4, cy + 16); y++) {
          this._setPath(sx, y);
        }
      }
      if (sy > 4 && sy < this.rows - 4) {
        for (let x = Math.max(4, cx - 16); x < Math.min(this.cols - 4, cx + 16); x++) {
          this._setPath(x, sy);
        }
      }
    }
    // Update path tile types
    this._refinePaths();
  }

  _setPath(x, y) {
    if (x >= 0 && x < this.cols && y >= 0 && y < this.rows) {
      if (this.tiles[y][x] === TILE.WATER) return;
      this.tiles[y][x] = TILE.PATH_CROSS;
    }
  }

  _refinePaths() {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (this.tiles[y][x] !== TILE.PATH_CROSS) continue;
        const u = y > 0 && this._isPath(x, y - 1);
        const d = y < this.rows - 1 && this._isPath(x, y + 1);
        const l = x > 0 && this._isPath(x - 1, y);
        const r = x < this.cols - 1 && this._isPath(x + 1, y);
        if ((u || d) && !(l || r)) this.tiles[y][x] = TILE.PATH_V;
        else if ((l || r) && !(u || d)) this.tiles[y][x] = TILE.PATH_H;
      }
    }
  }

  _isPath(x, y) {
    const t = this.tiles[y]?.[x];
    return t === TILE.PATH_H || t === TILE.PATH_V || t === TILE.PATH_CROSS;
  }

  _placeBuildings(buildings) {
    const rng = this._rng(123);
    const cx = this.cols >> 1;
    const cy = this.rows >> 1;
    const placed = [];

    for (let i = 0; i < buildings.length; i++) {
      const bDef = buildings[i];
      const bType = this._matchBuildingType(bDef.type || 'house');
      const bw = bType.w;
      const bh = bType.h;

      // Try to place near roads, spiraling out from center
      let bestX = -1, bestY = -1;
      for (let attempt = 0; attempt < 200; attempt++) {
        const angle = rng() * Math.PI * 2;
        const dist = 4 + rng() * 20;
        const tx = (cx + Math.cos(angle) * dist - bw / 2) | 0;
        const ty = (cy + Math.sin(angle) * dist - bh / 2) | 0;

        if (this._canPlaceBuilding(tx, ty, bw, bh, placed)) {
          bestX = tx;
          bestY = ty;
          break;
        }
      }

      if (bestX >= 0) {
        // Use the dynamic theme palette for building colors
        let color = bType.color;
        let roofColor = bType.roofColor;
        const palette = this.themeConfig?.buildingPalette;
        if (palette && palette.length > 0) {
          const [pc, pr] = palette[i % palette.length];
          color = pc;
          roofColor = pr;
        }
        const building = {
          name: bDef.name || `Building ${i}`,
          type: bDef.type || 'house',
          x: bestX,
          y: bestY,
          w: bw,
          h: bh,
          color,
          roofColor,
        };
        this.buildings.push(building);
        placed.push(building);
        this._stampBuilding(building);
      }
    }
  }

  _matchBuildingType(type) {
    const t = type.toLowerCase();
    for (const [key, val] of Object.entries(BUILDING_TYPES)) {
      if (t.includes(key)) return val;
    }
    // Default mapping
    if (t.includes('bar') || t.includes('pub') || t.includes('tavern')) return BUILDING_TYPES.tavern;
    if (t.includes('store') || t.includes('shop')) return BUILDING_TYPES.shop;
    if (t.includes('home') || t.includes('house') || t.includes('cottage')) return BUILDING_TYPES.house;
    return BUILDING_TYPES.house;
  }

  _canPlaceBuilding(x, y, w, h, placed) {
    if (x < 2 || y < 2 || x + w >= this.cols - 2 || y + h >= this.rows - 2) return false;

    // Check for overlaps with existing buildings (with padding)
    for (const p of placed) {
      if (x < p.x + p.w + 2 && x + w + 2 > p.x && y < p.y + p.h + 2 && y + h + 2 > p.y) return false;
    }

    // Check that the area doesn't overlap water
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (this.tiles[y + dy]?.[x + dx] === TILE.WATER) return false;
      }
    }

    // Should be near a road
    let nearRoad = false;
    for (let dx = -1; dx <= w; dx++) {
      if (this._isPath(x + dx, y + h) || this._isPath(x + dx, y - 1)) nearRoad = true;
    }
    for (let dy = -1; dy <= h; dy++) {
      if (this._isPath(x - 1, y + dy) || this._isPath(x + w, y + dy)) nearRoad = true;
    }
    return nearRoad;
  }

  _stampBuilding(b) {
    for (let dy = 0; dy < b.h; dy++) {
      for (let dx = 0; dx < b.w; dx++) {
        const tx = b.x + dx, ty = b.y + dy;
        if (dy === 0) {
          this.tiles[ty][tx] = TILE.ROOF;
        } else if (dy === 1) {
          this.tiles[ty][tx] = TILE.ROOF_FRONT;
        } else if (dy === b.h - 1) {
          // Front wall
          if (dx === (b.w >> 1)) {
            this.tiles[ty][tx] = TILE.DOOR;
          } else {
            this.tiles[ty][tx] = TILE.WALL_FRONT;
          }
        } else {
          this.tiles[ty][tx] = TILE.WALL;
        }
      }
    }

    // Add floor in front of door (path)
    const doorX = b.x + (b.w >> 1);
    const doorY = b.y + b.h;
    if (doorY < this.rows) {
      this.tiles[doorY][doorX] = TILE.PATH_CROSS;
    }
  }

  _addDecorations(themeConfig) {
    const rng = this._rng(456);
    const baseTile = themeConfig.baseTile;
    const decoTiles = themeConfig.decoTiles;
    const decoWeights = themeConfig.decoWeights;

    for (let y = 2; y < this.rows - 2; y++) {
      for (let x = 2; x < this.cols - 2; x++) {
        if (this.tiles[y][x] !== baseTile) continue;
        const r = rng();
        let cumulative = 0;
        for (let i = 0; i < decoTiles.length; i++) {
          cumulative += decoWeights[i] || 0.005;
          if (r < cumulative) {
            this.tiles[y][x] = decoTiles[i];
            break;
          }
        }
      }
    }

    // Add benches/decor near buildings
    for (const b of this.buildings) {
      const bx = b.x + b.w + 1;
      const by = b.y + b.h - 1;
      if (bx < this.cols && by < this.rows && this.tiles[by][bx] === baseTile) {
        if (rng() < 0.4) this.tiles[by][bx] = themeConfig.accentTile;
      }
    }

    // Add a centerpiece (well for village, fountain for modern, etc.)
    const cx = this.cols >> 1;
    const cy = this.rows >> 1;
    const centerpiece = themeConfig.accentTile || TILE.WELL;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (this.tiles[cy + dy]?.[cx + dx] === baseTile) {
          this.tiles[cy + dy][cx + dx] = centerpiece;
          return;
        }
      }
    }
  }

  _setPlayerSpawn() {
    const cx = this.cols >> 1;
    const cy = this.rows >> 1;
    // Find nearest path tile to center
    for (let r = 0; r < 20; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx, y = cy + dy;
          if (this._isPath(x, y)) {
            this.playerSpawn = { x, y };
            return;
          }
        }
      }
    }
    this.playerSpawn = { x: cx, y: cy };
  }

  _setNpcSpawns(characters) {
    const rng = this._rng(789);
    this.npcSpawnPoints = [];

    for (let i = 0; i < characters.length; i++) {
      const char = characters[i];
      let spawnX, spawnY;

      // Try to spawn near their associated building
      const building = this.buildings.find(b =>
        b.name.toLowerCase().includes((char.home || '').toLowerCase()) ||
        b.type.toLowerCase().includes((char.occupation || '').toLowerCase())
      ) || this.buildings[i % this.buildings.length];

      if (building) {
        const doorX = building.x + (building.w >> 1);
        const doorY = building.y + building.h + 1;
        spawnX = doorX;
        spawnY = doorY;
      } else {
        spawnX = (this.cols >> 1) + ((rng() * 10 - 5) | 0);
        spawnY = (this.rows >> 1) + ((rng() * 10 - 5) | 0);
      }

      // Ensure walkable
      if (!this.isWalkable(spawnX, spawnY)) {
        for (let r = 1; r < 10; r++) {
          let found = false;
          for (let dy = -r; dy <= r && !found; dy++) {
            for (let dx = -r; dx <= r && !found; dx++) {
              if (this.isWalkable(spawnX + dx, spawnY + dy)) {
                spawnX += dx;
                spawnY += dy;
                found = true;
              }
            }
          }
          if (found) break;
        }
      }

      this.npcSpawnPoints.push({ x: spawnX, y: spawnY, building });
    }
  }

  _updateCollision() {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        this.collision[y][x] = SOLID_TILES.has(this.tiles[y][x]);
      }
    }
  }

  isWalkable(x, y) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return false;
    return !this.collision[y][x];
  }

  getTile(x, y) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return TILE.WATER;
    return this.tiles[y][x];
  }

  setTile(x, y, type) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    this.tiles[y][x] = type;
    this.collision[y][x] = SOLID_TILES.has(type);
  }

  // Find a random walkable tile
  randomWalkable(nearX, nearY, radius = 10) {
    const rng = this._rng(Date.now());
    for (let i = 0; i < 50; i++) {
      const x = nearX + ((rng() * radius * 2 - radius) | 0);
      const y = nearY + ((rng() * radius * 2 - radius) | 0);
      if (this.isWalkable(x, y)) return { x, y };
    }
    return { x: nearX, y: nearY };
  }

  // Simple BFS pathfinding
  findPath(sx, sy, ex, ey, maxSteps = 200) {
    if (!this.isWalkable(ex, ey)) return null;

    const key = (x, y) => `${x},${y}`;
    const queue = [{ x: sx, y: sy, path: [] }];
    const visited = new Set([key(sx, sy)]);

    while (queue.length > 0 && queue.length < maxSteps) {
      const cur = queue.shift();
      if (cur.x === ex && cur.y === ey) return cur.path;

      for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
        const nx = cur.x + dx, ny = cur.y + dy;
        const k = key(nx, ny);
        if (!visited.has(k) && this.isWalkable(nx, ny)) {
          visited.add(k);
          queue.push({ x: nx, y: ny, path: [...cur.path, { x: nx, y: ny }] });
        }
      }
    }
    return null;
  }

  // Get the building at a tile position
  getBuildingAt(x, y) {
    return this.buildings.find(b =>
      x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
    );
  }

  _rng(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
}
