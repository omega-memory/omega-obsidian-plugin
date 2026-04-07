import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { App, normalizePath, requestUrl } from "obsidian";

const DB_FILENAME = "omega-index.db";
const SQL_WASM_CDN = "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.wasm";

export class OmegaDB {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private app: App;
  private pluginDir: string;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, pluginDir: string) {
    this.app = app;
    this.pluginDir = pluginDir;
  }

  async init(): Promise<void> {
    // Load sql-wasm.wasm: try local first, download from CDN if missing
    const wasmPath = normalizePath(`${this.pluginDir}/sql-wasm.wasm`);
    let wasmBinary: ArrayBuffer;

    try {
      wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);
    } catch {
      // Not found locally, download from CDN and cache
      console.log("OMEGA: Downloading sql-wasm.wasm from CDN...");
      const resp = await requestUrl({ url: SQL_WASM_CDN });
      wasmBinary = resp.arrayBuffer;
      // Save to plugin dir for next time
      await this.app.vault.adapter.writeBinary(wasmPath, wasmBinary);
      console.log("OMEGA: sql-wasm.wasm cached locally.");
    }

    this.SQL = await initSqlJs({
      wasmBinary: wasmBinary,
    });

    // Try to load existing DB
    const dbPath = normalizePath(`${this.pluginDir}/${DB_FILENAME}`);
    try {
      const existing = await this.app.vault.adapter.readBinary(dbPath);
      this.db = new this.SQL.Database(new Uint8Array(existing));
    } catch {
      // No existing DB, create fresh
      this.db = new this.SQL.Database();
    }

    this.createSchema();
  }

  private createSchema(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        title TEXT,
        content_hash TEXT,
        indexed_at TEXT,
        mtime INTEGER
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        chunk_index INTEGER,
        chunk_text TEXT,
        embedding BLOB
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks(note_id);

      CREATE TABLE IF NOT EXISTS contradictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_a_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        note_b_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        chunk_a_text TEXT,
        chunk_b_text TEXT,
        similarity REAL,
        detected_at TEXT
      );
    `);
  }

  // Note operations
  upsertNote(path: string, title: string, contentHash: string, mtime: number): number {
    if (!this.db) throw new Error("DB not initialized");

    this.db.run(
      `INSERT INTO notes (path, title, content_hash, indexed_at, mtime)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT(path) DO UPDATE SET
         title = excluded.title,
         content_hash = excluded.content_hash,
         indexed_at = excluded.indexed_at,
         mtime = excluded.mtime`,
      [path, title, contentHash, mtime]
    );

    const result = this.db.exec("SELECT last_insert_rowid()");
    // If update happened, get the existing id
    const idResult = this.db.exec(`SELECT id FROM notes WHERE path = ?`, [path]);
    this.markDirty();
    return idResult[0]?.values[0]?.[0] as number;
  }

  getNoteByPath(path: string): { id: number; content_hash: string; mtime: number } | null {
    if (!this.db) return null;
    const result = this.db.exec("SELECT id, content_hash, mtime FROM notes WHERE path = ?", [path]);
    if (!result.length || !result[0].values.length) return null;
    const row = result[0].values[0];
    return { id: row[0] as number, content_hash: row[1] as string, mtime: row[2] as number };
  }

  deleteNote(path: string): void {
    if (!this.db) return;
    this.db.run("DELETE FROM notes WHERE path = ?", [path]);
    this.markDirty();
  }

  getNoteCount(): number {
    if (!this.db) return 0;
    const result = this.db.exec("SELECT COUNT(*) FROM notes");
    return result[0]?.values[0]?.[0] as number || 0;
  }

  // Chunk operations
  deleteChunksForNote(noteId: number): void {
    if (!this.db) return;
    this.db.run("DELETE FROM chunks WHERE note_id = ?", [noteId]);
  }

  insertChunk(noteId: number, chunkIndex: number, chunkText: string, embedding: Float32Array): void {
    if (!this.db) return;
    this.db.run(
      "INSERT INTO chunks (note_id, chunk_index, chunk_text, embedding) VALUES (?, ?, ?, ?)",
      [noteId, chunkIndex, chunkText, new Uint8Array(embedding.buffer)]
    );
    this.markDirty();
  }

  getAllChunks(): Array<{ note_id: number; chunk_index: number; chunk_text: string; embedding: Float32Array; path: string; title: string }> {
    if (!this.db) return [];
    const result = this.db.exec(`
      SELECT c.note_id, c.chunk_index, c.chunk_text, c.embedding, n.path, n.title
      FROM chunks c JOIN notes n ON c.note_id = n.id
    `);
    if (!result.length) return [];

    return result[0].values.map((row: unknown[]) => ({
      note_id: row[0] as number,
      chunk_index: row[1] as number,
      chunk_text: row[2] as string,
      embedding: new Float32Array((row[3] as Uint8Array).buffer),
      path: row[4] as string,
      title: row[5] as string,
    }));
  }

  // Contradiction operations
  insertContradiction(noteAId: number, noteBId: number, chunkAText: string, chunkBText: string, similarity: number): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO contradictions (note_a_id, note_b_id, chunk_a_text, chunk_b_text, similarity, detected_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [noteAId, noteBId, chunkAText, chunkBText, similarity]
    );
    this.markDirty();
  }

  getContradictions(): Array<{ chunk_a_text: string; chunk_b_text: string; similarity: number; path_a: string; path_b: string; detected_at: string }> {
    if (!this.db) return [];
    const result = this.db.exec(`
      SELECT c.chunk_a_text, c.chunk_b_text, c.similarity, na.path, nb.path, c.detected_at
      FROM contradictions c
      JOIN notes na ON c.note_a_id = na.id
      JOIN notes nb ON c.note_b_id = nb.id
      ORDER BY c.detected_at DESC
      LIMIT 100
    `);
    if (!result.length) return [];
    return result[0].values.map((row: unknown[]) => ({
      chunk_a_text: row[0] as string,
      chunk_b_text: row[1] as string,
      similarity: row[2] as number,
      path_a: row[3] as string,
      path_b: row[4] as string,
      detected_at: row[5] as string,
    }));
  }

  clearContradictions(): void {
    if (!this.db) return;
    this.db.run("DELETE FROM contradictions");
    this.markDirty();
  }

  // Persistence
  private markDirty(): void {
    this.dirty = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), 5000); // Debounce 5s
  }

  async persist(): Promise<void> {
    if (!this.db || !this.dirty) return;
    const data = this.db.export();
    const dbPath = normalizePath(`${this.pluginDir}/${DB_FILENAME}`);
    await this.app.vault.adapter.writeBinary(dbPath, data.buffer as ArrayBuffer);
    this.dirty = false;
  }

  async close(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
    this.db?.close();
    this.db = null;
  }
}
