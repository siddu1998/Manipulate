// ─── Input Manager ────────────────────────────────────────────────
export class Input {
  constructor() {
    this.keys = {};
    this.justPressed = {};
    this.mouse = { x: 0, y: 0, clicked: false, worldX: 0, worldY: 0 };
    this._bindings();
  }

  _bindings() {
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (!this.keys[e.key.toLowerCase()]) {
        this.justPressed[e.key.toLowerCase()] = true;
      }
      this.keys[e.key.toLowerCase()] = true;
    });
    window.addEventListener('keyup', e => {
      this.keys[e.key.toLowerCase()] = false;
    });
    window.addEventListener('mousemove', e => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    window.addEventListener('mousedown', e => {
      if (e.target.tagName === 'CANVAS') {
        this.mouse.clicked = true;
      }
    });
  }

  isDown(key) {
    return !!this.keys[key.toLowerCase()];
  }

  wasPressed(key) {
    return !!this.justPressed[key.toLowerCase()];
  }

  endFrame() {
    this.justPressed = {};
    this.mouse.clicked = false;
  }

  getMovement() {
    let dx = 0, dy = 0;
    if (this.isDown('w') || this.isDown('arrowup'))    dy = -1;
    if (this.isDown('s') || this.isDown('arrowdown'))  dy =  1;
    if (this.isDown('a') || this.isDown('arrowleft'))  dx = -1;
    if (this.isDown('d') || this.isDown('arrowright')) dx =  1;
    return { dx, dy };
  }

  updateWorldMouse(cameraX, cameraY) {
    this.mouse.worldX = this.mouse.x + cameraX;
    this.mouse.worldY = this.mouse.y + cameraY;
  }
}
