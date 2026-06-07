type BaseNavItem = {
  title: string;
  badge?: string;
  icon?: React.ElementType;
  /**
   * Optional inline content rendered at the right edge of the menu row.
   * SBR-04 uses this to mount the pending-approvals pill on the Admin →
   * Approvals entry.
   */
  extra?: React.ReactNode;
};

export type NavLink = BaseNavItem & {
  url: string;
  items?: never;
};

export type NavCollapsible = BaseNavItem & {
  items: (BaseNavItem & { url: string })[];
  url?: never;
};

export type NavItem = NavCollapsible | NavLink;

export type NavGroup = {
  title?: string;
  items: NavItem[];
};
