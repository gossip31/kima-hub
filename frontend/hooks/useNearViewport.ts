"use client";

import { RefObject, useEffect, useState } from "react";

// Find the nearest scrolling ancestor. App pages scroll inside a nested
// <main> (overflow-y-auto), not the window, so an IntersectionObserver must
// use that element as its root or rootMargin can't see past its clipped fold.
function getScrollParent(el: HTMLElement | null): HTMLElement | null {
    let node = el?.parentElement ?? null;
    while (node) {
        const overflowY = getComputedStyle(node).overflowY;
        if (
            overflowY === "auto" ||
            overflowY === "scroll" ||
            overflowY === "overlay"
        ) {
            return node;
        }
        node = node.parentElement;
    }
    return null;
}

/**
 * Returns true once `ref` is within `viewports` scroll-container heights of the
 * viewport, so content (e.g. cover images) can start loading ahead of the
 * scroll rather than reactively at the fold. Once true, it stays true.
 *
 * The look-ahead is computed in px from the scroll container's height, so it
 * scales with screen size and works regardless of which element scrolls.
 */
export function useNearViewport(
    ref: RefObject<HTMLElement | null>,
    viewports = 1.5,
): boolean {
    const [near, setNear] = useState(false);

    useEffect(() => {
        if (near) return;
        const el = ref.current;
        if (!el) return;

        const root = getScrollParent(el);
        const vh = root?.clientHeight || window.innerHeight;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setNear(true);
                    observer.disconnect();
                }
            },
            {
                root: root ?? null,
                rootMargin: `${Math.round(viewports * vh)}px 0px`,
            },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [near, ref, viewports]);

    return near;
}
