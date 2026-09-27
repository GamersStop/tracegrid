# TraceGrid — Agent Context & Architecture

## What is TraceGrid?

TraceGrid is a **universal full-stack visual lineage and architectural compiler**. It operates bi-directionally between a human-readable `architecture.md` source-of-truth file and a structured JSON graph that powers an interactive 3-column visual canvas:

```
[Database ERD] ──→ [API Request Flow] ──→ [Frontend Directory Tree]
```

It serves two modes:

| Mode | Trigger | Behaviour |
|------|---------|-----------|
| **Greenfield** | Empty workspace or PRD/idea string | Design directory layout, synthesize DB schema, map API flows, emit `architecture.md` |
| **Brownfield** | Existing codebase | Scan DB models, API routes, frontend fetch hooks → compile `architecture.md` |

When `architecture.md` already exists and is valid, TraceGrid reads it directly into the graph — no scanning required.

---

## Repository Layout

```
tracegrid/
├── AGENTS.md                  ← this file
├── .bobrules                  ← AI coding standards
├── .bob/
│   ├── custom_modes.yaml      ← tracegrid-architect & tracegrid-scanner modes
│   └── commands/
│       └── tracegrid.md       ← /tracegrid slash-command interface
├── architecture.md            ← single source of truth (generated or authored)
└── packages/
    ├── core/                  ← engine library
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts       ← barrel export
    │       ├── types.ts       ← TraceNode, TraceEdge, ArchitectureSpec, etc.
    │       ├── parser.ts      ← architecture.md → {nodes, edges}
    │       ├── scanner.ts     ← codebase → raw lineage data
    │       └── generator.ts   ← raw lineage data → architecture.md
    └── cli/                   ← runnable CLI
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts       ← CLI entry (tracegrid init | scan | serve)
            └── server.ts      ← express API for graph JSON
```

---

## Core Engine (`packages/core`)

### `types.ts`
Defines the canonical data model:
- `TraceNode` — a single entity in the graph (table, endpoint, component)
- `TraceEdge` — a directed relationship between two `TraceNode`s
- `ArchitectureSpec` — full parsed representation of `architecture.md`
- `RequestFlow` — one end-to-end request path (Frontend → API → DB)
- `ProjectBlueprint` — output of Greenfield mode (directory tree + spec)

### `parser.ts`
Deterministic Markdown parser:
1. Extracts Mermaid `erDiagram` blocks → DB nodes + FK edges
2. Extracts Markdown tables (API routes) → endpoint nodes + request-flow edges
3. Extracts fenced code blocks (directory trees) → component nodes
4. Outputs `{ nodes: TraceNode[], edges: TraceEdge[] }`

### `scanner.ts`
Modular filesystem inspector:
- **DB layer**: Prisma schema files, SQL DDL (`.sql`), Sequelize/TypeORM model files
- **API layer**: Express routers, FastAPI route decorators, Next.js `app/` or `pages/api/` handlers
- **Frontend layer**: `fetch()`/`axios` calls in `.tsx`/`.jsx`, component names, mapped routes

### `generator.ts`
Formats extracted `ArchitectureSpec` into the canonical `architecture.md` template:
- Mermaid ERD block for DB tables
- Markdown table for API route inventory
- Fenced directory tree
- Request flow table

---

## CLI (`packages/cli`)

| Command | Description |
|---------|-------------|
| `tracegrid init "<idea or PRD path>"` | Greenfield: design + emit `architecture.md` |
| `tracegrid scan [dir]` | Brownfield: scan codebase → emit `architecture.md` |
| `tracegrid serve` | Serve graph JSON at `http://localhost:4000/graph` |

---

## Data Contract: `architecture.md`

Sections (in order):

1. `## Database Schema` — Mermaid `erDiagram` block
2. `## API Routes` — Markdown table: `Method | Path | Handler | Description`
3. `## Directory Structure` — fenced tree block
4. `## Request Flows` — Markdown table: `Feature | Frontend | Endpoint | DB Tables`

Any deviation from this schema is treated as a parse error.

---

## Key Design Principles

- **Schema-first**: `architecture.md` is the single source of truth. No code is written before the schema is defined.
- **Deterministic parsing**: The parser must produce identical output for identical input. No heuristics in the parser layer.
- **Modular scanning**: Each scanner (DB / API / Frontend) is a pure function: `(dir: string) => ScanResult`. Easy to extend.
- **Minimal dependencies**: Core engine has zero runtime dependencies beyond the Node.js standard library. CLI adds only `express` and `commander`.
- **Clean separation**: `core` never imports from `cli`. `cli` depends on `core` only through its public barrel export.
