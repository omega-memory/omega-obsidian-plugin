/**
 * Bridge to OMEGA's engine. Three modes:
 * 1. HTTP mode: OMEGA daemon running at 127.0.0.1:8377 (full engine access)
 * 2. SQLite mode: Read ~/.omega/omega.db directly (read-only, agent memories)
 * 3. Offline: Neither available (plugin operates standalone)
 */

import { requestUrl } from "obsidian";

const OMEGA_HTTP_URL = "http://127.0.0.1:8377";
const HEALTH_TIMEOUT = 2000;
const QUERY_TIMEOUT = 10000;

export type OmegaMode = "http" | "sqlite" | "offline";

export interface OmegaMemory {
  content: string;
  event_type: string;
  created_at: string;
  project: string | null;
  priority: number;
  access_count: number;
  status: string;
}

export interface ContradictionResult {
  content_a: string;
  content_b: string;
  similarity: number;
  note_a: string;
  note_b: string;
}

export interface DuplicateResult {
  content: string;
  note_a: string;
  note_b: string;
  similarity: number;
}

export class OmegaBridge {
  private _mode: OmegaMode = "offline";
  private _memoryCount = 0;
  private _lastHealthCheck = 0;

  get mode(): OmegaMode { return this._mode; }
  get memoryCount(): number { return this._memoryCount; }
  get isConnected(): boolean { return this._mode !== "offline"; }

  /**
   * Detect OMEGA and determine best mode.
   * Try HTTP first (full engine), fall back to SQLite (read-only), then offline.
   */
  async detect(): Promise<OmegaMode> {
    // Always try SQLite first for memory count (most reliable)
    let sqliteCount = 0;
    try {
      const nodeRequire = (window as any).require;
      const fs = nodeRequire("fs");
      const path = nodeRequire("path");
      const os = nodeRequire("os");
      const dbPath = path.join(os.homedir(), ".omega", "omega.db");
      if (fs.existsSync(dbPath)) {
        sqliteCount = await this._getMemoryCountSQLite(dbPath);
      }
    } catch { /* ignore */ }

    // Try HTTP daemon for full engine access
    try {
      const resp = await this._fetch(`${OMEGA_HTTP_URL}/health`, HEALTH_TIMEOUT);
      if (resp && resp.status === "ok") {
        this._mode = "http";
        this._memoryCount = sqliteCount;
        console.log(`OMEGA Bridge: Connected via HTTP (${this._memoryCount} memories)`);
        return this._mode;
      }
    } catch {
      // HTTP not available
    }

    // Try SQLite direct read
    try {
      const nodeRequire = (window as any).require;
      const fs = nodeRequire("fs");
      const path = nodeRequire("path");
      const os = nodeRequire("os");
      const dbPath = path.join(os.homedir(), ".omega", "omega.db");

      if (fs.existsSync(dbPath)) {
        this._mode = "sqlite";
        this._memoryCount = await this._getMemoryCountSQLite(dbPath);
        console.log(`OMEGA Bridge: Connected via SQLite (${this._memoryCount} memories)`);
        return this._mode;
      }
    } catch {
      // SQLite not available
    }

    this._mode = "offline";
    console.log("OMEGA Bridge: Offline (OMEGA not detected)");
    return this._mode;
  }

  /**
   * Search using OMEGA's full engine (HTTP mode only).
   * Falls back to null if not in HTTP mode.
   */
  async search(query: string, limit: number = 10): Promise<string | null> {
    if (this._mode !== "http") return null;

    try {
      const result = await this._callTool("omega_query", {
        query,
        limit,
        mode: "semantic",
      });
      return result;
    } catch (e) {
      console.warn("OMEGA Bridge: search failed:", e);
      return null;
    }
  }

  /**
   * Store a vault summary to OMEGA so coding agents can access vault knowledge.
   */
  async storeVaultKnowledge(content: string, metadata: Record<string, unknown> = {}): Promise<boolean> {
    if (this._mode !== "http") return false;

    try {
      await this._callTool("omega_store", {
        content,
        event_type: "memory",
        metadata: { ...metadata, source: "obsidian-vault", plugin: "omega-memory" },
      });
      return true;
    } catch (e) {
      // MCP StreamableHTTP requires session handshake; store via HTTP not yet supported
      console.debug("OMEGA Bridge: vault sync skipped (MCP protocol upgrade needed)");
      return false;
    }
  }

