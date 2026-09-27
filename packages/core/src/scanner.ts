/**
 * TraceGrid modular filesystem scanner.
 *
 * Inspects an existing project directory and extracts:
 *   1. DB layer  — Prisma schema, SQL DDL, TypeORM/Sequelize models
 *   2. API layer — Express routers, Next.js route handlers, FastAPI routes
 *   3. Frontend  — fetch()/axios calls in .tsx/.jsx/.ts/.js files
 *
 * Design rules:
 *  - Every sub-scanner is a pure function: (content: string, filePath: string) => partial result.
 *  - No subprocess execution, no dynamic require/import of project code.
 *  - On unrecognised patterns: return empty result, never throw.
 *  - Regex patterns are named constants with inline explanation comments.
 */

import * as fs from "fs";
import * as path from "path";
import {
  APIScanResult,
  APIRoute,
  ColumnMeta,
  DBScanResult,
  ERRelationship,
  FrontendScanResult,
  HttpMethod,
  TableDefinition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Combined result of a full directory scan. */
export interface ScanResult {
  db: DBScanResult;
  api: APIScanResult;
  frontend: FrontendScanResult;
}

/**
 * Scan a project directory and return raw lineage data.
 * @param dir Absolute or workspace-relative path to scan.
 */
export function scanDirectory(dir: string): ScanResult {
  const absDir = path.resolve(dir);
  const allFiles = walkDir(absDir);

  const db: DBScanResult = { tables: [], relationships: [], sources: [], dtoNames: new Set() };
  const api: APIScanResult = { routes: [], sources: [] };
  const frontend: FrontendScanResult = { componentCalls: {}, sources: [] };

  // --- Pass 1: collect all DB models so API scanners can trace model references ---
  const fileContents = new Map<string, string>();
  for (const filePath of allFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    fileContents.set(filePath, content);

    const rel = path.relative(absDir, filePath);

    if (isPrismaSchema(filePath)) {
      const result = scanPrismaSchema(content, rel);
      mergeDb(db, result, rel);
    } else if (isSqlFile(filePath)) {
      const result = scanSqlDdl(content, rel);
      mergeDb(db, result, rel);
    } else if (isOrmModel(filePath, content)) {
      const result = scanOrmModel(content, rel);
      mergeDb(db, result, rel);
    } else if (filePath.endsWith(".py")) {
      // Also scan Python files for transient DTO classes even if they are not
      // ORM model files (e.g. schemas.py, requests.py, payloads.py).
      const dtos = scanPythonDtoClasses(content);
      for (const d of dtos) db.dtoNames!.add(d);
    }
  }

  // Build the known model name list once DB scan is complete
  const knownModels = db.tables.map((t) => t.name);

  // --- Pass 2: scan API routes and frontend, now with model names available ---
  for (const [filePath, content] of fileContents) {
    const rel = path.relative(absDir, filePath);

    if (isExpressRouter(filePath, content)) {
      const result = scanExpressRouter(content, rel, knownModels);
      mergeApi(api, result, rel);
    }
    if (isNextJsRoute(filePath)) {
      const result = scanNextJsRoute(content, rel, filePath, knownModels);
      mergeApi(api, result, rel);
    }
    if (isFastApiFile(filePath, content)) {
      const dtoToModel = buildDtoToModelMap(content, knownModels);
      const result = scanFastApiRoutes(content, rel, knownModels, dtoToModel);
      mergeApi(api, result, rel);
    }

    if (isFrontendFile(filePath)) {
      const result = scanFrontendCalls(content, rel);
      mergeFrontend(frontend, result, rel);
    }
  }

  return { db, api, frontend };
}

// ---------------------------------------------------------------------------
// File classification helpers
// ---------------------------------------------------------------------------

function isPrismaSchema(filePath: string): boolean {
  return filePath.endsWith("schema.prisma") || filePath.endsWith(".prisma");
}

function isSqlFile(filePath: string): boolean {
  return filePath.endsWith(".sql");
}

function isOrmModel(filePath: string, content: string): boolean {
  // TypeORM: files containing @Entity decorator
  // Sequelize: files calling Model.define() or extending Model
  // SQLModel/SQLAlchemy: Python classes inheriting from SQLModel, Base, or DeclarativeBase
  const TYPEORM_RE = /@Entity\s*\(/;
  const SEQUELIZE_RE = /sequelize\.define\s*\(|extends\s+Model\s*\{/;
  const SQLMODEL_RE = /class\s+\w+\s*\([^)]*(?:SQLModel|Base|DeclarativeBase)[^)]*\)/;
  return (
    ((filePath.endsWith(".ts") || filePath.endsWith(".js")) &&
      (TYPEORM_RE.test(content) || SEQUELIZE_RE.test(content))) ||
    (filePath.endsWith(".py") && SQLMODEL_RE.test(content))
  );
}

function isExpressRouter(filePath: string, content: string): boolean {
  // Files importing express Router or calling router.get/post/put/delete/patch
  const ROUTER_RE = /express\.Router\s*\(\)|router\.(get|post|put|delete|patch)\s*\(/;
  return (filePath.endsWith(".ts") || filePath.endsWith(".js")) && ROUTER_RE.test(content);
}

function isNextJsRoute(filePath: string): boolean {
  // Next.js app router: app/**/route.ts or route.js
  // Next.js pages router: pages/api/**/*.ts or *.js
  const NEXT_ROUTE_RE = /(pages[\\/]api[\\/]|app[\\/].*[\\/]route)\.(ts|js)$/;
  return NEXT_ROUTE_RE.test(filePath);
}

function isFastApiFile(filePath: string, content: string): boolean {
  // Python files using FastAPI @app.get / @router.get decorators
  const FASTAPI_RE = /@(app|router)\.(get|post|put|delete|patch)\s*\(/;
  return filePath.endsWith(".py") && FASTAPI_RE.test(content);
}

function isFrontendFile(filePath: string): boolean {
  return (
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".jsx") ||
    (filePath.endsWith(".ts") && !filePath.includes("node_modules")) ||
    (filePath.endsWith(".js") && !filePath.includes("node_modules"))
  );
}

// ---------------------------------------------------------------------------
// DB Scanners
// ---------------------------------------------------------------------------

/**
 * Scan a Prisma schema file.
 * Matches: `model ModelName { ... }` blocks.
 * Extracts field names, types, @id and @relation annotations.
 */
export function scanPrismaSchema(
  content: string,
  _filePath: string,
): { tables: TableDefinition[]; relationships: ERRelationship[] } {
  // Matches a full Prisma model block: `model Name { ... }`
  const MODEL_BLOCK_RE = /model\s+(\w+)\s*\{([^}]*)\}/g;
  // Matches a field line: `fieldName  FieldType  @id  @relation(...)`
  const FIELD_RE = /^\s+(\w+)\s+([\w?[\]]+)(.*)?$/;
  // Matches @relation(fields: [...], references: [...]) to extract FK target
  const RELATION_RE = /@relation\s*\([^)]*references:\s*\[(\w+)\][^)]*\)/;

  const tables: TableDefinition[] = [];
  const relationships: ERRelationship[] = [];

  let modelMatch: RegExpExecArray | null;
  while ((modelMatch = MODEL_BLOCK_RE.exec(content)) !== null) {
    const modelName = modelMatch[1] ?? "";
    const body = modelMatch[2] ?? "";
    const columns: ColumnMeta[] = [];

    for (const rawLine of body.split("\n")) {
      const fieldMatch = FIELD_RE.exec(rawLine);
      if (!fieldMatch) continue;

      const name = fieldMatch[1] ?? "";
      const rawType = fieldMatch[2] ?? "";
      const annotations = fieldMatch[3] ?? "";
      // Strip Prisma nullable `?` and array `[]` from type
      const type = rawType.replace(/[?[\]]/g, "");
      const nullable = rawType.includes("?");
      const primaryKey = annotations.includes("@id");

      const col: ColumnMeta = { name, type, nullable, primaryKey };

      // Detect FK from @relation annotation on the field
      const relMatch = RELATION_RE.exec(annotations);
      if (relMatch) {
        relationships.push({
          from: modelName,
          to: type,
          cardinality: "||--o{",
          label: name,
        });
        col.foreignKey = { referencesTable: type, referencesColumn: relMatch[1] ?? "" };
      }

      columns.push(col);
    }

    tables.push({ name: modelName, columns });
  }

  return { tables, relationships };
}

