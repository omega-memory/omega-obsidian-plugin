import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import type OmegaPlugin from "../../main";
import { cosineSimilarity } from "../embeddings";

export const SEARCH_VIEW_TYPE = "omega-search";

export class SearchView extends ItemView {
  private plugin: OmegaPlugin;
  private searchCount = 0;
  private searchInput: HTMLInputElement | null = null;
  private resultsContainer: HTMLElement | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: OmegaPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return SEARCH_VIEW_TYPE; }
  getDisplayText(): string { return "OMEGA Search"; }
  getIcon(): string { return "search"; }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("omega-search-view");

    // Header
    const header = container.createDiv({ cls: "omega-search-header" });
    const titleEl = header.createEl("h4", { text: "Semantic Search" });
    titleEl.style.margin = "0 0 8px 0";
    titleEl.style.fontSize = "13px";
    titleEl.style.fontWeight = "600";
    titleEl.style.color = "var(--text-muted)";
    titleEl.style.textTransform = "uppercase";
    titleEl.style.letterSpacing = "0.05em";

    // Search input
    this.searchInput = header.createEl("input", {
      type: "text",
      placeholder: "Search by meaning...",
      cls: "omega-search-input",
    });
    this.searchInput.style.width = "100%";
    this.searchInput.style.padding = "8px 12px";
    this.searchInput.style.borderRadius = "6px";
    this.searchInput.style.border = "1px solid var(--background-modifier-border)";
    this.searchInput.style.background = "var(--background-primary)";
    this.searchInput.style.color = "var(--text-normal)";
    this.searchInput.style.fontSize = "14px";
    this.searchInput.style.marginBottom = "12px";

    this.searchInput.addEventListener("input", () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.doSearch(), 300);
    });

    // Status
    const status = container.createDiv({ cls: "omega-search-status" });
    const noteCount = this.plugin.db?.getNoteCount() || 0;
    status.style.fontSize = "11px";
    status.style.color = "var(--text-faint)";
    status.style.marginBottom = "8px";
    status.textContent = `${noteCount} notes indexed`;

    // Results
    this.resultsContainer = container.createDiv({ cls: "omega-search-results" });
  }

  private async doSearch(): Promise<void> {
    const query = this.searchInput?.value?.trim();
    if (!query || !this.resultsContainer || !this.plugin.embeddings?.isReady) return;

    this.searchCount++;

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

    // Render results
    this.resultsContainer.empty();

    if (topResults.length === 0) {
      this.resultsContainer.createDiv({
        text: "No results found.",
        cls: "omega-no-results",
      }).style.cssText = "color: var(--text-faint); font-size: 13px; padding: 16px 0; text-align: center;";
      return;
    }

    // Deduplicate by note path (show best chunk per note)
    const seenPaths = new Set<string>();
    const deduped = topResults.filter(r => {
      if (seenPaths.has(r.path)) return false;
      seenPaths.add(r.path);
      return true;
    });

    for (const result of deduped) {
      const item = this.resultsContainer.createDiv({ cls: "omega-result-item" });
      item.style.cssText = "padding: 8px 4px; border-bottom: 1px solid var(--background-modifier-border); cursor: pointer;";

      // Title row
      const titleRow = item.createDiv();
      titleRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;";

      const titleEl = titleRow.createEl("span", { text: result.title });
      titleEl.style.cssText = "font-size: 13px; font-weight: 500; color: var(--text-normal);";

      const scoreEl = titleRow.createEl("span", { text: `${(result.score * 100).toFixed(0)}%` });
      scoreEl.style.cssText = "font-size: 11px; color: var(--text-faint); font-family: var(--font-monospace);";

      // Preview
      const preview = item.createDiv({
        text: result.chunk_text.slice(0, 150).replace(/\[.*?\]\s*/, "") + (result.chunk_text.length > 150 ? "..." : ""),
      });
      preview.style.cssText = "font-size: 12px; color: var(--text-muted); line-height: 1.4;";

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

    // Nagware: every 10th search
    if (this.searchCount % 10 === 0 && !this.plugin.isPro) {
      const nag = this.resultsContainer.createDiv({ cls: "omega-nag" });
      nag.style.cssText = "margin-top: 16px; padding: 8px 12px; background: var(--background-secondary); border-radius: 6px; font-size: 11px; color: var(--text-muted); text-align: center;";
      nag.createSpan({ text: "Pro: Connect this search to your coding agent. " });
      const link = nag.createEl("a", { text: "Learn more", href: "https://omegamax.co/pro?ref=obsidian-search" });
      link.style.color = "var(--interactive-accent)";
    }
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.contentEl.empty();
  }
}