  /**
   * Detect contradictions in provided content pairs using OMEGA's engine.
   */
  async detectContradictions(contents: Array<{ text: string; source: string }>): Promise<ContradictionResult[]> {
    if (this._mode !== "http") return [];

    try {
      // Use omega_reflect with contradictions action
      const result = await this._callTool("omega_reflect", {
        action: "contradictions",
      });
      // Parse result and return structured data
      if (typeof result === "string" && result.includes("contradiction")) {
        return this._parseContradictions(result);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Get recent agent memories (works in both HTTP and SQLite modes).
   */
  async getRecentMemories(limit: number = 10): Promise<OmegaMemory[]> {
    if (this._mode === "http") {
      return this._getMemoriesHTTP(limit);
    } else if (this._mode === "sqlite") {
      return this._getMemoriesSQLite(limit);
    }
    return [];
  }

  /**
   * Get memories by type (decision, lesson, etc.)
   */
  async getMemoriesByType(eventType: string, limit: number = 10): Promise<OmegaMemory[]> {
    if (this._mode === "http") {
      try {
        const result = await this._callTool("omega_query", {
          query: eventType,
          event_type: eventType,
          limit,
          mode: "semantic",
        });
        return this._parseMemoriesFromResult(result);
      } catch { return []; }
    } else if (this._mode === "sqlite") {
      return this._getMemoriesByTypeSQLite(eventType, limit);
    }
    return [];
  }

  /**
   * Find duplicate content across vault notes using OMEGA's similarity detection.
   */
  async findDuplicates(chunks: Array<{ text: string; source: string }>, threshold: number = 0.88): Promise<DuplicateResult[]> {
    // This runs locally using the plugin's own embeddings, not OMEGA
    // OMEGA's dedup threshold is 0.88
    return []; // Implemented in SearchView using plugin's own cosine similarity
  }

  /**
   * Get OMEGA status summary for display in the sidebar.
   */
  getStatusText(): string {
    switch (this._mode) {
      case "http":
        return `Connected to OMEGA (${this._memoryCount} memories)`;
      case "sqlite":
        return `OMEGA detected (${this._memoryCount} memories, read-only)`;
      case "offline":
        return "OMEGA not detected";
    }
  }

  getStatusColor(): string {
    switch (this._mode) {
      case "http": return "var(--interactive-accent)";
      case "sqlite": return "var(--text-muted)";
      case "offline": return "var(--text-faint)";
    }
  }

  // ---- Private methods ----

  private async _fetch(url: string, _timeout: number): Promise<any> {
    // Use Obsidian's requestUrl which bypasses CORS restrictions
    try {
      const resp = await requestUrl({ url, method: "GET" });
      return resp.json;
    } catch {
      return null;
    }
  }

  private async _callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // MCP over HTTP using Obsidian's CORS-free requestUrl
    const resp = await requestUrl({
      url: `${OMEGA_HTTP_URL}/mcp`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: toolName === "omega_query" || toolName === "omega_store" || toolName === "omega_reflect"
            ? "omega_call"
            : toolName,
          arguments: toolName === "omega_query" || toolName === "omega_store" || toolName === "omega_reflect"
            ? { tool: toolName, args }
            : args,
        },
        id: Date.now(),
      }),
    });

