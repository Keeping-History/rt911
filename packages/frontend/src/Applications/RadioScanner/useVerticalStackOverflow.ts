import { useEffect, useState } from "react";

/**
 * Reports whether `label` and `extra` are too tall to stack vertically inside
 * `container`, re-measuring via ResizeObserver so window resizes are picked
 * up. The container's height must be imposed by CSS (the station buttons are
 * a fixed fraction of the strip), not derived from its content.
 *
 * Deliberately compares the children's summed single-line heights (plus the
 * container's row-gap) against the container instead of checking
 * scrollHeight > clientHeight: the caller flips the container to a row layout
 * when this reports true, which would clear a scrollHeight overflow and make
 * the two layouts oscillate. The children's own heights are the same in both
 * directions, so this measurement is stable.
 *
 * Returns callback refs (not ref objects) for the same remount-safety reasons
 * as useHorizontalOverflow. `extra` may legitimately never mount (an online
 * station has no OFFLINE marquee); a lone label always fits.
 */
export function useVerticalStackOverflow() {
	const [container, setContainer] = useState<HTMLElement | null>(null);
	const [label, setLabel] = useState<HTMLElement | null>(null);
	const [extra, setExtra] = useState<HTMLElement | null>(null);
	const [overflowing, setOverflowing] = useState(false);

	useEffect(() => {
		// jsdom has neither ResizeObserver nor layout; report "fits" there.
		if (!container || !label || typeof ResizeObserver === "undefined") return;
		if (!extra) {
			// Nothing to stack under the label (station online) — and clear a
			// stale row layout left over from before the marquee unmounted.
			setOverflowing(false);
			return;
		}
		const measure = () => {
			// row-gap is what would separate the stacked pair; `gap` sets it
			// identically in both flex directions so this reads the same value
			// whichever layout is currently applied.
			const gap = Number.parseFloat(getComputedStyle(container).rowGap) || 0;
			const needed = label.offsetHeight + gap + extra.offsetHeight;
			// 1px slack absorbs subpixel rounding so the mode doesn't flicker
			// when the stack is exactly container-height.
			setOverflowing(needed > container.clientHeight + 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		observer.observe(label);
		observer.observe(extra);
		return () => observer.disconnect();
	}, [container, label, extra]);

	return { containerRef: setContainer, labelRef: setLabel, extraRef: setExtra, overflowing };
}
