// ─── Canvas Renderer ──────────────────────────────────────────────
import { TILE_SIZE, WORLD_COLS, WORLD_ROWS } from './config.js';
import { getTileSprite } from './sprites.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    // Camera
    this.camX = 0;
    this.camY = 0;
    this.camTargetX = 0;
    this.camTargetY = 0;

    // Minimap
    this.minimapCanvas = document.getElementById('minimap');
    this.minimapCtx = this.minimapCanvas?.getContext('2d');
    this.showMinimap = false;

    // Effects / particles
    this.particles = [];

    // ★ Floating text (transaction animations, reactions, etc.)
    this.floatingTexts = [];

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Also observe parent container size changes (sidebar appearing, etc.)
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    }
  }

  resize() {
    // Use the parent container size, not the full window (sidebar takes space)
    const parent = this.canvas.parentElement;
    const w = parent ? parent.clientWidth : window.innerWidth;
    const h = parent ? parent.clientHeight : window.innerHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.imageSmoothingEnabled = false;
    this.viewW = w;
    this.viewH = h;
    if (this.minimapCanvas) {
      this.minimapCanvas.width = 160;
      this.minimapCanvas.height = 120;
    }
  }

  // ─── Camera ─────────────────────────────────────────────────────
  followTarget(px, py) {
    this.camTargetX = px - this.viewW / 2 + TILE_SIZE / 2;
    this.camTargetY = py - this.viewH / 2 + TILE_SIZE / 2;
    const maxX = WORLD_COLS * TILE_SIZE - this.viewW;
    const maxY = WORLD_ROWS * TILE_SIZE - this.viewH;
    this.camTargetX = Math.max(0, Math.min(maxX, this.camTargetX));
    this.camTargetY = Math.max(0, Math.min(maxY, this.camTargetY));
    this.camX += (this.camTargetX - this.camX) * 0.1;
    this.camY += (this.camTargetY - this.camY) * 0.1;
  }

  // ─── Particles / Effects ────────────────────────────────────────
  addParticle(x, y, type) {
    this.particles.push({
      x, y,
      vx: (Math.random() - 0.5) * (type === 'fire' ? 1.2 : 0.5),
      vy: -(Math.random() * (type === 'fire' ? 2.5 : 1.5) + 0.5),
      life: 1.0,
      decay: 0.008 + Math.random() * 0.015,
      size: type === 'fire' ? 3 + Math.random() * 5 : 2 + Math.random() * 3,
      type,
    });
  }

  spawnEffect(worldX, worldY, type, intensity = 5) {
    const px = worldX * TILE_SIZE + TILE_SIZE / 2;
    const py = worldY * TILE_SIZE;
    for (let i = 0; i < intensity; i++) {
      this.addParticle(
        px + (Math.random() - 0.5) * TILE_SIZE * 2,
        py + Math.random() * TILE_SIZE,
        type
      );
    }
  }

  _updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      if (p.type === 'fire') {
        p.vy -= 0.03;
        p.size *= 0.995;
      } else if (p.type === 'smoke') {
        p.vy -= 0.01;
        p.vx += (Math.random() - 0.5) * 0.1;
        p.size *= 1.003;
      } else if (p.type === 'splash') {
        p.vy += 0.08;
      } else if (p.type === 'gold') {
        p.vy += 0.02;  // gentle gravity
        p.vx *= 0.98;
        p.size *= 0.997;
      }
      if (p.life <= 0 || p.size < 0.5) {
        this.particles.splice(i, 1);
      }
    }
  }

  _drawParticles(ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life * 0.85);
      let color;
      if (p.type === 'fire') {
        const t = 1 - p.life;
        if (t < 0.3) color = '#ffdd33';
        else if (t < 0.6) color = '#ff8800';
        else color = '#cc2200';
      } else if (p.type === 'smoke') {
        const g = Math.floor(80 + p.life * 60);
        color = `rgb(${g},${g},${g})`;
      } else if (p.type === 'splash') {
        color = `hsl(210, 80%, ${50 + p.life * 30}%)`;
      } else if (p.type === 'sparkle') {
        color = `hsl(${Math.random() * 60 + 30}, 100%, ${60 + p.life * 30}%)`;
      } else if (p.type === 'gold') {
        color = `hsl(${43 + Math.random() * 10}, 100%, ${50 + p.life * 30}%)`;
      } else {
        color = '#fff';
      }
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(p.x - p.size / 2), Math.round(p.y - p.size / 2), p.size, p.size);
    }
    ctx.globalAlpha = 1.0;
  }

  // ─── Floating Text (money, reactions, etc.) ─────────────────────
  addFloatingText(worldX, worldY, text, color = '#FFD700', size = 12, duration = 1.8) {
    this.floatingTexts.push({
      x: worldX,
      y: worldY,
      text,
      color,
      size,
      life: 1.0,
      decay: 1.0 / (duration * 60), // ~60fps
      vy: -0.8,        // float upward
      vx: (Math.random() - 0.5) * 0.3,
    });
  }

  _updateFloatingTexts() {
    for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
      const ft = this.floatingTexts[i];
      ft.x += ft.vx;
      ft.y += ft.vy;
      ft.vy *= 0.98;   // slow down
      ft.life -= ft.decay;
      if (ft.life <= 0) {
        this.floatingTexts.splice(i, 1);
      }
    }
  }

  _drawFloatingTexts(ctx) {
    for (const ft of this.floatingTexts) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, ft.life);
      const scale = 0.8 + ft.life * 0.4; // slightly shrink as it fades
      ctx.font = `bold ${Math.round(ft.size * scale)}px "Inter", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      // Outline for readability
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText(ft.text, ft.x, ft.y);

      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.restore();
    }
  }

  // ─── Main Render ────────────────────────────────────────────────
  render(world, player, npcs, gameTime, worldEvents) {
    const ctx = this.ctx;
    const dt = 16; // approximate frame dt
    ctx.clearRect(0, 0, this.viewW, this.viewH);

    ctx.fillStyle = '#2a5a1a';
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    // Visible tile range
    const startCol = Math.max(0, Math.floor(this.camX / TILE_SIZE) - 1);
    const endCol = Math.min(WORLD_COLS, Math.ceil((this.camX + this.viewW) / TILE_SIZE) + 1);
    const startRow = Math.max(0, Math.floor(this.camY / TILE_SIZE) - 1);
    const endRow = Math.min(WORLD_ROWS, Math.ceil((this.camY + this.viewH) / TILE_SIZE) + 1);

    ctx.save();
    ctx.translate(-Math.round(this.camX), -Math.round(this.camY));

    // 1) Draw ground tiles
    for (let y = startRow; y < endRow; y++) {
      for (let x = startCol; x < endCol; x++) {
        const tile = world.getTile(x, y);
        const variant = ((x * 7 + y * 13) & 0xf);
        const sprite = getTileSprite(tile, variant);
        ctx.drawImage(sprite, x * TILE_SIZE, y * TILE_SIZE);
      }
    }

    // 2) Draw building overlays (colored, with type-specific decorations)
    for (const b of world.buildings) {
      const bpx = b.x * TILE_SIZE;
      const bpy = b.y * TILE_SIZE;
      if (bpx + b.w * TILE_SIZE < this.camX - 32 || bpx > this.camX + this.viewW + 32) continue;
      if (bpy + b.h * TILE_SIZE < this.camY - 32 || bpy > this.camY + this.viewH + 32) continue;
      this._drawBuilding(ctx, b);
    }

    // 3) Collect & sort entities by Y for depth
    const entities = [
      { entity: player, type: 'player' },
      ...npcs.map(n => ({ entity: n, type: 'npc' }))
    ].sort((a, b) => a.entity.py - b.entity.py);

    for (const { entity } of entities) {
      this._drawEntity(ctx, entity);
    }

    // 4) Particles (fire, smoke, etc.)
    this._updateParticles(dt);
    this._drawParticles(ctx);

    // 5) Continuously spawn particles for active world events
    if (worldEvents) {
      for (const ev of worldEvents) {
        if (ev.type === 'fire') {
          this.spawnEffect(ev.x, ev.y, 'fire', 3);
          if (Math.random() < 0.3) this.spawnEffect(ev.x, ev.y, 'smoke', 1);
        } else if (ev.type === 'rain') {
          for (let i = 0; i < 4; i++) {
            const rx = this.camX / TILE_SIZE + Math.random() * this.viewW / TILE_SIZE;
            const ry = this.camY / TILE_SIZE + Math.random() * this.viewH / TILE_SIZE;
            this.addParticle(rx * TILE_SIZE, ry * TILE_SIZE, 'splash');
          }
        } else if (ev.type === 'sparkle' || ev.type === 'magic') {
          this.spawnEffect(ev.x, ev.y, 'sparkle', 2);
        }
      }
    }

    // 6) Floating text (transactions, reactions)
    this._updateFloatingTexts();
    this._drawFloatingTexts(ctx);

    // 7) NPC name tags
    for (const npc of npcs) {
      this._drawNameTag(ctx, npc);
    }

    // 8) Speech bubbles
    for (const npc of npcs) {
      if (npc.speechBubble) this._drawSpeechBubble(ctx, npc);
    }

    // 9) Building labels
    for (const b of world.buildings) {
      const bx = (b.x + b.w / 2) * TILE_SIZE;
      const by = b.y * TILE_SIZE - 16;
      if (bx > this.camX - 100 && bx < this.camX + this.viewW + 100 &&
          by > this.camY - 50 && by < this.camY + this.viewH + 50) {
        this._drawLabel(ctx, b.name, bx, by, '#fff', 'rgba(0,0,0,0.6)', 10);
      }
    }

    // 10) Event labels (e.g. "FIRE!" over burning buildings)
    if (worldEvents) {
      for (const ev of worldEvents) {
        if (ev.type === 'fire') {
          const ex = ev.x * TILE_SIZE + TILE_SIZE / 2;
          const ey = ev.y * TILE_SIZE - 24;
          this._drawLabel(ctx, '🔥 FIRE!', ex, ey, '#ff4444', 'rgba(80,0,0,0.7)', 10);
        }
      }
    }

    ctx.restore();

    // 11) Day/night overlay
    this._drawDayNightOverlay(ctx, gameTime);

    // 12) Minimap
    if (this.showMinimap) this._drawMinimap(world, player, npcs, worldEvents);
  }

  // ─── Building Rendering ─────────────────────────────────────────
  _drawBuilding(ctx, b) {
    const TS = TILE_SIZE;
    const px = b.x * TS;
    const py = b.y * TS;
    const pw = b.w * TS;
    const ph = b.h * TS;

    const roofH = Math.min(TS * 2, ph * 0.45);
    const overhang = 4;

    // ── Roof ── (procedural fallback)
    ctx.fillStyle = b.roofColor;
    ctx.fillRect(px - overhang, py, pw + overhang * 2, roofH);
    // Tile pattern
    ctx.fillStyle = this._adj(b.roofColor, -18);
    for (let ry = py; ry < py + roofH; ry += 7) {
      ctx.fillRect(px - overhang, ry, pw + overhang * 2, 2);
    }
    // Bottom edge
    ctx.fillStyle = this._adj(b.roofColor, -35);
    ctx.fillRect(px - overhang, py + roofH - 4, pw + overhang * 2, 4);

    // ── Walls ──
    const wallY = py + roofH;
    const wallH = ph - roofH;
    ctx.fillStyle = b.color;
    ctx.fillRect(px, wallY, pw, wallH);
    // Border
    ctx.fillStyle = this._adj(b.color, -20);
    ctx.fillRect(px, wallY, pw, 2);
    ctx.fillRect(px, wallY, 2, wallH);
    ctx.fillRect(px + pw - 2, wallY, 2, wallH);

    // ── Windows ──
    const frontY = py + ph - TS;
    const doorCol = Math.floor(b.w / 2);
    for (let c = 0; c < b.w; c++) {
      if (c === doorCol) continue;
      const wx = px + c * TS + 7;
      const wy = frontY + 6;
      const ww = TS - 14;
      const wh = TS - 14;
      if (ww < 4) continue;
      // Glass
      ctx.fillStyle = b._glowColor || '#6fa8c7';
      ctx.fillRect(wx, wy, ww, wh);
      // Frame
      ctx.fillStyle = this._adj(b.color, -30);
      ctx.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      ctx.fillRect(wx, wy + wh / 2 - 1, ww, 2);
      // Sill
      ctx.fillRect(wx - 1, wy + wh, ww + 2, 2);
    }
    // Upper windows for taller buildings
    if (wallH > TS * 1.5) {
      for (let c = 1; c < b.w - 1; c += 2) {
        const wx = px + c * TS + 8;
        const wy = wallY + 8;
        ctx.fillStyle = b._glowColor || '#6fa8c7';
        ctx.fillRect(wx, wy, TS - 16, TS - 16);
        ctx.fillStyle = this._adj(b.color, -30);
        ctx.fillRect(wx + (TS - 16) / 2 - 1, wy, 2, TS - 16);
      }
    }

    // ── Door ──
    const doorX = px + doorCol * TS;
    const doorW = TS - 8;
    const doorH = TS - 4;
    ctx.fillStyle = '#3d1f0a';
    ctx.fillRect(doorX + 4, frontY + 4, doorW, doorH);
    ctx.fillStyle = '#5a3520';
    ctx.fillRect(doorX + 6, frontY + 6, doorW - 4, doorH - 4);
    // Handle
    ctx.fillStyle = '#DAA520';
    ctx.fillRect(doorX + doorW - 2, frontY + TS / 2, 3, 3);
    // Frame
    ctx.fillStyle = this._adj(b.color, -35);
    ctx.fillRect(doorX + 2, frontY + 2, doorW + 4, 3);
    ctx.fillRect(doorX + 2, frontY + 2, 3, doorH + 2);
    ctx.fillRect(doorX + doorW + 3, frontY + 2, 3, doorH + 2);

    // ── Type decorations ──
    this._drawBuildingDecor(ctx, b, px, py, pw, ph, roofH);
  }

  _drawBuildingDecor(ctx, b, px, py, pw, ph, roofH) {
    const TS = TILE_SIZE;
    const t = (b.type || '').toLowerCase();
    const cx = px + pw / 2;

    if (t.includes('tavern') || t.includes('inn') || t.includes('pub') || t.includes('bar')) {
      b._glowColor = '#d4a040';
      // Hanging sign board
      ctx.fillStyle = '#654321';
      ctx.fillRect(px + pw - TS + 8, py + roofH - 2, 3, 18);
      ctx.fillStyle = '#8B6914';
      ctx.fillRect(px + pw - TS - 4, py + roofH + 12, 26, 14);
      ctx.fillStyle = '#DAA520';
      ctx.font = '8px sans-serif';
      ctx.fillText('INN', px + pw - TS, py + roofH + 23);
    }

    if (t.includes('church') || t.includes('temple') || t.includes('chapel')) {
      b._glowColor = '#b080d0'; // stained glass
      // Steeple/Cross
      ctx.fillStyle = '#FFD700';
      ctx.fillRect(cx - 2, py - 14, 4, 18);
      ctx.fillRect(cx - 7, py - 8, 14, 4);
      // Arched doorway accent
      ctx.fillStyle = '#FFD700';
      const doorCol = Math.floor(b.w / 2);
      ctx.fillRect(px + doorCol * TS + 4, py + ph - TS + 2, TS - 8, 3);
    }

    if (t.includes('blacksmith') || t.includes('forge') || t.includes('smith')) {
      b._glowColor = '#e06020'; // furnace glow
      // Chimney
      ctx.fillStyle = '#444';
      ctx.fillRect(px + pw - TS + 4, py - 10, 14, 14);
      ctx.fillStyle = '#555';
      ctx.fillRect(px + pw - TS + 6, py - 8, 10, 10);
      // Anvil
      ctx.fillStyle = '#333';
      ctx.fillRect(px + pw + 4, py + ph - 10, 12, 5);
      ctx.fillRect(px + pw + 6, py + ph - 14, 8, 5);
    }

    if (t.includes('bakery') || t.includes('bread')) {
      b._glowColor = '#e8a040'; // warm oven
      // Small chimney with smoke hint
      ctx.fillStyle = '#8B6914';
      ctx.fillRect(px + TS - 4, py - 8, 12, 12);
    }

    if (t.includes('shop') || t.includes('store') || t.includes('market')) {
      // Colorful awning
      const awnY = py + roofH - 2;
      const stripe1 = '#c0392b', stripe2 = '#e8e8e8';
      for (let sx = px - 2; sx < px + pw + 2; sx += 10) {
        ctx.fillStyle = Math.floor((sx - px) / 10) % 2 === 0 ? stripe1 : stripe2;
        ctx.fillRect(sx, awnY, 10, 8);
      }
    }

    if (t.includes('school') || t.includes('library')) {
      // Flag pole
      ctx.fillStyle = '#888';
      ctx.fillRect(px + 4, py - 18, 2, 22);
      ctx.fillStyle = '#e74c3c';
      ctx.fillRect(px + 6, py - 16, 12, 8);
    }

    if (t.includes('hospital') || t.includes('clinic') || t.includes('healer')) {
      // Red cross on wall
      ctx.fillStyle = '#e74c3c';
      ctx.fillRect(cx - 2, py + roofH + 6, 4, 14);
      ctx.fillRect(cx - 7, py + roofH + 11, 14, 4);
    }

    if (t.includes('townhall') || t.includes('hall') || t.includes('government')) {
      // Columns
      ctx.fillStyle = '#ddd';
      ctx.fillRect(px + 4, py + roofH, 6, ph - roofH);
      ctx.fillRect(px + pw - 10, py + roofH, 6, ph - roofH);
      // Flag
      ctx.fillStyle = '#888';
      ctx.fillRect(cx - 1, py - 16, 2, 20);
      ctx.fillStyle = '#3498db';
      ctx.fillRect(cx + 1, py - 14, 14, 9);
    }

    if (t.includes('farm') || t.includes('barn')) {
      // X-pattern on door
      const doorCol = Math.floor(b.w / 2);
      const dx = px + doorCol * TS + 6;
      const dy = py + ph - TS + 6;
      ctx.strokeStyle = '#8B6914';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(dx, dy); ctx.lineTo(dx + TS - 12, dy + TS - 12);
      ctx.moveTo(dx + TS - 12, dy); ctx.lineTo(dx, dy + TS - 12);
      ctx.stroke();
    }

    if (t.includes('cafe') || t.includes('coffee')) {
      b._glowColor = '#d4a050';
      // Small awning
      ctx.fillStyle = '#2e7d32';
      ctx.fillRect(px - 2, py + roofH - 2, pw + 4, 6);
    }

    if (t.includes('temple') || t.includes('shrine') || t.includes('monastery')) {
      b._glowColor = '#e8c840';
      // Golden dome on roof
      ctx.fillStyle = '#DAA520';
      ctx.beginPath();
      ctx.arc(cx, py + 4, pw / 5, Math.PI, 0);
      ctx.fill();
      // Ornamental top
      ctx.fillStyle = '#FFD700';
      ctx.fillRect(cx - 1, py - 8, 2, 12);
      ctx.fillRect(cx - 4, py - 8, 8, 3);
    }

    if (t.includes('castle') || t.includes('fortress') || t.includes('keep')) {
      // Battlements / crenellations on roof
      ctx.fillStyle = this._adj(b.roofColor, 15);
      for (let bx = px; bx < px + pw; bx += 10) {
        ctx.fillRect(bx, py - 6, 6, 8);
      }
      // Tower accents on sides
      ctx.fillStyle = this._adj(b.color, -15);
      ctx.fillRect(px - 4, py + roofH, 8, ph - roofH);
      ctx.fillRect(px + pw - 4, py + roofH, 8, ph - roofH);
      // Tower tops
      ctx.fillStyle = this._adj(b.roofColor, 15);
      ctx.fillRect(px - 6, py - 8, 12, 8);
      ctx.fillRect(px + pw - 6, py - 8, 12, 8);
    }

    if (t.includes('stable') || t.includes('horse')) {
      // Hay bale near entrance
      ctx.fillStyle = '#DAA520';
      ctx.fillRect(px + pw + 2, py + ph - 8, 10, 6);
      ctx.fillStyle = '#C8960C';
      ctx.fillRect(px + pw + 4, py + ph - 10, 6, 4);
    }
  }

  // ─── Entity ─────────────────────────────────────────────────────
  _drawEntity(ctx, entity) {
    const sprite = entity.getSprite();
    if (sprite) {
      ctx.drawImage(sprite, Math.round(entity.px), Math.round(entity.py));
    } else {
      ctx.fillStyle = entity.colors.shirt;
      ctx.fillRect(entity.px + 8, entity.py + 4, 16, 24);
    }
  }

  _drawNameTag(ctx, npc) {
    if (npc.speechBubble) return;
    ctx.save();
    ctx.font = 'bold 9px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const name = npc.name.split(' ')[0];
    const tw = ctx.measureText(name).width + 8;
    const nx = npc.px + TILE_SIZE / 2;
    const ny = npc.py - 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    this._roundRect(ctx, nx - tw / 2, ny - 13, tw, 14, 3);
    ctx.fill();
    ctx.fillStyle = (npc.state === 'following' || npc.state === 'leading') ? '#2ecc71' : '#fff';
    ctx.fillText(name, nx, ny);
    ctx.restore();
  }

  // ─── Speech Bubble ──────────────────────────────────────────────
  _drawSpeechBubble(ctx, npc) {
    const text = npc.speechBubble;
    if (!text) return;
    ctx.save();
    ctx.font = '11px "Inter", sans-serif';
    const maxWidth = 180;
    const words = text.split(' ');
    const lines = [];
    let cur = words[0] || '';
    for (let i = 1; i < words.length; i++) {
      const test = cur + ' ' + words[i];
      if (ctx.measureText(test).width > maxWidth) { lines.push(cur); cur = words[i]; }
      else cur = test;
    }
    lines.push(cur);
    if (lines.length > 3) { lines.length = 3; lines[2] += '...'; }

    const lh = 15, pad = 8;
    const bubW = Math.min(maxWidth + pad * 2, Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2);
    const bubH = lines.length * lh + pad * 2;
    const bx = npc.px + TILE_SIZE / 2 - bubW / 2;
    const by = npc.py - bubH - 14;

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    this._roundRect(ctx, bx, by, bubW, bubH, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    this._roundRect(ctx, bx, by, bubW, bubH, 8);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.moveTo(npc.px + TILE_SIZE / 2 - 5, by + bubH);
    ctx.lineTo(npc.px + TILE_SIZE / 2, by + bubH + 8);
    ctx.lineTo(npc.px + TILE_SIZE / 2 + 5, by + bubH);
    ctx.fill();

    ctx.fillStyle = '#1a1a2e';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], bx + pad, by + pad + i * lh);
    }
    ctx.restore();
  }

  _drawLabel(ctx, text, x, y, color, bgColor, fontSize) {
    ctx.save();
    ctx.font = `bold ${fontSize}px "Press Start 2P", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(text).width + 10;
    const th = fontSize + 8;
    ctx.fillStyle = bgColor;
    this._roundRect(ctx, x - tw / 2, y - th, tw, th, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, x, y - 4);
    ctx.restore();
  }

  // ─── Day/Night ──────────────────────────────────────────────────
  _drawDayNightOverlay(ctx, gameTime) {
    if (!gameTime) return;
    const h = gameTime.hours + gameTime.minutes / 60;
    let alpha = 0;
    if (h < 5 || h > 21) alpha = 0.35;
    else if (h < 7) alpha = 0.35 * (7 - h) / 2;
    else if (h > 19) alpha = 0.35 * (h - 19) / 2;
    if (alpha > 0) {
      ctx.fillStyle = `rgba(10, 10, 40, ${alpha})`;
      ctx.fillRect(0, 0, this.viewW, this.viewH);
    }
  }

  // ─── Minimap ────────────────────────────────────────────────────
  _drawMinimap(world, player, npcs, worldEvents) {
    if (!this.minimapCtx) return;
    const mctx = this.minimapCtx;
    const mw = 200, mh = 150;
    const sx = mw / WORLD_COLS, sy = mh / WORLD_ROWS;

    mctx.fillStyle = '#1a1a2e';
    mctx.fillRect(0, 0, mw, mh);

    for (let y = 0; y < WORLD_ROWS; y += 2) {
      for (let x = 0; x < WORLD_COLS; x += 2) {
        const tile = world.getTile(x, y);
        let color = '#4a7a32';
        if (tile >= 3 && tile <= 5) color = '#c9b48c';
        else if (tile === 6) color = '#3a7bd5';
        else if (tile === 7) color = '#e8d5a3';
        else if (tile >= 10 && tile <= 12) color = '#8B7355';
        else if (tile >= 17 && tile <= 18) color = '#8B4513';
        else if (tile === 13 || tile === 14) color = '#2d6a2d';
        mctx.fillStyle = color;
        mctx.fillRect(x * sx, y * sy, sx * 2 + 1, sy * 2 + 1);
      }
    }

    // Building colors on minimap
    for (const b of world.buildings) {
      mctx.fillStyle = b.roofColor;
      mctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    }

    // Events on minimap
    if (worldEvents) {
      for (const ev of worldEvents) {
        if (ev.type === 'fire') {
          mctx.fillStyle = '#ff4400';
          mctx.fillRect(ev.x * sx - 2, ev.y * sy - 2, 5, 5);
        }
      }
    }

    for (const npc of npcs) {
      mctx.fillStyle = npc.colors.shirt;
      mctx.fillRect(npc.x * sx - 1, npc.y * sy - 1, 3, 3);
    }
    mctx.fillStyle = '#2ecc71';
    mctx.fillRect(player.x * sx - 2, player.y * sy - 2, 5, 5);

    mctx.strokeStyle = '#fff';
    mctx.lineWidth = 1;
    mctx.strokeRect(
      this.camX / TILE_SIZE * sx, this.camY / TILE_SIZE * sy,
      this.viewW / TILE_SIZE * sx, this.viewH / TILE_SIZE * sy
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _adj(hex, amount) {
    if (!hex || hex[0] !== '#') return hex;
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.max(0, Math.min(255, ((num >> 16) & 0xff) + amount));
    const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amount));
    const b = Math.max(0, Math.min(255, (num & 0xff) + amount));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }

  toggleMinimap() {
    this.showMinimap = !this.showMinimap;
    this.minimapCanvas?.classList.toggle('hidden', !this.showMinimap);
  }
}
