#!/usr/bin/env node
/**
 * TraceGrid CLI entrypoint.
 *
 * Commands:
 *   tracegrid init "<idea or path/to/prd.md>" [--scaffold] [--out <path>]
 *   tracegrid scan [dir]                       [--out <path>]
 *   tracegrid serve                            [--port <n>] [--arch <path>]
 *   tracegrid validate                         [--arch <path>] [--json]
 */

import { program } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, relative } from "path";
import {
  parseArchitectureMd,
  parseToGraph,
  scanDirectory,
  generateFromScanResults,
  buildDirectoryTree,
  ParseError,
} from "@tracegrid/core";
import { startServer } from "./server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveArchPath(optArch?: string): string {
  return resolve(optArch ?? "architecture.md");
}

function writeOutput(content: string, outPath: string): void {
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, content, "utf-8");
  console.log(`✅ Written to: ${outPath}`);
}

function die(message: string): never {
  process.stderr.write(`\n❌ ${message}\n\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// `tracegrid init`
// ---------------------------------------------------------------------------

program
  .command("init <ideaOrPath>")
  .description(
    'Greenfield mode: generate architecture.md from an idea string or PRD file.\n' +
    'If <ideaOrPath> points to an existing file, its content is used as the PRD.\n' +
    'Otherwise the string itself is used as the idea prompt.',
  )
  .option("--out <path>", "Output path for architecture.md", "architecture.md")
  .option(
    "--scaffold",
    "After generating architecture.md, print a scaffold notice (full scaffolding requires the tracegrid-architect agent)",
  )
  .action((ideaOrPath: string, opts: { out: string; scaffold?: boolean }) => {
    let prompt: string;

    if (existsSync(ideaOrPath)) {
      prompt = readFileSync(ideaOrPath, "utf-8");
      console.log(`\n📄 Using PRD from: ${ideaOrPath}`);
    } else {
      prompt = ideaOrPath;
      console.log(`\n💡 Idea: "${prompt}"`);
    }

    // The init command generates a starter architecture.md template.
    // Full AI-driven design requires the tracegrid-architect agent (custom mode).
    const template = generateInitTemplate(prompt);
    writeOutput(template, resolve(opts.out));

    if (opts.scaffold) {
      console.log(
        "\n📁 Scaffold flag detected.\n" +
          "   Full directory scaffolding requires the tracegrid-architect agent.\n" +
          '   Run: /tracegrid init "' +
          prompt.slice(0, 60) +
          '" --scaffold\n' +
          "   inside a Bob session with the tracegrid-architect mode active.\n",
      );
    }
  });

// ---------------------------------------------------------------------------
// `tracegrid scan`
// ---------------------------------------------------------------------------

program
  .command("scan [dir]")
  .description(
    "Brownfield mode: scan a project directory and emit architecture.md.\n" +
    "Defaults to the current working directory if [dir] is omitted.",
  )
  .option("--out <path>", "Output path for architecture.md", "architecture.md")
  .action((dir: string | undefined, opts: { out: string }) => {
    const targetDir = resolve(dir ?? ".");
    console.log(`\n🔍 Scanning: ${targetDir}`);

    const result = scanDirectory(targetDir);

    console.log(
      `   Found: ${result.db.tables.length} DB tables, ` +
        `${result.api.routes.length} API routes, ` +
        `${Object.keys(result.frontend.componentCalls).length} frontend components`,
    );

    // Build directory tree from scanned sources
    const allSources = [...result.db.sources, ...result.api.sources, ...result.frontend.sources];
    const uniqueSources = [...new Set(allSources)].map((s) =>
      relative(targetDir, resolve(s)),
    );
    const dirTree = buildDirectoryTree(uniqueSources, dir ?? ".");

    const archMd = generateFromScanResults(
      result.db,
      result.api,
      result.frontend,
      dirTree,
    );

    writeOutput(archMd, resolve(opts.out));
  });

// ---------------------------------------------------------------------------
// `tracegrid serve`
// ---------------------------------------------------------------------------

program
  .command("serve")
  .description("Start the graph JSON API server (reads architecture.md).")
  .option("--port <n>", "Port to listen on", "4000")
  .option("--arch <path>", "Path to architecture.md", "architecture.md")
  .action((opts: { port: string; arch: string }) => {
    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      die(`Invalid port: ${opts.port}`);
    }
    const archPath = resolveArchPath(opts.arch);
    if (!existsSync(archPath)) {
      die(`architecture.md not found at: ${archPath}\nRun 'tracegrid scan' or 'tracegrid init' first.`);
    }
    startServer({ port, archPath });
  });

// ---------------------------------------------------------------------------
// `tracegrid validate`
// ---------------------------------------------------------------------------

program
  .command("validate")
  .description("Validate architecture.md against the canonical schema.")
  .option("--arch <path>", "Path to architecture.md", "architecture.md")
  .option("--json", "Output results as JSON")
  .action((opts: { arch: string; json?: boolean }) => {
    const archPath = resolveArchPath(opts.arch);
    if (!existsSync(archPath)) {
      die(`architecture.md not found at: ${archPath}`);
    }

    const source = readFileSync(archPath, "utf-8");
    try {
      const spec = parseArchitectureMd(source);
      const graph = parseToGraph(source);
      const result = {
        valid: true,
        sections: {
          database: { tables: spec.database.tables.length, relationships: spec.database.relationships.length },
          routes: { count: spec.routes.length },
          directoryTree: { lines: spec.directoryTree.split("\n").length },
          requestFlows: { count: spec.requestFlows.length },
        },
        graph: { nodes: graph.nodes.length, edges: graph.edges.length },
      };

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("\n✅ architecture.md is valid\n");
        console.log(`   DB tables:        ${result.sections.database.tables}`);
        console.log(`   Relationships:    ${result.sections.database.relationships}`);
        console.log(`   API routes:       ${result.sections.routes.count}`);
        console.log(`   Request flows:    ${result.sections.requestFlows.count}`);
        console.log(`   Graph nodes:      ${result.graph.nodes}`);
        console.log(`   Graph edges:      ${result.graph.edges}\n`);
      }
    } catch (err) {
      if (err instanceof ParseError) {
        if (opts.json) {
          console.log(JSON.stringify({ valid: false, error: err.message, section: err.section }));
        } else {
          die(err.message);
        }
        process.exit(1);
      }
      throw err;
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program
  .name("tracegrid")
  .version("0.1.0")
  .description("TraceGrid — universal full-stack visual lineage compiler");

program.parse(process.argv);

// ---------------------------------------------------------------------------
// Init template generator (stub — full AI generation via architect agent)
// ---------------------------------------------------------------------------

function generateInitTemplate(prompt: string): string {
  const truncated = prompt.slice(0, 200).replace(/\n/g, " ");
  return `# architecture.md
<!-- Generated by: tracegrid init -->
<!-- Idea/PRD: ${truncated} -->
<!-- 
  This is a starter template. For a fully AI-generated architecture,
  activate the tracegrid-architect mode in Bob and run:
  /tracegrid init "${truncated.slice(0, 80)}"
-->

## Database Schema

\`\`\`mermaid
erDiagram
  ExampleEntity {
    int id PK
    string name
  }
\`\`\`

## API Routes

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | /api/example | exampleController.list | List example entities |

## Directory Structure

\`\`\`
project/
├── src/
│   ├── controllers/
│   └── models/
└── package.json
\`\`\`

## Request Flows

| Feature | Frontend Component | Endpoint | DB Tables |
|---------|--------------------|----------|-----------|
| List Examples | ExampleList | GET /api/example | ExampleEntity |
`;
}
