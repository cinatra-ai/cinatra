// A FIXTURE pack's own declared tool module (cinatra#3249, epic #3023).
//
// It stands in for the module a calling extension declares in its own manifest:
// the host never reads this file's logic, it only loads it from the pack's tree
// at the pinned version and calls the one export the contract names, handing it
// the ports. The scope is a fixture scope on purpose — this contract names no
// real organisation's pack.

/**
 * The callable export the declared-tools contract pins: one argument, `{ input, ports }`.
 *
 * Its table is a RUN-BOUND and SCOPE-BOUND declared table: the module never
 * names the run and never names the scope — it asks for THIS RUN'S rows with
 * `{ boundRun: true }` on the declared run column, and for THIS SCOPE'S rows
 * with `{ boundScope: true }` on the declared scope columns, and the host
 * substitutes the run and the scope it bound. On the write it names none of
 * the organisation, the run or the scope.
 */
export async function extensionTool({ input, ports }) {
  const rows = await ports.data.select({
    table: "fixture_rows",
    where: { kind: input.kind, run_id: { boundRun: true } },
  });
  const inserted = await ports.data.insertIfAbsent({
    table: "fixture_rows",
    row: { id: input.rowId, kind: input.kind, step: "first" },
    conflictKeys: ["kind"],
  });
  const updated = await ports.data.updateWhere({
    table: "fixture_rows",
    set: { step: "second" },
    where: { kind: input.kind, run_id: { boundRun: true } },
    expect: { step: "first" },
  });
  const scopeRows = await ports.data.select({
    table: "fixture_rows",
    where: {
      kind: input.kind,
      scope_kind: { boundScope: true },
      scope_id: { boundScope: true },
    },
  });
  const listed = await ports.artifacts.list({ types: [input.type], limit: 10 });
  const read = await ports.artifacts.contentRead({ artifactId: input.artifactId });
  ports.review.file([{ artifactId: input.artifactId, representationRevisionId: "rev-1" }]);
  return {
    ok: true,
    seenInput: input,
    rows,
    scopeRows,
    inserted,
    updated,
    listed,
    read,
    at: ports.clock.now().toISOString(),
  };
}
