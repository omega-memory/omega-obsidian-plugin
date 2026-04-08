/**
 * OMEGA Vault Export — Export memories as Obsidian-native markdown.
 *
 * Reads from ~/.omega/omega.db (SQLite) and writes a structured vault
 * with YAML frontmatter, [[wikilinks]], entity profiles, and MOC indexes.
 *
 * Works in SQLite mode only (no daemon required).
 */

import { Notice } from "obsidian";

/** Raw memory row from omega.db */
interface MemoryRow {
  node_id: string;
  content: string;
  metadata: string | null;
  created_at: string;
  last_accessed: string | null;
  access_count: number;
  event_type: string | null;
  project: string | null;
  entity_id: string | null;
  status: string | null;
  priority: number;
  ttl_seconds: number | null;
}

/** Edge (relationship) between memories */
interface EdgeRow {
  source_id: string;
  target_id: string;
  edge_type: string;
  weight: number;
}

/** Parsed metadata from JSON column */
interface ParsedMetadata {
  tags?: string[] | string;
  event_type?: string;
  entity_id?: string;
  project?: string;
  project_path?: string;
  session_id?: string;
  agent_type?: string;
  category?: string;
  [key: string]: unknown;
}

/** Export result stats */
export interface ExportResult {
  memoriesExported: number;
  entitiesCreated: number;
  projectsCreated: number;
  mocsCreated: number;
  edgeLinksCreated: number;
  outputDir: string;
  exportedAt: string;
}

/** Map event_type to subdirectory name */
const TYPE_TO_DIR: Record<string, string> = {
  decision: "decisions",
  lesson_learned: "lessons",
  error_pattern: "errors",
  user_preference: "preferences",
  task_completion: "tasks",
  checkpoint: "checkpoints",
  session_summary: "sessions",
  advisor_insight: "insights",
  fact: "facts",
  memory: "memories",
};
const DEFAULT_DIR = "memories";

/** Characters not allowed in filenames */
const UNSAFE_RE = /[<>:"/\\|?*\x00-\x1f]/g;

function sanitizeFilename(name: string): string {
  let s = name.replace(UNSAFE_RE, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (s.length > 180) s = s.slice(0, 180);
  return s;
}

/** Extract a readable title from memory content */
function extractTitle(content: string, nodeId: string): string {
  // Use first line if it looks like a title (short, no markdown headers needed)
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.length > 0 && firstLine.length <= 120) {
    // Strip markdown formatting
    const cleaned = firstLine.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/\[|\]/g, "");
    if (cleaned.length > 0) return cleaned;
  }
  // Fall back to node_id
  return nodeId;
}

/** Compute strength from access_count (0-1 range) */
function computeStrength(accessCount: number): number {
  if (accessCount <= 0) return 0;
  return Math.min(1.0, accessCount / 20.0);
}

/** Format ISO date to Obsidian-friendly format */
function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  // Already ISO format, just ensure it's clean
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toISOString();
  } catch {
    return dateStr;
  }
}

