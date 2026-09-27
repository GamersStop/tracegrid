import {
  scanPrismaSchema,
  scanSqlDdl,
  scanExpressRouter,
  scanNextJsRoute,
  scanFastApiRoutes,
  scanFrontendCalls,
  scanOrmModel,
  scanSqlAlchemyModel,
  extractHandlerModels,
  scanPythonDtoClasses,
  buildDtoToModelMap,
} from "../scanner.js";

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------
describe("scanPrismaSchema", () => {
  const SCHEMA = `
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]   @relation("UserPosts")
}

model Post {
  id        Int      @id
  title     String
  authorId  Int
  author    User     @relation("UserPosts", fields: [authorId], references: [id])
}
`;

  it("extracts model names", () => {
    const { tables } = scanPrismaSchema(SCHEMA, "schema.prisma");
    expect(tables.map((t) => t.name)).toContain("User");
    expect(tables.map((t) => t.name)).toContain("Post");
  });

  it("marks @id field as primaryKey", () => {
    const { tables } = scanPrismaSchema(SCHEMA, "schema.prisma");
    const user = tables.find((t) => t.name === "User")!;
    expect(user.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
  });

  it("detects @relation and adds to relationships", () => {
    const { relationships } = scanPrismaSchema(SCHEMA, "schema.prisma");
    expect(relationships.length).toBeGreaterThan(0);
    expect(relationships.some((r) => r.from === "Post")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQL DDL
// ---------------------------------------------------------------------------
describe("scanSqlDdl", () => {
  const DDL = `
CREATE TABLE users (
  id INT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(100)
);

CREATE TABLE posts (
  id INT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  author_id INT,
  FOREIGN KEY (author_id) REFERENCES users(id)
);
`;

  it("extracts table names", () => {
    const { tables } = scanSqlDdl(DDL, "schema.sql");
    expect(tables.map((t) => t.name)).toContain("users");
    expect(tables.map((t) => t.name)).toContain("posts");
  });

  it("marks PRIMARY KEY column correctly", () => {
    const { tables } = scanSqlDdl(DDL, "schema.sql");
    const users = tables.find((t) => t.name === "users")!;
    expect(users.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
  });

  it("extracts FOREIGN KEY relationships", () => {
    const { relationships } = scanSqlDdl(DDL, "schema.sql");
    expect(relationships.some((r) => r.from === "posts" && r.to === "users")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Express router
// ---------------------------------------------------------------------------
describe("scanExpressRouter", () => {
  const ROUTER_CODE = `
const router = express.Router();

router.get('/users', userController.list);
router.post('/users', async (req, res) => { res.json({}); });
router.delete('/users/:id', deleteUser);
`;

  it("extracts all three routes", () => {
    const { routes } = scanExpressRouter(ROUTER_CODE, "routes/users.ts");
    expect(routes.length).toBe(3);
  });

  it("extracts HTTP methods correctly", () => {
    const { routes } = scanExpressRouter(ROUTER_CODE, "routes/users.ts");
    expect(routes.map((r) => r.method)).toEqual(["GET", "POST", "DELETE"]);
  });

  it("extracts route paths", () => {
    const { routes } = scanExpressRouter(ROUTER_CODE, "routes/users.ts");
    expect(routes[0]!.path).toBe("/users");
    expect(routes[2]!.path).toBe("/users/:id");
  });
});

// ---------------------------------------------------------------------------
// Next.js route
// ---------------------------------------------------------------------------
describe("scanNextJsRoute", () => {
  const APP_ROUTE = `
export async function GET(request: Request) {
  return Response.json({ ok: true });
}

export async function POST(request: Request) {
  const body = await request.json();
  return Response.json({ id: 1 });
}
`;

  it("extracts GET and POST from app router file", () => {
    const { routes } = scanNextJsRoute(
      APP_ROUTE,
      "app/api/users/route.ts",
      "/project/app/api/users/route.ts",
    );
    expect(routes.map((r) => r.method)).toContain("GET");
    expect(routes.map((r) => r.method)).toContain("POST");
  });

  it("derives URL path from app router file path", () => {
    const { routes } = scanNextJsRoute(
      APP_ROUTE,
      "app/api/users/route.ts",
      "/project/app/api/users/route.ts",
    );
    expect(routes[0]!.path).toBe("/api/users");
  });

  const PAGES_ROUTE = `
export default function handler(req, res) {
  if (req.method === 'GET') {
    res.json([]);
  }
  if (req.method === 'POST') {
    res.json({ created: true });
  }
}
`;

  it("extracts methods from pages/api route", () => {
    const { routes } = scanNextJsRoute(
      PAGES_ROUTE,
      "pages/api/posts.ts",
      "/project/pages/api/posts.ts",
    );
    expect(routes.map((r) => r.method)).toContain("GET");
    expect(routes.map((r) => r.method)).toContain("POST");
  });
});

// ---------------------------------------------------------------------------
// FastAPI
// ---------------------------------------------------------------------------
describe("scanFastApiRoutes", () => {
  const FASTAPI_CODE = `
from fastapi import APIRouter

router = APIRouter()

@router.get('/items')
async def list_items():
    return []

@router.post('/items')
async def create_item(item: Item):
    return item
`;

  it("extracts FastAPI routes", () => {
    const { routes } = scanFastApiRoutes(FASTAPI_CODE, "routers/items.py");
    expect(routes.length).toBe(2);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[1]!.method).toBe("POST");
  });

  it("captures function name as handler", () => {
    const { routes } = scanFastApiRoutes(FASTAPI_CODE, "routers/items.py");
    expect(routes[0]!.handler).toBe("list_items");
    expect(routes[1]!.handler).toBe("create_item");
  });
});

// ---------------------------------------------------------------------------
// Frontend calls
// ---------------------------------------------------------------------------
describe("scanFrontendCalls", () => {
  const COMPONENT = `
import React from 'react';

export function PostList() {
  const [posts, setPosts] = React.useState([]);
  React.useEffect(() => {
    fetch('/api/posts').then(r => r.json()).then(setPosts);
  }, []);
  return <div>{posts.map(p => <p key={p.id}>{p.title}</p>)}</div>;
}
`;

  it("detects fetch call", () => {
    const { componentCalls } = scanFrontendCalls(COMPONENT, "components/PostList.tsx");
    expect(componentCalls["PostList"]).toContain("/api/posts");
  });

  const AXIOS_COMPONENT = `
import axios from 'axios';

export function UserProfile() {
  const load = () => axios.get('/api/users/me');
  return <div />;
}
`;

  it("detects axios.get call", () => {
    const { componentCalls } = scanFrontendCalls(AXIOS_COMPONENT, "components/UserProfile.tsx");
    expect(componentCalls["UserProfile"]).toContain("/api/users/me");
  });

  it("returns empty object for files with no API calls", () => {
    const { componentCalls } = scanFrontendCalls(
      "export const x = 1;",
      "utils/helpers.ts",
    );
    expect(Object.keys(componentCalls).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ORM model (TypeORM)
// ---------------------------------------------------------------------------
describe("scanOrmModel (TypeORM)", () => {
  const ENTITY = `
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';

@Entity()
export class Article {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @ManyToOne(() => Author)
  author: Author;
}
`;

  it("extracts entity name", () => {
    const { tables } = scanOrmModel(ENTITY, "entities/Article.ts");
    expect(tables.map((t) => t.name)).toContain("Article");
  });

  it("marks @PrimaryGeneratedColumn as primaryKey", () => {
    const { tables } = scanOrmModel(ENTITY, "entities/Article.ts");
    const article = tables.find((t) => t.name === "Article");
    expect(article).toBeDefined();
    const idCol = article!.columns.find((c) => c.name === "id");
    expect(idCol?.primaryKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLAlchemy / SQLModel
// ---------------------------------------------------------------------------
describe("scanSqlAlchemyModel", () => {
  const SQLMODEL_CODE = `
from sqlmodel import SQLModel, Field
from typing import Optional

class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    secret_name: str
    age: Optional[int] = None

class Team(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    headquarters: str
`;

  it("extracts SQLModel class names as tables", () => {
    const { tables } = scanSqlAlchemyModel(SQLMODEL_CODE, "models.py");
    expect(tables.map((t) => t.name)).toContain("Hero");
    expect(tables.map((t) => t.name)).toContain("Team");
  });

  it("extracts fields from SQLModel class", () => {
    const { tables } = scanSqlAlchemyModel(SQLMODEL_CODE, "models.py");
    const hero = tables.find((t) => t.name === "Hero")!;
    expect(hero.columns.map((c) => c.name)).toContain("name");
    expect(hero.columns.map((c) => c.name)).toContain("secret_name");
  });

  it("marks primary_key=True field as primaryKey", () => {
    const { tables } = scanSqlAlchemyModel(SQLMODEL_CODE, "models.py");
    const hero = tables.find((t) => t.name === "Hero")!;
    const idCol = hero.columns.find((c) => c.name === "id");
    expect(idCol?.primaryKey).toBe(true);
  });

  it("marks Optional[...] fields as nullable", () => {
    const { tables } = scanSqlAlchemyModel(SQLMODEL_CODE, "models.py");
    const hero = tables.find((t) => t.name === "Hero")!;
    const idCol = hero.columns.find((c) => c.name === "id");
    expect(idCol?.nullable).toBe(true);
    const nameCol = hero.columns.find((c) => c.name === "name");
    expect(nameCol?.nullable).toBe(false);
  });

  const SQLALCHEMY_CODE = `
from sqlalchemy import Column, Integer, String, ForeignKey
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass

class User(Base):
    id: int = mapped_column(Integer, primary_key=True)
    email: str = mapped_column(String)

class Post(Base):
    id: int = mapped_column(Integer, primary_key=True)
    title: str = mapped_column(String)
    user_id: int = mapped_column(Integer, ForeignKey("user.id"))
`;

  it("extracts SQLAlchemy DeclarativeBase classes", () => {
    const { tables } = scanSqlAlchemyModel(SQLALCHEMY_CODE, "models.py");
    const names = tables.map((t) => t.name);
    expect(names).toContain("User");
    expect(names).toContain("Post");
  });

  it("extracts ForeignKey relationship from mapped_column", () => {
    const { relationships } = scanSqlAlchemyModel(SQLALCHEMY_CODE, "models.py");
    expect(relationships.some((r) => r.from === "Post" && r.to === "user")).toBe(true);
  });

  it("delegates Python files from scanOrmModel to sqlalchemy scanner", () => {
    const { tables } = scanOrmModel(SQLMODEL_CODE, "models.py");
    expect(tables.map((t) => t.name)).toContain("Hero");
  });
});

// ---------------------------------------------------------------------------
// Path-aware component naming
// ---------------------------------------------------------------------------
describe("scanFrontendCalls — path-aware component naming", () => {
  const PAGE_CODE = `
export default function AdminPage() {
  fetch('/api/admin/metrics');
  return null;
}
`;

  it("uses directory name for generic page.tsx basename", () => {
    const { componentCalls } = scanFrontendCalls(
      PAGE_CODE,
      "src/app/(portal)/admin/page.tsx",
    );
    // Should NOT be the bare "page" key
    expect(Object.keys(componentCalls)).not.toContain("page");
    // Should be PascalCase from parent directory
    expect(Object.keys(componentCalls)).toContain("AdminPage");
  });

  it("uses directory name for generic index.tsx basename", () => {
    const { componentCalls } = scanFrontendCalls(
      `export default function Dash() { fetch('/api/dashboard'); return null; }`,
      "src/pages/dashboard/index.tsx",
    );
    expect(Object.keys(componentCalls)).not.toContain("index");
    expect(Object.keys(componentCalls)).toContain("DashboardIndex");
  });

  it("uses directory name for sos/page.tsx → SosPage", () => {
    const { componentCalls } = scanFrontendCalls(
      `export default function SOS() { fetch('/api/sos'); return null; }`,
      "src/app/(portal)/sos/page.tsx",
    );
    expect(Object.keys(componentCalls)).toContain("SosPage");
  });

  it("handles hyphenated directory name: live-grid/page.tsx → LiveGridPage", () => {
    const { componentCalls } = scanFrontendCalls(
      `export default function Grid() { fetch('/api/live-grid'); return null; }`,
      "src/app/(portal)/live-grid/page.tsx",
    );
    expect(Object.keys(componentCalls)).toContain("LiveGridPage");
  });

  it("preserves meaningful non-generic filenames unchanged", () => {
    const { componentCalls } = scanFrontendCalls(
      `export function GiverGate() { fetch('/api/verify-session'); return null; }`,
      "src/components/GiverGate.tsx",
    );
    expect(Object.keys(componentCalls)).toContain("GiverGate");
  });
});

// ---------------------------------------------------------------------------
// extractHandlerModels
// ---------------------------------------------------------------------------
describe("extractHandlerModels", () => {
  const MODELS = ["Volunteer", "VolunteerOffer", "Mission", "User", "Post"];

  it("returns empty array when no known models provided", () => {
    expect(extractHandlerModels("select(Volunteer)", [])).toEqual([]);
  });

  // --- Python / FastAPI patterns ---

  it("detects SQLModel select() query", () => {
    const body = "results = session.exec(select(VolunteerOffer)).all()";
    expect(extractHandlerModels(body, MODELS)).toContain("VolunteerOffer");
  });

  it("detects db.query(Model) pattern", () => {
    const body = "rows = db.query(Volunteer).filter(Volunteer.active == True).all()";
    const found = extractHandlerModels(body, MODELS);
    expect(found).toContain("Volunteer");
  });

  it("detects FastAPI response_model annotation", () => {
    const decorator = "@router.get('/volunteers', response_model=List[Volunteer])";
    expect(extractHandlerModels(decorator, MODELS)).toContain("Volunteer");
  });

  it("detects return type annotation -> ModelName", () => {
    const sig = "async def list_offers(db: Session) -> list[VolunteerOffer]:";
    expect(extractHandlerModels(sig, MODELS)).toContain("VolunteerOffer");
  });

  it("detects function parameter type annotation", () => {
    const sig = "async def create_volunteer(item: Volunteer, db: Session):";
    expect(extractHandlerModels(sig, MODELS)).toContain("Volunteer");
  });

  it("detects Python import statement", () => {
    const imp = "from app.models import Volunteer, VolunteerOffer";
    const found = extractHandlerModels(imp, MODELS);
    expect(found).toContain("Volunteer");
    expect(found).toContain("VolunteerOffer");
  });

  it("detects multiple models in the same body", () => {
    const body = `
from app.models import Volunteer, VolunteerOffer
async def handler(db: Session):
    v = db.query(Volunteer).all()
    o = session.exec(select(VolunteerOffer)).all()
    return v
`;
    const found = extractHandlerModels(body, MODELS);
    expect(found).toContain("Volunteer");
    expect(found).toContain("VolunteerOffer");
    expect(found).not.toContain("Mission");
  });

  // --- TypeScript / JS patterns ---

  it("detects Prisma client camelCase accessor", () => {
    const body = "const users = await prisma.user.findMany();";
    expect(extractHandlerModels(body, ["User"])).toContain("User");
  });

  it("detects prisma.post.create()", () => {
    const body = "const p = await prisma.post.create({ data: input });";
    expect(extractHandlerModels(body, ["Post"])).toContain("Post");
  });

  it("detects getRepository(Model) TypeORM pattern", () => {
    const body = "const repo = getRepository(Mission); return repo.find();";
    expect(extractHandlerModels(body, MODELS)).toContain("Mission");
  });

  it("detects TS import { Model } from '...'", () => {
    const body = "import { Volunteer } from '../models/Volunteer';";
    expect(extractHandlerModels(body, MODELS)).toContain("Volunteer");
  });

  it("falls back to bare identifier for models >= 4 chars", () => {
    const body = "const item = new Mission(); await item.save();";
    expect(extractHandlerModels(body, MODELS)).toContain("Mission");
  });

  it("does NOT false-positive on short model names not present", () => {
    // Short names (< 4 chars) should not match via bare-identifier fallback
    const found = extractHandlerModels("const x = 1;", ["Post", "User"]);
    // They may match via other patterns but bare-identifier fallback is skipped
    // The content has no references at all, so result should be empty
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanExpressRouter — with knownModels
// ---------------------------------------------------------------------------
describe("scanExpressRouter — model tracing", () => {
  it("attaches traced models via inline handler body", () => {
    const code = `
const router = express.Router();

async function listVolunteers(req, res) {
  const rows = await prisma.volunteer.findMany();
  res.json(rows);
}

router.get('/volunteers', listVolunteers);
`;
    const { routes } = scanExpressRouter(code, "routes/volunteers.ts", ["Volunteer"]);
    expect(routes[0]!.dbTables).toContain("Volunteer");
  });

  it("attaches models from inline arrow callback", () => {
    const code = `
const router = express.Router();
router.post('/missions', async (req, res) => {
  const m = new Mission(req.body);
  await m.save();
  res.json(m);
});
`;
    const { routes } = scanExpressRouter(code, "routes/missions.ts", ["Mission"]);
    expect(routes[0]!.dbTables).toContain("Mission");
  });

  it("returns empty dbTables when no models match", () => {
    const code = `
const router = express.Router();
router.get('/health', (req, res) => res.json({ ok: true }));
`;
    const { routes } = scanExpressRouter(code, "routes/health.ts", ["Volunteer", "Mission"]);
    expect(routes[0]!.dbTables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanFastApiRoutes — with knownModels
// ---------------------------------------------------------------------------
describe("scanFastApiRoutes — model tracing", () => {
  it("traces models from handler body + imports", () => {
    const code = `
from app.models import Volunteer, VolunteerOffer

router = APIRouter()

@router.get('/volunteers')
async def list_volunteers(db: Session = Depends(get_db)):
    return db.query(Volunteer).all()

@router.post('/offers')
async def create_offer(offer: VolunteerOffer, db: Session = Depends(get_db)):
    db.add(offer)
    db.commit()
    return offer
`;
    const { routes } = scanFastApiRoutes(code, "routers/volunteers.py", [
      "Volunteer",
      "VolunteerOffer",
      "Mission",
    ]);

    const listRoute = routes.find((r) => r.path === "/volunteers");
    expect(listRoute?.dbTables).toContain("Volunteer");

    const offerRoute = routes.find((r) => r.path === "/offers");
    expect(offerRoute?.dbTables).toContain("VolunteerOffer");
  });

  it("traces response_model annotation", () => {
    const code = `
from app.models import Mission

router = APIRouter()

@router.get('/missions', response_model=List[Mission])
async def list_missions(db: Session = Depends(get_db)):
    return db.query(Mission).all()
`;
    const { routes } = scanFastApiRoutes(code, "routers/missions.py", ["Mission", "Volunteer"]);
    expect(routes[0]!.dbTables).toContain("Mission");
    expect(routes[0]!.dbTables).not.toContain("Volunteer");
  });
});

// ---------------------------------------------------------------------------
// scanNextJsRoute — with knownModels
// ---------------------------------------------------------------------------
describe("scanNextJsRoute — model tracing", () => {
  it("traces Prisma calls inside app router GET handler", () => {
    const code = `
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  const users = await prisma.user.findMany();
  return Response.json(users);
}
`;
    const { routes } = scanNextJsRoute(
      code,
      "app/api/users/route.ts",
      "/project/app/api/users/route.ts",
      ["User", "Post"],
    );
    const get = routes.find((r) => r.method === "GET");
    expect(get?.dbTables).toContain("User");
    expect(get?.dbTables).not.toContain("Post");
  });
});


// ---------------------------------------------------------------------------
// scanSqlAlchemyModel — persistent vs DTO segregation
// ---------------------------------------------------------------------------
describe("scanSqlAlchemyModel — only persistent models in tables", () => {
  const MIXED_CODE = `
from sqlmodel import SQLModel, Field
from pydantic import BaseModel
from typing import Optional

class Volunteer(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str

class VolunteerCreate(BaseModel):
    name: str

class AdminLoginRequest(BaseModel):
    username: str
    password: str
`;

  it("includes only table=True SQLModel classes", () => {
    const { tables } = scanSqlAlchemyModel(MIXED_CODE, "models.py");
    const names = tables.map((t) => t.name);
    expect(names).toContain("Volunteer");
    expect(names).not.toContain("VolunteerCreate");
    expect(names).not.toContain("AdminLoginRequest");
  });
});

// ---------------------------------------------------------------------------
// scanPythonDtoClasses
// ---------------------------------------------------------------------------
describe("scanPythonDtoClasses", () => {
  it("detects BaseModel subclasses as DTOs", () => {
    const code = `
class ClaimItemRequest(BaseModel):
    item_id: int

class ClaimItemResponse(BaseModel):
    success: bool
`;
    const dtos = scanPythonDtoClasses(code);
    expect(dtos).toContain("ClaimItemRequest");
    expect(dtos).toContain("ClaimItemResponse");
  });

  it("detects classes with DTO-suffix names as DTOs", () => {
    const code = `
class VolunteerSchema(SomeBase):
    id: int
`;
    const dtos = scanPythonDtoClasses(code);
    expect(dtos).toContain("VolunteerSchema");
  });

  it("does NOT include SQLModel table=True classes as DTOs", () => {
    const code = `
class Volunteer(SQLModel, table=True):
    id: int

class VolunteerCreate(BaseModel):
    name: str
`;
    const dtos = scanPythonDtoClasses(code);
    expect(dtos).toContain("VolunteerCreate");
    expect(dtos).not.toContain("Volunteer");
  });

  it("detects SQLModel without table=True as DTO", () => {
    const code = `class VolunteerRead(SQLModel):
    id: int
    name: str
`;
    const dtos = scanPythonDtoClasses(code);
    expect(dtos).toContain("VolunteerRead");
  });
});

// ---------------------------------------------------------------------------
// buildDtoToModelMap
// ---------------------------------------------------------------------------
describe("buildDtoToModelMap", () => {
  const CODE = `
class VolunteerCreate(BaseModel):
    name: str

class ClaimItemRequest(BaseModel):
    item_id: int

class AdminLoginRequest(BaseModel):
    username: str
`;
  const MODELS = ["Volunteer", "ClaimItem", "Admin", "Mission"];

  it("maps VolunteerCreate → Volunteer", () => {
    const map = buildDtoToModelMap(CODE, MODELS);
    expect(map.get("VolunteerCreate")).toBe("Volunteer");
  });

  it("maps ClaimItemRequest → ClaimItem", () => {
    const map = buildDtoToModelMap(CODE, MODELS);
    expect(map.get("ClaimItemRequest")).toBe("ClaimItem");
  });

  it("maps AdminLoginRequest → Admin", () => {
    const map = buildDtoToModelMap(CODE, MODELS);
    expect(map.get("AdminLoginRequest")).toBe("Admin");
  });

  it("returns empty map when no known models", () => {
    const map = buildDtoToModelMap(CODE, []);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scanFastApiRoutes — DTO parameter resolution
// ---------------------------------------------------------------------------
describe("scanFastApiRoutes — DTO parameter resolution", () => {
  it("resolves DTO parameter to underlying persistent model", () => {
    const code = `
from app.models import Volunteer
from app.schemas import VolunteerCreate

router = APIRouter()

@router.post('/volunteers')
async def create_volunteer(payload: VolunteerCreate, db: Session = Depends(get_db)):
    vol = Volunteer(**payload.dict())
    db.add(vol)
    db.commit()
    return vol
`;
    const dtoToModel = new Map([["VolunteerCreate", "Volunteer"]]);
    const { routes } = scanFastApiRoutes(code, "routers/volunteers.py", ["Volunteer"], dtoToModel);
    expect(routes[0]!.dbTables).toContain("Volunteer");
  });

  it("does not duplicate model when already found directly", () => {
    const code = `
from app.models import Volunteer
from app.schemas import VolunteerCreate

router = APIRouter()

@router.post('/volunteers')
async def create_volunteer(payload: VolunteerCreate, db: Session = Depends(get_db)):
    db.add(Volunteer(**payload.dict()))
    db.commit()
`;
    const dtoToModel = new Map([["VolunteerCreate", "Volunteer"]]);
    const { routes } = scanFastApiRoutes(code, "routers/volunteers.py", ["Volunteer"], dtoToModel);
    const tables = routes[0]!.dbTables ?? [];
    // Should contain Volunteer exactly once
    expect(tables.filter((t) => t === "Volunteer").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scanFrontendCalls — deeper discovery
// ---------------------------------------------------------------------------
describe("scanFrontendCalls — deeper discovery", () => {
  it("detects template literal fetch path with interpolation", () => {
    const code = `
export function ItemPage({ id }) {
  fetch(\`/api/items/\${id}/claim\`);
  return null;
}
`;
    const { componentCalls } = scanFrontendCalls(code, "src/app/items/page.tsx");
    const calls = componentCalls["ItemsPage"] ?? componentCalls["ItemPage"] ?? Object.values(componentCalls)[0] ?? [];
    expect(calls.some((c) => c.includes("/api/items/") && c.includes("/claim"))).toBe(true);
  });

  it("detects api.post() named helper call", () => {
    const code = `
import { api } from '../lib/api';

export function ClaimPage() {
  api.post('/items/claim', { itemId: 1 });
  return null;
}
`;
    const { componentCalls } = scanFrontendCalls(code, "src/app/claim/page.tsx");
    const calls = Object.values(componentCalls).flat();
    expect(calls).toContain("/items/claim");
  });

  it("detects apiClient.get() named helper call with template literal", () => {
    const code = `
import { apiClient } from '../services/api';

export function UserProfile({ userId }) {
  apiClient.get(\`/users/\${userId}/profile\`);
  return null;
}
`;
    const { componentCalls } = scanFrontendCalls(code, "src/components/UserProfile.tsx");
    const calls = componentCalls["UserProfile"] ?? [];
    expect(calls.some((c) => c.startsWith("/users/"))).toBe(true);
  });

  it("detects imported API helper and guesses endpoint path", () => {
    const code = `
import { claimItem, donateSol } from '../api/actions';

export function ActionPanel() {
  claimItem(itemId);
  donateSol(amount);
  return null;
}
`;
    const { componentCalls } = scanFrontendCalls(code, "src/components/ActionPanel.tsx");
    const calls = componentCalls["ActionPanel"] ?? [];
    // claimItem → /item/claim or /claim or /item-claim variant
    expect(calls.length).toBeGreaterThan(0);
  });

  it("normalises template literal param to :param placeholder", () => {
    const code = "fetch(`/api/volunteers/${volunteerId}`)";
    const { componentCalls } = scanFrontendCalls(code, "src/components/VolunteerDetail.tsx");
    const calls = componentCalls["VolunteerDetail"] ?? [];
    expect(calls).toContain("/api/volunteers/:param");
  });

  it("still detects plain fetch('/api/...')", () => {
    const code = "fetch('/api/missions')";
    const { componentCalls } = scanFrontendCalls(code, "src/app/missions/page.tsx");
    const calls = Object.values(componentCalls).flat();
    expect(calls).toContain("/api/missions");
  });
});

