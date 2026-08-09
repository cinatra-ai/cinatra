// Minimal stand-ins for the host UI table primitives.
//
// `cost-by-provider-table.tsx` exports the pure row formatters the ledger's
// honesty assertions test (an unpriced row must not render as "$0.0000"; a
// knowledge-graph row counts episodes, not calls). Those formatters have to live
// in that module — `../store` is `server-only` and a new leaf module would grow
// every locked dev-perf route's graph — so importing them pulls the host UI
// barrel, which this package's test sandbox cannot resolve.
//
// Nothing here is rendered: the tests call the formatters directly. These exist
// only so the module loads.

import type { ReactNode } from "react";

type Props = { children?: ReactNode; className?: string };

const passthrough = ({ children }: Props) => children;

export const TableBody = passthrough;
export const TableCell = passthrough;
export const TableHead = passthrough;
export const TableHeader = passthrough;
export const TableRow = passthrough;
export const PaginatedTable = passthrough;
