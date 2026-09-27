/**
 * TraceGrid architecture.md generator.
 *
 * Converts an `ArchitectureSpec` (or raw scan results) into the canonical
 * `architecture.md` Markdown document.
 *
 * Contract: the output of `generateArchitectureMd()` must be parseable
 * by `parser.ts` without loss (round-trip safe).
 */

import {
  APIRoute,
  APIScanResult,
  ArchitectureSpec,
  ColumnMeta,
  DBScanResult,
  ERRelationship,
  FrontendScanResult,
  RequestFlow,
  TableDefinition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a full `architecture.md` document from an `ArchitectureSpec`.
 */
export function generateArchitectureMd(spec: ArchitectureSpec): string {
  return [
    generateDbSection(spec.database.tables, spec.database.relationships),
    generateRoutesSection(spec.routes),
    generateTreeSection(spec.directoryTree),
    generateFlowsSection(spec.requestFlows),
  ].join("\n\n");
}

/**
 * Synthesize an `ArchitectureSpec` from raw scan results, then render it.
 * Used by `tracegrid scan` in the CLI.
 */
export function generateFromScanResults(
  db: DBScanResult,
  api: APIScanResult,
  frontend: FrontendScanResult,
  directoryTree: string,
): string {
  const requestFlows = synthesizeRequestFlows(api, frontend, db);

  // Prune transient DTO/schema classes that have zero references in the graph.
  // A table is kept when:
  //  (a) it is NOT in the dtoNames set, OR
  //  (b) it IS in dtoNames but appears in at least one route's dbTables or ERD relationship.
  const { tables, relationships } = pruneUnreferencedDtos(db, api);

  const spec: ArchitectureSpec = {
    database: {
      tables,
      relationships,
      rawMermaid: renderMermaidErDiagram(tables, relationships),
    },
    routes: api.routes,
    directoryTree,
    requestFlows,
  };
  return generateArchitectureMd(spec);
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function generateDbSection(tables: TableDefinition[], relationships: ERRelationship[]): string {
  const mermaid = renderMermaidErDiagram(tables, relationships);
  return `## Database Schema\n\n${mermaid}`;
}

function generateRoutesSection(routes: APIRoute[]): string {
  if (routes.length === 0) {
    return "## API Routes\n\n| Method | Path | Handler | Description |\n|--------|------|---------|-------------|";
  }

  const header = "| Method | Path | Handler | Description |";
  const separator = "|--------|------|---------|-------------|";
  const rows = routes.map(
    (r) => `| ${r.method} | ${r.path} | ${r.handler} | ${r.description} |`,
  );

  return `## API Routes\n\n${[header, separator, ...rows].join("\n")}`;
}

function generateTreeSection(directoryTree: string): string {
  const body = directoryTree.trim();
  return `## Directory Structure\n\n\`\`\`\n${body}\n\`\`\``;
}

function generateFlowsSection(flows: RequestFlow[]): string {
  if (flows.length === 0) {
    return (
      "## Request Flows\n\n" +
      "| Feature | Frontend Component | Endpoint | DB Tables |\n" +
      "|---------|--------------------|----------|-----------|\n"
    );
  }

  const header = "| Feature | Frontend Component | Endpoint | DB Tables |";
  const separator = "|---------|--------------------|----------|-----------|";
  const rows = flows.map(
    (f) =>
      `| ${f.feature} | ${f.frontendComponent} | ${f.endpoint} | ${f.dbTables.join(", ")} |`,
  );

  return `## Request Flows\n\n${[header, separator, ...rows].join("\n")}`;
}

// ---------------------------------------------------------------------------
// Mermaid ERD renderer
// ---------------------------------------------------------------------------

/**
 * Render a Mermaid erDiagram block from tables and relationships.
 */
function renderMermaidErDiagram(
  tables: TableDefinition[],
  relationships: ERRelationship[],
): string {
  const lines: string[] = ["```mermaid", "erDiagram"];

  // Entity definitions
  for (const table of tables) {
    lines.push(`  ${table.name} {`);
    for (const col of table.columns) {
      const flags: string[] = [];
      if (col.primaryKey) flags.push("PK");
      if (col.foreignKey) flags.push("FK");
      lines.push(`    ${col.type} ${col.name}${flags.length ? " " + flags.join(" ") : ""}`);
    }
    lines.push("  }");
  }

  // Relationships
  const seen = new Set<string>();
  for (const rel of relationships) {
    const key = `${rel.from}-${rel.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = rel.label ? ` : "${rel.label}"` : ' : ""';
    lines.push(`  ${rel.from} ${rel.cardinality} ${rel.to}${label}`);
  }

  lines.push("```");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DTO pruning
// ---------------------------------------------------------------------------

/**
 * Remove transient DTO/schema classes from the ERD when they have no references.
 *
 * A class is removed when ALL of the following hold:
 *  1. Its name is in `db.dtoNames` (identified by the scanner as a DTO).
 *  2. No API route's `dbTables` list mentions it.
 *  3. No ERD relationship references it as `from` or `to`.
 *
 * This prevents classes like `AdminLoginRequest`, `ClaimItemRequest`, or
 * `DonateSolRequest` from appearing as floating nodes in the left column.
 */
function pruneUnreferencedDtos(
  db: DBScanResult,
  api: APIScanResult,
): { tables: TableDefinition[]; relationships: ERRelationship[] } {
  const dtoNames = db.dtoNames;
  if (!dtoNames || dtoNames.size === 0) {
    return { tables: db.tables, relationships: db.relationships };
  }

  // Collect all table names referenced by routes
  const referencedByRoutes = new Set<string>();
  for (const route of api.routes) {
    for (const t of route.dbTables ?? []) {
      referencedByRoutes.add(t);
    }
  }

  // Collect all table names referenced in ERD relationships
  const referencedInErd = new Set<string>();
  for (const rel of db.relationships) {
    referencedInErd.add(rel.from);
    referencedInErd.add(rel.to);
  }

  // Keep a table when it is not a DTO, or when it is referenced somewhere
  const keptTableNames = new Set<string>();
  const tables = db.tables.filter((t) => {
    if (!dtoNames.has(t.name)) {
      keptTableNames.add(t.name);
      return true; // not a DTO — always keep
    }
    const referenced = referencedByRoutes.has(t.name) || referencedInErd.has(t.name);
    if (referenced) keptTableNames.add(t.name);
    return referenced;
  });

  // Drop relationships whose `from` or `to` was pruned
  const relationships = db.relationships.filter(
    (r) => keptTableNames.has(r.from) && keptTableNames.has(r.to),
  );

  return { tables, relationships };
}

// ---------------------------------------------------------------------------
// Request flow synthesizer
// ---------------------------------------------------------------------------

/**
 * Infer request flows from API routes and frontend component calls.
 * Maps each component's API call to the corresponding route, and populates
 * the `dbTables` column using:
 *   1. Scanner-traced models stored in `route.dbTables` (highest confidence).
 *   2. Heuristic name-matching against handler string and path segments
 *      (fallback when static analysis found nothing).
 */
function synthesizeRequestFlows(
  api: APIScanResult,
  frontend: FrontendScanResult,
  db?: DBScanResult,
): RequestFlow[] {
  const flows: RequestFlow[] = [];
  const tableNames = db ? db.tables.map((t) => t.name) : [];

  for (const [component, apiPaths] of Object.entries(frontend.componentCalls)) {
    for (const apiPath of apiPaths) {
      // Find matching API route by path (ignore method for frontend correlation)
      const route = api.routes.find((r) => r.path === apiPath || apiPath.includes(r.path));
      const endpoint = route ? `${route.method} ${route.path}` : `GET ${apiPath}`;
      const feature = route?.description || deriveFeature(component, apiPath);

      // Prefer scanner-traced models; fall back to heuristic name matching.
      const tracedTables =
        route?.dbTables && route.dbTables.length > 0
          ? route.dbTables
          : inferDbTables(route?.handler ?? "", apiPath, tableNames);

      flows.push({
        feature,
        frontendComponent: component,
        endpoint,
        dbTables: tracedTables,
      });
    }
  }

  return flows;
}

/**
 * Heuristically infer which DB tables an endpoint touches.
 *
 * Strategy (in order of confidence):
 * 1. Exact table-name match in the handler string (e.g. handler `user_crud.list` → `User`)
 * 2. Exact table-name match in the URL path segments (e.g. `/api/users` → `User`)
 * 3. Singular/plural normalisation (e.g. `users` → `User`, `posts` → `Post`)
 *
 * Returns an empty array when no tables are known or no match can be made.
 */
function inferDbTables(handler: string, apiPath: string, tableNames: string[]): string[] {
  if (tableNames.length === 0) return [];

  const matched = new Set<string>();
  const handlerLower = handler.toLowerCase();
  const pathSegments = apiPath
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/^[:*]/, "")); // strip path params

  for (const table of tableNames) {
    const tableLower = table.toLowerCase();
    // 1. Handler contains the table name (case-insensitive)
    if (handlerLower.includes(tableLower)) {
      matched.add(table);
      continue;
    }
    // 2. Any path segment matches the table name exactly
    if (pathSegments.some((seg) => seg.toLowerCase() === tableLower)) {
      matched.add(table);
      continue;
    }
    // 3. Plural path segment matches singular table name
    //    e.g. "users" matches "User", "posts" matches "Post"
    if (
      pathSegments.some(
        (seg) =>
          seg.toLowerCase() === tableLower + "s" ||
          seg.toLowerCase() === tableLower.replace(/y$/, "ies"),
      )
    ) {
      matched.add(table);
    }
  }

  return Array.from(matched);
}

/** Derive a human-readable feature label from component name and API path. */
function deriveFeature(component: string, apiPath: string): string {
  const last = apiPath.split("/").filter(Boolean).pop() ?? "data";
  return `${component} → ${last}`;
}

// ---------------------------------------------------------------------------
// Directory tree builder (for scan mode)
// ---------------------------------------------------------------------------

/**
 * Build a directory tree string from a list of relative file paths.
 * Used by the CLI scan command to populate the `## Directory Structure` section.
 */
export function buildDirectoryTree(relativePaths: string[], rootName = "."): string {
  // Build a nested object tree
  const tree: Record<string, unknown> = {};

  for (const p of relativePaths) {
    const parts = p.replace(/\\/g, "/").split("/");
    let node = tree;
    for (const part of parts) {
      if (!node[part]) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
  }

  const lines: string[] = [`${rootName}/`];
  renderTree(tree, lines, "");
  return lines.join("\n");
}

function renderTree(
  node: Record<string, unknown>,
  lines: string[],
  indent: string,
): void {
  const keys = Object.keys(node).sort();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] ?? "";
    const isLast = i === keys.length - 1;
    const prefix = indent + (isLast ? "└── " : "├── ");
    const childIndent = indent + (isLast ? "    " : "│   ");
    const child = (node[key] ?? {}) as Record<string, unknown>;
    const isDir = Object.keys(child).length > 0;
    lines.push(`${prefix}${key}${isDir ? "/" : ""}`);
    if (isDir) {
      renderTree(child, lines, childIndent);
    }
  }
}
