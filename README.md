# Pixel World — AI-Powered Living Simulation

A 2D pixel art world where AI-powered characters live, work, and interact. Inspired by Generative Agents research.

## Quick Start

1. **Serve the files** (ES modules require a web server):
   ```bash
   cd simulation
   python3 -m http.server 8080
   ```
   Then open http://localhost:8080

2. **Add API keys** — Click the Settings button and add at least one API key (OpenAI, Anthropic, Google Gemini, or xAI Grok).

3. **Describe your world** — Type a description like:
   > "A cozy medieval village with a tavern, blacksmith, church, and market square. A river flows through the east side and there's a dark forest to the north."

4. **Click Generate World** — The AI will design your world, create characters, and bring them to life!

## Controls

| Key | Action |
|-----|--------|
| `WASD` / Arrow Keys | Move your character |
| `E` | Talk to nearby NPC |
| `/` | Open command bar |
| `M` | Toggle minimap |
| `Esc` | Close panels |

## Command Bar

Press `/` to open the command bar and type natural language requests:
- "Add a fountain in the town square"
- "Create a new character named Luna who is a mysterious fortune teller"
- "Turn the area around me into a forest"
- "Make the baker say hello to everyone"
- "Add some decorative lamps along the main road"

## Supported LLM Providers

| Provider | Model | Notes |
|----------|-------|-------|
| OpenAI | GPT-4o-mini | Recommended, works from browser |
| Anthropic | Claude Sonnet | Uses `anthropic-dangerous-direct-browser-access` header |
| Google | Gemini 2.0 Flash | Works from browser |
| xAI | Grok 3 Mini | OpenAI-compatible API |

## Architecture

```
js/
├── app.js        — Main application & game loop
├── config.js     — Game constants & tile definitions
├── llm.js        — Multi-provider LLM abstraction
├── sprites.js    — Procedural pixel art generation
├── world.js      — World generation & pathfinding
├── entities.js   — Player & NPC (memory, AI behavior)
├── renderer.js   — Canvas rendering & camera
├── input.js      — Keyboard/mouse input
└── ui.js         — UI panel management
```

## How It Works

1. **World Generation**: Your description is sent to the LLM which designs buildings, areas, and characters as JSON. This is then procedurally rendered as a tile-based map.
2. **Character AI**: Each NPC has a personality, occupation, and memory system. Every ~30 seconds, the LLM decides what one NPC should do next.
3. **Conversations**: When you talk to an NPC, the LLM generates responses based on their personality and memories.
4. **World Commands**: Natural language commands are interpreted by the LLM and translated into world modifications.