    const data = resp.json;
    if (data.result?.content?.[0]?.text) {
      return data.result.content[0].text;
    }
    if (data.error) {
      throw new Error(data.error.message || "MCP call failed");
    }
    return "";
  }

  private async _getMemoryCountHTTP(): Promise<number> {
    try {
      const result = await this._callTool("omega_stats", {});
      const match = (result || "").match(/memories[:\s]*(\d+)/i);
      return match ? parseInt(match[1]) : 0;
    } catch { return 0; }
  }

  private async _getMemoryCountSQLite(dbPath: string): Promise<number> {
    try {
      const initSqlJs = (await import("sql.js")).default;
      const nodeRequire = (window as any).require;
      const fs = nodeRequire("fs");
      const wasmPath = `${(window as any).app?.vault?.configDir || ".obsidian"}/plugins/omega-memory/sql-wasm.wasm`;
      const wasmBinary = fs.readFileSync(
        nodeRequire("path").join(
          (window as any).app?.vault?.adapter?.getBasePath?.() || ".",
          wasmPath
        )
      );
      const SQL = await initSqlJs({ wasmBinary: wasmBinary.buffer });
      const dbBuffer = fs.readFileSync(dbPath);
      const db = new SQL.Database(new Uint8Array(dbBuffer));
      const result = db.exec("SELECT COUNT(*) FROM memories");
      const count = result[0]?.values[0]?.[0] as number || 0;
      db.close();
      return count;
    } catch { return 0; }
  }

  private async _getMemoriesHTTP(limit: number): Promise<OmegaMemory[]> {
    try {
      const result = await this._callTool("omega_query", {
        query: "recent memories",
        limit,
        mode: "browse",
      });
      return this._parseMemoriesFromResult(result);
    } catch { return []; }
  }

  private async _getMemoriesSQLite(limit: number): Promise<OmegaMemory[]> {
    try {
      const nodeRequire = (window as any).require;
      const fs = nodeRequire("fs");
      const path = nodeRequire("path");
      const os = nodeRequire("os");
      const dbPath = path.join(os.homedir(), ".omega", "omega.db");
      if (!fs.existsSync(dbPath)) return [];

      const initSqlJs = (await import("sql.js")).default;
      const wasmPath = path.join(
        (window as any).app?.vault?.adapter?.getBasePath?.() || ".",
        (window as any).app?.vault?.configDir || ".obsidian",
        "plugins/omega-memory/sql-wasm.wasm"
      );
      const wasmBinary = fs.readFileSync(wasmPath);
      const SQL = await initSqlJs({ wasmBinary: wasmBinary.buffer });
      const dbBuffer = fs.readFileSync(dbPath);
      const db = new SQL.Database(new Uint8Array(dbBuffer));

      const result = db.exec(
        `SELECT content, event_type, created_at, project, priority, access_count, status
         FROM memories
         WHERE status != 'superseded'
         ORDER BY created_at DESC
         LIMIT ?`,
        [limit]
      );

      db.close();

      if (!result.length) return [];
      return result[0].values.map((row: unknown[]) => ({
        content: row[0] as string,
        event_type: row[1] as string || "memory",
        created_at: row[2] as string,
        project: row[3] as string | null,
        priority: row[4] as number || 3,
        access_count: row[5] as number || 0,
        status: row[6] as string || "active",
      }));
    } catch (e) {
      console.warn("OMEGA Bridge: SQLite read failed:", e);
      return [];
    }
  }

  private async _getMemoriesByTypeSQLite(eventType: string, limit: number): Promise<OmegaMemory[]> {
    try {
      const nodeRequire = (window as any).require;
      const fs = nodeRequire("fs");
      const path = nodeRequire("path");
      const os = nodeRequire("os");
      const dbPath = path.join(os.homedir(), ".omega", "omega.db");
      if (!fs.existsSync(dbPath)) return [];

      const initSqlJs = (await import("sql.js")).default;
      const wasmPath = path.join(
        (window as any).app?.vault?.adapter?.getBasePath?.() || ".",
        (window as any).app?.vault?.configDir || ".obsidian",
        "plugins/omega-memory/sql-wasm.wasm"
      );
      const wasmBinary = fs.readFileSync(wasmPath);
      const SQL = await initSqlJs({ wasmBinary: wasmBinary.buffer });
      const dbBuffer = fs.readFileSync(dbPath);
      const db = new SQL.Database(new Uint8Array(dbBuffer));

      const result = db.exec(
        `SELECT content, event_type, created_at, project, priority, access_count, status
         FROM memories WHERE event_type = ? AND status != 'superseded'
         ORDER BY created_at DESC LIMIT ?`,
        [eventType, limit]
      );

      db.close();

      if (!result.length) return [];
      return result[0].values.map((row: unknown[]) => ({
        content: row[0] as string,
        event_type: row[1] as string || "memory",
        created_at: row[2] as string,
        project: row[3] as string | null,
        priority: row[4] as number || 3,
        access_count: row[5] as number || 0,
        status: row[6] as string || "active",
      }));
    } catch { return []; }
  }

  private _parseMemoriesFromResult(result: string): OmegaMemory[] {
    // Parse markdown-formatted OMEGA query results into structured data
    const memories: OmegaMemory[] = [];
    const blocks = result.split(/\n---\n|\n\n## /);
    for (const block of blocks) {
      const content = block.trim();
      if (!content || content.length < 10) continue;
      const typeMatch = content.match(/\[(\w+)\]/);
      const dateMatch = content.match(/\d{4}-\d{2}-\d{2}/);
      memories.push({
        content: content.slice(0, 300),
        event_type: typeMatch?.[1] || "memory",
        created_at: dateMatch?.[0] || "",
        project: null,
        priority: 3,
        access_count: 0,
        status: "active",
      });
    }
    return memories;
  }

  private _parseContradictions(result: string): ContradictionResult[] {
    // Parse contradiction results from omega_reflect
    const contradictions: ContradictionResult[] = [];
    const blocks = result.split(/\n---\n/);
    for (const block of blocks) {
      if (!block.includes("contradict")) continue;
      contradictions.push({
        content_a: block.slice(0, 150),
        content_b: "",
        similarity: 0.9,
        note_a: "OMEGA memory",
        note_b: "OMEGA memory",
      });
    }
    return contradictions;
  }
}
