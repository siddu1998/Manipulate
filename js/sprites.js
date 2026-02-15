// ─── Procedural Pixel Art Sprite Generator ────────────────────────
// ★ Now with style-token rendering from worldDef.visualStyle.
// The palette, ground texture, vegetation type, and water style are
// all driven by data instead of hardcoded colors.
import { TILE_SIZE, TILE } from './config.js';

const TS = TILE_SIZE;
const cache = new Map();

// ── Style tokens from worldDef (set by app.js after world generation) ──
let _visualStyle = null;
export function setVisualStyle(style) {
  _visualStyle = style;
  cache.clear(); // re-render all tiles with new style
}
export function getVisualStyle() { return _visualStyle; }

// ── AI-generated custom assets (set by app.js after generation) ──
let customAssets = null;   // { tiles: { ground: dataUrl, ... }, buildings: { name: dataUrl, ... } }
const customImageCache = new Map(); // dataUrl → HTMLCanvasElement (scaled to tile size)

export function setCustomAssets(assets) {
  customAssets = assets;
  customImageCache.clear(); // reset when new assets arrive
}

// ── Style-aware color helpers ──
function pal(index, fallback) {
  return _visualStyle?.palette?.[index] || fallback;
}
function adjColor(hex, amount) {
  if (!hex || hex[0] !== '#') return hex;
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, ((num >> 16) & 0xff) + amount));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (num & 0xff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ── Texture strategies ──
function textureGrainy(ctx, x, y, w, h, baseColor, rng, count = 6) {
  fillRect(ctx, x, y, w, h, baseColor);
  for (let i = 0; i < count; i++) {
    const gx = x + (rng() * (w - 4)) | 0;
    const gy = y + (rng() * (h - 4)) | 0;
    fillRect(ctx, gx, gy, 2, 2, adjColor(baseColor, rng() > 0.5 ? 12 : -12));
  }
}

function textureSmooth(ctx, x, y, w, h, baseColor) {
  fillRect(ctx, x, y, w, h, baseColor);
}

function textureOrganic(ctx, x, y, w, h, baseColor, rng, count = 5) {
  fillRect(ctx, x, y, w, h, baseColor);
  for (let i = 0; i < count; i++) {
    const gx = x + (rng() * (w - 4)) | 0;
    const gy = y + (rng() * (h - 4)) | 0;
    fillRect(ctx, gx, gy, 2, 3, rng() > 0.5 ? adjColor(baseColor, 16) : adjColor(baseColor, -14));
  }
}

function textureBlock(ctx, x, y, w, h, baseColor, rng) {
  fillRect(ctx, x, y, w, h, baseColor);
  const bColor = adjColor(baseColor, -15);
  for (let by = y; by < y + h; by += 8) {
    const offset = ((by / 8) | 0) % 2 === 0 ? 0 : 4;
    for (let bx = x + offset; bx < x + w; bx += 8) {
      fillRect(ctx, bx, by, 8, 1, bColor);
      fillRect(ctx, bx, by, 1, 8, bColor);
    }
  }
}

function texturePlanks(ctx, x, y, w, h, baseColor, rng) {
  fillRect(ctx, x, y, w, h, baseColor);
  for (let py = y + 6; py < y + h; py += 7) {
    fillRect(ctx, x, py, w, 1, adjColor(baseColor, -20));
  }
  fillRect(ctx, x + (w >> 1), y, 1, h, adjColor(baseColor, -15));
}

function getGroundTextureFn() {
  const tex = _visualStyle?.groundTexture || 'organic';
  if (tex === 'grainy') return textureGrainy;
  if (tex === 'smooth') return textureSmooth;
  if (tex === 'block') return textureBlock;
  if (tex === 'planks') return texturePlanks;
  return textureOrganic;
}

export function getCustomAssets() {
  return customAssets;
}

// Load a data URL into a canvas scaled to target size
function loadCustomImage(dataUrl, w, h) {
  const k = `${dataUrl.substring(0, 60)}|${w}|${h}`;
  if (customImageCache.has(k)) return customImageCache.get(k);

  // Start async load; return null until ready (procedural fallback used until then)
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, w, h);
    customImageCache.set(k, canvas);
  };
  img.src = dataUrl;

  // Return canvas immediately (will be blank until image loads, then cached)
  customImageCache.set(k, canvas);
  return canvas;
}

function key(...args) { return args.join('|'); }

