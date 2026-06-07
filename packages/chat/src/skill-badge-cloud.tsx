"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";

/**
 * Public shape for a single suggestion badge rendered by SkillBadgeCloud below
 * the chat prompt window.
 *
 * `pinned` badges are always rendered first and are never filtered out by the
 * prompt value query. Use for static suggestions that should always be visible.
 * `icon` is an optional Lucide-compatible icon component rendered left of the label.
 */
export type SkillBadge = {
  id: string;
  name: string;
  prefillText: string;
  /** When true, badge always appears at the top and is never filtered away. */
  pinned?: boolean;
  /** Optional icon rendered left of the badge label. */
  icon?: React.ComponentType<{ className?: string }>;
};

export type SkillBadgeCloudProps = {
  /** Badges to render. Pass an empty array to render nothing. */
  badges: SkillBadge[];
  /** Current value of the chat prompt field — used for case-insensitive substring filtering. */
  promptValue: string;
  /** Called when the user clicks a badge. Receives the skill's prefill text. */
  onSelect: (prefillText: string) => void;
  /** Optional className appended to the outer container. */
  className?: string;
};

/**
 * SkillBadgeCloud — vertical-scrolling 3-column grid of skill suggestion badges.
 *
 * Layout:
 *   - CSS Grid: 3 columns, equal width, gap-2
 *   - Container: fixed max-height (12rem), overflow-y auto
 *   - Top + bottom gradient masks via CSS `mask-image` so badges fade out as
 *     they approach the prompt window above and the container edge below.
 *
 * Filtering:
 *   - Case-insensitive substring match against badge.name
 *   - Empty promptValue → all badges shown
 *   - Non-empty promptValue with at least one match → matches only
 *   - Non-empty promptValue with zero matches → renders nothing (returns null)
 *   - Empty `badges` prop → renders nothing
 */
export function SkillBadgeCloud({ badges, promptValue, onSelect, className }: SkillBadgeCloudProps) {
  const { pinnedBadges, filteredBadges } = useMemo(() => {
    const pinned = badges.filter((b) => b.pinned);
    const query = promptValue.trim().toLowerCase();
    const rest = badges.filter((b) => !b.pinned);
    const filtered = query.length === 0 ? rest : rest.filter((b) => b.name.toLowerCase().includes(query));
    return { pinnedBadges: pinned, filteredBadges: filtered };
  }, [badges, promptValue]);

  const allVisible = [...pinnedBadges, ...filteredBadges];

  // Always render a fixed-height container so the prompt field above never shifts
  // position when the badge list shrinks or empties due to filtering.
  return (
    <div className={`mt-4 h-48 ${className ?? ""}`}>
      {allVisible.length > 0 && (
        <div
          className="relative h-full overflow-y-auto"
          style={{
            maskImage:
              "linear-gradient(to bottom, transparent 0, black 1.5rem, black calc(100% - 2rem), transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0, black 1.5rem, black calc(100% - 2rem), transparent 100%)",
          }}
        >
          <div className="grid grid-cols-3 gap-2 px-1 py-6">
            {allVisible.map((badge) => {
              const Icon = badge.icon;
              return (
                <Button
                  key={badge.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full justify-center gap-1.5 text-xs truncate"
                  onClick={() => onSelect(badge.prefillText)}
                  title={badge.name}
                >
                  {Icon && <Icon data-icon="inline-start" aria-hidden="true" />}
                  <span className="truncate">{badge.name}</span>
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
