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
  // ─── Culture-aware palettes ──────────────────────────────────────
  egyptian:   [['#c4a574','#8B7355'],['#d4c5a0','#b0a080'],['#e8d5b0','#c4a574'],['#daa520','#b8860b'],['#f5f0e0','#d4c5a0']],
  indian:     [['#e8d5b0','#c9a227'],['#c0392b','#962d22'],['#f5f5dc','#d4c5a0'],['#ff6347','#cc4f39'],['#daa520','#b8860b']],
  japanese:   [['#8b0000','#4a0000'],['#2c2c2c','#1a1a1a'],['#f5f5dc','#d4c5a0'],['#bc8f8f','#8b6969'],['#556b2f','#3b4a20']],
  chinese:    [['#c0392b','#8b0000'],['#daa520','#b8860b'],['#2c2c2c','#1a1a1a'],['#e8d5b0','#c9a227'],['#8b0000','#5a0000']],
  greek:      [['#f5f5f5','#ccc'],['#e0d8c8','#b8b0a0'],['#87ceeb','#5a9bbe'],['#d4c5a0','#b0a080'],['#ddd','#aaa']],
  roman:      [['#d4c5a0','#b0a080'],['#f5f5f5','#ccc'],['#c0392b','#962d22'],['#8B7355','#6b5335'],['#BDB76B','#8b864e']],
  arabian:    [['#e8d5b0','#c9a227'],['#f0e6d0','#d4c5a0'],['#1a6b5a','#0d4a3a'],['#daa520','#b8860b'],['#2e86c1','#1a5276']],
  african:    [['#b5884a','#8B6914'],['#c0392b','#962d22'],['#d4a574','#a0785a'],['#8B7355','#6b5335'],['#daa520','#b8860b']],
  mesoamerican:[['#808040','#606030'],['#c4a574','#8B7355'],['#2ecc71','#1a9a52'],['#b0a080','#8a7a5a'],['#556b2f','#3b4a20']],
  nordic:     [['#8B7355','#6b5335'],['#2c3e50','#1a2836'],['#607D8B','#37474F'],['#b5651d','#8B4513'],['#ddd','#999']],
  scifi:      [['#1A237E','#0D1B6F'],['#006064','#004050'],['#311B92','#200A6F'],['#00BCD4','#0097A7'],['#4DB6AC','#2E7D67']],
  fantasy:    [['#9b59b6','#8e44ad'],['#3498db','#2980b9'],['#2ecc71','#27ae60'],['#e8d5b0','#b8860b'],['#daa520','#b8860b']],
};

function buildThemeConfig(desc) {
  const v = desc.visual || {};
  const culture = (desc.culture || '').toLowerCase();
  const ground = GROUND_MAP[v.ground] || GROUND_MAP.grass;
  const path = PATH_MAP[v.paths] || TILE.PATH_CROSS;
  const veg = VEGETATION_PRESETS[v.vegetation] || VEGETATION_PRESETS.moderate;

  // Culture-aware palette: prefer culture palette, then buildingStyle, then rustic
  let palette = BUILDING_PALETTES[v.buildingStyle] || BUILDING_PALETTES.rustic;
  if (culture) {
    for (const [key, pal] of Object.entries(BUILDING_PALETTES)) {
      if (culture.includes(key) || key.includes(culture)) { palette = pal; break; }
    }
  }
  // Also check if architect set a specific palette name
  if (v.culturePalette && BUILDING_PALETTES[v.culturePalette]) {
    palette = BUILDING_PALETTES[v.culturePalette];
  }

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
    culture,
    roadLayout: v.roadLayout || 'cross',
  };
}

export class World {
  constructor() {
    this.cols = WORLD_COLS;
    this.rows = WORLD_ROWS;
    this.tiles = [];
    this.collision = [];
    this.buildings = [];
    this.specialShapes = [];   // Parametric shapes (planets, orbs, arenas, etc.)
    this.name = '';
    this.description = '';
    this.theme = 'village';
    this.culture = '';
    this.npcSpawnPoints = [];
    this.playerSpawn = { x: 32, y: 24 };
    this.environmentTree = null;  // Hierarchical environment tree (paper Section 5.1)
  }

