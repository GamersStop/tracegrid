/**
 * packages/core public barrel export.
 * All consumers import from this file only.
 */

// Types
export type {
  APIRoute,
  APIScanResult,
  ArchitectureSpec,
  ColumnMeta,
  DatabaseSchema,
  DBScanResult,
  ERRelationship,
  FrontendScanResult,
  HttpMethod,
  NodeKind,
  NodeTier,
  ProjectBlueprint,
  RequestFlow,
  TableDefinition,
  TraceEdge,
  TraceGraph,
  TraceNode,
} from "./types.js";
export { ParseError, ScanError } from "./types.js";

// Parser
export { buildGraph, parseArchitectureMd, parseToGraph } from "./parser.js";

// Scanner
export type { ScanResult } from "./scanner.js";
export {
  scanDirectory,
  scanExpressRouter,
  scanFastApiRoutes,
  scanFrontendCalls,
  scanNextJsRoute,
  scanOrmModel,
  scanPrismaSchema,
  scanSqlAlchemyModel,
  scanSqlDdl,
} from "./scanner.js";

// Generator
export {
  buildDirectoryTree,
  generateArchitectureMd,
  generateFromScanResults,
} from "./generator.js";
