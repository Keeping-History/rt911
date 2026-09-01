// packages/frontend/src/Mobile/screens/AboutScreen.tsx
import { useRef } from "react";
import { useScreenWheel } from "../WheelContext";

// One wheel detent scrolls about a line of the About text.
const SCROLL_STEP_PX = 44;

export function AboutScreen() {
	const bodyRef = useRef<HTMLDivElement>(null);
	// The wheel scrolls the text: .ipodTextScreen is the overflow container,
	// so a step just moves its scrollTop (scrollBy isn't implemented in jsdom,
	// and a direct scrollTop write behaves identically in real browsers).
	useScreenWheel({
		onScroll: (steps) => {
			const el = bodyRef.current;
			if (el) el.scrollTop += steps * SCROLL_STEP_PX;
		},
	});
	return (
		<div className="ipodTextScreen" ref={bodyRef}>
			<div className="ipodMarquee ipodCenter">911realtime</div>
			<p>
				A living archive of September 11, 2001. Radio, television, and news
				replay in real time, synchronized to the archive clock.
			</p>
			<p className="ipodDim">
				For the full multi-window experience, visit 911realtime.org on a
				desktop computer.
			</p>
			<p className="ipodDim">
				iPod interface adapted from mitchivin/ipod (MIT).
			</p>
		</div>
	);
}
