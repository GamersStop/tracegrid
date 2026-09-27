# /tracegrid — TraceGrid Slash Command Interface

Use `/tracegrid` to invoke any TraceGrid operation directly from the chat interface.

---

## Command Reference

### `/tracegrid init "<idea or path/to/prd.md>"`
**Greenfield mode.** Activates the `tracegrid-architect` agent to:
1. Parse the idea string or read the PRD file provided.
2. Design normalized DB tables, API routes, directory structure, and request flows.
3. Write `architecture.md` to the project root.
4. Optionally scaffold the directory tree if `--scaffold` flag is included.

**Examples:**
```
/tracegrid init "A SaaS app where teams manage OKRs and track key results weekly"
/tracegrid init path/to/prd.md
/tracegrid init path/to/prd.md --scaffold
```

---

### `/tracegrid scan [dir]`
**Brownfield mode.** Activates the `tracegrid-scanner` agent to:
1. Inspect the given directory (defaults to workspace root if omitted).
2. Extract DB models, API routes, and frontend fetch calls.
3. Compile and write (or update) `architecture.md`.

**Examples:**
```
/tracegrid scan
/tracegrid scan ./apps/backend
```

---

### `/tracegrid serve`
Start the local graph API server at `http://localhost:4000`:
- `GET /graph` — returns full `{ nodes, edges }` JSON parsed from `architecture.md`
- `GET /graph/nodes` — nodes only
- `GET /graph/edges` — edges only
- `GET /health` — liveness check

**Example:**
```
/tracegrid serve
```

---

### `/tracegrid validate`
Validate the current `architecture.md` against the canonical schema.
Reports missing sections, malformed Mermaid blocks, and table schema violations.

```
/tracegrid validate
```

---

### `/tracegrid diff`
Compare the current `architecture.md` against the live codebase (runs scanner internally)
and report divergences — endpoints present in code but missing from the spec, and vice versa.

```
/tracegrid diff
```

---

## Flags

| Flag | Applies to | Description |
|------|-----------|-------------|
| `--scaffold` | `init` | Create the directory tree defined in `## Directory Structure` |
| `--out <path>` | `init`, `scan` | Write output to a custom path instead of `architecture.md` |
| `--port <n>` | `serve` | Override default port 4000 |
| `--json` | `validate`, `diff` | Emit results as JSON instead of human-readable text |

---

## Output Contract

All commands that write `architecture.md` produce a file with these four sections in order:

```markdown
## Database Schema
\`\`\`mermaid
erDiagram
  ...
\`\`\`

## API Routes
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
...

## Directory Structure
\`\`\`
project/
├── ...
\`\`\`

## Request Flows
| Feature | Frontend Component | Endpoint | DB Tables |
|---------|--------------------|----------|-----------|
...
```
