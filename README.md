# OMEGA Memory

Semantic search, knowledge rediscovery, and agent memory for your Obsidian vault. Find notes by meaning, not just keywords.

## Features

### Semantic Search
Search your vault by meaning. "What storage approach did we decide on" finds your note about "database choice" even though the words don't match. Powered by a local AI embedding model (bge-micro-v2, runs entirely on your machine).

### Rediscover
Surfaces notes you haven't opened recently that are related to what you're working on now. Turns your vault from a graveyard into a living knowledge system.

### Agent Memory
If you use [OMEGA](https://omegamax.co) with Claude Code, Cursor, or Windsurf, see your coding agent's accumulated memories inside Obsidian. Decisions, lessons, and context from your coding sessions, all in one place.

### Contradiction Detection
Scan your vault for notes that contain conflicting information. Results appear in a modal with similarity scores.

### Duplicate Detection
Find near-identical content scattered across different notes. Keep your vault clean.

## How It Works

OMEGA Memory indexes your vault using a local AI embedding model. The model runs inside your browser via WebAssembly, so your notes never leave your machine. On first install, the model (~17MB) downloads once and is cached for future use.

- **Read-only**: The plugin never modifies your vault files
- **Local-first**: All processing happens on your device
- **No API keys**: Works without any external accounts or configuration
- **Zero config**: Install, enable, search

## Installation

### From Community Plugins (recommended)
1. Open Obsidian Settings
2. Go to Community Plugins, click Browse
3. Search for "OMEGA Memory"
4. Click Install, then Enable

### Manual
1. Download `main.js`, `manifest.json`, and `sql-wasm.wasm` from the [latest release](https://github.com/omega-memory/omega-obsidian-plugin/releases)
2. Create a folder `.obsidian/plugins/omega-memory/` in your vault
3. Copy the three files into that folder
4. Enable the plugin in Obsidian Settings > Community Plugins

## Usage

- Click the search icon in the left ribbon, or use **Cmd/Ctrl+P** > "OMEGA: Semantic search"
- Type a question or concept in the search box
- Click any result to open the note
- The Rediscover section updates as you navigate between notes
- Use **Cmd/Ctrl+P** > "OMEGA: Find contradictions" to scan for conflicting content
- Use **Cmd/Ctrl+P** > "OMEGA: Find duplicates" to find overlapping content

## OMEGA Integration

OMEGA Memory works standalone with no dependencies. If you also use [OMEGA](https://omegamax.co) (`pip install omega-memory`) for AI agent memory, the plugin automatically detects it and shows your agent's memories in the sidebar.

[OMEGA Pro](https://omegamax.co/pro) ($19/mo) unlocks:
- **Agent Bridge**: Your coding agent can search your Obsidian vault during sessions
- **Multi-vault**: Index and search across multiple vaults
- **Cloud sync**: Sync your index across machines

## Network Usage

This plugin downloads an AI embedding model (~17MB) from HuggingFace Hub on first use. The model is cached locally after download. No other network requests are made. Your notes are never sent to any external server.

## Performance

- First install: ~15-30 seconds (model download + initial indexing)
- Subsequent launches: ~2-5 seconds (model load from cache)
- Search latency: <200ms per query
- Indexing: ~32 notes per second (batched embedding)
- Bundle size: 89KB (plus ~1MB sql-wasm.wasm)

## Commands

| Command | Description |
|---------|-------------|
| Semantic search | Open the search sidebar |
| Memory timeline | Chronological view of recent vault activity |
| Re-index vault | Force re-index all notes |
| Find contradictions | Scan vault for conflicting content |
| Find duplicates | Find near-identical content across notes |

## License

[Apache-2.0](LICENSE)

Copyright 2025-2026 Kokyo Keisho Zaidan Stichting
