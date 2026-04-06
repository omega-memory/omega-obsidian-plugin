import { Plugin, TFile } from "obsidian";
import { OmegaDB } from "./src/db";
import { EmbeddingEngine } from "./src/embeddings";
import { VaultIndexer } from "./src/indexer";
import { SearchView, SEARCH_VIEW_TYPE } from "./src/views/SearchView";
import { RelatedView, RELATED_VIEW_TYPE } from "./src/views/RelatedView";
import { TimelineView, TIMELINE_VIEW_TYPE } from "./src/views/TimelineView";
import { OmegaSettingTab } from "./src/views/SettingsTab";

interface OmegaSettings {
  proLicenseKey: string;
  indexOnStartup: boolean;
  searchResultLimit: number;
  nagDismissedUntil: number; // timestamp
}

const DEFAULT_SETTINGS: OmegaSettings = {
  proLicenseKey: "",
  indexOnStartup: true,
  searchResultLimit: 20,
  nagDismissedUntil: 0,
};

export default class OmegaPlugin extends Plugin {
  settings: OmegaSettings = DEFAULT_SETTINGS;
  db: OmegaDB | null = null;
  embeddings: EmbeddingEngine | null = null;
  indexer: VaultIndexer | null = null;

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
    this.registerView(
      RELATED_VIEW_TYPE,
      (leaf) => new RelatedView(leaf, this)
    );
    this.registerView(
      TIMELINE_VIEW_TYPE,
      (leaf) => new TimelineView(leaf, this)
    );

    // Register commands
    this.addCommand({
      id: "open-semantic-search",
      name: "Semantic search",
      callback: () => this.activateView(SEARCH_VIEW_TYPE),
    });

    this.addCommand({
      id: "open-related-notes",
      name: "Related notes",
      callback: () => this.activateView(RELATED_VIEW_TYPE),
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

    // Ribbon icon
    this.addRibbonIcon("search", "OMEGA semantic search", () => {
      this.activateView(SEARCH_VIEW_TYPE);
    });

    // Settings tab
    this.addSettingTab(new OmegaSettingTab(this.app, this));

    // File watchers
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          this.indexer?.onFileCreate(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
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
    this.app.workspace.onLayoutReady(async () => {
      try {
        await this.db!.init();
        await this.embeddings!.init();

        if (this.settings.indexOnStartup) {
          await this.indexer!.indexAll();
        }
      } catch (e) {
        console.error("OMEGA: Initialization failed:", e);
      }
    });
  }

  async onunload(): Promise<void> {
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
      console.warn("OMEGA: Embedding engine not ready, cannot reindex");
      return;
    }
    await this.indexer?.indexAll();
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
}
