# metrics-cost

## Raw SQL column naming

`db.execute(sql\`...\`)` returns rows with column names exactly as written in the query — the pg driver does not camelCase them. TypeScript `as SomeType` casts are compile-time only; they do not transform keys at runtime.

**Rule:** Any SQL alias that maps to a camelCase TypeScript property must be double-quoted in the query:

```sql
-- correct
SUM(cost_usd)::float AS "totalCost",
COUNT(*)::int         AS "callCount"

-- wrong — returns { total_cost, call_count }, not { totalCost, callCount }
SUM(cost_usd)::float AS total_cost,
COUNT(*)::int         AS call_count
```

Two valid patterns in this package:

1. **Quoted camelCase alias** — used in `readCostByProvider`, `readCostByAgent`:
   ```sql
   agent_label AS "agentLabel",
   SUM(cost_usd)::float AS "totalCost"
   ```

2. **Explicit row mapping** — used in `readCostSummary`:
   ```typescript
   return {
     totalAllTime: row.total_all_time as number | null,
     ...
   };
   ```

Both are acceptable. Pick one per query and be consistent within it.

## Fixed Costs card — cost_type values

The `cost_type` column stores `"legacy"` or `"subscription"` in the database. The UI displays `"legacy"` as **"One-time"** — the DB value was never migrated to avoid touching existing rows.

**Rule:** Any code filtering by cost type must use the DB values (`"legacy"`, `"subscription"`), not the display labels. The `buildLegacySubtitle` filter in `cost-summary-cards.tsx` and the badge renderer in `legacy-cost-list.tsx` both rely on this.

## Fixed Costs card — legacyMonthlyShare calculation rules

`legacyMonthlyShare` in `cost-summary-cards.tsx` determines how much of a fixed-cost entry counts toward the current month:

| frequency | behaviour |
|-----------|-----------|
| `once`    | Proration: `costUsd × (overlap days with current month / total days)`. Returns 0 if either date is absent. |
| `monthly` | Returns full `costUsd` if `isActiveInMonth` passes, else 0. |
| `yearly`  | Returns `costUsd / 12` if `isActiveInMonth` passes, else 0. |

**`isActiveInMonth` rules** (applies to `monthly` and `yearly` only):
- `startDate` absent → no lower bound (counts from the beginning)
- `endDate` absent → no upper bound (subscription still running)
- `startDate` set → entry excluded if current month ends before `startDate`
- `endDate` set → entry excluded if current month starts after `endDate`

## Fixed Costs card — Provider dropdown

The Provider `<select>` in `legacy-cost-list.tsx` is populated from `connectedProviders` built in `screens.tsx`. Source: `getPrimarySavedNangoConnections()` from `@cinatra-ai/connector-nango`, filtered to non-null connections, then translated via `CONNECTOR_KEY_TO_PROVIDER`:

```ts
const CONNECTOR_KEY_TO_PROVIDER: Record<string, string> = {
  openai: "openai",
  claude: "anthropic",
  gemini: "gemini",
  apollo: "apollo",
};
```

**To add a new provider connector:** add its Nango key → provider-name mapping to `CONNECTOR_KEY_TO_PROVIDER` in `screens.tsx`. The display label comes from `NANGO_CONNECTOR_DEFINITIONS[key].title`.
