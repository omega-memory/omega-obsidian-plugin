import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import type OmegaPlugin from "../../main";
import { cosineSimilarity } from "../embeddings";

export const RELATED_VIEW_TYPE = "omega-related";

export class RelatedView extends ItemView {
  private plugin: OmegaPlugin;
  private currentFile: TFile | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: OmegaPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return RELATED_VIEW_TYPE; }
  getDisplayText(): string { return "Related Notes"; }
  getIcon(): string { return "git-branch"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("omega-related-view");

    // Listen for active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateRelated();
      })
    );

    // Initial render
    this.updateRelated();
  }

  private async updateRelated(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file === this.currentFile || !this.plugin.embeddings?.isReady) return;
    this.currentFile = file;

    this.contentEl.empty();

    const header = this.contentEl.createDiv();
    header.style.cssText = "padding: 8px 0; margin-bottom: 8px;";
    const title = header.createEl("h4", { text: "Notes like this" });
    title.style.cssText = "margin: 0; font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;";

    const subtitle = header.createDiv({ text: file.basename });
    subtitle.style.cssText = "font-size: 12px; color: var(--text-faint); margin-top: 2px;";

    // Get this file's chunks
    const allChunks = this.plugin.db?.getAllChunks() || [];
    const fileChunks = allChunks.filter(c => c.path === file.path);

    if (fileChunks.length === 0) {
      this.contentEl.createDiv({ text: "This note hasn't been indexed yet." })
        .style.cssText = "font-size: 13px; color: var(--text-faint); padding: 16px 0; text-align: center;";
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

    // Score all other files' chunks
    const otherChunks = allChunks.filter(c => c.path !== file.path);
    const scored: Map<string, { path: string; title: string; score: number }> = new Map();

    for (const chunk of otherChunks) {
      const sim = cosineSimilarity(avgVec, chunk.embedding);
      const existing = scored.get(chunk.path);
      if (!existing || sim > existing.score) {
        scored.set(chunk.path, { path: chunk.path, title: chunk.title, score: sim });
      }
    }

    // Sort by score
    const results = Array.from(scored.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    if (results.length === 0) {
      this.contentEl.createDiv({ text: "No related notes found." })
        .style.cssText = "font-size: 13px; color: var(--text-faint); padding: 16px 0; text-align: center;";
      return;
    }

    for (const result of results) {
      const item = this.contentEl.createDiv();
      item.style.cssText = "padding: 6px 4px; border-bottom: 1px solid var(--background-modifier-border); cursor: pointer; display: flex; justify-content: space-between; align-items: center;";

      const nameEl = item.createEl("span", { text: result.title });
      nameEl.style.cssText = "font-size: 13px; color: var(--text-normal);";

      const scoreEl = item.createEl("span", { text: `${(result.score * 100).toFixed(0)}%` });
      scoreEl.style.cssText = "font-size: 11px; color: var(--text-faint); font-family: var(--font-monospace);";

      item.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(result.path);
        if (f instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(f);
        }
      });
      item.addEventListener("mouseenter", () => { item.style.background = "var(--background-modifier-hover)"; });
      item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
    }
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
