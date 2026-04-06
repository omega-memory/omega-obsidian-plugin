import { App, TFile } from "obsidian";
import { OmegaDB } from "./db";
import { EmbeddingEngine } from "./embeddings";

export interface IndexProgress {
  total: number;
  indexed: number;
  current: string;
  status: "idle" | "indexing" | "ready" | "error";
}

export class VaultIndexer {
  private app: App;
  private db: OmegaDB;
  private embeddings: EmbeddingEngine;
  private cancelled = false;

  onProgress: ((progress: IndexProgress) => void) | null = null;

  constructor(app: App, db: OmegaDB, embeddings: EmbeddingEngine) {
    this.app = app;
    this.db = db;
    this.embeddings = embeddings;
  }

  // Full vault index (first run or reindex)
  async indexAll(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    this.cancelled = false;

    this.onProgress?.({
      total: files.length,
      indexed: 0,
      current: "",
      status: "indexing",
    });

    let indexed = 0;
    for (const file of files) {
      if (this.cancelled) break;

      try {
        await this.indexFile(file);
      } catch (e) {
        console.error(`OMEGA: Failed to index ${file.path}:`, e);
      }

      indexed++;
      this.onProgress?.({
        total: files.length,
        indexed,
        current: file.basename,
        status: "indexing",
      });
    }

    this.onProgress?.({
      total: files.length,
      indexed,
      current: "",
      status: this.cancelled ? "idle" : "ready",
    });
  }

  // Index a single file (checks hash to skip unchanged)
  async indexFile(file: TFile): Promise<boolean> {
    if (!this.embeddings.isReady) return false;

    const content = await this.app.vault.cachedRead(file);
    const hash = await this.computeHash(content);

    // Check if already indexed with same hash
    const existing = this.db.getNoteByPath(file.path);
    if (existing && existing.content_hash === hash) {
      return false; // No change
    }

    // Upsert note
    const noteId = this.db.upsertNote(
      file.path,
      file.basename,
      hash,
      file.stat.mtime
    );

    // Delete old chunks
    this.db.deleteChunksForNote(noteId);

    // Split into chunks
    const chunks = this.chunkContent(content, file.basename);
    if (chunks.length === 0) return true;

    // Embed all chunks
    const vectors = await this.embeddings.embed(chunks);

    // Store chunks with embeddings
    for (let i = 0; i < chunks.length; i++) {
      this.db.insertChunk(noteId, i, chunks[i], vectors[i]);
    }

    return true;
  }

  // Handle file events
  async onFileCreate(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    await this.indexFile(file);
  }

  async onFileModify(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    await this.indexFile(file);
  }

  onFileDelete(path: string): void {
    this.db.deleteNote(path);
  }

  async onFileRename(file: TFile, oldPath: string): Promise<void> {
    if (file.extension !== "md") return;
    this.db.deleteNote(oldPath);
    await this.indexFile(file);
  }

  cancel(): void {
    this.cancelled = true;
  }

  // Split content into meaningful chunks
  private chunkContent(content: string, title: string): string[] {
    // Remove frontmatter
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
    const body = fmMatch ? content.slice(fmMatch[0].length) : content;

    if (!body.trim()) return [];

    const chunks: string[] = [];

    // Split by headings or double newlines
    const sections = body.split(/\n(?=#{1,6}\s)|(?:\n\s*\n)/);

    let currentChunk = "";
    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed) continue;

      if ((currentChunk + "\n\n" + trimmed).length > 800) {
        if (currentChunk) {
          chunks.push(`[${title}] ${currentChunk.trim()}`);
        }
        currentChunk = trimmed;
      } else {
        currentChunk = currentChunk ? `${currentChunk}\n\n${trimmed}` : trimmed;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(`[${title}] ${currentChunk.trim()}`);
    }

    return chunks;
  }

  private async computeHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}
