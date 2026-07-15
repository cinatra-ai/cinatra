/**
 * jsdom shims for the AccessCombobox behavioural render tests
 * (access-combobox-multi-open.test.tsx, access-combobox-selection-mode.test.tsx).
 *
 * The real picker mounts Radix Popover/Tooltip (Popper → ResizeObserver,
 * pointer-capture) and a cmdk Command list (scrollIntoView on the active
 * item). jsdom implements none of these, so importing this module FIRST
 * installs the no-op shims those primitives call at mount / on open. Mirrors
 * packages/dashboards/src/components/__tests__/jsdom-shims.ts.
 */

if (typeof window !== "undefined") {
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

// cmdk scrolls the active CommandItem into view when the list mounts / the
// selection moves; jsdom has no layout so scrollIntoView is undefined.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// Radix's Popper/DismissableLayer feature-detect pointer capture. jsdom omits
// these, and Radix calls them unconditionally on some code paths.
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture() {
      return false;
    };
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function setPointerCapture() {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  }
}

// Radix Popper positions the content via a ResizeObserver.
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
