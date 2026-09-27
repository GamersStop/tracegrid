/**
 * TraceGrid canonical type definitions.
 * All public engine interfaces live here — no runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Graph primitives
// ---------------------------------------------------------------------------

/** The tier a node belongs to in the 3-column canvas. */
export type NodeTier = "database" | "api" | "frontend";

/** The kind of entity a node represents within its tier. */
export type NodeKind =
  | "table"       // DB entity
  | "column"      // DB column (child of table)
  | "endpoint"    // API route
  | "component"   // Frontend React/Vue component
  | "directory"   // Directory in the project tree
  | "file";       // Source file

/**
 * A single node in the TraceGrid graph.
 * Nodes map to DB tables, API endpoints, or frontend components/files.
 */
export interface TraceNode {
  /** Stable, unique identifier. Format: `<tier>:<kind>:<name>` */
  id: string;
  /** Human-readable label shown on the canvas. */
  label: string;
  tier: NodeTier;
  kind: NodeKind;
  /**
   * Tier-specific metadata — shape depends on `kind`:
   * - table:    { columns: ColumnMeta[] }
   * - endpoint: { method: HttpMethod; path: string; handler: string; description?: string }
   * - component:{ filePath: string; apiCalls?: string[] }
   * - directory:{ filePath: string }
   * - file:     { filePath: string; language?: string }
   */
  meta: Record<string, unknown>;
}

/** HTTP methods recognised by the scanner and parser. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** Column-level metadata for a DB table node. */
export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  foreignKey?: { referencesTable: string; referencesColumn: string };
}

/**
 * A directed relationship between two nodes.
 */
export interface TraceEdge {
  id: string;
  /** `TraceNode.id` of the source node. */
  source: string;
  /** `TraceNode.id` of the target node. */
  target: string;
  /**
   * Semantic type of the relationship:
   * - `foreign-key`  — DB table FK relationship
   * - `calls`        — frontend component calls an API endpoint
   * - `reads`        — endpoint reads from a DB table
   * - `writes`       — endpoint writes to a DB table
   * - `renders`      — component renders data from another component/file
   * - `contains`     — directory contains file/sub-directory
   */
  type: "foreign-key" | "calls" | "reads" | "writes" | "renders" | "contains";
  label?: string;
}

// ---------------------------------------------------------------------------
// architecture.md sections
// ---------------------------------------------------------------------------

/** Parsed representation of the `## Database Schema` Mermaid block. */
export interface DatabaseSchema {
  /** All entity definitions extracted from the erDiagram block. */
  tables: TableDefinition[];
  /** All relationship lines extracted from the erDiagram block. */
  relationships: ERRelationship[];
  /** Raw Mermaid source (preserved for round-trip). */
  rawMermaid: string;
}

/** A single table/entity in the ERD. */
export interface TableDefinition {
  name: string;
  columns: ColumnMeta[];
}

/** A single relationship line in the Mermaid erDiagram. */
export interface ERRelationship {
  from: string;
  to: string;
  /** Mermaid cardinality string, e.g. `||--o{` */
  cardinality: string;
  label?: string;
}

/** A single row in the `## API Routes` Markdown table. */
export interface APIRoute {
  method: HttpMethod;
  path: string;
  /** Module/function reference, e.g. `userController.create` */
  handler: string;
  description: string;
  /**
   * DB model/table names detected in the handler body via static analysis.
   * Populated by the scanner; absent when parsing from `architecture.md`.
   */
  dbTables?: string[];
}

/** A single row in the `## Request Flows` Markdown table. */
export interface RequestFlow {
  /** Feature or user-story label, e.g. "User Registration". */
  feature: string;
  /** Frontend component that initiates the request. */
  frontendComponent: string;
  /** The API endpoint called, e.g. `POST /api/users`. */
  endpoint: string;
  /** Comma-separated list of DB tables touched. */
  dbTables: string[];
}

// ---------------------------------------------------------------------------
// Top-level document types
// ---------------------------------------------------------------------------

/**
 * The fully parsed, in-memory representation of an `architecture.md` file.
 * This is the primary output of `parser.ts` and the primary input of `generator.ts`.
 */
export interface ArchitectureSpec {
  database: DatabaseSchema;
  routes: APIRoute[];
  /** Raw directory tree string extracted from the fenced block. */
  directoryTree: string;
  requestFlows: RequestFlow[];
}

/**
 * The structured graph format consumed by the visual canvas.
 * Output of `buildGraph()` in `parser.ts`.
 */
export interface TraceGraph {
  nodes: TraceNode[];
  edges: TraceEdge[];
}

/**
 * Greenfield output: the full blueprint for a new project.
 * Produced by the `tracegrid-architect` agent and written as `architecture.md`.
 */
export interface ProjectBlueprint {
  /** The human-readable idea or PRD summary that was provided. */
  sourcePrompt: string;
  spec: ArchitectureSpec;
}

// ---------------------------------------------------------------------------
// Scanner intermediate types
// ---------------------------------------------------------------------------

/** Raw scan result for the DB layer. */
export interface DBScanResult {
  tables: TableDefinition[];
  relationships: ERRelationship[];
  /** Which files were scanned. */
  sources: string[];
  /**
   * Names of purely transient DTO/schema classes (e.g. Pydantic `BaseModel`
   * subclasses, or classes named `*Request` / `*Response` / `*Schema`).
   * These are excluded from the ERD and pruned when unreferenced.
   */
  dtoNames?: Set<string>;
}

/** Raw scan result for the API layer. */
export interface APIScanResult {
  routes: APIRoute[];
  sources: string[];
}

/** Raw scan result for the frontend layer. */
export interface FrontendScanResult {
  /** Component name → list of API paths it calls. */
  componentCalls: Record<string, string[]>;
  sources: string[];
}

/** Typed error thrown by the parser on malformed `architecture.md` input. */
export class ParseError extends Error {
  constructor(
    message: string,
    public readonly section: string,
    public readonly line?: number,
  ) {
    super(`[ParseError:${section}] ${message}${line !== undefined ? ` (line ${line})` : ""}`);
    this.name = "ParseError";
  }
}

/** Typed error thrown by the scanner on unrecoverable inspection failures. */
export class ScanError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
  ) {
    super(`[ScanError:${filePath}] ${message}`);
    this.name = "ScanError";
  }
}