// ─── Tile Sprite Generation ──────────────────────────────────────
// Tiles are ALWAYS procedural — AI generation doesn't produce good
// tileable 32x32 sprites. Only buildings use AI-generated images.
export function getTileSprite(tileType, variant = 0) {
  const k = key('tile', tileType, variant);
  if (cache.has(k)) return cache.get(k);

  const c = document.createElement('canvas');
  c.width = TS; c.height = TS;
  const ctx = c.getContext('2d');

  drawTile(ctx, tileType, variant);
  cache.set(k, c);
  return c;
}

function drawTile(ctx, type, v) {
  const rng = mulberry32(type * 1000 + v);
  const texFn = getGroundTextureFn();

  switch (type) {
    case TILE.GRASS: {
      // ★ Uses palette[0] if available (worldDef ground color)
      const gc = pal(0, '#5b8c3e');
      texFn(ctx, 0, 0, TS, TS, gc, rng);
      break;
    }
    case TILE.GRASS_DARK: {
      const gdc = adjColor(pal(0, '#5b8c3e'), -20);
      texFn(ctx, 0, 0, TS, TS, gdc, rng, 4);
      break;
    }
    case TILE.GRASS_FLOWER: {
      const gfc = pal(0, '#5b8c3e');
      fillRect(ctx, 0, 0, TS, TS, gfc);
      const flowerColors = [pal(2, '#e74c3c'), '#f1c40f', '#e67e22', '#9b59b6', '#fff'];
      for (let i = 0; i < 3; i++) {
        const fx = (rng() * 26) | 0 + 2, fy = (rng() * 26) | 0 + 2;
        fillRect(ctx, fx, fy, 3, 3, flowerColors[(rng() * flowerColors.length) | 0]);
        fillRect(ctx, fx + 1, fy + 1, 1, 1, '#f1c40f');
      }
      break;
    }
    case TILE.PATH_H:
    case TILE.PATH_V:
    case TILE.PATH_CROSS: {
      // ★ Path uses palette[1] (path color from worldDef)
      const pc = pal(1, '#c9b48c');
      textureBlock(ctx, 0, 0, TS, TS, pc, rng);
      for (let i = 0; i < 3; i++) {
        fillRect(ctx, (rng() * 28) | 0, (rng() * 28) | 0, 3, 2, adjColor(pc, -16));
      }
      // edges
      if (type === TILE.PATH_H || type === TILE.PATH_CROSS) {
        fillRect(ctx, 0, 0, TS, 2, '#a8936b');
        fillRect(ctx, 0, TS - 2, TS, 2, '#a8936b');
      }
      if (type === TILE.PATH_V || type === TILE.PATH_CROSS) {
        fillRect(ctx, 0, 0, 2, TS, '#a8936b');
        fillRect(ctx, TS - 2, 0, 2, TS, '#a8936b');
      }
      break;
    }
    case TILE.WATER: {
      // ★ Water uses palette[2] (water color from worldDef)
      const wc = pal(2, '#3a7bd5');
      fillRect(ctx, 0, 0, TS, TS, wc);
      const ws = _visualStyle?.waterStyle || 'still';
      const waveCount = ws === 'river' ? 6 : ws === 'ocean' ? 8 : 4;
      for (let i = 0; i < waveCount; i++) {
        fillRect(ctx, (rng() * 24) | 0, (rng() * 28) | 0, ws === 'ocean' ? 8 : 6, 2, adjColor(wc, 30));
      }
      break;
    }
    case TILE.SAND: {
      // ★ Sand uses palette[4] (sand/accent color from worldDef)
      const sc = pal(4, '#e8d5a3');
      textureGrainy(ctx, 0, 0, TS, TS, sc, rng, 4);
      break;
    }
    case TILE.FLOOR_WOOD: {
      const fwc = pal(3, '#b8860b');
      texturePlanks(ctx, 0, 0, TS, TS, fwc, rng);
      break;
    }
    case TILE.FLOOR_STONE: {
      const fsc = pal(3, '#999');
      textureBlock(ctx, 0, 0, TS, TS, fsc, rng);
      fillRect(ctx, 0, 0, 15, 15, adjColor(fsc, 10));
      fillRect(ctx, 16, 0, 16, 15, '#888');
      fillRect(ctx, 0, 16, 15, 16, '#888');
      fillRect(ctx, 16, 16, 16, 16, '#aaa');
      fillRect(ctx, 0, 15, TS, 1, '#777');
      fillRect(ctx, 15, 0, 1, TS, '#777');
      break;
    }
    case TILE.WALL:
      fillRect(ctx, 0, 0, TS, TS, '#8B7355');
      fillRect(ctx, 0, 0, TS, 2, '#7B6345');
      fillRect(ctx, 0, TS - 2, TS, 2, '#7B6345');
      break;
    case TILE.WALL_FRONT:
      fillRect(ctx, 0, 0, TS, TS, '#8B7355');
      // window
      fillRect(ctx, 10, 8, 12, 10, '#87CEEB');
      fillRect(ctx, 10, 8, 12, 2, '#6B5335');
      fillRect(ctx, 10, 16, 12, 2, '#6B5335');
      fillRect(ctx, 15, 8, 2, 10, '#6B5335');
      break;
    case TILE.DOOR:
      fillRect(ctx, 0, 0, TS, TS, '#8B7355');
      fillRect(ctx, 8, 2, 16, 28, '#654321');
      fillRect(ctx, 10, 4, 12, 24, '#7B5B3A');
      fillRect(ctx, 20, 15, 2, 3, '#DAA520');
      fillRect(ctx, 8, 28, 16, 2, '#543210');
      break;
    case TILE.TREE:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      // trunk
      fillRect(ctx, 13, 18, 6, 14, '#6B4226');
      fillRect(ctx, 14, 20, 4, 12, '#8B5A2B');
      // foliage
      fillCircle(ctx, 16, 12, 11, '#2d7a2d');
      fillCircle(ctx, 12, 10, 7, '#3a8a3a');
      fillCircle(ctx, 20, 10, 7, '#3a8a3a');
      fillCircle(ctx, 16, 7, 6, '#4a9a4a');
      break;
    case TILE.TREE_PINE:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillRect(ctx, 14, 22, 4, 10, '#6B4226');
      // pine layers
      for (let i = 0; i < 4; i++) {
        const w = 18 - i * 3, h = 7;
        const x = 16 - w / 2, y = 4 + i * 5;
        ctx.fillStyle = i % 2 === 0 ? '#1a5c1a' : '#2a6c2a';
        ctx.beginPath();
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + w / 2, y);
        ctx.lineTo(x + w, y + h);
        ctx.fill();
      }
      break;
    case TILE.FENCE_H:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillRect(ctx, 0, 10, TS, 3, '#b5651d');
      fillRect(ctx, 0, 18, TS, 3, '#b5651d');
      fillRect(ctx, 2, 6, 3, 20, '#a0551d');
      fillRect(ctx, TS - 5, 6, 3, 20, '#a0551d');
      break;
    case TILE.FENCE_V:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillRect(ctx, 12, 0, 3, TS, '#b5651d');
      fillRect(ctx, 18, 0, 3, TS, '#b5651d');
      fillRect(ctx, 8, 2, 18, 3, '#a0551d');
      fillRect(ctx, 8, TS - 5, 18, 3, '#a0551d');
      break;
    case TILE.ROOF:
      fillRect(ctx, 0, 0, TS, TS, '#8B4513');
      for (let y = 0; y < TS; y += 6) {
        fillRect(ctx, 0, y, TS, 2, '#7B3503');
      }
      break;
    case TILE.ROOF_FRONT:
      fillRect(ctx, 0, 0, TS, TS, '#8B4513');
      fillRect(ctx, 0, TS - 4, TS, 4, '#6B2503');
      for (let y = 0; y < TS - 4; y += 6) {
        fillRect(ctx, 0, y, TS, 2, '#7B3503');
      }
      break;
    case TILE.BRIDGE:
      fillRect(ctx, 0, 0, TS, TS, '#3a7bd5');
      fillRect(ctx, 2, 0, TS - 4, TS, '#b5651d');
      fillRect(ctx, 4, 0, TS - 8, TS, '#c5752d');
      fillRect(ctx, 2, 0, 2, TS, '#8B4513');
      fillRect(ctx, TS - 4, 0, 2, TS, '#8B4513');
      break;
    case TILE.BUSH:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillCircle(ctx, 16, 18, 10, '#2d6a2d');
      fillCircle(ctx, 12, 14, 7, '#3d7a3d');
      fillCircle(ctx, 20, 16, 7, '#3d7a3d');
      break;
    case TILE.ROCK:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillCircle(ctx, 16, 18, 10, '#888');
      fillCircle(ctx, 14, 15, 8, '#999');
      fillCircle(ctx, 20, 20, 6, '#777');
      break;
    case TILE.BENCH:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillRect(ctx, 4, 14, 24, 4, '#8B6914');
      fillRect(ctx, 6, 18, 3, 8, '#6B4914');
      fillRect(ctx, 23, 18, 3, 8, '#6B4914');
      fillRect(ctx, 4, 10, 24, 3, '#7B5914');
      break;
    case TILE.LAMP:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillRect(ctx, 14, 6, 4, 22, '#555');
      fillRect(ctx, 10, 2, 12, 8, '#777');
      fillRect(ctx, 12, 4, 8, 4, '#ffdd57');
      break;
    case TILE.WELL:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillCircle(ctx, 16, 18, 11, '#888');
      fillCircle(ctx, 16, 18, 8, '#3a7bd5');
      fillRect(ctx, 10, 6, 2, 14, '#6B4226');
      fillRect(ctx, 20, 6, 2, 14, '#6B4226');
      fillRect(ctx, 10, 5, 12, 3, '#8B5A2B');
      break;
    case TILE.SIGN:
      fillRect(ctx, 0, 0, TS, TS, '#5b8c3e');
      fillRect(ctx, 14, 14, 4, 14, '#6B4226');
      fillRect(ctx, 6, 6, 20, 12, '#b5651d');
      fillRect(ctx, 8, 8, 16, 8, '#c5752d');
      break;
    default:
      fillRect(ctx, 0, 0, TS, TS, '#f0f');
  }
}