/**
 * Scan SQL DDL files.
 * Matches: `CREATE TABLE tableName ( ... )` blocks.
 * Extracts column names, types, PRIMARY KEY, and FOREIGN KEY constraints.
 */
export function scanSqlDdl(
  content: string,
  _filePath: string,
): { tables: TableDefinition[]; relationships: ERRelationship[] } {
  // Matches: CREATE TABLE [IF NOT EXISTS] `name` ( ... );
  const CREATE_TABLE_RE =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(([^;]*)\)/gis;
  // Matches a column definition line: `colName TYPE [constraints...]`
  const COLUMN_DEF_RE = /^\s*[`"]?(\w+)[`"]?\s+(\w+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/;
  // Matches: FOREIGN KEY (col) REFERENCES table(refCol)
  const FK_RE =
    /FOREIGN\s+KEY\s*\([`"]?(\w+)[`"]?\)\s+REFERENCES\s+[`"]?(\w+)[`"]?\s*\([`"]?(\w+)[`"]?\)/gi;
  // Matches: PRIMARY KEY (col) or column-level PRIMARY KEY
  const PK_RE = /PRIMARY\s+KEY/i;

  const tables: TableDefinition[] = [];
  const relationships: ERRelationship[] = [];

  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = CREATE_TABLE_RE.exec(content)) !== null) {
    const tableName = tableMatch[1] ?? "";
    const body = tableMatch[2] ?? "";
    const columns: ColumnMeta[] = [];
    const fkMap = new Map<string, { referencesTable: string; referencesColumn: string }>();

    // Extract FK constraints from the block
    let fkMatch: RegExpExecArray | null;
    FK_RE.lastIndex = 0;
    while ((fkMatch = FK_RE.exec(body)) !== null) {
      const col = fkMatch[1] ?? "";
      const refTable = fkMatch[2] ?? "";
      const refCol = fkMatch[3] ?? "";
      fkMap.set(col.toLowerCase(), { referencesTable: refTable, referencesColumn: refCol });
      relationships.push({
        from: tableName,
        to: refTable,
        cardinality: "||--o{",
        label: col,
      });
    }

    // Parse column definitions (skip CONSTRAINT / PRIMARY KEY / FOREIGN KEY lines)
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|KEY)\b/i.test(line)) {
        continue;
      }
      const colMatch = COLUMN_DEF_RE.exec(line);
      if (!colMatch) continue;

      const colName = colMatch[1] ?? "";
      const colType = colMatch[2] ?? "";
      const primaryKey = PK_RE.test(line) || line.toUpperCase().includes("PRIMARY KEY");
      const nullable = !line.toUpperCase().includes("NOT NULL") && !primaryKey;
      const fkInfo = fkMap.get(colName.toLowerCase());

      columns.push({
        name: colName,
        type: colType,
        nullable,
        primaryKey,
        foreignKey: fkInfo,
      });
    }

    tables.push({ name: tableName, columns });
  }

  return { tables, relationships };
}

// ---------------------------------------------------------------------------
// Python DTO / Schema classification
// ---------------------------------------------------------------------------

/** Name suffixes that definitively mark a class as a DTO regardless of base class. */
const DTO_SUFFIX_RE = /(?:Request|Response|Schema|Payload|DTO|Create|Update|Read|Out|In)$/;

