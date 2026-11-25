// `next/cache` for the type picker's server action in the development media
// fixture's process (see picker-action-session.mjs). The fixture runs outside
// the app's server, so it holds no page cache of the app's to revalidate, and
// Next's own `revalidatePath` refuses outside a request. The app's pages read
// the promoted row on their next request.
export function revalidatePath(path: string, type?: "layout" | "page"): void {
  void path;
  void type;
}