// ─── Character Sprite Generation ─────────────────────────────────
// Returns a set of sprites: { down, up, left, right } each an array of 2 frames
export function getCharacterSprites(colors, isPlayer = false) {
  const k = key('char', colors.hair, colors.skin, colors.shirt, colors.pants, isPlayer);
  if (cache.has(k)) return cache.get(k);

  const sprites = {};
  for (const dir of ['down', 'up', 'left', 'right']) {
    sprites[dir] = [0, 1].map(frame => {
      const c = document.createElement('canvas');
      c.width = TS; c.height = TS;
      const ctx = c.getContext('2d');
      drawCharacter(ctx, colors, dir, frame, isPlayer);
      return c;
    });
  }
  cache.set(k, sprites);
  return sprites;
}

function drawCharacter(ctx, colors, dir, frame, isPlayer) {
  const { hair, skin, shirt, pants } = colors;
  const ox = 8, oy = 4; // offset to center in tile
  const s = 2; // pixel scale

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  fillEllipse(ctx, 16, 30, 8, 3);

  if (dir === 'down') {
    // Hair
    fillRect(ctx, ox + 2*s, oy, 4*s, 3*s, hair);
    fillRect(ctx, ox + 1*s, oy + 1*s, 6*s, 2*s, hair);
    // Face
    fillRect(ctx, ox + 2*s, oy + 3*s, 4*s, 2*s, skin);
    // Eyes
    fillRect(ctx, ox + 2*s, oy + 3*s, s, s, '#2c1810');
    fillRect(ctx, ox + 5*s, oy + 3*s, s, s, '#2c1810');
    // Body
    fillRect(ctx, ox + 1*s, oy + 5*s, 6*s, 4*s, shirt);
    // Arms
    const armOff = frame === 1 ? s : 0;
    fillRect(ctx, ox, oy + 5*s + armOff, s, 3*s, shirt);
    fillRect(ctx, ox + 7*s, oy + 5*s - armOff + s, s, 3*s, shirt);
    // Hands
    fillRect(ctx, ox, oy + 8*s + armOff, s, s, skin);
    fillRect(ctx, ox + 7*s, oy + 8*s - armOff + s, s, s, skin);
    // Pants
    fillRect(ctx, ox + 2*s, oy + 9*s, 2*s, 3*s, pants);
    fillRect(ctx, ox + 4*s, oy + 9*s, 2*s, 3*s, pants);
    // Leg animation
    if (frame === 1) {
      fillRect(ctx, ox + 1*s, oy + 11*s, 2*s, s, pants);
      fillRect(ctx, ox + 5*s, oy + 10*s, 2*s, s, pants);
    }
    // Shoes
    fillRect(ctx, ox + 2*s, oy + 12*s, 2*s, s, '#2c1810');
    fillRect(ctx, ox + 4*s, oy + 12*s, 2*s, s, '#2c1810');
  } else if (dir === 'up') {
    // Hair (back)
    fillRect(ctx, ox + 2*s, oy, 4*s, 3*s, hair);
    fillRect(ctx, ox + 1*s, oy + 1*s, 6*s, 3*s, hair);
    fillRect(ctx, ox + 2*s, oy + 4*s, 4*s, s, hair);
    // Body
    fillRect(ctx, ox + 1*s, oy + 5*s, 6*s, 4*s, shirt);
    // Arms
    const armOff = frame === 1 ? s : 0;
    fillRect(ctx, ox, oy + 5*s - armOff + s, s, 3*s, shirt);
    fillRect(ctx, ox + 7*s, oy + 5*s + armOff, s, 3*s, shirt);
    // Pants
    fillRect(ctx, ox + 2*s, oy + 9*s, 2*s, 3*s, pants);
    fillRect(ctx, ox + 4*s, oy + 9*s, 2*s, 3*s, pants);
    if (frame === 1) {
      fillRect(ctx, ox + 1*s, oy + 10*s, 2*s, s, pants);
      fillRect(ctx, ox + 5*s, oy + 11*s, 2*s, s, pants);
    }
    fillRect(ctx, ox + 2*s, oy + 12*s, 2*s, s, '#2c1810');
    fillRect(ctx, ox + 4*s, oy + 12*s, 2*s, s, '#2c1810');
  } else {
    // Draw left-facing, flip canvas for right
    if (dir === 'right') {
      ctx.save();
      ctx.translate(TS, 0);
      ctx.scale(-1, 1);
    }
    // Hair
    fillRect(ctx, ox + 2*s, oy, 4*s, 3*s, hair);
    fillRect(ctx, ox + 1*s, oy + 1*s, 5*s, 2*s, hair);
    // Face
    fillRect(ctx, ox + 2*s, oy + 3*s, 4*s, 2*s, skin);
    // Eye
    fillRect(ctx, ox + 4*s, oy + 3*s, s, s, '#2c1810');
    // Body
    fillRect(ctx, ox + 1*s, oy + 5*s, 5*s, 4*s, shirt);
    // Arm
    const armOff = frame === 1 ? s : 0;
    fillRect(ctx, ox + 1*s, oy + 5*s + armOff, s, 3*s, shirt);
    fillRect(ctx, ox + 1*s, oy + 8*s + armOff, s, s, skin);
    // Pants
    fillRect(ctx, ox + 2*s, oy + 9*s, 2*s, 3*s, pants);
    fillRect(ctx, ox + 3*s, oy + 9*s, 2*s, 3*s, pants);
    if (frame === 1) {
      fillRect(ctx, ox + 1*s, oy + 11*s, 2*s, s, pants);
    }
    fillRect(ctx, ox + 2*s, oy + 12*s, 2*s, s, '#2c1810');
    fillRect(ctx, ox + 3*s, oy + 12*s, 2*s, s, '#2c1810');
    if (dir === 'right') ctx.restore();
  }

  // Player marker (small colored triangle above head)
  if (isPlayer) {
    ctx.fillStyle = '#3498db';
    ctx.beginPath();
    ctx.moveTo(16, oy - 4);
    ctx.lineTo(13, oy - 9);
    ctx.lineTo(19, oy - 9);
    ctx.fill();
  }
}

