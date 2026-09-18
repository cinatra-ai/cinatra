// A FIXTURE pack's own declared tool module (cinatra#3249, epic #3023).
//
// It stands in for the module a calling extension declares in its own manifest:
// the host never reads this file's logic, it only loads it from the pack's tree
// at the pinned version and calls the one export the contract names, handing it
// the ports. The scope is a fixture scope on purpose — this contract names no
// real organisation's pack.

/** The callable export the declared-tools contract pins: one argument, `{ input, ports }`. */
export async function extensionTool({ input, ports }) {
  const rows = await ports.data.select({ table: "fixture_rows", where: { kind: input.kind } });
  const inserted = await ports.data.insertIfAbsent({
    table: "fixture_rows",
    row: { kind: input.kind },
    conflictKeys: ["kind"],
  });
  const updated = await ports.data.updateWhere({
    table: "fixture_rows",
    set: { step: "second" },
    where: { kind: input.kind },
    expect: { step: "first" },
  });
  const listed = await ports.artifacts.list({ types: [input.type], limit: 10 });
  const read = await ports.artifacts.contentRead({ artifactId: input.artifactId });
  ports.review.file([{ artifactId: input.artifactId, representationRevisionId: "rev-1" }]);
  return {
    ok: true,
    seenInput: input,
    rows,
    inserted,
    updated,
    listed,
    read,
    at: ports.clock.now().toISOString(),
  };
}
