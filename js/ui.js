// ─── UI Management (new split-layout) ─────────────────────────────

export class UI {
  constructor() {
    this.els = {
      settingsModal:  document.getElementById('settings-modal'),
      setupScreen:    document.getElementById('setup-screen'),
      gameScreen:     document.getElementById('game-screen'),
      loadingOverlay: document.getElementById('loading-overlay'),
      loadingText:    document.getElementById('loading-text'),
      worldDesc:      document.getElementById('world-description'),
      setupStatus:    document.getElementById('setup-status'),
      generateBtn:    document.getElementById('generate-btn'),
      worldName:      document.getElementById('world-name'),
      npcInfo:        document.getElementById('npc-info'),
      chatMessages:   document.getElementById('chat-messages'),
      chatInput:      document.getElementById('chat-input'),
      chatNpcName:    document.querySelector('.chat-npc-name'),
      commandInput:   document.getElementById('command-input'),
      interactionHint:document.getElementById('interaction-hint'),
      notifications:  document.getElementById('notifications'),
      gameTime:       document.getElementById('game-time'),
      openaiKey:      document.getElementById('openai-key'),
      anthropicKey:   document.getElementById('anthropic-key'),
      geminiKey:      document.getElementById('gemini-key'),
      grokKey:        document.getElementById('grok-key'),
      primaryProvider: document.getElementById('primary-provider'),
    };
    this.chatOpen = false;
    this.commandBarOpen = false;
  }

  // ─── Settings ───────────────────────────────────────────────────
  openSettings() { this.els.settingsModal.classList.remove('hidden'); }
  closeSettings() { this.els.settingsModal.classList.add('hidden'); }

  loadKeysIntoUI(llm) {
    this.els.openaiKey.value = llm.keys.openai || '';
    this.els.anthropicKey.value = llm.keys.anthropic || '';
    this.els.geminiKey.value = llm.keys.gemini || '';
    this.els.grokKey.value = llm.keys.grok || '';
    this.els.primaryProvider.value = llm.provider || 'openai';
  }

  getKeysFromUI() {
    return {
      keys: {
        openai: this.els.openaiKey.value.trim(),
        anthropic: this.els.anthropicKey.value.trim(),
        gemini: this.els.geminiKey.value.trim(),
        grok: this.els.grokKey.value.trim(),
      },
      provider: this.els.primaryProvider.value,
    };
  }

  // ─── Screens ────────────────────────────────────────────────────
  showSetup() { this.els.setupScreen.classList.remove('hidden'); this.els.gameScreen.classList.add('hidden'); }
  showGame() { this.els.setupScreen.classList.add('hidden'); this.els.gameScreen.classList.remove('hidden'); }
  showLoading(text) { this.els.loadingOverlay.classList.remove('hidden'); this.els.loadingText.textContent = text || 'Loading...'; }
  hideLoading() { this.els.loadingOverlay.classList.add('hidden'); }
  setLoadingText(text) { this.els.loadingText.textContent = text; }
  setWorldName(name) { this.els.worldName.textContent = name; }

  setStatus(text, isError = false) {
    this.els.setupStatus.classList.remove('hidden');
    this.els.setupStatus.textContent = text;
    this.els.setupStatus.style.color = isError ? 'var(--red)' : 'var(--green)';
  }

  // ─── NPC Info ───────────────────────────────────────────────────
  showNpcInfo(npc) {
    this.els.npcInfo.classList.remove('hidden');
    this.els.npcInfo.querySelector('.npc-name').textContent = npc.name;
    const occEl = this.els.npcInfo.querySelector('.npc-occupation');
    occEl.textContent = npc.state === 'following' ? `${npc.occupation} (Following)` : npc.occupation;
    this.els.npcInfo.querySelector('.npc-activity').textContent = npc.currentActivity;
  }
  hideNpcInfo() { this.els.npcInfo.classList.add('hidden'); }

  // ─── Chat (lives in sidebar tab) ───────────────────────────────
  openChat(npc) {
    this.chatOpen = true;
    // Switch to chat tab
    document.querySelectorAll('#sidebar-tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#sidebar .tab-content').forEach(t => t.classList.remove('active'));
    document.querySelector('[data-tab="tab-chat"]')?.classList.add('active');
    document.getElementById('tab-chat')?.classList.add('active');

    this.els.chatNpcName.textContent = npc.name;
    this.els.chatMessages.innerHTML = '';
    this.els.chatInput.value = '';
    this.els.chatInput.focus();
    this.addChatMessage(npc.name, npc.currentActivity, 'npc');
  }

  closeChat() {
    this.chatOpen = false;
  }

  addChatMessage(sender, text, type = 'npc') {
    // Remove empty state
    const empty = this.els.chatMessages.querySelector('.empty-state');
    if (empty) empty.remove();

    const msg = document.createElement('div');
    msg.className = `chat-message ${type}`;
    msg.innerHTML = `<span class="sender">${sender}:</span> ${text}`;
    this.els.chatMessages.appendChild(msg);
    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
  }

  getChatInput() {
    const val = this.els.chatInput.value.trim();
    this.els.chatInput.value = '';
    return val;
  }

  setChatLoading(loading) {
    this.els.chatInput.disabled = loading;
    this.els.chatInput.placeholder = loading ? 'Thinking...' : 'Say something...';
  }

  // ─── Command Bar (always visible, no open/close) ───────────────
  openCommandBar() { this.els.commandInput.focus(); }
  closeCommandBar() { this.els.commandInput.blur(); }
  isCommandBarOpen() { return document.activeElement === this.els.commandInput; }

  getCommandInput() {
    const val = this.els.commandInput.value.trim();
    this.els.commandInput.value = '';
    return val;
  }

  // ─── Interaction Hint ───────────────────────────────────────────
  showInteractionHint() { this.els.interactionHint.classList.remove('hidden'); }
  hideInteractionHint() { this.els.interactionHint.classList.add('hidden'); }

  // ─── Notifications ──────────────────────────────────────────────
  notify(text, type = 'info', duration = 3000) {
    const n = document.createElement('div');
    n.className = `notification ${type}`;
    n.textContent = text;
    this.els.notifications.appendChild(n);
    requestAnimationFrame(() => n.classList.add('show'));
    setTimeout(() => { n.classList.remove('show'); setTimeout(() => n.remove(), 200); }, duration);
  }

  // ─── Game Time ──────────────────────────────────────────────────
  updateGameTime(hours, minutes, day) {
    const el = this.els.gameTime;
    if (!el) return;
    const h12 = hours % 12 || 12;
    const m = String(minutes).padStart(2, '0');
    const period = hours >= 12 ? 'PM' : 'AM';
    el.textContent = `Day ${day} \u2022 ${h12}:${m} ${period}`;
  }

  // ─── Checks ─────────────────────────────────────────────────────
  isChatOpen() { return this.chatOpen; }
  isModalOpen() { return !this.els.settingsModal.classList.contains('hidden'); }
  isAnyInputFocused() {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }
}
