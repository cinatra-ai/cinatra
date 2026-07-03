// Intentionally violates the arbitrary-type bans from a NON-JSX module
// (cinatra#803): .ts template-literal HTML builders (like the chat markdown
// renderer) must not be a bypass lane around the JSX-layer bans.
export function renderHeaderCell(label: string): string {
  return `<th class="px-4 text-left text-xs uppercase tracking-[0.1em]">${label}</th>`;
}
