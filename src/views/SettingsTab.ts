import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type OmegaPlugin from "../../main";

export class OmegaSettingTab extends PluginSettingTab {
  plugin: OmegaPlugin;

  constructor(app: App, plugin: OmegaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Header
    containerEl.createEl("h2", { text: "OMEGA Memory" });

    // Index status
    const noteCount = this.plugin.db?.getNoteCount() || 0;
    new Setting(containerEl)
      .setName("Index status")
      .setDesc(`${noteCount} notes indexed`)
      .addButton(btn => btn
        .setButtonText("Re-index vault")
        .onClick(async () => {
          btn.setButtonText("Indexing...");
          btn.setDisabled(true);
          await this.plugin.reindex();
          btn.setButtonText("Re-index vault");
          btn.setDisabled(false);
          new Notice(`OMEGA: Indexed ${this.plugin.db?.getNoteCount() || 0} notes`);
          this.display(); // Refresh
        })
      );

    // Index on startup
    new Setting(containerEl)
      .setName("Index on startup")
      .setDesc("Automatically index new and changed notes when Obsidian starts.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.indexOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.indexOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    // Search result limit
    new Setting(containerEl)
      .setName("Search results")
      .setDesc("Maximum number of results to show in semantic search.")
      .addSlider(slider => slider
        .setLimits(5, 50, 5)
        .setValue(this.plugin.settings.searchResultLimit)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.searchResultLimit = value;
          await this.plugin.saveSettings();
        })
      );

    // Pro section
    containerEl.createEl("h3", { text: "OMEGA Pro" });

    if (this.plugin.isPro) {
      new Setting(containerEl)
        .setName("License")
        .setDesc("Pro license active")
        .addText(text => text
          .setValue(this.plugin.settings.proLicenseKey)
          .setDisabled(true)
        );

      // Show active Pro features
      const activeSection = containerEl.createDiv();
      activeSection.style.cssText = "margin-top: 8px;";

      const activeTitle = activeSection.createEl("p", { text: "Active Pro features:" });
      activeTitle.style.cssText = "font-size: 12px; color: var(--text-muted); margin-bottom: 8px;";

      const activeFeatures = [
        "Enhanced search (OMEGA's full retrieval pipeline when daemon running)",
        "Agent Bridge (your coding agent can search your vault)",
        "Multi-vault support (via OMEGA entity management)",
        "Cloud sync (via your own Supabase instance)",
        "Priority support",
      ];
      const list = activeSection.createEl("ul");
      list.style.cssText = "margin: 0; padding-left: 20px; font-size: 12px; color: var(--text-normal);";
      for (const f of activeFeatures) {
        list.createEl("li", { text: f }).style.marginBottom = "4px";
      }

      // Manage subscription link
      new Setting(activeSection)
        .setName("Manage subscription")
        .addButton(btn => btn
          .setButtonText("Open dashboard")
          .onClick(() => {
            window.open("https://omegamax.co/pro/dashboard?ref=obsidian-settings");
          })
        );
    } else {
      // Pro upsell
      const proDesc = containerEl.createDiv();
      proDesc.style.cssText = "margin-bottom: 16px; padding: 12px 16px; background: var(--background-secondary); border-radius: 8px; border: 1px solid var(--background-modifier-border);";

      const proTitle = proDesc.createEl("strong", { text: "Unlock the full platform" });
      proTitle.style.cssText = "display: block; margin-bottom: 6px; color: var(--text-normal);";

      const features = proDesc.createEl("ul");
      features.style.cssText = "margin: 0 0 8px 0; padding-left: 20px; font-size: 13px; color: var(--text-muted);";
      features.createEl("li", { text: "Agent Bridge: search your vault from Claude Code and Cursor" });
      features.createEl("li", { text: "Multi-vault support with isolated namespaces" });
      features.createEl("li", { text: "Cloud sync via your own Supabase" });
      features.createEl("li", { text: "PDF and image indexing" });

      const proLink = proDesc.createEl("a", {
        text: "$19/mo at omegamax.co/pro",
        href: "https://omegamax.co/pro?ref=obsidian-settings",
      });
      proLink.style.cssText = "font-size: 13px; color: var(--interactive-accent);";

      // License key input
      new Setting(containerEl)
        .setName("Pro license key")
        .setDesc("Enter your OMEGA Pro license key to unlock Pro features.")
        .addText(text => text
          .setPlaceholder("OMEGA-PRO-...")
          .setValue(this.plugin.settings.proLicenseKey)
          .onChange(async (value) => {
            this.plugin.settings.proLicenseKey = value.trim();
            await this.plugin.saveSettings();
            if (value.trim().startsWith("OMEGA-PRO-")) {
              new Notice("OMEGA: Validating license...");
              const valid = await this.plugin.validateProLicense();
              if (valid) {
                new Notice("OMEGA Pro activated! Enhanced search and agent bridge unlocked.");
                this.display(); // Refresh to show Pro UI
              } else {
                new Notice("OMEGA: Invalid or expired license key. Check your key at omegamax.co/pro/dashboard");
              }
            }
          })
        );
    }

    // Locked Pro features
    if (!this.plugin.isPro) {
      const lockedSection = containerEl.createDiv();
      lockedSection.style.cssText = "margin-top: 8px; opacity: 0.5;";

      new Setting(lockedSection)
        .setName("Agent Bridge")
        .setDesc("Connect vault search to Claude Code and Cursor. Requires Pro.")
        .addToggle(toggle => toggle.setValue(false).setDisabled(true));

      new Setting(lockedSection)
        .setName("Multi-vault")
        .setDesc("Index and search across multiple vaults. Requires Pro.")
        .addToggle(toggle => toggle.setValue(false).setDisabled(true));

      new Setting(lockedSection)
        .setName("Cloud sync")
        .setDesc("Sync index to your Supabase instance. Requires Pro.")
        .addToggle(toggle => toggle.setValue(false).setDisabled(true));
    }

    // About
    containerEl.createEl("h3", { text: "About" });
    const about = containerEl.createDiv();
    about.style.cssText = "font-size: 12px; color: var(--text-faint); line-height: 1.6;";
    about.createSpan({ text: "OMEGA Memory v0.1.0 " });
    about.createEl("br");
    about.createSpan({ text: "Local-first semantic memory for your vault. " });
    about.createEl("br");
    about.createSpan({ text: "Apache-2.0 License. " });
    const siteLink = about.createEl("a", { text: "omegamax.co", href: "https://omegamax.co" });
    siteLink.style.color = "var(--interactive-accent)";
  }
}
