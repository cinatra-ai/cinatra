type BaseNavItem = {
  title: string;
  badge?: string;
  icon?: React.ElementType;
  /**
   * Optional inline content rendered at the right edge of the menu row.
   * Used to mount the pending-approvals pill on the Admin →
   * Approvals entry.
   */
  extra?: React.ReactNode;
};

export type NavLink = BaseNavItem & {
  url: string;
  items?: never;
  /**
   * Extra routes that should mark this link active, beyond `url` and its
   * nested sub-paths. Lets one sidebar entry (e.g. the Analytics → LLM
   * category) stay lit across sibling routes it owns that don't share its
   * url prefix (e.g. /analytics/llm-usage, /analytics/api). Each entry is
   * matched as a path-boundary prefix, so nested sub-routes count too.
   */
  activePaths?: string[];
};

export type NavCollapsible = BaseNavItem & {
  items: (BaseNavItem & { url: string; activePaths?: string[] })[];
  url?: never;
};

export type NavItem = NavCollapsible | NavLink;

export type NavGroup = {
  title?: string;
  items: NavItem[];
};