// ─── Building Roof Sprite ────────────────────────────────────────
export function getBuildingRoof(w, h, roofColor) {
  const k = key('roof', w, h, roofColor);
  if (cache.has(k)) return cache.get(k);
  const c = document.createElement('canvas');
  c.width = w * TS; c.height = h * TS;
  const ctx = c.getContext('2d');

  ctx.fillStyle = roofColor;
  ctx.fillRect(0, 0, c.width, c.height);
  // Roof pattern
  ctx.fillStyle = adjustColor(roofColor, -20);
  for (let y = 0; y < c.height; y += 8) {
    ctx.fillRect(0, y, c.width, 2);
  }
  // Edge
  ctx.fillStyle = adjustColor(roofColor, -40);
  ctx.fillRect(0, c.height - 4, c.width, 4);

  cache.set(k, c);
  return c;
}

// ─── Helper drawing functions ────────────────────────────────────
function fillRect(ctx, x, y, w, h, color) {
  if (color) ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function fillCircle(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function fillEllipse(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

function adjustColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, ((num >> 16) & 0xff) + amount));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (num & 0xff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ─── Custom Building Image Access ─────────────────────────────────
export function getCustomBuildingImage(buildingName, w, h) {
  if (!customAssets?.buildings?.[buildingName]) return null;
  return loadCustomImage(customAssets.buildings[buildingName], w, h);
}

// Deterministic RNG for tile variants
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