/**
 * Returns true when `bases` is the parenthesised inheritance list of a class
 * that is a persistent ORM model:
 *   - `SQLModel` + `table=True` somewhere on the same line
 *   - Inherits `Base` or `DeclarativeBase` but NOT `BaseModel`
 *
 * Note: we must not confuse `Base` with `BaseModel` — use a word-boundary anchor.
 */
function isPersistentClass(classLine: string): boolean {
  // SQLModel with table=True
  if (/SQLModel/.test(classLine) && /table\s*=\s*True/.test(classLine)) return true;
  // DeclarativeBase (exact word)
  if (/\bDeclarativeBase\b/.test(classLine)) return true;
  // Base — word boundary, but NOT BaseModel
  if (/\bBase\b/.test(classLine) && !/\bBaseModel\b/.test(classLine)) return true;
  return false;
}

/**
 * Scan a Python file for transient DTO/schema class names.
 * Returns the names of classes that are purely transient (not DB-backed tables).
 *
 * Detection rules (any of the following → DTO):
 *  1. Inherits from `BaseModel`
 *  2. Inherits from `SQLModel` without `table=True`
 *  3. Class name ends with a DTO suffix (Request/Response/Schema/Payload/DTO/Create/…)
 *
 * Safety: if the same file also has persistent classes, those are never tagged as DTOs.
 */
export function scanPythonDtoClasses(content: string): string[] {
  const dtos = new Set<string>();
  const persistent = new Set<string>();

  // Walk every `class Name(bases):` line in the file
  // Use a fresh local regex — avoids shared /g state issues
  const CLASS_LINE_RE = /^class\s+(\w+)\s*\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = CLASS_LINE_RE.exec(content)) !== null) {
    const name = m[1] ?? "";
    const bases = m[2] ?? "";

    if (isPersistentClass(`class ${name}(${bases})`)) {
      persistent.add(name);
      continue;
    }

    // DTO by inheritance
    if (/\bBaseModel\b/.test(bases) || (bases.trim() === "SQLModel" && !/table\s*=\s*True/.test(bases))) {
      dtos.add(name);
      continue;
    }

    // DTO by name suffix
    if (DTO_SUFFIX_RE.test(name)) {
      dtos.add(name);
    }
  }

  // Subtract anything we also identified as persistent (safety net)
  for (const p of persistent) dtos.delete(p);

  return Array.from(dtos).filter(Boolean);
}

/**
 * Build a mapping of DTO class name → underlying persistent model name.
 *
 * When a DTO is named `VolunteerCreate` and there is a known model `Volunteer`,
 * this function records `VolunteerCreate → Volunteer`.  The mapping is then
 * used in `scanFastApiRoutes` to resolve DTO parameters to real DB models.
 *
 * Strategy:
 *  1. Strip common DTO suffixes from the class name and look for a prefix
 *     match against knownModels (case-insensitive).
 *  2. Additionally, scan the DTO class body for `model_class = SomeModel` or
 *     `orm_mode` / `from_orm` usage to find explicit references.
 */
export function buildDtoToModelMap(
  content: string,
  knownModels: string[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (knownModels.length === 0) return map;

  const dtoNames = scanPythonDtoClasses(content);
  const modelLower = knownModels.map((m) => ({ original: m, lower: m.toLowerCase() }));

  for (const dtoName of dtoNames) {
    // Strip suffix to get a stem, e.g. "VolunteerCreate" → "Volunteer"
    const stem = dtoName.replace(
      /(?:Request|Response|Schema|Payload|DTO|Create|Update|Read|Out|In|List|Detail)$/,
      "",
    );
    const stemLower = stem.toLowerCase();

    // Exact prefix match
    const hit = modelLower.find(
      (ml) => ml.lower === stemLower || ml.lower.startsWith(stemLower) || stemLower.startsWith(ml.lower),
    );
    if (hit) {
      map.set(dtoName, hit.original);
    }
  }

  return map;
}

/**
 * Scan SQLModel / SQLAlchemy Python model files.
 *
 * Handles both styles:
 *   - SQLModel:      `class User(SQLModel, table=True):`
 *   - SQLAlchemy v2: `class User(Base):`  or  `class User(DeclarativeBase):`
 *
 * Extracts field names, types (from type annotations and `Column(...)` calls),
 * primary keys, and ForeignKey relationships.
 *
 * Only persistent (table-backed) classes are returned as `tables`.
 * Transient DTO/schema classes are silently skipped.
 */
export function scanSqlAlchemyModel(
  content: string,
  _filePath: string,
): { tables: TableDefinition[]; relationships: ERRelationship[] } {
  const tables: TableDefinition[] = [];
  const relationships: ERRelationship[] = [];

  // Match a class definition. We grab every `class Name(bases):` and then
  // filter with isPersistentClass() below.
  //
  // Note: do NOT use the `m` flag with $ in the lookahead — in multiline mode
  // $ matches end of each line which would truncate the body. Use a non-multiline
  // `\nclass` lookahead only (no $).  The final class in the file is captured by
  // the fallback that extends to the end of the string.
  const CLASS_HEADER_RE = /class\s+(\w+)\s*\(([^)]*)\)\s*:/g;

  // Match annotated field: `  field_name: Optional[Type] = ...` or `  field_name: Type`
  // Also handles `  field_name: type = Field(...)` (SQLModel) and `Column(...)` (SA)
  // Rules:
  //  - [^\S\n]{2,8}: indent (spaces/tabs only, NOT newline) — prevents the regex from
  //    consuming a leading \n and then matching mid-word on the next line.
  //  - [^\S\n]* between the type token and optional `=`: same reason — don't eat newlines.
  const FIELD_RE =
    /^[^\S\n]{2,8}(\w+)[^\S\n]*:[^\S\n]*(Optional\[)?(\w+)\]?[^\S\n]*(?:=[^\S\n]*(?:Field|Column|mapped_column)\s*\(([^)]*)\))?/gm;

  // Match `ForeignKey("table.col")` or `ForeignKey('table.col')`
  const FK_INNER_RE = /ForeignKey\s*\(\s*['"](\w+)\.(\w+)['"]/;
  // Match `primary_key=True` inside Field/Column/mapped_column
  const PK_ATTR_RE = /primary_key\s*=\s*True/;

  let classMatch: RegExpExecArray | null;
  while ((classMatch = CLASS_HEADER_RE.exec(content)) !== null) {
    const className = classMatch[1] ?? "";
    const bases = classMatch[2] ?? "";

    // Skip transient DTOs — only process persistent ORM models
    if (!isPersistentClass(`class ${className}(${bases})`)) continue;

    // Extract body: from after this match's `:` to the start of the next `class` keyword
    const bodyStart = classMatch.index + classMatch[0].length;
    const nextClassIdx = content.indexOf("\nclass ", bodyStart);
    const body = nextClassIdx === -1
      ? content.slice(bodyStart)
      : content.slice(bodyStart, nextClassIdx);

    const columns: ColumnMeta[] = [];

    FIELD_RE.lastIndex = 0;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = FIELD_RE.exec(body)) !== null) {
      const fieldName = fieldMatch[1] ?? "";
      // Skip dunder / class-level names and common non-column attrs
      if (fieldName.startsWith("__") || fieldName === "model_config") continue;
      const rawType = fieldMatch[3] ?? "str";
      const fieldAttrs = fieldMatch[4] ?? "";

      const primaryKey = PK_ATTR_RE.test(fieldAttrs);
      const nullable = (fieldMatch[2] !== undefined); // Optional[...] wrapper present

      const col: ColumnMeta = { name: fieldName, type: rawType, nullable, primaryKey };

      // Detect ForeignKey
      const fkMatch = FK_INNER_RE.exec(fieldAttrs);
      if (fkMatch) {
        const refTable = fkMatch[1] ?? "";
        const refCol = fkMatch[2] ?? "";
        col.foreignKey = { referencesTable: refTable, referencesColumn: refCol };
        relationships.push({
          from: className,
          to: refTable,
          cardinality: "||--o{",
          label: fieldName,
        });
      }

      columns.push(col);
    }

    if (columns.length > 0) {
      tables.push({ name: className, columns });
    }
  }

  return { tables, relationships };
}

