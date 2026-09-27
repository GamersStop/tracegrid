/**
 * TraceGrid deterministic Markdown parser.
 */

import {
  ArchitectureSpec,
  APIRoute,
  ColumnMeta,
  DatabaseSchema,
  ERRelationship,
  HttpMethod,
  ParseError,
  RequestFlow,
  TableDefinition,
  TraceEdge,
  TraceGraph,
  TraceNode,
} from "./types.js";

const HEADING_DB = "## Database Schema";
const HEADING_ROUTES = "## API Routes";
const HEADING_TREE = "## Directory Structure";
const HEADING_FLOWS = "## Request Flows";

const REQUIRED_SECTIONS = [HEADING_DB, HEADING_ROUTES, HEADING_TREE, HEADING_FLOWS] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseArchitectureMd(source: string): ArchitectureSpec {
  const sections = splitSections(source);
  validateRequiredSections(sections);

  return {
    database: parseDbSection(sections[HEADING_DB] ?? ""),
    routes: parseRoutesSection(sections[HEADING_ROUTES] ?? ""),
    directoryTree: parseTreeSection(sections[HEADING_TREE] ?? ""),
    requestFlows: parseFlowsSection(sections[HEADING_FLOWS] ?? ""),
  };
}

export function buildGraph(spec: ArchitectureSpec): TraceGraph {
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];

  for (const table of spec.database.tables) {
    const nodeId = `database:table:${table.name}`;
    nodes.push({
      id: nodeId,
      label: table.name,
      tier: "database",
      kind: "table",
      meta: { columns: table.columns },
    });

    for (const col of table.columns) {
      if (col.foreignKey) {
        const targetId = `database:table:${col.foreignKey.referencesTable}`;
        edges.push({
          id: `edge:fk:${table.name}.${col.name}`,
          source: nodeId,
          target: targetId,
          type: "foreign-key",
          label: `${col.name} → ${col.foreignKey.referencesColumn}`,
        });
      }
    }
  }

  for (const rel of spec.database.relationships) {
    const edgeId = `edge:rel:${rel.from}-${rel.to}`;
    if (!edges.find((e) => e.id === edgeId)) {
      edges.push({
        id: edgeId,
        source: `database:table:${rel.from}`,
        target: `database:table:${rel.to}`,
        type: "foreign-key",
        label: rel.label,
      });
    }
  }

  for (const route of spec.routes) {
    const nodeId = `api:endpoint:${route.method}:${route.path}`;
    nodes.push({
      id: nodeId,
      label: `${route.method} ${route.path}`,
      tier: "api",
      kind: "endpoint",
      meta: {
        method: route.method,
        path: route.path,
        handler: route.handler,
        description: route.description,
      },
    });
  }

  const seenComponents = new Set<string>();
  for (const flow of spec.requestFlows) {
    const compId = `frontend:component:${flow.frontendComponent}`;
    if (!seenComponents.has(compId)) {
      seenComponents.add(compId);
      nodes.push({
        id: compId,
        label: flow.frontendComponent,
        tier: "frontend",
        kind: "component",
        meta: { apiCalls: [flow.endpoint] },
      });
    }

    const parts = flow.endpoint.split(" ");
    const method = parts[0] ?? "";
    const routePath = parts.slice(1).join(" ");
    const apiNodeId = `api:endpoint:${method}:${routePath}`;
    edges.push({
      id: `edge:calls:${flow.frontendComponent}:${flow.endpoint}`,
      source: compId,
      target: apiNodeId,
      type: "calls",
      label: flow.feature,
    });

    for (const table of flow.dbTables) {
      edges.push({
        id: `edge:reads:${method}:${routePath.replace(/\//g, "")}:${table}`,
        source: apiNodeId,
        target: `database:table:${table}`,
        type: "reads",
      });
    }
  }

  return { nodes, edges };
}

export function parseToGraph(source: string): TraceGraph {
  return buildGraph(parseArchitectureMd(source));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function splitSections(source: string): Record<string, string> {
  const lines = source.split("\n");
  const result: Record<string, string> = {};
  let currentHeading: string | null = null;
  const buffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentHeading !== null) {
        result[currentHeading] = buffer.join("\n").trim();
      }
      currentHeading = line.trim();
      buffer.length = 0;
    } else {
      buffer.push(line);
    }
  }
  if (currentHeading !== null) {
    result[currentHeading] = buffer.join("\n").trim();
  }
  return result;
}

function validateRequiredSections(sections: Record<string, string>): void {
  for (const heading of REQUIRED_SECTIONS) {
    if (!(heading in sections)) {
      throw new ParseError(`Required section "${heading}" is missing`, heading);
    }
  }
}

// ---------------------------------------------------------------------------
// DB Section parser
// ---------------------------------------------------------------------------

