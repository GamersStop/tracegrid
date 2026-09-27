import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArchitectureMd, buildGraph, parseToGraph } from "../parser.js";
import { ParseError } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, "fixtures/architecture.md"), "utf-8");

describe("parseArchitectureMd", () => {
  it("parses all four sections without error", () => {
    const spec = parseArchitectureMd(FIXTURE);
    expect(spec.database.tables.length).toBeGreaterThan(0);
    expect(spec.routes.length).toBeGreaterThan(0);
    expect(spec.directoryTree).toBeTruthy();
    expect(spec.requestFlows.length).toBeGreaterThan(0);
  });

  it("extracts DB table names correctly", () => {
    const spec = parseArchitectureMd(FIXTURE);
    const names = spec.database.tables.map((t) => t.name);
    expect(names).toContain("User");
    expect(names).toContain("Post");
    expect(names).toContain("Comment");
  });

  it("extracts correct number of columns for User table", () => {
    const spec = parseArchitectureMd(FIXTURE);
    const user = spec.database.tables.find((t) => t.name === "User")!;
    expect(user.columns.length).toBe(4);
    expect(user.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
  });

  it("extracts ERD relationships", () => {
    const spec = parseArchitectureMd(FIXTURE);
    const rels = spec.database.relationships;
    expect(rels.length).toBeGreaterThanOrEqual(3);
    expect(rels.some((r) => r.from === "User" && r.to === "Post")).toBe(true);
  });

  it("extracts API routes with correct methods", () => {
    const spec = parseArchitectureMd(FIXTURE);
    expect(spec.routes.length).toBe(6);
    expect(spec.routes[0]!.method).toBe("GET");
    expect(spec.routes[1]!.method).toBe("POST");
    expect(spec.routes[4]!.method).toBe("GET");
    expect(spec.routes[5]!.method).toBe("DELETE");
  });

  it("extracts request flows with dbTables array", () => {
    const spec = parseArchitectureMd(FIXTURE);
    const postList = spec.requestFlows.find((f) => f.feature === "List Posts")!;
    expect(postList).toBeDefined();
    expect(postList.frontendComponent).toBe("PostList");
    expect(postList.endpoint).toBe("GET /api/posts");
    expect(postList.dbTables).toEqual(["Post", "User"]);
  });

  it("throws ParseError when a required section is missing", () => {
    const truncated = FIXTURE.split("## API Routes")[0]!;
    expect(() => parseArchitectureMd(truncated)).toThrow(ParseError);
  });

  it("throws ParseError when DB section has no mermaid block", () => {
    const noMermaid = FIXTURE.replace(/```mermaid[\s\S]*?```/, "no block here");
    expect(() => parseArchitectureMd(noMermaid)).toThrow(ParseError);
  });

  it("throws ParseError when directory section has no fenced block", () => {
    // Replace the fenced tree block while keeping all four headings
    const noTree = FIXTURE.replace(/```\nmyapp[\s\S]*?```/, "no tree here");
    expect(() => parseArchitectureMd(noTree)).toThrow(ParseError);
  });
});

describe("buildGraph", () => {
  it("produces nodes for every table, route, and component", () => {
    const spec = parseArchitectureMd(FIXTURE);
    const graph = buildGraph(spec);
    const tableNodes = graph.nodes.filter((n) => n.tier === "database");
    const apiNodes = graph.nodes.filter((n) => n.tier === "api");
    const feNodes = graph.nodes.filter((n) => n.tier === "frontend");
    expect(tableNodes.length).toBe(3);
    expect(apiNodes.length).toBe(6);
    expect(feNodes.length).toBeGreaterThan(0);
  });

  it("produces foreign-key edges from ERD relationships", () => {
    const spec = parseArchitectureMd(FIXTURE);
    const graph = buildGraph(spec);
    const fkEdges = graph.edges.filter((e) => e.type === "foreign-key");
    expect(fkEdges.length).toBeGreaterThanOrEqual(3);
  });

  it("produces calls edges from request flows", () => {
    const spec = parseArchitectureMd(FIXTURE);
    const graph = buildGraph(spec);
    const callEdges = graph.edges.filter((e) => e.type === "calls");
    expect(callEdges.length).toBeGreaterThan(0);
  });

  it("node IDs use the format tier:kind:name", () => {
    const spec = parseArchitectureMd(FIXTURE);
    const graph = buildGraph(spec);
    for (const node of graph.nodes) {
      expect(node.id).toMatch(/^(database|api|frontend):(table|endpoint|component):/);
    }
  });
});

describe("parseToGraph convenience wrapper", () => {
  it("returns the same result as parseArchitectureMd + buildGraph", () => {
    const graph1 = parseToGraph(FIXTURE);
    const spec = parseArchitectureMd(FIXTURE);
    const graph2 = buildGraph(spec);
    expect(graph1.nodes.length).toBe(graph2.nodes.length);
    expect(graph1.edges.length).toBe(graph2.edges.length);
  });
});
