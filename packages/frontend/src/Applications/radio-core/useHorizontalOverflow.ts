import { useEffect, useState } from "react";

/**
 * Reports whether `content` is naturally wider than `container`, re-measuring
 * via ResizeObserver so window resizes and segment swaps are picked up.
 *
 * Returns callback refs (not ref objects) so callers that mount the content
 * node in different branches (e.g. inside vs. outside a Marquee) re-trigger
 * observation when the node remounts — a ref object + one-shot effect would
 * keep observing the detached node.
 *
 * The content element must not be allowed to shrink-to-fit (give it
 * `width: max-content`), otherwise scrollWidth never exceeds the container
 * and overflow is never detected.
 */
export function useHorizontalOverflow() {
	const [container, setContainer] = useState<HTMLElement | null>(null);
	const [content, setContent] = useState<HTMLElement | null>(null);
	const [overflowing, setOverflowing] = useState(false);

	useEffect(() => {
		// jsdom has neither ResizeObserver nor layout; report "fits" there.
		if (!container || !content || typeof ResizeObserver === "undefined") return;
		const measure = () => {
			// 1px slack absorbs subpixel rounding so the mode doesn't flicker
			// when the content is exactly container-width.
			setOverflowing(content.scrollWidth > container.clientWidth + 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		observer.observe(content);
		return () => observer.disconnect();
	}, [container, content]);

	return { containerRef: setContainer, contentRef: setContent, overflowing };
}
