// packages/frontend/src/Mobile/screens/AboutScreen.tsx
export function AboutScreen() {
	return (
		<div className="ipodTextScreen">
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
