# TraceGrid

> **Universal full-stack visual lineage and architectural compiler.**
> Bi-directionally synchronise your codebase with a single `architecture.md` source-of-truth — then visualise the full DB → API → Frontend data flow on an interactive canvas.

---

## What it does

TraceGrid operates in two directions:

| Direction | Mode | Input | Output |
|-----------|------|-------|--------|
| **Idea → Architecture** | Greenfield | PRD text or idea string | `architecture.md` scaffold |
| **Codebase → Architecture** | Brownfield | Existing project directory | `architecture.md` compiled from source |
| **Architecture → Graph** | Serve | `architecture.md` | `{ nodes, edges }` JSON via HTTP |

The `architecture.md` file is the **single source of truth**. It contains four canonical sections:

```markdown
## Database Schema      ← Mermaid erDiagram block
## API Routes           ← Markdown table (Method | Path | Handler | Description)
## Directory Structure  ← Fenced directory tree
## Request Flows        ← Markdown table (Feature | Frontend | Endpoint | DB Tables)
```

---

## Visual Canvas

The JSON graph served by `tracegrid serve` powers a **3-column interactive canvas**:

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Database ERD   │────▶│  API Route Flow   │────▶│ Frontend Directory│
│                  │     │                  │     │                  │
│  User ──── Post  │     │ GET /api/posts   │     │  PostList.tsx    │
│  Post ─── Comment│     │ POST /api/users  │     │  UserProfile.tsx │
│                  │     │                  │     │                  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

Edge types: `foreign-key` · `calls` · `reads` · `writes` · `renders` · `contains`

---

## Quickstart

```bash
# 1. Clone and install
git clone https://github.com/GamersStop/tracegrid.git
cd tracegrid
npm install

# 2. Build
npm run build

# 3. Scan an existing project
node packages/cli/dist/index.js scan /path/to/your/project --out architecture.md

# 4. Validate the generated file
node packages/cli/dist/index.js validate

# 5. Serve the graph JSON
node packages/cli/dist/index.js serve --port 4000
# → http://localhost:4000/graph
```

---

## CLI Reference

### `tracegrid init "<idea or path/to/prd.md>"`

**Greenfield mode.** Generates a starter `architecture.md` from a free-text idea or PRD file.

```bash
node packages/cli/dist/index.js init "A SaaS invoicing app with team workspaces"
node packages/cli/dist/index.js init ./docs/prd.md --out architecture.md
```

For a fully AI-generated architecture, activate the **tracegrid-architect** Bob mode and use `/tracegrid init "…"`.

| Flag | Default | Description |
|------|---------|-------------|
| `--out <path>` | `architecture.md` | Output file path |
| `--scaffold` | off | Print scaffolding notice |

---

### `tracegrid scan [dir]`

**Brownfield mode.** Inspects a project directory and compiles `architecture.md`.

```bash
node packages/cli/dist/index.js scan .
node packages/cli/dist/index.js scan ./apps/backend --out backend-arch.md
```

**What it detects:**

| Layer | Formats |
|-------|---------|
| Database | Prisma (`.prisma`), SQL DDL (`.sql`), TypeORM (`@Entity`), Sequelize (`sequelize.define`) |
| API | Express (`router.get/post…`), Next.js app router (`route.ts`), Next.js pages (`pages/api/`), FastAPI (`@router.get`) |
| Frontend | `fetch()`, `axios.get/post`, `useSWR`, `useQuery` in `.tsx` / `.jsx` / `.ts` / `.js` |

| Flag | Default | Description |
|------|---------|-------------|
| `--out <path>` | `architecture.md` | Output file path |

---

### `tracegrid serve`

Start the local graph JSON API server. Reads `architecture.md` on every request (hot-reload safe).

```bash
node packages/cli/dist/index.js serve --port 4000
```

| Endpoint | Response |
|----------|----------|
| `GET /graph` | `{ nodes: TraceNode[], edges: TraceEdge[] }` |
| `GET /graph/nodes` | `{ nodes: TraceNode[] }` |
| `GET /graph/edges` | `{ edges: TraceEdge[] }` |
| `GET /health` | `{ status: "ok" }` |

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `4000` | Listen port |
| `--arch <path>` | `architecture.md` | Path to source file |

---

### `tracegrid validate`

Validate `architecture.md` against the canonical schema and print graph statistics.