  // ─── Build world from LLM description ──────────────────────────
  buildFromDescription(desc) {
    this.name = desc.name || 'Unknown World';
    this.description = desc.description || '';
    this.culture = (desc.culture || '').toLowerCase();

    // ★ Build theme config dynamically from LLM visual properties + culture
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

    // Step 2: Build road network (culture-aware layout)
    this._buildRoads(themeConfig);

    // Step 3: Place buildings (with parametric shape support)
    this._placeBuildings(desc.buildings || []);

    // Step 4: Add theme-appropriate decorations
    this._addDecorations(themeConfig);

    // Step 5: Normalize and store parametric special shapes (planets, orbs, etc.)
    this.specialShapes = this._normalizeSpecialShapes(desc.specialShapes || []);

    // Step 6: Set player spawn at a path tile near center
    this._setPlayerSpawn();

    // Step 7: Set NPC spawn points near their assigned buildings
    this._setNpcSpawns(desc.characters || []);

    // Update collision map (includes parametric building collision)
    this._updateCollision();

    // Step 8: Build hierarchical environment tree (paper Section 5.1)
    this.environmentTree = new EnvironmentTree(this.name);
    this.environmentTree.buildFromWorld(this.buildings, desc.areas || []);
  }

  _addTerrainZones(areas, themeConfig) {
    const rng = this._rng(42);
    for (const area of areas) {
      const type = (area.type || '').toLowerCase();
      let tileType;
      if (type.includes('forest') || type.includes('wood') || type.includes('jungle')) tileType = 'forest';
      else if (type.includes('water') || type.includes('lake') || type.includes('river') || type.includes('pond') || type.includes('pool') || type.includes('nile') || type.includes('oasis')) tileType = 'water';
      else if (type.includes('park') || type.includes('garden') || type.includes('courtyard') || type.includes('green') || type.includes('lounge')) tileType = 'park';
      else if (type.includes('desert') || type.includes('beach') || type.includes('sand') || type.includes('dune') || type.includes('wasteland')) tileType = 'sand';
      else if (type.includes('parking') || type.includes('lot') || type.includes('concrete') || type.includes('plaza') || type.includes('square')) tileType = 'paved';
      else if (type.includes('lobby') || type.includes('hall') || type.includes('atrium') || type.includes('floor')) tileType = 'indoor';
      else if (type.includes('ruins') || type.includes('ruin') || type.includes('ancient') || type.includes('excavation')) tileType = 'ruins';
      else if (type.includes('rocky') || type.includes('mountain') || type.includes('cliff') || type.includes('canyon') || type.includes('quarry')) tileType = 'rocky';
      else if (type.includes('farm') || type.includes('field') || type.includes('crop') || type.includes('plantation')) tileType = 'farm';
      else if (type.includes('swamp') || type.includes('marsh') || type.includes('bog')) tileType = 'swamp';
      else continue;

      // Place zone — use area position hints if provided, otherwise random
      const zw = area.w || (8 + (rng() * 10) | 0);
      const zh = area.h || (6 + (rng() * 8) | 0);
      const zx = area.x != null ? area.x : ((rng() * (this.cols - zw - 4)) | 0) + 2;
      const zy = area.y != null ? area.y : ((rng() * (this.rows - zh - 4)) | 0) + 2;

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
          } else if (tileType === 'ruins') {
            // Broken stone, scattered rocks, sand patches
            const r = rng();
            if (r < 0.3) this.tiles[y][x] = TILE.FLOOR_STONE;
            else if (r < 0.5) this.tiles[y][x] = TILE.ROCK;
            else if (r < 0.7) this.tiles[y][x] = TILE.SAND;
            else this.tiles[y][x] = TILE.FLOOR_STONE;
          } else if (tileType === 'rocky') {
            const r = rng();
            if (r < 0.4) this.tiles[y][x] = TILE.ROCK;
            else if (r < 0.7) this.tiles[y][x] = TILE.SAND;
            else this.tiles[y][x] = TILE.FLOOR_STONE;
          } else if (tileType === 'farm') {
            const r = rng();
            if (r < 0.5) this.tiles[y][x] = TILE.GRASS_DARK;
            else if (r < 0.8) this.tiles[y][x] = TILE.GRASS;
            else this.tiles[y][x] = TILE.GRASS_FLOWER;
          } else if (tileType === 'swamp') {
            const r = rng();
            if (r < 0.3) this.tiles[y][x] = TILE.WATER;
            else if (r < 0.5) this.tiles[y][x] = TILE.GRASS_DARK;
            else this.tiles[y][x] = TILE.BUSH;
          }
        }
      }
    }
  }

  _buildRoads(themeConfig) {
    const cx = this.cols >> 1;
    const cy = this.rows >> 1;
    const layout = themeConfig.roadLayout || 'cross';

    if (layout === 'radial' || layout === 'circular') {
      // Circular plaza with radial roads — great for Egyptian, Indian, ancient layouts
      const plazaR = 4;
      for (let dy = -plazaR; dy <= plazaR; dy++) {
        for (let dx = -plazaR; dx <= plazaR; dx++) {
          if (dx * dx + dy * dy <= plazaR * plazaR) {
            this._setPath(cx + dx, cy + dy);
          }
        }
      }
      // Radial spokes
      const spokes = 6;
      for (let i = 0; i < spokes; i++) {
        const angle = (i / spokes) * Math.PI * 2;
        for (let d = plazaR; d < 22; d++) {
          const px = Math.round(cx + Math.cos(angle) * d);
          const py = Math.round(cy + Math.sin(angle) * d);
          if (px > 2 && px < this.cols - 2 && py > 2 && py < this.rows - 2) {
            this._setPath(px, py);
          }
        }
      }
      // Outer ring
      const ringR = 16;
      for (let a = 0; a < 360; a += 2) {
        const rad = (a / 180) * Math.PI;
        const px = Math.round(cx + Math.cos(rad) * ringR);
        const py = Math.round(cy + Math.sin(rad) * ringR);
        if (px > 2 && px < this.cols - 2 && py > 2 && py < this.rows - 2) {
          this._setPath(px, py);
        }
      }
    } else if (layout === 'organic') {
      // Meandering paths — good for villages, jungles
      const rng = this._rng(999);
      let px = cx, py = 4;
      while (py < this.rows - 4) {
        this._setPath(px, py);
        this._setPath(px + 1, py);
        py++;
        if (rng() < 0.3) px += rng() > 0.5 ? 1 : -1;
        px = Math.max(4, Math.min(this.cols - 4, px));
      }
      let px2 = 4, py2 = cy;
      while (px2 < this.cols - 4) {
        this._setPath(px2, py2);
        this._setPath(px2, py2 + 1);
        px2++;
        if (rng() < 0.3) py2 += rng() > 0.5 ? 1 : -1;
        py2 = Math.max(4, Math.min(this.rows - 4, py2));
      }
    } else {
      // Default: cross layout (original)
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

    // Sort: landmarks first (placed closer to center), then regular buildings
    const sorted = [...buildings].map((b, i) => ({ ...b, _idx: i }));
    sorted.sort((a, b) => (b.landmark ? 1 : 0) - (a.landmark ? 1 : 0));

    for (let si = 0; si < sorted.length; si++) {
      const bDef = sorted[si];
      const bType = this._matchBuildingType(bDef.type || 'house');

      // Shape can come from bDef.shape, bDef.shapeSpec, or bType.shape
      const shape = bDef.shape || bType.shape || null;

      const bw = bDef.w || bType.w;
      const bh = bDef.h || bType.h;

      // Landmarks get placed closer to center
      const minDist = bDef.landmark ? 2 : 4;
      const maxDist = bDef.landmark ? 14 : 22;

      // Try to place near roads, spiraling out from center
      let bestX = -1, bestY = -1;
      for (let attempt = 0; attempt < 300; attempt++) {
        const angle = rng() * Math.PI * 2;
        const dist = minDist + rng() * maxDist;
        const tx = (cx + Math.cos(angle) * dist - bw / 2) | 0;
        const ty = (cy + Math.sin(angle) * dist - bh / 2) | 0;

        if (this._canPlaceBuilding(tx, ty, bw, bh, placed)) {
          bestX = tx;
          bestY = ty;
          break;
        }
      }

      if (bestX >= 0) {
        // Per-building colors: prefer bDef.color, then palette, then bType default
        let color = bDef.color || bType.color;
        let roofColor = bDef.roofColor || bType.roofColor;
        const palette = this.themeConfig?.buildingPalette;
        if (!bDef.color && palette && palette.length > 0) {
          const [pc, pr] = palette[si % palette.length];
          color = pc;
          roofColor = pr;
        }

        const building = {
          name: bDef.name || `Building ${si}`,
          type: bDef.type || 'house',
          shape: shape,
          landmark: bDef.landmark || false,
          x: bestX,
          y: bestY,
          w: bw,
          h: bh,
          color,
          roofColor,
        };
        this.buildings.push(building);
        placed.push(building);

        // Only stamp tile grid for default-shape buildings
        if (!shape || shape === 'default') {
          this._stampBuilding(building);
        } else {
          // For parametric shapes, fill the footprint with walkable floor
          this._stampParametricFootprint(building);
        }
      }
    }
  }

  _matchBuildingType(type) {
    const t = type.toLowerCase();
    // Check landmark/special types first (pyramid, dome, etc.)
    for (const [key, val] of Object.entries(BUILDING_TYPES)) {
      if (t === key) return val;
    }
    for (const [key, val] of Object.entries(BUILDING_TYPES)) {
      if (t.includes(key)) return val;
    }
    // Default mapping
    if (t.includes('bar') || t.includes('pub') || t.includes('tavern')) return BUILDING_TYPES.tavern;
    if (t.includes('store') || t.includes('shop')) return BUILDING_TYPES.shop;
    if (t.includes('home') || t.includes('house') || t.includes('cottage')) return BUILDING_TYPES.house;
    if (t.includes('tomb') || t.includes('mausoleum') || t.includes('shrine')) return BUILDING_TYPES.temple;
    if (t.includes('monument') || t.includes('statue') || t.includes('memorial')) return BUILDING_TYPES.monument;
    if (t.includes('palace') || t.includes('manor') || t.includes('mansion')) return BUILDING_TYPES.palace;
    return BUILDING_TYPES.house;
  }

  // Fill footprint for parametric-shaped buildings (walkable base, no tile stamping)
  _stampParametricFootprint(b) {
    for (let dy = 0; dy < b.h; dy++) {
      for (let dx = 0; dx < b.w; dx++) {
        const tx = b.x + dx, ty = b.y + dy;
        if (ty >= 0 && ty < this.rows && tx >= 0 && tx < this.cols) {
          // Make the footprint sand/stone (looks like a foundation)
          this.tiles[ty][tx] = TILE.FLOOR_STONE;
        }
      }
    }
    // Door tile
    const doorX = b.x + (b.w >> 1);
    const doorY = b.y + b.h;
    if (doorY < this.rows) {
      this.tiles[doorY][doorX] = TILE.PATH_CROSS;
    }
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

  _normalizeSpecialShapes(shapes) {
    return (shapes || []).map(s => ({
      type: (s.type || 'circle').toLowerCase(),
      x: s.x ?? (this.cols >> 1),
      y: s.y ?? (this.rows >> 1),
      radius: s.radius ?? 2,
      radiusX: s.radiusX ?? s.radius ?? 2,
      radiusY: s.radiusY ?? s.radius ?? 2,
      innerRadius: s.innerRadius ?? 1,
      outerRadius: s.outerRadius ?? s.radius ?? 2,
      sides: s.sides ?? 6,
      fill: s.fill || '#6b8cae',
      stroke: s.stroke || null,
      label: s.label || s.name || '',
    }));
  }

  _updateCollision() {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        this.collision[y][x] = SOLID_TILES.has(this.tiles[y][x]);
      }
    }
    // Parametric-shaped buildings: mark edges as solid, interior walkable
    for (const b of this.buildings) {
      if (!b.shape || b.shape === 'default') continue;
      for (let dy = 0; dy < b.h; dy++) {
        for (let dx = 0; dx < b.w; dx++) {
          const tx = b.x + dx, ty = b.y + dy;
          if (ty < 0 || ty >= this.rows || tx < 0 || tx >= this.cols) continue;
          // Only block the outer edge so NPCs can walk through the interior
          const isEdge = dy === 0 || dy === b.h - 1 || dx === 0 || dx === b.w - 1;
          if (isEdge) this.collision[ty][tx] = true;
        }
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
