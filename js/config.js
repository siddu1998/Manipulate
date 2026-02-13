// ─── Game Configuration ───────────────────────────────────────────
export const TILE_SIZE = 32;
export const WORLD_COLS = 64;
export const WORLD_ROWS = 48;
export const CHAR_W = 16;
export const CHAR_H = 20;

export const GAME_SPEED = 1; // 1 real second = 1 game minute

export const TILE = {
  GRASS:        0,
  GRASS_DARK:   1,
  GRASS_FLOWER: 2,
  PATH_H:       3,
  PATH_V:       4,
  PATH_CROSS:   5,
  WATER:        6,
  SAND:         7,
  FLOOR_WOOD:   8,
  FLOOR_STONE:  9,
  WALL:        10,
  WALL_FRONT:  11,
  DOOR:        12,
  TREE:        13,
  TREE_PINE:   14,
  FENCE_H:     15,
  FENCE_V:     16,
  ROOF:        17,
  ROOF_FRONT:  18,
  BRIDGE:      19,
  BUSH:        20,
  ROCK:        21,
  BENCH:       22,
  LAMP:        23,
  WELL:        24,
  SIGN:        25,
};

export const SOLID_TILES = new Set([
  TILE.WALL, TILE.WALL_FRONT, TILE.TREE, TILE.TREE_PINE,
  TILE.FENCE_H, TILE.FENCE_V, TILE.ROOF, TILE.ROOF_FRONT,
  TILE.WATER, TILE.BUSH, TILE.ROCK, TILE.WELL, TILE.LAMP,
]);

export const WALKABLE_TILES = new Set([
  TILE.GRASS, TILE.GRASS_DARK, TILE.GRASS_FLOWER,
  TILE.PATH_H, TILE.PATH_V, TILE.PATH_CROSS,
  TILE.SAND, TILE.FLOOR_WOOD, TILE.FLOOR_STONE,
  TILE.DOOR, TILE.BRIDGE, TILE.BENCH, TILE.SIGN,
]);

export const BUILDING_TYPES = {
  house:      { w: 5, h: 4, color: '#b5651d', roofColor: '#8B4513' },
  tavern:     { w: 7, h: 5, color: '#8B6914', roofColor: '#654321' },
  shop:       { w: 5, h: 4, color: '#4682B4', roofColor: '#2c5f8a' },
  blacksmith: { w: 6, h: 4, color: '#555',    roofColor: '#333' },
  church:     { w: 6, h: 6, color: '#ddd',    roofColor: '#999' },
  school:     { w: 6, h: 5, color: '#c9302c', roofColor: '#8b0000' },
  library:    { w: 5, h: 4, color: '#6B3A2A', roofColor: '#4a2818' },
  cafe:       { w: 5, h: 4, color: '#d4a574', roofColor: '#a0785a' },
  hospital:   { w: 6, h: 5, color: '#f0f0f0', roofColor: '#ccc' },
  farm:       { w: 7, h: 5, color: '#8B7355', roofColor: '#6b5335' },
  market:     { w: 6, h: 3, color: '#c0392b', roofColor: '#962d22' },
  townhall:   { w: 7, h: 6, color: '#BDB76B', roofColor: '#8b864e' },
  bakery:     { w: 5, h: 4, color: '#f4a460', roofColor: '#cd853f' },
  inn:        { w: 6, h: 5, color: '#8B6914', roofColor: '#654321' },
  temple:     { w: 6, h: 6, color: '#e8d5b0', roofColor: '#b8860b' },
  castle:     { w: 8, h: 7, color: '#808080', roofColor: '#4a4a4a' },
  barracks:   { w: 6, h: 5, color: '#6b6b6b', roofColor: '#444' },
  stable:     { w: 6, h: 4, color: '#9a7b4f', roofColor: '#6b5335' },
  well:       { w: 3, h: 3, color: '#888',    roofColor: '#666' },
  fountain:   { w: 4, h: 3, color: '#7fb3d8', roofColor: '#5a9bbe' },
};

export const HAIR_COLORS = [
  '#2c1810', '#4a2c17', '#8B4513', '#D2691E', '#daa520',
  '#f5deb3', '#ff6347', '#1a1a2e', '#c0c0c0', '#ff69b4',
];
export const SHIRT_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#ecf0f1', '#34495e', '#d35400',
];
export const PANTS_COLORS = [
  '#2c3e50', '#34495e', '#7f8c8d', '#1a1a2e', '#4a3728',
  '#2d5a27', '#1f3a5f', '#3d3d3d', '#5d4e37', '#2c2c54',
];

export const DEFAULT_OCCUPATIONS = [
  'Farmer', 'Blacksmith', 'Baker', 'Scholar', 'Guard',
  'Merchant', 'Healer', 'Bard', 'Hunter', 'Innkeeper',
  'Priest', 'Teacher', 'Fisherman', 'Carpenter', 'Tailor',
];