/** Parse the JSON metadata column safely */
function parseMetadata(raw: string | null): ParsedMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Generate a single memory note as markdown */
function memoryToMarkdown(
  row: MemoryRow,
  meta: ParsedMetadata,
  edges: EdgeRow[],
  entityNames: Map<string, string>,
  projectNames: Set<string>,
): string {
  const lines: string[] = [];
  const eventType = row.event_type || meta.event_type || "memory";
  const rawProject = row.project || meta.project || meta.project_path || null;
  const project = rawProject ? normalizeProjectName(rawProject) || null : null;
  const entityId = row.entity_id || meta.entity_id || null;
  const strength = computeStrength(row.access_count);
  const title = extractTitle(row.content, row.node_id);

  // Collect tags
  const tags: string[] = [];
  if (meta.tags) {
    if (Array.isArray(meta.tags)) tags.push(...meta.tags);
    else if (typeof meta.tags === "string") {
      tags.push(...(meta.tags as string).split(",").map((t: string) => t.trim()).filter(Boolean));
    }
  }
  if (meta.category && !tags.includes(meta.category as string)) {
    tags.push(meta.category as string);
  }

  // YAML frontmatter
  lines.push("---");
  lines.push(`memory_id: ${row.node_id}`);
  lines.push(`type: ${eventType}`);
  if (project && projectNames.has(project)) {
    lines.push(`project: "[[${sanitizeFilename(project)}]]"`);
  } else if (project) {
    lines.push(`project: ${project}`);
  }
  if (entityId && entityNames.has(entityId)) {
    lines.push(`entity: "[[${sanitizeFilename(entityNames.get(entityId) || entityId)}]]"`);
  } else if (entityId) {
    lines.push(`entity: ${entityId}`);
  }
  lines.push(`strength: ${strength.toFixed(2)}`);
  lines.push(`status: ${row.status || "active"}`);
  lines.push(`created: ${formatDate(row.created_at)}`);
  if (row.last_accessed) {
    lines.push(`accessed: ${formatDate(row.last_accessed)}`);
  }
  lines.push(`access_count: ${row.access_count || 0}`);
  if (tags.length > 0) {
    lines.push(`tags: [${tags.join(", ")}]`);
  }
  if (edges.length > 0) {
    const relatedLinks = edges.map(e => {
      const targetFile = sanitizeFilename(e.source_id === row.node_id ? e.target_id : e.source_id);
      return `"[[${targetFile}]]"`;
    });
    lines.push(`related:`);
    for (const link of relatedLinks) {
      lines.push(`  - ${link}`);
    }
  }
  if (row.priority && row.priority !== 3) {
    lines.push(`priority: ${row.priority}`);
  }
  lines.push(`aliases: [${row.node_id}]`);
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${title}`);
  lines.push("");

  // Body content
  lines.push(row.content.trim());
  lines.push("");

  // Related section with labeled wikilinks
  if (edges.length > 0) {
    lines.push("## Related");
    for (const edge of edges) {
      const isOutgoing = edge.source_id === row.node_id;
      const otherId = isOutgoing ? edge.target_id : edge.source_id;
      const targetFile = sanitizeFilename(otherId);
      const label = edgeTypeLabel(edge.edge_type);
      lines.push(`- [[${targetFile}]] -- ${label}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Normalize project paths to clean display names */
function normalizeProjectName(raw: string): string {
  if (!raw || raw === "/") return "";
  // Strip common prefixes
  let name = raw
    .replace(/^\/Users\/[^/]+\/Projects\//i, "")
    .replace(/^~\/Projects\//i, "")
    .replace(/^\/Users\/[^/]+\/?$/i, "")
    .replace(/\/$/, "");
  if (!name || name === "/") return "";
  // Use last path component if still a path
  if (name.includes("/")) {
    const parts = name.split("/").filter(Boolean);
    // Keep up to 2 levels (e.g., "omega/admin")
    name = parts.slice(-2).join("/");
  }
  return name;
}

function edgeTypeLabel(edgeType: string): string {
  const labels: Record<string, string> = {
    related_to: "Related",
    contradicts: "Contradicts",
    supersedes: "Supersedes",
    superseded_by: "Superseded by",
    evolved_from: "Evolved from",
    evolved_into: "Evolved into",
    similar_to: "Similar",
    derived_from: "Derived from",
  };
  return labels[edgeType] || edgeType.replace(/_/g, " ");
}

/** Generate an entity profile note */
function generateEntityProfile(
  entityId: string,
  displayName: string,
  memories: MemoryRow[],
  projectNames: Set<string>,
): string {
  const lines: string[] = [];
  const projects = new Set<string>();
  const types = new Map<string, number>();

  for (const m of memories) {
    const p = m.project;
    if (p) projects.add(p);
    const t = m.event_type || "memory";
    types.set(t, (types.get(t) || 0) + 1);
  }

  // Frontmatter
  lines.push("---");
  lines.push(`entity_id: ${entityId}`);
  lines.push(`type: entity`);
  lines.push(`memory_count: ${memories.length}`);
  if (projects.size > 0) {
    lines.push("projects:");
    for (const p of projects) {
      if (projectNames.has(p)) {
        lines.push(`  - "[[${sanitizeFilename(p)}]]"`);
      } else {
        lines.push(`  - ${p}`);
      }
    }
  }
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${displayName}`);
  lines.push("");

  // Summary
  lines.push(`**${memories.length} memories** across ${projects.size} project(s).`);
  lines.push("");

  // Type breakdown
  if (types.size > 0) {
    lines.push("## Memory Types");
    const sorted = [...types.entries()].sort((a, b) => b[1] - a[1]);
    for (const [t, count] of sorted) {
      lines.push(`- **${t}**: ${count}`);
    }
    lines.push("");
  }

  // Recent memories (last 10)
  const recent = [...memories]
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, 10);

  if (recent.length > 0) {
    lines.push("## Recent Memories");
    for (const m of recent) {
      const title = extractTitle(m.content, m.node_id);
      const shortTitle = title.length > 80 ? title.slice(0, 80) + "..." : title;
      const date = m.created_at ? m.created_at.split("T")[0] : "";
      lines.push(`- [[${sanitizeFilename(m.node_id)}|${shortTitle}]] (${date})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Generate a project MOC (Map of Content) */
function generateProjectMOC(
  projectName: string,
  memories: MemoryRow[],
): string {
  const lines: string[] = [];
  const types = new Map<string, MemoryRow[]>();

  for (const m of memories) {
    const t = m.event_type || "memory";
    if (!types.has(t)) types.set(t, []);
    types.get(t)!.push(m);
  }

  // Frontmatter
  lines.push("---");
  lines.push(`project: ${projectName}`);
  lines.push("type: moc");
  lines.push(`memory_count: ${memories.length}`);
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${projectName}`);
  lines.push("");
  lines.push(`**${memories.length} memories** in this project.`);
  lines.push("");

  // Group by type
  const typeOrder = ["decision", "lesson_learned", "user_preference", "advisor_insight", "checkpoint", "error_pattern", "fact", "memory"];

  for (const t of typeOrder) {
    const items = types.get(t);
    if (!items || items.length === 0) continue;
    const dirName = TYPE_TO_DIR[t] || t;
    lines.push(`## ${dirName.charAt(0).toUpperCase() + dirName.slice(1)} (${items.length})`);
    lines.push("");

    // Sort by date descending
    const sorted = [...items].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    for (const m of sorted.slice(0, 30)) {
      const title = extractTitle(m.content, m.node_id);
      const shortTitle = title.length > 80 ? title.slice(0, 80) + "..." : title;
      const date = m.created_at ? m.created_at.split("T")[0] : "";
      lines.push(`- [[${sanitizeFilename(m.node_id)}|${shortTitle}]] (${date})`);
    }
    if (sorted.length > 30) {
      lines.push(`- ... and ${sorted.length - 30} more`);
    }
    lines.push("");
    types.delete(t);
  }

  // Remaining types not in the order list
  for (const [t, items] of types) {
    if (items.length === 0) continue;
    lines.push(`## ${t.replace(/_/g, " ")} (${items.length})`);
    lines.push("");
    const sorted = [...items].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    for (const m of sorted.slice(0, 20)) {
      const title = extractTitle(m.content, m.node_id);
      const shortTitle = title.length > 80 ? title.slice(0, 80) + "..." : title;
      lines.push(`- [[${sanitizeFilename(m.node_id)}|${shortTitle}]]`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Generate a type MOC (all decisions, all lessons, etc.) */
function generateTypeMOC(
  typeName: string,
  dirName: string,
  memories: MemoryRow[],
  projectNames: Set<string>,
): string {
  const lines: string[] = [];

  // Group by project
  const byProject = new Map<string, MemoryRow[]>();
  const noProject: MemoryRow[] = [];
  for (const m of memories) {
    const p = m.project;
    if (p) {
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p)!.push(m);
    } else {
      noProject.push(m);
    }
  }

  lines.push("---");
  lines.push(`type: moc`);
  lines.push(`memory_type: ${typeName}`);
  lines.push(`count: ${memories.length}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${dirName.charAt(0).toUpperCase() + dirName.slice(1)}`);
  lines.push("");
  lines.push(`**${memories.length}** ${typeName.replace(/_/g, " ")} memories.`);
  lines.push("");

  // By project
  for (const [proj, items] of [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const projLink = projectNames.has(proj) ? `[[${sanitizeFilename(proj)}|${proj}]]` : proj;
    lines.push(`## ${projLink} (${items.length})`);
    lines.push("");
    const sorted = [...items].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    for (const m of sorted.slice(0, 25)) {
      const title = extractTitle(m.content, m.node_id);
      const shortTitle = title.length > 80 ? title.slice(0, 80) + "..." : title;
      const date = m.created_at ? m.created_at.split("T")[0] : "";
      lines.push(`- [[${sanitizeFilename(m.node_id)}|${shortTitle}]] (${date})`);
    }
    if (sorted.length > 25) lines.push(`- ... and ${sorted.length - 25} more`);
    lines.push("");
  }

  if (noProject.length > 0) {
    lines.push(`## Unscoped (${noProject.length})`);
    lines.push("");
    const sorted = [...noProject].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    for (const m of sorted.slice(0, 25)) {
      const title = extractTitle(m.content, m.node_id);
      const shortTitle = title.length > 80 ? title.slice(0, 80) + "..." : title;
      lines.push(`- [[${sanitizeFilename(m.node_id)}|${shortTitle}]]`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Generate the Home index note */
function generateHomeIndex(
  totalMemories: number,
  typeStats: Map<string, number>,
  projectStats: Map<string, number>,
  entityStats: Map<string, number>,
  exportedAt: string,
): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push("type: index");
  lines.push(`total_memories: ${totalMemories}`);
  lines.push(`exported: ${exportedAt}`);
  lines.push("---");
  lines.push("");
  lines.push("# OMEGA Memory Vault");
  lines.push("");
  lines.push(`**${totalMemories} memories** exported on ${exportedAt.split("T")[0]}.`);
  lines.push("");

  // By Type
  lines.push("## By Type");
  lines.push("");
  const sortedTypes = [...typeStats.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, count] of sortedTypes) {
    const dirName = TYPE_TO_DIR[t] || DEFAULT_DIR;
    const displayName = dirName.charAt(0).toUpperCase() + dirName.slice(1);
    lines.push(`- [[${displayName}|${displayName}]] (${count})`);
  }
  lines.push("");

  // By Project
  if (projectStats.size > 0) {
    lines.push("## By Project");
    lines.push("");
    const sortedProjects = [...projectStats.entries()].sort((a, b) => b[1] - a[1]);
    for (const [p, count] of sortedProjects) {
      lines.push(`- [[${sanitizeFilename(p)}|${p}]] (${count})`);
    }
    lines.push("");
  }

  // By Entity
  if (entityStats.size > 0) {
    lines.push("## By Entity");
    lines.push("");
    const sortedEntities = [...entityStats.entries()].sort((a, b) => b[1] - a[1]);
    for (const [e, count] of sortedEntities) {
      lines.push(`- [[${sanitizeFilename(e)}|${e}]] (${count})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}


/**
 * Main export function. Reads from ~/.omega/omega.db and writes
 * an Obsidian vault to the specified directory.
 */
export async function exportToVault(
  outputDir: string,
  options: {
    limit?: number;
    project?: string;
    isPro?: boolean;
    onProgress?: (message: string, pct: number) => void;
  } = {},
): Promise<ExportResult> {
  const { limit = 0, project, isPro = false, onProgress } = options;
  const FREE_LIMIT = 20;

  const nodeRequire = (window as any).require;
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const os = nodeRequire("os");

  // Locate omega.db
  const dbPath = path.join(os.homedir(), ".omega", "omega.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error("OMEGA database not found at ~/.omega/omega.db. Is OMEGA installed?");
  }

  onProgress?.("Loading OMEGA database...", 0);

  // Load sql.js and open database
  const initSqlJs = (await import("sql.js")).default;
  const wasmPath = path.join(
    (window as any).app?.vault?.adapter?.getBasePath?.() || ".",
    (window as any).app?.vault?.configDir || ".obsidian",
    "plugins/omega-memory/sql-wasm.wasm",
  );
  const wasmBinary = fs.readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary: wasmBinary.buffer });
  const dbBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(dbBuffer));

  try {
    // Query memories
    onProgress?.("Querying memories...", 5);

    let sql = `SELECT node_id, content, metadata, created_at, last_accessed,
               access_count, event_type, project, entity_id, status, priority, ttl_seconds
               FROM memories WHERE status != 'superseded'`;
    const params: unknown[] = [];

    if (project) {
      sql += " AND (project = ? OR metadata LIKE ?)";
      params.push(project, `%"project":"${project}"%`);
    }

    sql += " ORDER BY created_at DESC";

    // Apply limit: Pro gets full export, free gets sample
    const effectiveLimit = !isPro ? FREE_LIMIT : (limit > 0 ? limit : 0);
    if (effectiveLimit > 0) {
      sql += " LIMIT ?";
      params.push(effectiveLimit);
    }

    const memResult = db.exec(sql, params);
    if (!memResult.length) {
      db.close();
      return {
        memoriesExported: 0,
        entitiesCreated: 0,
        projectsCreated: 0,
        mocsCreated: 0,
        edgeLinksCreated: 0,
        outputDir,
        exportedAt: new Date().toISOString(),
      };
    }

    const rows: MemoryRow[] = memResult[0].values.map((r: unknown[]) => ({
      node_id: r[0] as string,
      content: r[1] as string,
      metadata: r[2] as string | null,
      created_at: r[3] as string,
      last_accessed: r[4] as string | null,
      access_count: (r[5] as number) || 0,
      event_type: r[6] as string | null,
      project: r[7] as string | null,
      entity_id: r[8] as string | null,
      status: r[9] as string | null,
      priority: (r[10] as number) || 3,
      ttl_seconds: r[11] as number | null,
    }));

    onProgress?.(`Found ${rows.length} memories. Loading relationships...`, 10);

    // Query all edges
    const edgeResult = db.exec("SELECT source_id, target_id, edge_type, weight FROM edges");
    const allEdges: EdgeRow[] = edgeResult.length
      ? edgeResult[0].values.map((r: unknown[]) => ({
          source_id: r[0] as string,
          target_id: r[1] as string,
          edge_type: r[2] as string,
          weight: (r[3] as number) || 1.0,
        }))
      : [];

    // Index edges by node_id
    const edgeIndex = new Map<string, EdgeRow[]>();
    for (const edge of allEdges) {
      if (!edgeIndex.has(edge.source_id)) edgeIndex.set(edge.source_id, []);
      edgeIndex.get(edge.source_id)!.push(edge);
      if (!edgeIndex.has(edge.target_id)) edgeIndex.set(edge.target_id, []);
      edgeIndex.get(edge.target_id)!.push(edge);
    }

    db.close();

    // Collect entities and projects
    const entityMemories = new Map<string, MemoryRow[]>();
    const projectMemories = new Map<string, MemoryRow[]>();
    const typeMemories = new Map<string, MemoryRow[]>();
    const entityNames = new Map<string, string>(); // entity_id -> display name
    const projectNames = new Set<string>();

    for (const row of rows) {
      const meta = parseMetadata(row.metadata);
      const entityId = row.entity_id || meta.entity_id;
      const proj = row.project || meta.project || meta.project_path;
      const eventType = row.event_type || meta.event_type || "memory";

      if (entityId) {
        if (!entityMemories.has(entityId)) entityMemories.set(entityId, []);
        entityMemories.get(entityId)!.push(row);
        if (!entityNames.has(entityId)) {
          // Use entity_id as display name, cleaned up
          entityNames.set(entityId, entityId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
        }
      }

      if (proj) {
        const normalizedProj = normalizeProjectName(proj);
        if (normalizedProj) {
          if (!projectMemories.has(normalizedProj)) projectMemories.set(normalizedProj, []);
          projectMemories.get(normalizedProj)!.push(row);
          projectNames.add(normalizedProj);
        }
      }

      if (!typeMemories.has(eventType)) typeMemories.set(eventType, []);
      typeMemories.get(eventType)!.push(row);
    }

    // Create directory structure
    onProgress?.("Creating vault structure...", 15);

    const dirs = [
      path.join(outputDir, "_index", "Projects"),
      path.join(outputDir, "_index", "Entities"),
      path.join(outputDir, "_index", "Types"),
      path.join(outputDir, "entities"),
      path.join(outputDir, "archive"),
    ];

    // Add type subdirectories
    const usedDirs = new Set<string>();
    for (const row of rows) {
      const meta = parseMetadata(row.metadata);
      const eventType = row.event_type || meta.event_type || "memory";
      const dirName = TYPE_TO_DIR[eventType] || DEFAULT_DIR;
      usedDirs.add(dirName);
    }
    for (const d of usedDirs) {
      dirs.push(path.join(outputDir, "memories", d));
    }

    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Export memory notes
    let exported = 0;
    let edgeLinksCreated = 0;
    const total = rows.length;

    for (const row of rows) {
      const meta = parseMetadata(row.metadata);
      const eventType = row.event_type || meta.event_type || "memory";
      const dirName = TYPE_TO_DIR[eventType] || DEFAULT_DIR;
      const edges = edgeIndex.get(row.node_id) || [];
      edgeLinksCreated += edges.length;

      const markdown = memoryToMarkdown(row, meta, edges, entityNames, projectNames);
      const filename = sanitizeFilename(row.node_id) + ".md";
      const filepath = path.join(outputDir, "memories", dirName, filename);

      fs.writeFileSync(filepath, markdown, "utf-8");
      exported++;

      if (exported % 50 === 0 || exported === total) {
        const pct = 15 + Math.round((exported / total) * 60);
        onProgress?.(`Exported ${exported}/${total} memories...`, pct);
      }
    }

    // Generate entity profiles (Pro only)
    let entitiesCreated = 0;
    if (isPro) {
      onProgress?.("Generating entity profiles...", 78);
      for (const [entityId, memories] of entityMemories) {
        const displayName = entityNames.get(entityId) || entityId;
        const markdown = generateEntityProfile(entityId, displayName, memories, projectNames);
        const filename = sanitizeFilename(displayName) + ".md";
        const filepath = path.join(outputDir, "entities", filename);
        fs.writeFileSync(filepath, markdown, "utf-8");
        entitiesCreated++;
      }
    }

    // Generate project MOCs (Pro only)
    let projectsCreated = 0;
    if (isPro) {
      onProgress?.("Generating project indexes...", 85);
      for (const [proj, memories] of projectMemories) {
        const markdown = generateProjectMOC(proj, memories);
        const filename = sanitizeFilename(proj) + ".md";
        const filepath = path.join(outputDir, "_index", "Projects", filename);
        fs.writeFileSync(filepath, markdown, "utf-8");
        projectsCreated++;
      }
    }

    // Generate type MOCs (Pro only)
    let mocsCreated = 0;
    if (isPro) {
      onProgress?.("Generating type indexes...", 90);
      for (const [typeName, memories] of typeMemories) {
        const dirName = TYPE_TO_DIR[typeName] || DEFAULT_DIR;
        const markdown = generateTypeMOC(typeName, dirName, memories, projectNames);
        const displayName = dirName.charAt(0).toUpperCase() + dirName.slice(1);
        const filename = displayName + ".md";
        const filepath = path.join(outputDir, "_index", "Types", filename);
        fs.writeFileSync(filepath, markdown, "utf-8");
        mocsCreated++;
      }
    }

    // Generate Home index (always)
    onProgress?.("Generating vault index...", 95);
    const typeStats = new Map<string, number>();
    for (const [t, m] of typeMemories) typeStats.set(t, m.length);
    const projectStats = new Map<string, number>();
    for (const [p, m] of projectMemories) projectStats.set(p, m.length);
    const entityStats = new Map<string, number>();
    for (const [e, m] of entityMemories) entityStats.set(entityNames.get(e) || e, m.length);

    const exportedAt = new Date().toISOString();
    const homeContent = generateHomeIndex(exported, typeStats, projectStats, entityStats, exportedAt);
    fs.writeFileSync(path.join(outputDir, "_index", "Home.md"), homeContent, "utf-8");
    mocsCreated++;

    // Create .obsidian directory if it doesn't exist (makes it openable as a vault)
    const obsidianDir = path.join(outputDir, ".obsidian");
    if (!fs.existsSync(obsidianDir)) {
      fs.mkdirSync(obsidianDir, { recursive: true });
      // Minimal app.json so Obsidian recognizes it as a vault
      fs.writeFileSync(
        path.join(obsidianDir, "app.json"),
        JSON.stringify({ alwaysUpdateLinks: true }, null, 2),
        "utf-8",
      );
    }

    onProgress?.("Export complete!", 100);

    return {
      memoriesExported: exported,
      entitiesCreated,
      projectsCreated,
      mocsCreated,
      edgeLinksCreated,
      outputDir,
      exportedAt,
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
