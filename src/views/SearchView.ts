import { ItemView, WorkspaceLeaf, TFile, Notice } from "obsidian";
import type OmegaPlugin from "../../main";
import { cosineSimilarity } from "../embeddings";
import initSqlJs from "sql.js";

export const SEARCH_VIEW_TYPE = "omega-search";

const SEARCH_SUGGESTIONS = [
  "what decisions did I make recently",
  "how does the architecture work",
  "what are the key priorities",
  "debugging tips and patterns",
  "competitor strengths and weaknesses",
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function timeAgoFromMs(mtime: number): string {
  const diff = Date.now() - mtime;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

interface SectionState {
  collapsed: boolean;
  headerEl: HTMLElement | null;
  contentEl: HTMLElement | null;
}

export class SearchView extends ItemView {
  private plugin: OmegaPlugin;
  private searchCount = 0;
  private searchInput: HTMLInputElement | null = null;
  private searchResultsContainer: HTMLElement | null = null;
  private searchStatusEl: HTMLElement | null = null;
  private resurfaceContentEl: HTMLElement | null = null;
  private agentMemoryContentEl: HTMLElement | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentFile: TFile | null = null;

  private sections: Record<string, SectionState> = {
    search: { collapsed: false, headerEl: null, contentEl: null },
    resurface: { collapsed: false, headerEl: null, contentEl: null },
    agentMemory: { collapsed: false, headerEl: null, contentEl: null },
  };

  constructor(leaf: WorkspaceLeaf, plugin: OmegaPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return SEARCH_VIEW_TYPE; }
  getDisplayText(): string { return "OMEGA"; }
  getIcon(): string { return "search"; }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("omega-search-view");
    container.style.cssText = "padding: 0; overflow-y: auto;";

    // Global header
    const globalHeader = container.createDiv({ cls: "omega-global-header" });
    globalHeader.style.cssText = "padding: 12px 12px 8px 12px; border-bottom: 1px solid var(--background-modifier-border);";

    const titleRow = globalHeader.createDiv();
    titleRow.style.cssText = "display: flex; align-items: center; gap: 6px;";

    const wordmark = titleRow.createEl("span");
    wordmark.style.cssText = "font-family: var(--font-monospace); font-size: 15px; letter-spacing: 0.05em; color: var(--text-normal);";
    wordmark.createSpan({ text: "Omega" });
    const maxSpan = wordmark.createSpan({ text: "Max" });
    maxSpan.style.fontWeight = "600";

    // Spacer to push badge/button to the right
    const spacer = titleRow.createDiv();
    spacer.style.cssText = "flex: 1;";

    if (this.plugin.isPro) {
      const proBadge = titleRow.createEl("span", { text: "Pro" });
      proBadge.style.cssText = "font-size: 10px; font-weight: 600; color: #d4a843; background: rgba(212, 168, 67, 0.15); padding: 1px 6px; border-radius: 10px; letter-spacing: 0.02em;";
    } else {
      const upgradeBtn = titleRow.createEl("a", { text: "Upgrade", href: "https://omegamax.co/pro?ref=obsidian-header" });
      upgradeBtn.style.cssText = "font-size: 11px; font-weight: 600; color: #000; background: #d4a843; padding: 2px 10px; border-radius: 10px; text-decoration: none; letter-spacing: 0.02em; cursor: pointer; transition: background 0.15s;";
      upgradeBtn.addEventListener("mouseenter", () => { upgradeBtn.style.background = "#FFB000"; });
      upgradeBtn.addEventListener("mouseleave", () => { upgradeBtn.style.background = "#d4a843"; });
    }

    // === SEARCH SECTION ===
    this.buildSearchSection(container);

    // === RESURFACE SECTION ===
    this.buildResurfaceSection(container);

    // === AGENT MEMORY SECTION ===
    this.buildAgentMemorySection(container);

    // Listen for active file changes to update resurface
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateResurface();
      })
    );

    // Check for auto-discovery results from first run
    if ((this.plugin as any).discoveryQuery && (this.plugin as any).discoveryResults) {
      const query = (this.plugin as any).discoveryQuery as string;
      const results = (this.plugin as any).discoveryResults as any[];
      if (this.searchInput && results.length > 0) {
        this.searchInput.value = query;
        this.renderSearchResults(results);
        // Clear after consuming
        (this.plugin as any).discoveryQuery = null;
        (this.plugin as any).discoveryResults = null;
      }
    }

    // Initial population
    this.updateResurface();
    this.loadAgentMemory();
  }

  // ──────────────────────────────────────────────
  // SEARCH SECTION
  // ──────────────────────────────────────────────

  private buildSearchSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "omega-section omega-search-section" });
    section.style.cssText = "border-bottom: 1px solid var(--background-modifier-border);";

    // Section header (clickable to collapse)
    const header = section.createDiv({ cls: "omega-section-header" });
    header.style.cssText = "display: flex; align-items: center; gap: 6px; padding: 10px 12px; cursor: pointer; user-select: none;";

    const chevron = header.createEl("span", { text: "\u25BC" });
    chevron.style.cssText = "font-size: 8px; color: var(--text-faint); transition: transform 0.15s;";
    chevron.addClass("omega-chevron");

    const icon = header.createEl("span", { text: "\uD83D\uDD0D" });
    icon.style.cssText = "font-size: 12px;";

    const label = header.createEl("span", { text: "Search" });
    label.style.cssText = "font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;";

    // Section content
    const content = section.createDiv({ cls: "omega-section-content" });
    content.style.cssText = "padding: 0 12px 12px 12px; max-height: 400px; overflow-y: auto;";

    this.sections.search.headerEl = header;
    this.sections.search.contentEl = content;

    header.addEventListener("click", () => this.toggleSection("search", chevron));

    // Search input
    this.searchInput = content.createEl("input", {
      type: "text",
      placeholder: "Search your vault by meaning...",
      cls: "omega-search-input",
    });
    this.searchInput.style.cssText = `
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--background-modifier-border);
      background: var(--background-primary);
      color: var(--text-normal);
      font-size: 14px;
      margin-bottom: 8px;
      outline: none;
      box-sizing: border-box;
    `;

    this.searchInput.addEventListener("input", () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.doSearch(), 300);
    });

    this.searchInput.addEventListener("focus", () => {
      this.searchInput!.style.borderColor = "var(--interactive-accent)";
      this.searchInput!.style.boxShadow = "0 0 0 2px var(--interactive-accent-hover)";
    });

    this.searchInput.addEventListener("blur", () => {
      this.searchInput!.style.borderColor = "var(--background-modifier-border)";
      this.searchInput!.style.boxShadow = "none";
    });

    // Status
    this.searchStatusEl = content.createDiv({ cls: "omega-search-status" });
    this.searchStatusEl.style.cssText = "font-size: 11px; color: var(--text-faint); margin-bottom: 12px;";
    this.updateSearchStatus();

    // Results container
    this.searchResultsContainer = content.createDiv({ cls: "omega-search-results" });

    // Show empty state with suggestions
    this.showSearchEmptyState();

    // Focus the input
    this.searchInput.focus();
  }

  private updateSearchStatus(): void {
    if (!this.searchStatusEl) return;
    const noteCount = this.plugin.db?.getNoteCount() || 0;
    const ready = this.plugin.embeddings?.isReady;
    if (!ready) {
      this.searchStatusEl.textContent = "Loading AI model...";
    } else if (noteCount === 0) {
      this.searchStatusEl.textContent = "Indexing your vault...";
    } else {
      this.searchStatusEl.textContent = `${noteCount} notes indexed`;
    }
  }

  private showSearchEmptyState(): void {
    if (!this.searchResultsContainer) return;
    this.searchResultsContainer.empty();

    const empty = this.searchResultsContainer.createDiv();
    empty.style.cssText = "padding: 8px 0;";

    const hint = empty.createDiv({ text: "Search by meaning, not just keywords." });
    hint.style.cssText = "font-size: 12px; color: var(--text-faint); margin-bottom: 16px;";

    const suggestLabel = empty.createDiv({ text: "Try searching for:" });
    suggestLabel.style.cssText = "font-size: 11px; color: var(--text-faint); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em;";

    for (const suggestion of SEARCH_SUGGESTIONS) {
      const btn = empty.createDiv({ text: suggestion });
      btn.style.cssText = `
        padding: 6px 10px;
        margin-bottom: 4px;
        border-radius: 6px;
        font-size: 12px;
        color: var(--text-muted);
        cursor: pointer;
        background: var(--background-secondary);
        transition: background 0.15s;
      `;
      btn.addEventListener("click", () => {
        if (this.searchInput) {
          this.searchInput.value = suggestion;
          this.doSearch();
        }
      });
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "var(--background-modifier-hover)";
        btn.style.color = "var(--text-normal)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "var(--background-secondary)";
        btn.style.color = "var(--text-muted)";
      });
    }
  }

  private async doSearch(): Promise<void> {
    const query = this.searchInput?.value?.trim();
    if (!this.searchResultsContainer) return;

    if (!query) {
      this.showSearchEmptyState();
      return;
    }

    if (!this.plugin.embeddings?.isReady) {
      this.searchResultsContainer.empty();
      this.searchResultsContainer.createDiv({ text: "AI model still loading. Please wait..." })
        .style.cssText = "color: var(--text-faint); font-size: 13px; padding: 16px 0; text-align: center;";
      return;
    }

    this.updateSearchStatus();
    this.searchCount++;

    // Show loading state
    this.searchResultsContainer.empty();
    const loadingEl = this.searchResultsContainer.createDiv({ text: "Searching..." });
    loadingEl.style.cssText = "color: var(--text-faint); font-size: 13px; padding: 16px 0; text-align: center;";

    // Embed query
    const queryVec = await this.plugin.embeddings.embedSingle(query);

    // Get all chunks and compute similarity
    const chunks = this.plugin.db?.getAllChunks() || [];
    const scored = chunks.map(chunk => ({
      ...chunk,
      score: cosineSimilarity(queryVec, chunk.embedding),
    }));

    // Sort by score, take top N
    scored.sort((a, b) => b.score - a.score);
    const limit = this.plugin.settings.searchResultLimit || 20;
    const topResults = scored.slice(0, limit);

    this.renderSearchResults(topResults);
  }

  private renderSearchResults(topResults: Array<{ note_id: number; chunk_index: number; chunk_text: string; embedding: Float32Array; path: string; title: string; score: number }>): void {
    if (!this.searchResultsContainer) return;
    this.searchResultsContainer.empty();

    if (topResults.length === 0) {
      this.searchResultsContainer.createDiv({ text: "No results found. Try a different query." })
        .style.cssText = "color: var(--text-faint); font-size: 13px; padding: 16px 0; text-align: center;";
      return;
    }

    // Deduplicate by note path (show best chunk per note)
    const seenPaths = new Set<string>();
    const deduped = topResults.filter(r => {
      if (seenPaths.has(r.path)) return false;
      seenPaths.add(r.path);
      return true;
    });

    // Only show results above a minimum relevance threshold
    const meaningful = deduped.filter(r => r.score > 0.3);
    const toShow = meaningful.length > 0 ? meaningful : deduped.slice(0, 3);

    for (const result of toShow) {
      const item = this.searchResultsContainer.createDiv({ cls: "omega-result-item" });
      item.style.cssText = "padding: 10px 8px; border-bottom: 1px solid var(--background-modifier-border); cursor: pointer; border-radius: 4px;";

      // Title row
      const titleRow = item.createDiv();
      titleRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;";

      const titleEl = titleRow.createEl("span", { text: result.title });
      titleEl.style.cssText = "font-size: 13px; font-weight: 600; color: var(--text-normal);";

      // Confidence label with color coding
      const scorePercent = Math.round(result.score * 100);
      const confidence = scorePercent >= 70 ? "High" : scorePercent >= 50 ? "Medium" : "Low";
      const confidenceColor = scorePercent >= 70 ? "#5ec9a0" : scorePercent >= 50 ? "var(--text-muted)" : "var(--text-faint)";
      const scoreEl = titleRow.createEl("span", { text: confidence });
      scoreEl.style.cssText = `font-size: 10px; font-weight: 600; color: ${confidenceColor}; font-family: var(--font-monospace); text-transform: uppercase; letter-spacing: 0.03em;`;

      // Preview: show the matched chunk content, cleaned up
      const cleanPreview = result.chunk_text
        .replace(/^\[.*?\]\s*/, "") // Remove [Title] prefix
        .replace(/^#+ /gm, "")     // Remove heading markers
        .replace(/\n+/g, " ")      // Flatten newlines
        .trim();
      const previewText = cleanPreview.length > 120
        ? cleanPreview.slice(0, 120) + "..."
        : cleanPreview;

      const preview = item.createDiv({ text: previewText });
      preview.style.cssText = "font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-top: 2px;";

      // Click to open
      item.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(result.path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });

      item.addEventListener("mouseenter", () => {
        item.style.background = "var(--background-modifier-hover)";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "transparent";
      });
    }

    // Result count
    if (deduped.length > toShow.length) {
      const more = this.searchResultsContainer.createDiv({
        text: `${deduped.length - toShow.length} more results below threshold`,
      });
      more.style.cssText = "font-size: 11px; color: var(--text-faint); text-align: center; padding: 8px 0;";
    }

    // Nagware: every 10th search
    if (this.searchCount % 10 === 0 && !this.plugin.isPro) {
      const nag = this.searchResultsContainer.createDiv({ cls: "omega-nag" });
      nag.style.cssText = "margin-top: 16px; padding: 10px 12px; background: var(--background-secondary); border-radius: 8px; font-size: 12px; color: var(--text-muted); text-align: center;";
      nag.createEl("strong", { text: "Pro: " }).style.color = "var(--interactive-accent)";
      nag.createSpan({ text: "Your coding agent can search this vault mid-session. No more re-explaining context. " });
      const link = nag.createEl("a", { text: "Learn more", href: "https://omegamax.co/pro?ref=obsidian-search" });
      link.style.color = "var(--interactive-accent)";
    }
  }

  // ──────────────────────────────────────────────
  // RESURFACE SECTION
  // ──────────────────────────────────────────────

  private buildResurfaceSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "omega-section omega-resurface-section" });
    section.style.cssText = "border-bottom: 1px solid var(--background-modifier-border);";

    // Section header
    const header = section.createDiv({ cls: "omega-section-header" });
    header.style.cssText = "display: flex; align-items: center; gap: 6px; padding: 10px 12px; cursor: pointer; user-select: none;";

    const chevron = header.createEl("span", { text: "\u25BC" });
    chevron.style.cssText = "font-size: 8px; color: var(--text-faint); transition: transform 0.15s;";
    chevron.addClass("omega-chevron");

    const icon = header.createEl("span", { text: "\u2728" });
    icon.style.cssText = "font-size: 12px;";

    const label = header.createEl("span", { text: "Rediscover" });
    label.style.cssText = "font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;";

    // Section content
    const content = section.createDiv({ cls: "omega-section-content" });
    content.style.cssText = "padding: 0 12px 12px 12px; max-height: 300px; overflow-y: auto;";

    this.sections.resurface.headerEl = header;
    this.sections.resurface.contentEl = content;
    this.resurfaceContentEl = content;

    header.addEventListener("click", () => this.toggleSection("resurface", chevron));
  }

  private async updateResurface(): Promise<void> {
    if (!this.resurfaceContentEl) return;
    if (this.sections.resurface.collapsed) return;

    const file = this.app.workspace.getActiveFile();

    // If no active file or same file, show placeholder
    if (!file) {
      this.resurfaceContentEl.empty();
      const msg = this.resurfaceContentEl.createDiv({ text: "Open a note to see related forgotten content" });
      msg.style.cssText = "font-size: 12px; color: var(--text-faint); padding: 8px 0; text-align: center;";
      return;
    }

    // Skip if same file (avoid redundant recomputation)
    if (file === this.currentFile) return;
    this.currentFile = file;

    if (!this.plugin.embeddings?.isReady) {
      this.resurfaceContentEl.empty();
      const msg = this.resurfaceContentEl.createDiv({ text: "Waiting for AI model..." });
      msg.style.cssText = "font-size: 12px; color: var(--text-faint); padding: 8px 0; text-align: center;";
      return;
    }

    this.resurfaceContentEl.empty();
    const loadingEl = this.resurfaceContentEl.createDiv({ text: "Finding forgotten notes..." });
    loadingEl.style.cssText = "font-size: 12px; color: var(--text-faint); padding: 8px 0; text-align: center;";

    // Get all chunks
    const allChunks = this.plugin.db?.getAllChunks() || [];
    const fileChunks = allChunks.filter(c => c.path === file.path);

    if (fileChunks.length === 0) {
      this.resurfaceContentEl.empty();
      const msg = this.resurfaceContentEl.createDiv({ text: "This note hasn't been indexed yet." });
      msg.style.cssText = "font-size: 12px; color: var(--text-faint); padding: 8px 0; text-align: center;";
      return;
    }

    // Average the file's chunk embeddings to get a file-level vector
    const dims = fileChunks[0].embedding.length;
    const avgVec = new Float32Array(dims);
    for (const chunk of fileChunks) {
      for (let i = 0; i < dims; i++) {
        avgVec[i] += chunk.embedding[i] / fileChunks.length;
      }
    }

    // Score all other files' chunks, keeping best per file
    const otherChunks = allChunks.filter(c => c.path !== file.path);
    const scored: Map<string, { path: string; title: string; score: number }> = new Map();

    for (const chunk of otherChunks) {
      const sim = cosineSimilarity(avgVec, chunk.embedding);
      const existing = scored.get(chunk.path);
      if (!existing || sim > existing.score) {
        scored.set(chunk.path, { path: chunk.path, title: chunk.title, score: sim });
      }
    }

    // Filter to files modified 30+ days ago
    const now = Date.now();
    const oldResults: Array<{ path: string; title: string; score: number; mtime: number }> = [];

    for (const result of scored.values()) {
      const vaultFile = this.app.vault.getAbstractFileByPath(result.path);
      if (vaultFile instanceof TFile) {
        const mtime = vaultFile.stat.mtime;
        if ((now - mtime) >= SEVEN_DAYS_MS) {
          oldResults.push({ ...result, mtime });
        }
      }
    }

    // Sort by semantic similarity, take top 5
    oldResults.sort((a, b) => b.score - a.score);
    const toShow = oldResults.slice(0, 5);

    this.resurfaceContentEl.empty();

    if (toShow.length === 0) {
      const msg = this.resurfaceContentEl.createDiv({ text: "No related notes you haven't opened recently." });
      msg.style.cssText = "font-size: 12px; color: var(--text-faint); padding: 8px 0; text-align: center;";
      return;
    }

    for (const result of toShow) {
      const item = this.resurfaceContentEl.createDiv({ cls: "omega-resurface-item" });
      item.style.cssText = "padding: 8px 6px; border-bottom: 1px solid var(--background-modifier-border); cursor: pointer; border-radius: 4px;";

      // Title row
      const titleRow = item.createDiv();
      titleRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;";

      const titleEl = titleRow.createEl("span", { text: result.title });
      titleEl.style.cssText = "font-size: 13px; font-weight: 500; color: var(--text-normal); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;";

      const agoEl = titleRow.createEl("span", { text: timeAgoFromMs(result.mtime) });
      agoEl.style.cssText = "font-size: 10px; color: var(--text-faint); font-family: var(--font-monospace); flex-shrink: 0; margin-left: 8px;";

      // One-line preview from the file
      const vaultFile = this.app.vault.getAbstractFileByPath(result.path);
      if (vaultFile instanceof TFile) {
        // Get preview from chunks
        const fileChunksForPreview = allChunks.filter(c => c.path === result.path);
        if (fileChunksForPreview.length > 0) {
          const previewText = fileChunksForPreview[0].chunk_text
            .replace(/^\[.*?\]\s*/, "")
            .replace(/^#+ /gm, "")
            .replace(/\n+/g, " ")
            .trim();
          const truncated = previewText.length > 80 ? previewText.slice(0, 80) + "..." : previewText;
          const previewEl = item.createDiv({ text: truncated });
          previewEl.style.cssText = "font-size: 11px; color: var(--text-faint); line-height: 1.4; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
        }
      }

      // Click to open
      item.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(result.path);
        if (f instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(f);
        }
      });

      item.addEventListener("mouseenter", () => {
        item.style.background = "var(--background-modifier-hover)";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "transparent";
      });
    }

  }

  // ──────────────────────────────────────────────
  // AGENT MEMORY SECTION
  // ──────────────────────────────────────────────

  private buildAgentMemorySection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "omega-section omega-agent-memory-section" });

    // Section header
    const header = section.createDiv({ cls: "omega-section-header" });
    header.style.cssText = "display: flex; align-items: center; gap: 6px; padding: 10px 12px; cursor: pointer; user-select: none;";

    const chevron = header.createEl("span", { text: "\u25BC" });
    chevron.style.cssText = "font-size: 8px; color: var(--text-faint); transition: transform 0.15s;";
    chevron.addClass("omega-chevron");

    const icon = header.createEl("span", { text: "\uD83E\uDDE0" });
    icon.style.cssText = "font-size: 12px;";

    const label = header.createEl("span", { text: "Agent Memory" });
    label.style.cssText = "font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;";

    // Section content
    const content = section.createDiv({ cls: "omega-section-content" });
    content.style.cssText = "padding: 0 12px 12px 12px; max-height: 300px; overflow-y: auto;";

    this.sections.agentMemory.headerEl = header;
    this.sections.agentMemory.contentEl = content;
    this.agentMemoryContentEl = content;

    header.addEventListener("click", () => this.toggleSection("agentMemory", chevron));
  }

  private async loadAgentMemory(): Promise<void> {
    if (!this.agentMemoryContentEl) return;
    this.agentMemoryContentEl.empty();

    // Use Node.js fs to check for ~/.omega/omega.db
    let omegaDbExists = false;
    let omegaDbPath = "";

    try {
      const nodeRequire = (window as any).require;
      const fs = nodeRequire("fs");
      const path = nodeRequire("path");
      const os = nodeRequire("os");
      omegaDbPath = path.join(os.homedir(), ".omega", "omega.db");
      omegaDbExists = fs.existsSync(omegaDbPath);
    } catch {
      // Not on desktop / Node.js not available, gracefully degrade
      omegaDbExists = false;
    }

    if (!omegaDbExists) {
      // Hide section entirely when OMEGA not installed
      this.agentMemoryContentEl.parentElement!.style.display = "none";
      return;
    }

    // Read the OMEGA SQLite database
    try {
      const nodeRequire = (window as any).require;
      const fs = nodeRequire("fs");
      const dbBuffer = fs.readFileSync(omegaDbPath);

      // Use the plugin's SQL.js WASM to open the external DB
      // We need to load sql.js independently for this read-only DB
      const pluginDir = `${this.app.vault.configDir}/plugins/omega-memory`;
      const wasmPath = `${pluginDir}/sql-wasm.wasm`;
      const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);

      const SQL = await initSqlJs({ wasmBinary });
      const omegaDb = new SQL.Database(new Uint8Array(dbBuffer.buffer));

      // Query recent memories
      let memories: Array<{ content: string; event_type: string; created_at: string; metadata: string }> = [];
      try {
        const result = omegaDb.exec(
          `SELECT content, event_type, created_at, metadata
           FROM memories
           ORDER BY created_at DESC
           LIMIT 5`
        );
        if (result.length > 0) {
          memories = result[0].values.map((row: unknown[]) => ({
            content: row[0] as string,
            event_type: row[1] as string,
            created_at: row[2] as string,
            metadata: row[3] as string,
          }));
        }
      } catch {
        // Table might not exist or different schema
        memories = [];
      }

      omegaDb.close();

      if (memories.length === 0) {
        const emptyMsg = this.agentMemoryContentEl.createDiv({ text: "Your agent hasn't stored any memories yet." });
        emptyMsg.style.cssText = "font-size: 12px; color: var(--text-faint); padding: 12px 0; text-align: center;";
      } else {
        for (const memory of memories) {
          const item = this.agentMemoryContentEl.createDiv({ cls: "omega-memory-item" });
          item.style.cssText = "padding: 8px 6px; border-bottom: 1px solid var(--background-modifier-border); cursor: pointer; border-radius: 4px;";

          // Top row: type badge + time
          const topRow = item.createDiv();
          topRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;";

          // Type badge
          const typeBadge = topRow.createEl("span", { text: this.formatMemoryType(memory.event_type) });
          const badgeColor = this.getMemoryBadgeColor(memory.event_type);
          typeBadge.style.cssText = `font-size: 10px; font-weight: 600; color: ${badgeColor}; background: var(--background-secondary); padding: 1px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.03em;`;

          // Relative time
          const timeEl = topRow.createEl("span", { text: timeAgo(memory.created_at) });
          timeEl.style.cssText = "font-size: 10px; color: var(--text-faint); font-family: var(--font-monospace);";

          // Content (truncated)
          const contentText = memory.content.length > 80
            ? memory.content.slice(0, 80) + "..."
            : memory.content;
          const contentEl = item.createDiv({ text: contentText });
          contentEl.style.cssText = "font-size: 12px; color: var(--text-muted); line-height: 1.4;";

          // Click to copy to clipboard
          item.addEventListener("click", () => {
            navigator.clipboard.writeText(memory.content).then(() => {
              new Notice("Memory copied to clipboard");
            });
          });

          item.addEventListener("mouseenter", () => {
            item.style.background = "var(--background-modifier-hover)";
          });
          item.addEventListener("mouseleave", () => {
            item.style.background = "transparent";
          });
        }
      }

      // Pro upsell
      const proUpsell = this.agentMemoryContentEl.createDiv();
      proUpsell.style.cssText = "margin-top: 12px; padding: 8px 10px; background: var(--background-secondary); border-radius: 6px; font-size: 11px; color: var(--text-faint); text-align: center;";
      proUpsell.createEl("strong", { text: "Pro: " }).style.color = "var(--interactive-accent)";
      proUpsell.createSpan({ text: "Let your agent search your vault during coding sessions. " });
      const proLink = proUpsell.createEl("a", { text: "Learn more", href: "https://omegamax.co/pro?ref=obsidian-agent-memory" });
      proLink.style.color = "var(--interactive-accent)";

    } catch (e) {
      console.error("OMEGA: Failed to read agent memory DB:", e);
      const errorMsg = this.agentMemoryContentEl.createDiv({ text: "Could not read agent memory database." });
      errorMsg.style.cssText = "font-size: 12px; color: var(--text-faint); padding: 12px 0; text-align: center;";
    }
  }

  private formatMemoryType(eventType: string): string {
    if (!eventType) return "memory";
    // Clean up common event types
    const typeMap: Record<string, string> = {
      "decision": "decision",
      "lesson": "lesson",
      "user_preference": "preference",
      "advisor_insight": "insight",
      "memory": "memory",
      "context": "context",
      "handoff": "handoff",
    };
    return typeMap[eventType] || eventType.replace(/_/g, " ");
  }

  private getMemoryBadgeColor(eventType: string): string {
    const colorMap: Record<string, string> = {
      "decision": "var(--interactive-accent)",
      "lesson": "var(--text-accent)",
      "user_preference": "var(--text-muted)",
      "advisor_insight": "var(--interactive-accent)",
    };
    return colorMap[eventType] || "var(--text-faint)";
  }

  // ──────────────────────────────────────────────
  // SECTION COLLAPSE/EXPAND
  // ──────────────────────────────────────────────

  private toggleSection(sectionKey: string, chevronEl: HTMLElement): void {
    const section = this.sections[sectionKey];
    if (!section || !section.contentEl) return;

    section.collapsed = !section.collapsed;

    if (section.collapsed) {
      section.contentEl.style.display = "none";
      chevronEl.style.transform = "rotate(-90deg)";
    } else {
      section.contentEl.style.display = "";
      chevronEl.style.transform = "rotate(0deg)";

      // Refresh content when expanding
      if (sectionKey === "resurface") {
        this.currentFile = null; // Force refresh
        this.updateResurface();
      } else if (sectionKey === "agentMemory") {
        this.loadAgentMemory();
      }
    }
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.contentEl.empty();
  }
}
