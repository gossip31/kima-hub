"use client";

import { useRef, useState } from "react";
import { CachedImage } from "./CachedImage";
import { useNearViewport } from "@/hooks/useNearViewport";

interface LazyCoverProps {
    src: string | null | undefined;
    alt: string;
    sizes?: string;
    /** Applied to the underlying image (e.g. object-cover, hover scale). */
    className?: string;
    /** How many scroll-container heights ahead to start loading. */
    preloadViewports?: number;
}

/**
 * A `fill` cover image that starts loading ~`preloadViewports` scroll-container
 * heights before it scrolls into view, then fades in once decoded. Use it as a
 * drop-in for a `<Image fill … />` cover inside a positioned (`relative`)
 * container that already has a placeholder background — e.g. the standard
 * `relative aspect-square` cover cards across the app.
 *
 * Until it's near the viewport it renders nothing (the container's background
 * shows through), so off-screen covers stay cheap.
 */
export function LazyCover({
    src,
    alt,
    sizes,
    className,
    preloadViewports = 1.5,
}: LazyCoverProps) {
    const ref = useRef<HTMLDivElement>(null);
    const near = useNearViewport(ref, preloadViewports);
    const [loaded, setLoaded] = useState(false);
    const [errored, setErrored] = useState(false);

    return (
        <div ref={ref} className="absolute inset-0">
            {near && !errored && (
                <CachedImage
                    src={src}
                    alt={alt}
                    fill
                    sizes={sizes}
                    loading="eager"
                    onLoad={() => setLoaded(true)}
                    onError={() => setErrored(true)}
                    className={`${className ?? ""} transition-opacity duration-300 ${
                        loaded ? "opacity-100" : "opacity-0"
                    }`}
                />
            )}
        </div>
    );
}
