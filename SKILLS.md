# TraceGrid Agent Skills Registry

This document defines the discrete operational skills available to IBM Bob subagents within the TraceGrid workspace.

### Skill 1: `skill-parse-erd`
- **Owner:** `tracegrid-architect`, `tracegrid-scanner`
- **Description:** Parses Mermaid `erDiagram` syntax or SQL DDL into an AST representation containing entities, primary keys, foreign keys, and column attributes.
- **Input:** Raw markdown or SQL file content.
- **Output:** Standardized `EntityDefinition[]` JSON.

### Skill 2: `skill-trace-lineage`
- **Owner:** `tracegrid-scanner`
- **Description:** Correlates an API endpoint route string (e.g., `GET /api/orders`) with both its underlying database query and the frontend fetch/hook that consumes it.
- **Input:** Backend route signatures and frontend JSX/TSX files.
- **Output:** Directed edge triples `(DB_Column -> API_Route -> UI_Component)`.

### Skill 3: `skill-synthesize-architecture`
- **Owner:** `tracegrid-architect`
- **Description:** Ingests unstructured feature requirements or PRD markdown, extracts core domain models, plans REST endpoints, and compiles a canonical `architecture.md` file.
- **Input:** Unstructured prompt or `PRD.md`.
- **Output:** Fully compliant `architecture.md`.

### Skill 4: `skill-scaffold-stack`
- **Owner:** `tracegrid-scaffolder`
- **Description:** Reads `architecture.md`, creates directory trees on the local filesystem, generates initial database migration files, and outputs typed boilerplate stubs.
- **Input:** Canonical `architecture.md`.
- **Output:** Filesystem modifications across `/src`, `/server`, and `/prisma`.