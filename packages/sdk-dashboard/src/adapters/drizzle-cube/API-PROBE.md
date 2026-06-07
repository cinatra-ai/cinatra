# drizzle-cube/server 0.5.6 API Probe

Source of truth: `node_modules/drizzle-cube/dist/server/index.d.ts` after
`pnpm install` of the exact-pinned `drizzle-cube@0.5.6` from
`packages/sdk-dashboard/package.json`.

## Imports used by the adapter

```ts
import {
  defineCube,
  createDrizzleSemanticLayer,
  type Cube,
  type SecurityContext as DCSecurityContext,
  type SemanticQuery,
  type QueryContext,
  type QueryResult as DCQueryResult,
} from "drizzle-cube/server";
```

## Cube construction

```ts
defineCube(name: string, definition: Omit<Cube, 'name'>): Cube
```

`Cube` shape (relevant fields):

```ts
interface Cube {
  name: string;
  title?: string;
  description?: string;
  sql: (ctx: QueryContext) => BaseQueryDefinition;
  dimensions: Record<string, Dimension>;
  measures: Record<string, Measure>;
  joins?: Record<string, CubeJoin>;
}
```

The `sql` function returns a `BaseQueryDefinition`:

```ts
interface BaseQueryDefinition {
  from: QueryableRelation;          // Drizzle table reference
  joins?: Array<{ table: QueryableRelation; on: SQL; type?: 'left' | 'right' | 'inner' | 'full' }>;
  where?: SQL;                       // Typically security-context filtering.
}
```

`QueryContext` exposes `securityContext` to the cube's `sql` function:

```ts
interface QueryContext {
  db: DrizzleDatabase;
  schema?: any;
  securityContext: SecurityContext;
  query?: SemanticQuery;
  cube?: Cube;
  /* ... */
}
```

## Semantic layer construction + cube registration

```ts
const layer = createDrizzleSemanticLayer({ drizzle, schema });
layer.registerCube(cube);   // call once per cube
```

## Query execution

Two relevant entry points on `SemanticLayerCompiler`:

```ts
// Query a single cube by name (preferred for our adapter).
executeQuery(cubeName: string, query: SemanticQuery, securityContext: SecurityContext): Promise<QueryResult>

// Query the active cube (auto-detected from query.measures/dimensions).
execute(query: SemanticQuery, securityContext: SecurityContext, options?: ExecutionOptions): Promise<QueryResult>

// Cube catalog metadata.
getMetadata(): CubeMetadata[]
```

`SemanticQuery` shape:

```ts
interface SemanticQuery {
  measures?: string[];               // e.g. ['agent_runs.count']
  dimensions?: string[];             // e.g. ['agent_runs.status']
  filters?: Array<Filter>;
  timeDimensions?: Array<TimeDimension>;
  limit?: number;
  offset?: number;
  order?: Record<string, 'asc' | 'desc'>;
  /* ... fillMissingDatesValue, raw mode, etc. */
}
```

Members are referenced as `${cubeName}.${dimensionOrMeasureName}`.

## SecurityContext

```ts
interface SecurityContext {
  [key: string]: unknown;
}
```

Host-defined. Cinatra layers our typed `SecurityContext` (userId, organizationId,
workspaceId, teamIds, ownerLevel) into this shape and reads it back inside
each cube's `sql` function to construct the row-filtering `where` clause.

## Confirmed API Answers

| Question | Answer |
|---|---|
| Cube registration API | `layer.registerCube(cube)` after construction. |
| Query-execution method name | `executeQuery(cubeName, query, securityContext)` for single-cube. |
| Metadata method name | `getMetadata()` returns `CubeMetadata[]`. |
| BaseQueryDefinition shape | `{ from, joins?, where? }`. The cube's `sql` constructs this. |
| SecurityContext propagation | Yes — `QueryContext.securityContext` is set during execution and is what the cube's `sql` callback receives. |

## What the adapter does

`createDrizzleCubeAdapter({ drizzle, schema, cubes })` returns
`{ executeQuery, getCubeMeta }` and translates between Cinatra DTOs and the
above drizzle-cube API. The adapter is the ONLY file in the repo permitted to
import `drizzle-cube/*` — ESLint-enforced.
