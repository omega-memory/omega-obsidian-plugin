import { App, Modal, Notice, Plugin, TFile, requestUrl } from "obsidian";
import { OmegaDB } from "./src/db";
import { EmbeddingEngine, cosineSimilarity } from "./src/embeddings";
import { VaultIndexer } from "./src/indexer";
import { SearchView, SEARCH_VIEW_TYPE } from "./src/views/SearchView";
import { TimelineView, TIMELINE_VIEW_TYPE } from "./src/views/TimelineView";
import { OmegaSettingTab } from "./src/views/SettingsTab";
import { OmegaBridge } from "./src/omega-bridge";

interface OmegaSettings {
  proLicenseKey: string;
  indexOnStartup: boolean;
  searchResultLimit: number;
  nagDismissedUntil: number;
  hasCompletedOnboarding: boolean;
}

const DEFAULT_SETTINGS: OmegaSettings = {
  proLicenseKey: "",
  indexOnStartup: true,
  searchResultLimit: 20,
  nagDismissedUntil: 0,
  hasCompletedOnboarding: false,
};

export default class OmegaPlugin extends Plugin {
  settings: OmegaSettings = DEFAULT_SETTINGS;
  db: OmegaDB | null = null;
  embeddings: EmbeddingEngine | null = null;
  indexer: VaultIndexer | null = null;
  omega: OmegaBridge | null = null;
  statusNotice: Notice | null = null;
  _proValidated = false;
  _proValidatedAt = 0;
  discoveryQuery: string | null = null;
  discoveryResults: Array<{ note_id: number; chunk_index: number; chunk_text: string; embedding: Float32Array; path: string; title: string; score: number }> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize database
    const pluginDir = `${this.app.vault.configDir}/plugins/omega-memory`;
    this.db = new OmegaDB(this.app, pluginDir);

    // Initialize embedding engine
    this.embeddings = new EmbeddingEngine();

    // Initialize indexer
    this.indexer = new VaultIndexer(this.app, this.db, this.embeddings);