```bash
node packages/cli/dist/index.js validate
node packages/cli/dist/index.js validate --json   # machine-readable output
```

---

## `architecture.md` Schema

```markdown
## Database Schema

\`\`\`mermaid
erDiagram
  User {
    int id PK
    string email
    string passwordHash
  }
  Post {
    int id PK
    string title
    int authorId FK
  }
  User ||--o{ Post : "writes"
\`\`\`

## API Routes

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | /api/posts | postController.list | List all posts |
| POST | /api/posts | postController.create | Create a post |

## Directory Structure

\`\`\`
myapp/
├── src/
│   ├── controllers/
│   └── models/
└── package.json
\`\`\`

## Request Flows

| Feature | Frontend Component | Endpoint | DB Tables |
|---------|--------------------|----------|-----------|
| List Posts | PostList | GET /api/posts | Post, User |
```

All four sections are **required**. Missing sections cause a `ParseError`.

---

## Project Structure

```
tracegrid/
├── AGENTS.md                   ← AI agent context & architecture reference
├── .bobrules                   ← Enforced coding standards for AI agents
├── .bob/
│   ├── custom_modes.yaml       ← tracegrid-architect + tracegrid-scanner Bob modes
│   └── commands/tracegrid.md  ← /tracegrid slash-command interface
├── architecture.md             ← Source of truth (generated or authored)
└── packages/
    ├── core/                   ← Engine library (zero runtime dependencies)
    │   └── src/
    │       ├── types.ts        ← TraceNode, TraceEdge, ArchitectureSpec, …
    │       ├── parser.ts       ← architecture.md → { nodes, edges }
    │       ├── scanner.ts      ← codebase → raw lineage data
    │       └── generator.ts    ← lineage data → architecture.md
    └── cli/                    ← Runnable CLI
        └── src/
            ├── index.ts        ← init | scan | validate | serve commands
            └── server.ts       ← Express graph JSON API
```

---

## API: `@tracegrid/core`

```typescript
import {
  parseArchitectureMd,   // string → ArchitectureSpec
  buildGraph,            // ArchitectureSpec → TraceGraph
  parseToGraph,          // string → TraceGraph (convenience)
  scanDirectory,         // dir → ScanResult
  generateArchitectureMd,       // ArchitectureSpec → string
  generateFromScanResults,      // ScanResult → string
  buildDirectoryTree,    // string[] → ascii tree string
} from '@tracegrid/core';
```

Key types: [`TraceNode`](packages/core/src/types.ts) · [`TraceEdge`](packages/core/src/types.ts) · [`ArchitectureSpec`](packages/core/src/types.ts) · [`TraceGraph`](packages/core/src/types.ts) · [`ProjectBlueprint`](packages/core/src/types.ts)

---

## Bob AI Modes

Two specialised Bob AI modes are defined in [`.bob/custom_modes.yaml`](.bob/custom_modes.yaml):

| Mode slug | Purpose |
|-----------|---------|
| `tracegrid-architect` | Parses PRDs/ideas into ERDs, API route tables, and directory layouts |
| `tracegrid-scanner` | AST-level extraction across DB models, API controllers, and JSX fetch hooks |

Use the `/tracegrid` slash command (defined in [`.bob/commands/tracegrid.md`](.bob/commands/tracegrid.md)) to invoke any operation from within a Bob session.

---

## Running Tests

```bash
npm test
# 33 tests — parser (19) + scanner (14)
```

Tests live in [`packages/core/src/__tests__/`](packages/core/src/__tests__/) and cover:
- All four `architecture.md` section parsers
- `buildGraph` node/edge generation
- Prisma, SQL DDL, TypeORM, Sequelize scanners
- Express, Next.js (app & pages router), FastAPI route scanners
- `fetch()` / `axios` / `useSWR` frontend call detection
- Error paths (`ParseError` on missing/malformed sections)

---

## Design Principles

- **Schema-first** — `architecture.md` is written before any code. No DB migration without a schema entry.
- **Deterministic parsing** — identical input always produces identical `{ nodes, edges }` output.
- **Pure scanner functions** — `(content: string, filePath: string) => ScanResult`. No subprocess execution, no dynamic imports.
- **Zero core dependencies** — `packages/core` has no runtime npm dependencies.
- **Strict TypeScript** — `noUncheckedIndexedAccess`, `strict: true`, explicit return types on all public functions, no `any`.

---

## License

MIT
