import { useClassicyBalloonHelp } from "classicy";
import { type MouseEvent, useCallback, useRef, useState } from "react";
import { parseBalloonTitle } from "./newsContentLinks";

/**
 * Delegated hover-balloon for a `dangerouslySetInnerHTML`'d article body
 * (News app detail view / HyperCard's `directusNews` part). The article HTML
 * is opaque to React — there's nothing to attach a per-`<a>` hook to at mount
 * — so this mirrors `handleNewsContentClick`'s event-delegation approach:
 * `useClassicyBalloonHelp` is called once, bound to a single ref that gets
 * repointed at whichever anchor is currently hovered.
 *
 * Spread `containerHandlers` onto the content container and render `balloon`
 * anywhere in the same component tree.
 */
export function useNewsContentBalloon() {
	const anchorRef = useRef<HTMLElement | null>(null);
	const [content, setContent] = useState("");
	const { handlers, balloon } = useClassicyBalloonHelp(anchorRef, { content });

	const onMouseOver = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			const target = event.target as HTMLElement | null;
			const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
			const title = anchor ? parseBalloonTitle(anchor) : null;
			if (!anchor || !title) return;
			anchorRef.current = anchor;
			setContent(title);
			handlers.onMouseEnter();
		},
		[handlers],
	);

	const onMouseOut = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			const target = event.target as HTMLElement | null;
			const anchor = target?.closest?.("a[href]") as HTMLElement | null;
			if (!anchor) return;
			const related = event.relatedTarget as Node | null;
			// Moving to a descendant of the same anchor (e.g. bold text inside the
			// link) isn't leaving it — only fire when the pointer actually exits.
			if (related && anchor.contains(related)) return;
			handlers.onMouseLeave();
		},
		[handlers],
	);

	return { containerHandlers: { onMouseOver, onMouseOut }, balloon };
}