/**
 * Scan TypeORM / Sequelize model files.
 * TypeORM: extracts @Entity + @Column / @PrimaryGeneratedColumn / @ManyToOne etc.
 * Sequelize: extracts Model.define() field definitions.
 * Python SQLModel/SQLAlchemy: delegated to scanSqlAlchemyModel.
 */
export function scanOrmModel(
  content: string,
  filePath: string,
): { tables: TableDefinition[]; relationships: ERRelationship[] } {
  // Delegate Python files to the SQLAlchemy/SQLModel scanner
  if (filePath.endsWith(".py")) {
    return scanSqlAlchemyModel(content, filePath);
  }
  const tables: TableDefinition[] = [];
  const relationships: ERRelationship[] = [];

  // --- TypeORM path ---
  // Matches: class ClassName (where @Entity appears somewhere before it in the file)
  const TYPEORM_CLASS_RE = /@Entity[^]*?class\s+(\w+)/g;
  // Matches @PrimaryGeneratedColumn or @Column decorated fields
  const TYPEORM_FIELD_RE =
    /@(PrimaryGeneratedColumn|PrimaryColumn|Column|ManyToOne|OneToMany|ManyToMany|JoinColumn)[^]*?\n\s+(\w+)(?:\??:\s*(\w+))?/g;

  let entityMatch: RegExpExecArray | null;
  while ((entityMatch = TYPEORM_CLASS_RE.exec(content)) !== null) {
    const className = entityMatch[1] ?? "";
    const columns: ColumnMeta[] = [];

    // Search for decorated fields in the class body (rough window)
    const classBody = content.slice(entityMatch.index);
    let fieldMatch: RegExpExecArray | null;
    TYPEORM_FIELD_RE.lastIndex = 0;
    while ((fieldMatch = TYPEORM_FIELD_RE.exec(classBody)) !== null) {
      const decorator = fieldMatch[1] ?? "";
      const fieldName = fieldMatch[2] ?? "";
      const fieldType = fieldMatch[3] ?? "any";
      const isRelation = ["ManyToOne", "OneToMany", "ManyToMany"].includes(decorator);
      const primaryKey = decorator.includes("Primary");

      if (isRelation) {
        relationships.push({
          from: className,
          to: fieldType,
          cardinality: "||--o{",
          label: fieldName,
        });
        continue;
      }

      columns.push({ name: fieldName, type: fieldType, nullable: false, primaryKey });
    }

    if (columns.length > 0) {
      tables.push({ name: className, columns });
    }
  }

  // --- Sequelize path ---
  // Matches: sequelize.define('ModelName', { ... })
  const SEQ_DEFINE_RE =
    /(?:sequelize|Sequelize)\.define\s*\(\s*['"](\w+)['"]\s*,\s*\{([^}]*)\}/g;
  const SEQ_FIELD_RE = /(\w+)\s*:\s*\{[^}]*type\s*:\s*DataTypes\.(\w+)/g;

  let defineMatch: RegExpExecArray | null;
  while ((defineMatch = SEQ_DEFINE_RE.exec(content)) !== null) {
    const modelName = defineMatch[1] ?? "";
    const fieldsBody = defineMatch[2] ?? "";
    const columns: ColumnMeta[] = [];

    let fieldMatch: RegExpExecArray | null;
    SEQ_FIELD_RE.lastIndex = 0;
    while ((fieldMatch = SEQ_FIELD_RE.exec(fieldsBody)) !== null) {
      const fieldName = fieldMatch[1] ?? "";
      const dataType = fieldMatch[2] ?? "";
      columns.push({ name: fieldName, type: dataType, nullable: true, primaryKey: false });
    }

    if (columns.length > 0) {
      tables.push({ name: modelName, columns });
    }
  }

  return { tables, relationships };
}

// ---------------------------------------------------------------------------
// Handler-to-Model tracing helpers
// ---------------------------------------------------------------------------

/**
 * Extract DB model/table names referenced inside a handler body (or full file).
 *
 * Covers:
 *  - TypeScript/JS:
 *    - Prisma:   `prisma.modelName.findMany(...)`, `prisma.modelName.create(...)` etc.
 *    - TypeORM:  `db.query(ModelName)`, `repository.find()` preceded by `getRepository(ModelName)`
 *    - Imports:  `import { ModelName } from '...'`, `require('...ModelName...')`
 *    - Generic usage: any identifier that matches a known model name
 *  - Python/FastAPI:
 *    - SQLModel/SQLAlchemy: `select(ModelName)`, `session.get(ModelName, ...)`,
 *      `session.exec(select(ModelName))`, `db.query(ModelName)`, `db.add(ModelName(...))`
 *    - Pydantic/return annotations: `-> ModelName`, `-> list[ModelName]`,
 *      `response_model=ModelName`, `-> Optional[ModelName]`
 *    - Import lines: `from models import ModelName`
 *
 * @param body     The source text to scan (handler function body or full file).
 * @param knownModels  Array of known model/table names from the DB scan.
 * @returns Deduplicated list of matched model names.
 */
export function extractHandlerModels(body: string, knownModels: string[]): string[] {
  if (knownModels.length === 0) return [];
  const found = new Set<string>();

  for (const model of knownModels) {
    // Build patterns that look for the exact identifier (word-boundary match).
    // We test each model individually to keep the logic simple and readable.
    const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // TS/JS — Prisma client: `prisma.modelName` (camelCase accessor)
    const prismaCamel = model.charAt(0).toLowerCase() + model.slice(1);
    const escapedCamel = prismaCamel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\bprisma\\.${escapedCamel}\\b`).test(body)) {
      found.add(model);
      continue;
    }

    // TS/JS — ORM generic: `getRepository(Model)`, `db.query(Model)`,
    //          `repo.find()` where repo was typed as `Repository<Model>`
    if (
      new RegExp(
        `\\b(?:getRepository|Repository|db\\.query|db\\.getRepository)\\s*[<(]\\s*${escaped}[\\s,>)]`,
      ).test(body)
    ) {
      found.add(model);
      continue;
    }

    // Python — ORM select / session queries: `select(Model)`, `session.get(Model`,
    //          `db.query(Model)`, `db.add(Model(`, `db.add(model_instance`
    if (
      new RegExp(
        `\\b(?:select|session\\.get|session\\.exec\\(select|db\\.query|db\\.add|db\\.merge)\\s*\\(\\s*${escaped}[\\s,)]`,
      ).test(body)
    ) {
      found.add(model);
      continue;
    }

    // Python — Pydantic/FastAPI response_model or return type annotation
    if (
      new RegExp(
        `(?:response_model\\s*=\\s*(?:List\\[)?${escaped}|->\\s*(?:Optional\\[|list\\[|List\\[)?${escaped})`,
      ).test(body)
    ) {
      found.add(model);
      continue;
    }

    // Python — function parameter type annotation: `item: Model` or `items: List[Model]`
    if (new RegExp(`:\\s*(?:Optional\\[|List\\[|list\\[)?${escaped}[\\]\\s,)]`).test(body)) {
      found.add(model);
      continue;
    }

    // TS/JS — import statement: `import { Model }` or `import Model`
    if (new RegExp(`\\bimport\\b[^\\n]*\\b${escaped}\\b`).test(body)) {
      found.add(model);
      continue;
    }

    // Python — import statement: `from ... import Model` or `import Model`
    if (new RegExp(`^(?:from\\s+\\S+\\s+)?import\\s+[^\\n]*\\b${escaped}\\b`, "m").test(body)) {
      found.add(model);
      continue;
    }

    // Fallback — bare identifier usage (any word-boundary occurrence).
    // Applied last to avoid false positives on short model names.
    if (model.length >= 4 && new RegExp(`\\b${escaped}\\b`).test(body)) {
      found.add(model);
    }
  }

  return Array.from(found);
}

/**
 * Extract the body of a named function/async function from source text.
 * Returns the entire slice from the function's opening brace to the matching
 * closing brace (or the rest of the file when braces are unbalanced).
 * For Python `def` functions, returns the indented block after the `:`.
 */
function extractFunctionBody(content: string, funcName: string, isPython = false): string {
  if (isPython) {
    // Match `def funcName(`:  grab everything indented after the colon
    const defRe = new RegExp(`def\\s+${funcName}\\s*\\([^)]*\\)[^:]*:([\\s\\S]*?)(?=\\ndef\\s|\\nclass\\s|$)`);
    const m = defRe.exec(content);
    return m ? (m[1] ?? "") : "";
  }

  // JS/TS: find `function funcName` or `funcName = async (...) =>`
  const startRe = new RegExp(
    `(?:(?:async\\s+)?function\\s+${funcName}\\s*\\(|(?:const|let|var)\\s+${funcName}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|\\w+)\\s*=>)`,
  );
  const startMatch = startRe.exec(content);
  if (!startMatch) return "";

  // Scan forward from match end to find the function body (opening brace)
  let i = startMatch.index + startMatch[0].length;
  while (i < content.length && content[i] !== "{") i++;
  if (i >= content.length) return "";

  // Walk balanced braces
  let depth = 0;
  const start = i;
  while (i < content.length) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  return content.slice(start, i + 1);
}

// ---------------------------------------------------------------------------
// API Scanners
// ---------------------------------------------------------------------------

/**
 * Scan an Express router file.
 * Matches: router.get('/path', handler) or app.post('/path', ...)
 * Extracts HTTP method, path, handler function reference, and DB models used.
 *
 * @param content     File source text.
 * @param filePath    Relative file path (used to derive fallback handler names).
 * @param knownModels Known DB model names from the DB scan (for model tracing).
 */
export function scanExpressRouter(
  content: string,
  filePath: string,
  knownModels: string[] = [],
): { routes: APIRoute[] } {
  // Matches: router.METHOD('path', ...handler) or app.METHOD('path', ...)
  // Captures: method, path string, optional handler name
  const ROUTE_RE =
    /(?:router|app)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`](\/[^'"`]*?)['"`]\s*,\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\s*\w*\s*\(|(\w+))/gi;

  const routes: APIRoute[] = [];
  let match: RegExpExecArray | null;

  while ((match = ROUTE_RE.exec(content)) !== null) {
    const method = match[1] ?? "";
    const routePath = match[2] ?? "";
    const handlerRef = match[3];
    const handlerName = handlerRef ?? deriveHandlerFromPath(routePath, filePath);

    // Trace models: if handler is an external ref (e.g. `userController.list`),
    // search the whole file; otherwise try to extract the inline function body.
    let searchText = content;
    if (!handlerRef) {
      // Inline callback — capture the slice after this decorator position
      searchText = content.slice(match.index);
    } else if (!handlerRef.includes(".")) {
      // Named local function — extract its body
      const body = extractFunctionBody(content, handlerRef);
      if (body) searchText = body;
    }

    routes.push({
      method: method.toUpperCase() as HttpMethod,
      path: routePath,
      handler: handlerName,
      description: "",
      dbTables: extractHandlerModels(searchText, knownModels),
    });
  }

  return { routes };
}

/**
 * Scan a Next.js route file (app router or pages/api).
 * App router: exports named functions GET, POST, PUT, PATCH, DELETE.
 * Pages router: exports default handler, checks req.method.
 *
 * @param content     File source text.
 * @param relPath     Relative file path.
 * @param absPath     Absolute file path (used for URL derivation).
 * @param knownModels Known DB model names from the DB scan (for model tracing).
 */
export function scanNextJsRoute(
  content: string,
  relPath: string,
  absPath: string,
  knownModels: string[] = [],
): { routes: APIRoute[] } {
  const routes: APIRoute[] = [];
  const urlPath = deriveNextJsUrlPath(absPath);

  // App router: export async function GET(request: Request)
  const APP_HANDLER_RE =
    /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = APP_HANDLER_RE.exec(content)) !== null) {
    const method = match[1] ?? "";
    const body = extractFunctionBody(content, method);
    routes.push({
      method: method as HttpMethod,
      path: urlPath,
      handler: `${relPath}#${method}`,
      description: "",
      dbTables: extractHandlerModels(body || content, knownModels),
    });
  }

  // Pages router: req.method === 'POST' etc.
  const PAGES_METHOD_RE = /req\.method\s*===?\s*['"](\w+)['"]/g;
  while ((match = PAGES_METHOD_RE.exec(content)) !== null) {
    const method = (match[1] ?? "").toUpperCase() as HttpMethod;
    if (!routes.find((r) => r.method === method && r.path === urlPath)) {
      routes.push({
        method,
        path: urlPath,
        handler: `${relPath}#handler`,
        description: "",
        dbTables: extractHandlerModels(content, knownModels),
      });
    }
  }

  // Pages router fallback — no method checks found, assume GET
  if (routes.length === 0 && content.includes("export default")) {
    routes.push({
      method: "GET",
      path: urlPath,
      handler: `${relPath}#default`,
      description: "",
      dbTables: extractHandlerModels(content, knownModels),
    });
  }

  return { routes };
}

/**
 * Scan a FastAPI Python file.
 * Matches: @app.get('/path') or @router.post('/path')
 *
 * @param content     File source text.
 * @param filePath    Relative file path (used to derive fallback handler names).
 * @param knownModels Known DB model names from the DB scan (for model tracing).
 * @param dtoToModel  Optional map of DTO class name → persistent model name.
 *                    When provided, DTO parameters in function signatures are
 *                    resolved to their underlying persistent model.
 */
export function scanFastApiRoutes(
  content: string,
  filePath: string,
  knownModels: string[] = [],
  dtoToModel: Map<string, string> = new Map(),
): { routes: APIRoute[] } {
  // Matches: @(app|router).method('/path') optionally with response_model etc.
  const FASTAPI_RE =
    /@(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/gi;
  // Matches the function name after the decorator block
  const FUNC_NAME_RE = /def\s+(\w+)\s*\(/;

  const routes: APIRoute[] = [];
  let match: RegExpExecArray | null;

  while ((match = FASTAPI_RE.exec(content)) !== null) {
    const method = match[1] ?? "";
    const routePath = match[2] ?? "";
    // Find the function name after this match position
    const afterDecorator = content.slice(match.index + match[0].length);
    const funcMatch = FUNC_NAME_RE.exec(afterDecorator);
    const handlerName = funcMatch
      ? (funcMatch[1] ?? deriveHandlerFromPath(routePath, filePath))
      : deriveHandlerFromPath(routePath, filePath);

    // Extract handler body for precise model tracing
    const body = funcMatch
      ? extractFunctionBody(content, handlerName, true)
      : "";

    // Search handler body + file-level imports (imports are outside the function body)
    const importBlock = extractImportBlock(content);
    const searchText = importBlock + (body || content);

    // Direct model matches from body/imports
    const directModels = extractHandlerModels(searchText, knownModels);

    // Resolve DTO parameter types → underlying persistent model
    // E.g. `payload: ClaimItemRequest` → `ClaimItemRequest` → `ClaimItem` (if in knownModels)
    //      or `payload: VolunteerCreate` → `Volunteer`
    const resolvedFromDto: string[] = [];
    if (dtoToModel.size > 0) {
      const funcSig = funcMatch ? (afterDecorator.slice(0, afterDecorator.indexOf(":") + 200)) : "";
      for (const [dtoName, modelName] of dtoToModel) {
        const escapedDto = dtoName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Match `: DtoName` or `: List[DtoName]` in function signature or body
        if (
          new RegExp(`:\\s*(?:List\\[|list\\[)?${escapedDto}[\\]\\s,)]`).test(funcSig + searchText)
        ) {
          if (!directModels.includes(modelName)) {
            resolvedFromDto.push(modelName);
          }
        }
      }
    }

    routes.push({
      method: method.toUpperCase() as HttpMethod,
      path: routePath,
      handler: handlerName,
      description: "",
      dbTables: [...directModels, ...resolvedFromDto],
    });
  }

  return { routes };
}

/**
 * Extract the import/from-import lines at the top of a Python file.
 * Used to supplement handler body analysis so that models imported at module
 * level are still associated with handlers that use them.
 */
function extractImportBlock(content: string): string {
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    if (/^\s*(?:import|from)\s/.test(line)) {
      lines.push(line);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Frontend Scanner
// ---------------------------------------------------------------------------

/**
 * Scan a frontend file for API calls.
 *
 * Detection strategies (in order):
 *  1. Direct `fetch('/api/...')` or `fetch(\`/api/...\`)` — literal and template literal
 *  2. `axios.get/post/...('/api/...')` — axios method calls
 *  3. `axios({ url: '/api/...' })` — axios config object
 *  4. `useSWR('/api/...')` / `useQuery('/api/...')` / `useFetch('/api/...')` hooks
 *  5. Named API helper calls: `api.get(...)`, `apiClient.post(...)`, `client.post(...)`,
 *     `request.get(...)` — where the callee is a well-known API wrapper identifier
 *  6. Template literal paths: `` `/api/items/${id}/claim` `` → normalised to
 *     `/api/items/:id/claim`
 *
 * Returns: component name (derived from file) → deduplicated list of API paths called.
 */
export function scanFrontendCalls(
  content: string,
  filePath: string,
): { componentCalls: Record<string, string[]> } {
  const componentName = deriveComponentName(filePath);
  const calls = new Set<string>();

  // Helper: add a URL if it looks like an API path
  function addIfApi(url: string): void {
    const norm = normaliseApiPath(url);
    if (norm) calls.add(norm);
  }

  // 1. fetch('...')  — literal strings
  const FETCH_LIT_RE = /\bfetch\s*\(\s*'([^']+)'/g;
  const FETCH_DQ_RE = /\bfetch\s*\(\s*"([^"]+)"/g;
  for (const re of [FETCH_LIT_RE, FETCH_DQ_RE]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) addIfApi(m[1] ?? "");
  }

  // 2. fetch(`/api/.../...`) — template literal (may contain ${...} expressions)
  const FETCH_TMPL_RE = /\bfetch\s*\(\s*`([^`]+)`/g;
  {
    let m: RegExpExecArray | null;
    while ((m = FETCH_TMPL_RE.exec(content)) !== null) addIfApi(m[1] ?? "");
  }

  // 3. axios.METHOD('...')
  const AXIOS_METHOD_RE =
    /\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  {
    let m: RegExpExecArray | null;
    while ((m = AXIOS_METHOD_RE.exec(content)) !== null) addIfApi(m[1] ?? "");
  }

  // 4. axios({ url: '...' })
  const AXIOS_OBJ_RE = /\baxios\s*\(\s*\{[^}]*url\s*:\s*['"`]([^'"`]+)['"`]/g;
  {
    let m: RegExpExecArray | null;
    while ((m = AXIOS_OBJ_RE.exec(content)) !== null) addIfApi(m[1] ?? "");
  }

  // 5. React data-fetching hooks: useSWR / useQuery / useFetch / useInfiniteQuery
  const HOOK_RE = /\bus(?:SWR|eQuery|eFetch|eInfiniteQuery)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  {
    let m: RegExpExecArray | null;
    while ((m = HOOK_RE.exec(content)) !== null) addIfApi(m[1] ?? "");
  }

  // 6. Named API helper instances: api.get/post/put/patch/delete/request(...)
  //    Covers patterns like: api.post('/items/claim'), apiClient.get(`/users/${id}`)
  //    Detects callee names that are common API wrapper identifiers.
  const API_HELPER_RE =
    /\b(?:api|apiClient|client|http|httpClient|request|service|fetcher)\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  {
    let m: RegExpExecArray | null;
    while ((m = API_HELPER_RE.exec(content)) !== null) addIfApi(m[1] ?? "");
  }

  // 7. Named API helper with template literal argument
  const API_HELPER_TMPL_RE =
    /\b(?:api|apiClient|client|http|httpClient|request|service|fetcher)\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(\s*`([^`]+)`/g;
  {
    let m: RegExpExecArray | null;
    while ((m = API_HELPER_TMPL_RE.exec(content)) !== null) addIfApi(m[1] ?? "");
  }

  // 8. Standalone helper functions that look like API wrappers:
  //    claimItem(), donateSol(), onboardUser() — named action calls where
  //    the file imports from an api/services module and the function name
  //    maps to an endpoint path heuristically.
  //    We detect: `import { claimItem, ... } from '...api...'` + call sites.
  if (content.includes("/api/") || content.includes("api/")) {
    const importedApiHelpers = extractApiHelperImports(content);
    for (const helper of importedApiHelpers) {
      // Convert camelCase helper name to a likely API path
      // e.g. claimItem → /items/claim, donateSol → /donate-sol, onboard → /onboard
      const guessedPath = camelToApiPath(helper);
      if (guessedPath) calls.add(guessedPath);
    }
  }

  if (calls.size === 0) return { componentCalls: {} };
  return { componentCalls: { [componentName]: Array.from(calls) } };
}

/**
 * Normalise a URL string extracted from source code.
 * - Template literal expressions `${...}` → `:param`
 * - Keeps the path if it starts with `/` and looks like an API route,
 *   or if it contains `/api/`.
 * - Returns `null` for strings that are not API paths.
 */
function normaliseApiPath(raw: string): string | null {
  // Replace template literal interpolations with a path parameter placeholder
  const normalised = raw.replace(/\$\{[^}]*\}/g, ":param");
  if (normalised.startsWith("/") || normalised.includes("/api/")) {
    return normalised;
  }
  return null;
}

/**
 * Extract names of API helper functions that are imported from api/service modules.
 * e.g. `import { claimItem, donateSol } from '../api/items'`
 * → returns ["claimItem", "donateSol"]
 */
function extractApiHelperImports(content: string): string[] {
  const helpers: string[] = [];
  // Match: import { name1, name2 } from '...api...' or '...service...'
  const IMPORT_RE =
    /import\s*\{([^}]+)\}\s*from\s*['"`][^'"`]*(?:api|service|client|fetch|http)[^'"`]*['"`]/gi;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const names = (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
      .filter((s) => s.length > 0 && /^[a-z]/.test(s)); // camelCase only
    helpers.push(...names);
  }
  return helpers;
}

/**
 * Heuristically convert a camelCase API helper name to a likely URL path.
 * Examples:
 *   claimItem    → /items/claim
 *   donateSol    → /donate-sol
 *   onboardUser  → /onboard
 *   getVolunteer → /volunteers
 *   listMissions → /missions
 */
function camelToApiPath(name: string): string | null {
  // Strip common leading verbs: get, list, fetch, load, create, update, delete, do, send
  const withoutVerb = name.replace(
    /^(?:get|list|fetch|load|create|update|delete|remove|add|send|submit|do|post|put|patch)\b/i,
    "",
  );
  if (!withoutVerb) return null;

  // Convert PascalCase remainder to kebab segments
  // e.g. "VolunteerOffer" → "volunteer-offer", "Sol" → "sol"
  const kebab = withoutVerb
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");

  return `/${kebab}`;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Recursively walk a directory, returning all file paths. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip hidden dirs, node_modules, dist, .next, __pycache__
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === ".next" ||
      entry.name === "__pycache__"
    ) {
      continue;
    }

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }

  return results;
}

/** Derive a human-readable handler name from a route path and source file. */
function deriveHandlerFromPath(routePath: string, filePath: string): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  const lastSegment = routePath.split("/").filter(Boolean).pop() ?? "handler";
  return `${fileName}.${lastSegment.replace(/[:*]/g, "")}`;
}

/** Derive a URL path from a Next.js file path. */
function deriveNextJsUrlPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  // App router: strip everything up to and including /app/, remove /route.ts
  const appMatch = /\/app\/(.+)\/route\.[jt]s$/.exec(normalized);
  if (appMatch) return "/" + (appMatch[1] ?? "").replace(/\[([^\]]+)\]/g, ":$1");

  // Pages router: strip everything up to and including /pages/api/
  const pagesMatch = /\/pages\/api\/(.+)\.[jt]s$/.exec(normalized);
  if (pagesMatch) return "/api/" + (pagesMatch[1] ?? "").replace(/\[([^\]]+)\]/g, ":$1");

  return "/unknown";
}

/**
 * Generic filenames that carry no semantic meaning on their own.
 * When a file has one of these names, we walk up into its parent directories
 * to build a meaningful, unique PascalCase component identifier.
 *
 * Examples:
 *   src/app/(portal)/admin/page.tsx      → AdminPage
 *   src/app/(portal)/sos/page.tsx        → SosPage
 *   src/app/(portal)/page.tsx            → PortalPage   (group stripped)
 *   src/pages/dashboard/index.tsx        → DashboardIndex
 *   components/auth/layout.tsx           → AuthLayout
 */
const GENERIC_FILENAMES = new Set([
  "page", "index", "route", "view", "layout", "screen",
  "app", "main", "default", "home",
]);

function deriveComponentName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const ext = path.extname(normalized);
  const base = path.basename(normalized, ext);

  // If the basename is not generic, use it as-is (already meaningful)
  if (!GENERIC_FILENAMES.has(base.toLowerCase())) {
    return base;
  }

  // Walk up the path segments to find a meaningful prefix.
  // Strip the filename itself and collect non-trivial segments.
  const segments = normalized
    .replace(ext, "")          // remove extension
    .split("/")
    .slice(0, -1)               // remove filename segment
    .map((s) =>
      // Strip Next.js route group parens: (portal) → portal
      s.replace(/^\((.+)\)$/, "$1")
    )
    .filter((s) =>
      // Keep only alphanumeric, non-empty, non-trivial directory names
      s.length > 0 &&
      !["src", "app", "pages", "views", "components", "screens"].includes(s.toLowerCase())
    );

  // Take the last meaningful segment + the base name, PascalCase both
  const qualifier = segments.pop();
  if (!qualifier) {
    // Fallback: return the raw base if we can't derive anything better
    return base;
  }

  const toPascal = (s: string): string =>
    s
      .split(/[-_]/)
      .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : ""))
      .join("");

  return toPascal(qualifier) + toPascal(base);
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function mergeDb(
  db: DBScanResult,
  result: { tables: TableDefinition[]; relationships: ERRelationship[] },
  source: string,
): void {
  db.tables.push(...result.tables);
  db.relationships.push(...result.relationships);
  if (result.tables.length > 0 && !db.sources.includes(source)) {
    db.sources.push(source);
  }
}

function mergeApi(api: APIScanResult, result: { routes: APIRoute[] }, source: string): void {
  api.routes.push(...result.routes);
  if (result.routes.length > 0 && !api.sources.includes(source)) {
    api.sources.push(source);
  }
}

function mergeFrontend(
  frontend: FrontendScanResult,
  result: { componentCalls: Record<string, string[]> },
  source: string,
): void {
  for (const [comp, calls] of Object.entries(result.componentCalls)) {
    if (!frontend.componentCalls[comp]) {
      frontend.componentCalls[comp] = [];
    }
    const existing = frontend.componentCalls[comp];
    if (existing) {
      existing.push(...calls.filter((c) => !existing.includes(c)));
    }
  }
  if (Object.keys(result.componentCalls).length > 0 && !frontend.sources.includes(source)) {
    frontend.sources.push(source);
  }
}
