import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import type OmegaPlugin from "../../main";

export const TIMELINE_VIEW_TYPE = "omega-timeline";

export class TimelineView extends ItemView {
  private plugin: OmegaPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: OmegaPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return TIMELINE_VIEW_TYPE; }
  getDisplayText(): string { return "Memory Timeline"; }
  getIcon(): string { return "clock"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("omega-timeline-view");

    const header = this.contentEl.createEl("h4", { text: "Memory Timeline" });
    header.style.cssText = "margin: 0 0 12px 0; font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;";

    // Get all markdown files sorted by mtime desc
    const files = this.app.vault.getMarkdownFiles()
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 100);

    // Group by day
    const groups: Map<string, TFile[]> = new Map();
    for (const file of files) {
      const day = new Date(file.stat.mtime).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(file);
    }

    for (const [day, dayFiles] of groups) {
      const dayHeader = this.contentEl.createDiv({ text: day });
      dayHeader.style.cssText = "font-size: 11px; font-weight: 600; color: var(--text-faint); padding: 8px 0 4px 0; border-bottom: 1px solid var(--background-modifier-border); text-transform: uppercase; letter-spacing: 0.03em;";

      for (const file of dayFiles) {
        const item = this.contentEl.createDiv();
        item.style.cssText = "padding: 4px 8px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;";

        const nameEl = item.createEl("span", { text: file.basename });
        nameEl.style.cssText = "font-size: 13px; color: var(--text-normal); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

        const timeEl = item.createEl("span", {
          text: new Date(file.stat.mtime).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        });
        timeEl.style.cssText = "font-size: 11px; color: var(--text-faint); font-family: var(--font-monospace); flex-shrink: 0; margin-left: 8px;";

        item.addEventListener("click", () => {
          this.app.workspace.getLeaf(false).openFile(file);
        });
        item.addEventListener("mouseenter", () => { item.style.background = "var(--background-modifier-hover)"; });
        item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
      }
    }

    // Note count
    const noteCount = this.plugin.db?.getNoteCount() || 0;
    if (noteCount > 0) {
      const footer = this.contentEl.createDiv();
      footer.style.cssText = "margin-top: 16px; padding: 8px 0; font-size: 11px; color: var(--text-faint); text-align: center;";
      footer.textContent = `${noteCount} notes in OMEGA index`;
    }
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
