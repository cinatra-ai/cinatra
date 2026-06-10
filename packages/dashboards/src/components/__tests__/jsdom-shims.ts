/**
 * jsdom shims for the React dashboard component tests.
 *
 * MUST be the first import of any test file that pulls in
 * `drizzle-cube/client`: the library's theme module calls
 * `window.matchMedia` at import time, and its responsive hook needs a
 * desktop `window.innerWidth` (>= 1200px) plus a `ResizeObserver` to put
 * the dashboard into the editable tier. Import-order matters — ESM
 * evaluates imports in document order, so listing this module first runs
 * the shims before drizzle-cube's module side effects.
 */

if (typeof window !== "undefined") {
  // Desktop width — jsdom defaults to 1024, which drizzle-cube's
  // three-tier responsive strategy treats as read-only "scaled".
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1440,
  });

  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
  }
}

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
}
