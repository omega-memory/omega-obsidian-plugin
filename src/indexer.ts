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

    this.onProgress?.({ total: files.length, indexed: 0, current: "Reading files...", status: "indexing" });

    // Phase 1: Read all files, compute hashes, identify changed files
    const toIndex: Array<{ file: TFile; content: string; hash: string; noteId: number; chunks: string[] }> = [];

    for (const file of files) {
      if (this.cancelled) break;
      try {
        const content = await this.app.vault.cachedRead(file);
        const hash = await this.computeHash(content);
        const existing = this.db.getNoteByPath(file.path);

        if (existing && existing.content_hash === hash) continue; // Skip unchanged

        const noteId = this.db.upsertNote(file.path, file.basename, hash, file.stat.mtime);
        this.db.deleteChunksForNote(noteId);
        const chunks = this.chunkContent(content, file.basename);
        if (chunks.length > 0) {
          toIndex.push({ file, content, hash, noteId, chunks });
        }
      } catch (e) {
        console.error(`OMEGA: Failed to read ${file.path}:`, e);
      }
    }

    if (toIndex.length === 0 || this.cancelled) {
      this.onProgress?.({ total: files.length, indexed: files.length, current: "", status: "ready" });
      return;
    }

    // Phase 2: Batch embed all chunks across all files in batches of 32
    const allChunks: string[] = [];
    const chunkMap: Array<{ noteId: number; startIdx: number; count: number }> = [];

    for (const item of toIndex) {
      chunkMap.push({ noteId: item.noteId, startIdx: allChunks.length, count: item.chunks.length });
      allChunks.push(...item.chunks);
    }

    this.onProgress?.({ total: files.length, indexed: files.length - toIndex.length, current: `Embedding ${allChunks.length} chunks...`, status: "indexing" });

    // Embed in batches of 32 to avoid iframe message size limits
    const batchSize = 32;
    const allVectors: Float32Array[] = [];
    for (let i = 0; i < allChunks.length; i += batchSize) {
      if (this.cancelled) break;
      const batch = allChunks.slice(i, i + batchSize);
      const vectors = await this.embeddings.embed(batch);
      allVectors.push(...vectors);

      this.onProgress?.({
        total: allChunks.length,
        indexed: Math.min(i + batchSize, allChunks.length),
        current: `Embedding ${Math.min(i + batchSize, allChunks.length)}/${allChunks.length} chunks...`,
        status: "indexing",
      });
    }

    // Phase 3: Store all chunks with their embeddings
    for (const mapping of chunkMap) {
      const chunks = allChunks.slice(mapping.startIdx, mapping.startIdx + mapping.count);
      const vectors = allVectors.slice(mapping.startIdx, mapping.startIdx + mapping.count);
      for (let i = 0; i < chunks.length; i++) {
        this.db.insertChunk(mapping.noteId, i, chunks[i], vectors[i]);
      }
    }

    this.onProgress?.({ total: files.length, indexed: files.length, current: "", status: "ready" });
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
