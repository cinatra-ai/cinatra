/**
 * The Dashboards tab's OWN empty reading (the ratified drawing, The Dashboards
 * tab section, "the tab across its load states").
 *
 * The drawing gives this state its own words rather than the shared Empty
 * pattern: a centred dashed panel reading "No dashboards in this scope yet"
 * over one helper line. The helper names the recourse a MANAGER has - "A
 * manager can Add an existing dashboard, or create one that homes here."
 *
 * That recourse does not exist everywhere. The same section rules that "a
 * personal user scope and the whole-workspace scope are not add-to-scope
 * targets - they carry no Add, so add-to-scope is the three shared scopes
 * only", and that for a reader without write authority the management action
 * "is not rendered" at all. Where there is no Add to name, the helper says what
 * the tab will hold instead of promising an affordance that is not drawn there.
 *
 * Extracted to its own module (cinatra#2807, fix leg 2) so the whole-workspace
 * Dashboards tab and the three shared scopes' Dashboards tab render ONE
 * element from ONE place, and the drawn wording lives in exactly one file.
 */

export function ScopeDashboardsEmptyState({
  canManage,
  ...rest
}: { canManage: boolean } & React.ComponentProps<"div">) {
  return (
    <div
      data-state="empty"
      className="rounded-lg border border-dashed border-line px-3 py-[18px] text-center"
      {...rest}
    >
      <p className="text-xs font-semibold text-foreground">
        No dashboards in this scope yet
      </p>
      <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {canManage ? (
          <>
            A manager can <b className="font-semibold text-foreground">Add</b> an
            existing dashboard, or create one that homes here.
          </>
        ) : (
          <>Dashboards homed or listed here will appear on this tab.</>
        )}
      </p>
    </div>
  );
}
