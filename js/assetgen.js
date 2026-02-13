// ═══════════════════════════════════════════════════════════════════
//  Asset Generation Pipeline
//
//  Generates pixel art tile and building sprites using image APIs
//  (Nano Banana / DALL-E), with localStorage caching and
//  procedural fallback.
//
//  Flow: planAssets → check cache → generate missing → cache → return
// ═══════════════════════════════════════════════════════════════════

const CACHE_PREFIX = 'simulate_assets_';
const MAX_CACHED_WORLDS = 5;

// ─── Asset Planning ───────────────────────────────────────────────
// Given the world description, determine what tile and building
// sprites are needed.

export function planAssets(worldData) {
  const buildings = worldData.buildings || [];

  // Only generate building sprites — tiles stay procedural
  // (AI image gen doesn't produce good tileable 32x32 sprites)
  const buildingAssets = buildings.map(b => ({
    id: `building_${slugify(b.name)}`,
    name: b.name,
    type: b.type,
    prompt: buildingPrompt(b, worldData),
  }));

  return { tiles: [], buildings: buildingAssets, cacheKey: computeCacheKey(worldData) };
}

function tilePrompt(subject, role, worldData) {
  const theme = worldData.description || 'a village';
  return `A single 32x32 pixel art tile sprite of ${subject} (used as ${role}). Top-down view, seamless tileable, 16-bit retro RPG style. Context: ${theme}. Flat colors, crisp pixels, no anti-aliasing. Output a single square tile on a transparent or matching background.`;
}

function buildingPrompt(building, worldData) {
  const theme = worldData.description || 'a village';
  return `A single small pixel art building viewed from the front, in the style of classic 16-bit RPG games like Stardew Valley or Pokemon. The building is "${building.name}" (a ${building.type}) in ${theme}. Show the full building with a roof, walls, door, and windows. Simple flat colors, chunky pixels, clean edges. Dark or transparent background (NOT white). The building should be centered and fill most of the frame.`;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function computeCacheKey(worldData) {
  const v = worldData.visual || {};
  const seed = `${worldData.name}|${v.ground}|${v.paths}|${v.vegetation}|${v.buildingStyle}`;
  // Simple hash
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return CACHE_PREFIX + Math.abs(hash).toString(36);
}

// ─── Generation Pipeline ──────────────────────────────────────────

export async function generateAssets(assetPlan, llm, onProgress) {
  const { tiles, buildings, cacheKey } = assetPlan;

  // Check cache first
  const cached = loadCachedAssets(cacheKey);
  if (cached) {
    onProgress?.('Using cached assets');
    return cached;
  }

  const result = { tiles: {}, buildings: {} };

  // Only generate building sprites (tiles stay procedural)
  onProgress?.(`Generating building sprites (0/${buildings.length})...`);
  let buildingsDone = 0;
  for (let i = 0; i < buildings.length; i += 3) {
    const batch = buildings.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(b => generateSingleAsset(b.prompt, llm))
    );
    for (let j = 0; j < batch.length; j++) {
      buildingsDone++;
      if (results[j].status === 'fulfilled' && results[j].value) {
        result.buildings[batch[j].name] = results[j].value;
      }
      onProgress?.(`Generating building sprites (${buildingsDone}/${buildings.length})...`);
    }
  }

  // Cache the result
  cacheAssets(cacheKey, result);
  onProgress?.('Assets ready');
  return result;
}

async function generateSingleAsset(prompt, llm) {
  const dataUrl = await llm.generateImage(prompt);
  if (!dataUrl) return null;

  // Convert the image to a fixed-size canvas for consistent rendering
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve(dataUrl); // Return the data URL as-is; rendering handles sizing
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ─── localStorage Caching ─────────────────────────────────────────

function loadCachedAssets(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Check if cache has actual content
    if (!data.tiles || Object.keys(data.tiles).length === 0) return null;
    // Update access time for LRU
    data.lastAccessed = Date.now();
    localStorage.setItem(key, JSON.stringify(data));
    return data;
  } catch {
    return null;
  }
}

function cacheAssets(key, assets) {
  try {
    const data = { ...assets, createdAt: Date.now(), lastAccessed: Date.now() };
    // Check total cache size and evict LRU if needed
    evictIfNeeded();
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err) {
    console.warn('Failed to cache assets:', err.message);
    // If storage is full, clear oldest and retry
    try {
      evictOldest();
      localStorage.setItem(key, JSON.stringify({ ...assets, createdAt: Date.now(), lastAccessed: Date.now() }));
    } catch { /* give up */ }
  }
}

function evictIfNeeded() {
  const cacheKeys = getAllCacheKeys();
  if (cacheKeys.length >= MAX_CACHED_WORLDS) {
    evictOldest();
  }
}

function evictOldest() {
  const cacheKeys = getAllCacheKeys();
  if (cacheKeys.length === 0) return;

  let oldest = null;
  let oldestTime = Infinity;
  for (const k of cacheKeys) {
    try {
      const data = JSON.parse(localStorage.getItem(k));
      const time = data?.lastAccessed || data?.createdAt || 0;
      if (time < oldestTime) { oldestTime = time; oldest = k; }
    } catch { /* skip */ }
  }
  if (oldest) localStorage.removeItem(oldest);
}

function getAllCacheKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  return keys;
}

// ─── Helper: Load data URL as HTMLImageElement ────────────────────
export function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}