function parseDbSection(body: string): DatabaseSchema {
  const MERMAID_BLOCK_RE = /```mermaid\s*\n([\s\S]*?)```/;
  const match = MERMAID_BLOCK_RE.exec(body);
  if (!match) {
    throw new ParseError("No mermaid code block found", HEADING_DB);
  }
  const rawMermaid = match[0];
  const mermaidBody = match[1] ?? "";

  const tables = parseErDiagramEntities(mermaidBody);
  const relationships = parseErDiagramRelationships(mermaidBody);

  return { tables, relationships, rawMermaid };
}

function parseErDiagramEntities(mermaidBody: string): TableDefinition[] {
  const ENTITY_BLOCK_RE = /(\w+)\s*\{([^}]*)\}/g;
  const tables: TableDefinition[] = [];
  let entityMatch: RegExpExecArray | null;

  while ((entityMatch = ENTITY_BLOCK_RE.exec(mermaidBody)) !== null) {
    const name = entityMatch[1] ?? "";
    const bodyText = entityMatch[2] ?? "";
    const columnLines = bodyText.trim().split("\n");
    const columns: ColumnMeta[] = [];

    for (const rawLine of columnLines) {
      const line = rawLine.trim();
      if (!line) continue;
      const COLUMN_RE = /^(\S+)\s+(\S+)(?:\s+(.*))?$/;
      const colMatch = COLUMN_RE.exec(line);
      if (!colMatch) continue;

      const type = colMatch[1] ?? "";
      const colName = colMatch[2] ?? "";
      const flags = colMatch[3] ?? "";
      const flagsUpper = flags.toUpperCase();
      columns.push({
        name: colName,
        type,
        nullable: !flagsUpper.includes("PK") && !flagsUpper.includes("NOT NULL"),
        primaryKey: flagsUpper.includes("PK"),
        foreignKey: undefined,
      });
    }

    tables.push({ name, columns });
  }

  return tables;
}

function parseErDiagramRelationships(mermaidBody: string): ERRelationship[] {
  // Matches: `  EntityA ||--o{ EntityB : "label"` — leading whitespace is optional
  const REL_RE = /^\s*(\w+)\s+(\S+)\s+(\w+)\s*:\s*"?([^"\n]*)"?/gm;
  const relationships: ERRelationship[] = [];
  let relMatch: RegExpExecArray | null;

  while ((relMatch = REL_RE.exec(mermaidBody)) !== null) {
    const from = relMatch[1] ?? "";
    const cardinality = relMatch[2] ?? "";
    const to = relMatch[3] ?? "";
    const label = relMatch[4] ?? "";
    // Skip entity block opening lines like `User {` (cardinality would be `{` alone)
    // Valid Mermaid cardinality symbols always contain `|` or `-` or `o`
    if (cardinality === "{" || cardinality === "}") continue;
    relationships.push({ from, to, cardinality, label: label.trim() || undefined });
  }

  return relationships;
}

// ---------------------------------------------------------------------------
// API Routes section parser
// ---------------------------------------------------------------------------

function parseRoutesSection(body: string): APIRoute[] {
  const routes: APIRoute[] = [];
  const lines = body.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || line.startsWith("| Method") || /^\|[-| ]+\|$/.test(line)) {
      continue;
    }

    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);

    if (cells.length < 3) continue;

    const method = cells[0] ?? "";
    const path = cells[1] ?? "";
    const handler = cells[2] ?? "";
    const description = cells.slice(3).join("|").trim();

    const validMethods: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    const upperMethod = method.toUpperCase() as HttpMethod;
    if (!validMethods.includes(upperMethod)) continue;

    routes.push({ method: upperMethod, path, handler, description });
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Directory Tree section parser
// ---------------------------------------------------------------------------

function parseTreeSection(body: string): string {
  const TREE_BLOCK_RE = /```[^\n]*\n([\s\S]*?)```/;
  const match = TREE_BLOCK_RE.exec(body);
  if (!match) {
    throw new ParseError("No fenced code block found for directory tree", HEADING_TREE);
  }
  return (match[1] ?? "").trimEnd();
}

// ---------------------------------------------------------------------------
// Request Flows section parser
// ---------------------------------------------------------------------------

function parseFlowsSection(body: string): RequestFlow[] {
  const flows: RequestFlow[] = [];
  const lines = body.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || line.startsWith("| Feature") || /^\|[-| ]+\|$/.test(line)) {
      continue;
    }

    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);

    if (cells.length < 3) continue;

    const feature = cells[0] ?? "";
    const frontendComponent = cells[1] ?? "";
    const endpoint = cells[2] ?? "";
    const dbTablesRaw = cells[3] ?? "";
    const dbTables = dbTablesRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    flows.push({ feature, frontendComponent, endpoint, dbTables });
  }

  return flows;
}