    // Register views
    this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SearchView(leaf, this));
    this.registerView(TIMELINE_VIEW_TYPE, (leaf) => new TimelineView(leaf, this));

    // Register commands
    this.addCommand({
      id: "open-semantic-search",
      name: "Semantic search",
      callback: () => this.activateView(SEARCH_VIEW_TYPE),
    });

    this.addCommand({
      id: "open-timeline",
      name: "Memory timeline",
      callback: () => this.activateView(TIMELINE_VIEW_TYPE),
    });

    this.addCommand({
      id: "reindex-vault",
      name: "Re-index vault",
      callback: () => this.reindex(),
    });

    this.addCommand({
      id: "cancel-indexing",
      name: "Cancel indexing",
      callback: () => {
        this.indexer?.cancel();
        new Notice("OMEGA: Indexing cancelled.");
      },
    });

    this.addCommand({
      id: "find-contradictions",
      name: "Find contradictions in vault",
      callback: () => this.findContradictions(),
    });

    this.addCommand({
      id: "find-duplicates",
      name: "Find duplicate content across notes",
      callback: () => this.findDuplicates(),
    });

    // Ribbon icon
    this.addRibbonIcon("search", "OMEGA semantic search", () => {
      this.activateView(SEARCH_VIEW_TYPE);
    });

    // Settings tab
    this.addSettingTab(new OmegaSettingTab(this.app, this));

    // File watchers
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.embeddings?.isReady) {
          this.indexer?.onFileCreate(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.embeddings?.isReady) {
          this.indexer?.onFileModify(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.indexer?.onFileDelete(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          this.indexer?.onFileRename(file, oldPath);
        }
      })
    );

    // Initialize on layout ready
    this.app.workspace.onLayoutReady(() => this.initializePlugin());
  }

  private async initializePlugin(): Promise<void> {
    try {
      // Step 1: Database
      this.showStatus("OMEGA: Initializing database...");
      await this.db!.init();

      // Step 2: Embedding model (this downloads ~17MB on first run)
      this.showStatus("OMEGA: Loading AI model (first run downloads ~17MB)...");
      await this.embeddings!.init();

      // Step 2.5: Detect OMEGA engine
      this.omega = new OmegaBridge();
      await this.omega.detect();
      if (this.omega.isConnected) {
        new Notice(`OMEGA engine detected: ${this.omega.getStatusText()}`);
      }

      // Step 3: Index vault
      const fileCount = this.app.vault.getMarkdownFiles().length;
      this.showStatus(`OMEGA: Indexing ${fileCount} notes...`);
      if (this.settings.indexOnStartup) {
        await this.indexer!.indexAll();
        await this.db!.persist();
      }

      // Step 3.5: Sync vault knowledge to OMEGA (if HTTP mode, best-effort)
      if (this.omega?.mode === "http") {
        try {
          const syncNoteCount = this.db!.getNoteCount();
          await this.omega.storeVaultKnowledge(
            `Obsidian vault indexed: ${syncNoteCount} notes. Topics include: ${this._getVaultTopics()}.`,
            { note_count: syncNoteCount, vault_name: this.app.vault.getName() }
          );
        } catch (e) {
          console.warn("OMEGA: Vault sync to OMEGA skipped:", e);
        }
      }

      // Step 4: Ready
      const noteCount = this.db!.getNoteCount();
      this.hideStatus();
      new Notice(`OMEGA ready. ${noteCount} notes indexed with semantic search.`);

      // First-time onboarding: auto-open search sidebar with discovery results
      if (!this.settings.hasCompletedOnboarding) {
        this.settings.hasCompletedOnboarding = true;
        await this.saveSettings();
        new Notice("Welcome to OMEGA Memory! Semantic search is ready.\nPro unlocks agent bridge, multi-vault, and more at omegamax.co/pro", 10000);
        await this.triggerAutoDiscovery();
        await this.activateView(SEARCH_VIEW_TYPE);
      }
    } catch (e) {
      this.hideStatus();
      console.error("OMEGA: Initialization failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("internet") || msg.includes("Failed to load AI")) {
        new Notice(`OMEGA: ${msg}`, 15000);
      } else {
        new Notice("OMEGA: Failed to initialize. Please check your internet connection and restart Obsidian.", 10000);
      }
    }
  }

  private async triggerAutoDiscovery(): Promise<void> {
    const discoveryTerms = ["project", "idea", "plan", "goal", "decision", "important"];

    for (const term of discoveryTerms) {
      const chunks = this.db?.getAllChunks() || [];
      if (chunks.length === 0) break;

      const queryVec = await this.embeddings!.embedSingle(term);
      const scored = chunks.map(chunk => ({
        ...chunk,
        score: cosineSimilarity(queryVec, chunk.embedding),
      }));
      scored.sort((a, b) => b.score - a.score);

      if (scored.length > 0 && scored[0].score > 0.4) {
        // Found a good discovery term, set it as the initial search
        this.discoveryQuery = term;
        this.discoveryResults = scored.slice(0, 5);
        break;
      }
    }
  }

  private showStatus(message: string): void {
    console.log(message);
    // Show persistent notice (0 = stays until manually hidden)
    this.hideStatus();
    this.statusNotice = new Notice(message, 0);
  }

  private hideStatus(): void {
    if (this.statusNotice) {
      this.statusNotice.hide();
      this.statusNotice = null;
    }
  }

  async onunload(): Promise<void> {
    this.hideStatus();
    this.indexer?.cancel();
    await this.db?.close();
    this.embeddings?.dispose();
  }

  async activateView(viewType: string): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(viewType);

    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: viewType, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async reindex(): Promise<void> {
    if (!this.embeddings?.isReady) {
      new Notice("OMEGA: Embedding model still loading. Please wait.");
      return;
    }
    const fileCount = this.app.vault.getMarkdownFiles().length;
    new Notice(`OMEGA: Re-indexing ${fileCount} notes...`);
    await this.indexer?.indexAll();
    await this.db?.persist();
    const noteCount = this.db?.getNoteCount() || 0;
    new Notice(`OMEGA: Re-index complete. ${noteCount} notes ready.`);
  }

  private _getVaultTopics(): string {
    const files = this.app.vault.getMarkdownFiles();
    const titles = files.map(f => f.basename).slice(0, 20);
    return titles.join(", ");
  }

  async findContradictions(): Promise<void> {
    if (!this.embeddings?.isReady || !this.db) {
      new Notice("OMEGA: Not ready yet. Please wait for initialization.");
      return;
    }

    new Notice("OMEGA: Scanning vault for contradictions...");
    const chunks = this.db.getAllChunks();
    const contradictions: Array<{ a: typeof chunks[0]; b: typeof chunks[0]; score: number }> = [];

    // Compare chunks from different notes for high similarity (potential contradictions)
    for (let i = 0; i < chunks.length && i < 200; i++) {
      for (let j = i + 1; j < chunks.length && j < 200; j++) {
        if (chunks[i].path === chunks[j].path) continue; // Skip same-note chunks
        const sim = cosineSimilarity(chunks[i].embedding, chunks[j].embedding);
        if (sim > 0.85 && sim < 0.98) { // Similar but not identical
          contradictions.push({ a: chunks[i], b: chunks[j], score: sim });
        }
      }
    }

    if (contradictions.length === 0) {
      new Notice("OMEGA: No potential contradictions found.");
    } else {
      const modal = new ResultsModal(this.app, "Potential Contradictions", contradictions.map(c => ({
        title: `${c.a.title} vs ${c.b.title}`,
        detail: c.a.chunk_text.slice(0, 120),
        score: `${(c.score * 100).toFixed(0)}% similar`,
      })));
      modal.open();
      if (!this.isPro) {
        new Notice("Pro: Automatic contradiction monitoring across sessions. omegamax.co/pro", 8000);
      }
    }
  }

  async findDuplicates(): Promise<void> {
    if (!this.embeddings?.isReady || !this.db) {
      new Notice("OMEGA: Not ready yet. Please wait for initialization.");
      return;
    }

    new Notice("OMEGA: Scanning for duplicate content...");
    const chunks = this.db.getAllChunks();
    const duplicates: Array<{ a: typeof chunks[0]; b: typeof chunks[0]; score: number }> = [];

    for (let i = 0; i < chunks.length && i < 200; i++) {
      for (let j = i + 1; j < chunks.length && j < 200; j++) {
        if (chunks[i].path === chunks[j].path) continue;
        const sim = cosineSimilarity(chunks[i].embedding, chunks[j].embedding);
        if (sim > 0.95) { // Near-identical content
          duplicates.push({ a: chunks[i], b: chunks[j], score: sim });
        }
      }
    }

    if (duplicates.length === 0) {
      new Notice("OMEGA: No duplicates found. Your vault is clean.");
    } else {
      const modal = new ResultsModal(this.app, "Potential Duplicates", duplicates.map(d => ({
        title: `${d.a.title} vs ${d.b.title}`,
        detail: d.a.chunk_text.slice(0, 120),
        score: `${(d.score * 100).toFixed(0)}% similar`,
      })));
      modal.open();
      if (!this.isPro) {
        new Notice("Pro: Automatic deduplication and knowledge consolidation. omegamax.co/pro", 8000);
      }
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  get isPro(): boolean {
    return this.settings.proLicenseKey.startsWith("OMEGA-PRO-");
  }

  async validateProLicense(): Promise<boolean> {
    const key = this.settings.proLicenseKey;
    if (!key || !key.startsWith("OMEGA-PRO-")) {
      this._proValidated = false;
      return false;
    }

    // Use cached validation for 24 hours
    if (this._proValidated && this._proValidatedAt && Date.now() - this._proValidatedAt < 86400000) {
      return true;
    }

    // Validate against server
    try {
      const resp = await requestUrl({
        url: "https://admin.omegamax.co/api/pro/auth",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey: key }),
      });
      if (resp.json?.valid || resp.json?.active) {
        this._proValidated = true;
        this._proValidatedAt = Date.now();
        return true;
      }
    } catch {
      // Offline: trust format check as fallback
      if (key.startsWith("OMEGA-PRO-") && key.length > 15) {
        this._proValidated = true;
        this._proValidatedAt = Date.now();
        return true;
      }
    }

    this._proValidated = false;
    return false;
  }
}

class ResultsModal extends Modal {
  private title: string;
  private items: Array<{ title: string; detail: string; score: string }>;

  constructor(app: App, title: string, items: Array<{ title: string; detail: string; score: string }>) {
    super(app);
    this.title = title;
    this.items = items;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: `Found ${this.items.length} results.` }).style.cssText = "color: var(--text-muted); font-size: 13px;";

    for (const item of this.items) {
      const row = contentEl.createDiv();
      row.style.cssText = "padding: 8px 0; border-bottom: 1px solid var(--background-modifier-border);";

      const header = row.createDiv();
      header.style.cssText = "display: flex; justify-content: space-between; margin-bottom: 4px;";
      header.createEl("strong", { text: item.title }).style.cssText = "font-size: 13px;";
      header.createEl("span", { text: item.score }).style.cssText = "font-size: 11px; color: var(--text-faint); font-family: var(--font-monospace);";

      row.createDiv({ text: item.detail }).style.cssText = "font-size: 12px; color: var(--text-muted);";
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
