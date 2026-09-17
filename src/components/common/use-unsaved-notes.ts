"use client";

import { useEffect } from "react";

const dirtyForms = new Set<symbol>();
export function confirmUnsavedNotes(signingOut = false): boolean {
  return dirtyForms.size === 0 || window.confirm(signingOut
    ? "Sign out and discard your unsaved lead notes? Drafts are removed when you sign out."
    : "You have unsaved lead notes. Leave this page? Your draft stays in this tab until you save it or sign out.");
}
export function releaseUnsavedNotes(): void { dirtyForms.clear(); }

/** Drafts survive SPA/back navigation; confirm link/queue exits and native reload/close. */
export function useUnsavedNotes(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const id = Symbol();
    dirtyForms.add(id);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyForms.has(id)) { event.preventDefault(); event.returnValue = ""; }
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, location.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (url.pathname === location.pathname && url.search === location.search && url.origin === location.origin) return;
      if (!confirmUnsavedNotes()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      dirtyForms.delete(id);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}
