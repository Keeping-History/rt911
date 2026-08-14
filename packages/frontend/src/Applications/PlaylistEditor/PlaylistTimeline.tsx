import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditorEntry } from "./editorState";
import "./PlaylistEditor.scss";
import { resolveTimelineMeta } from "./resolveTimelineMeta";
import {
	layoutBars,
	layoutFlags,
	MAX_ZOOM,
	MIN_ZOOM,
	rulerLabels,
	rulerTicks,
	steppedZoom,
} from "./timelineLayout";

// Flags stack into rows when they fall within this fraction of each other. It is
// a fraction of the whole span, so it has to shrink as the track widens —
// otherwise zooming in spreads the flags apart on screen while still stacking
// them, which defeats the main reason to zoom into a crowded stretch.
const FLAG_MIN_GAP_FRAC = 0.015;

export function barMaskImage(fadeStart: boolean, fadeEnd: boolean): string {
	if (fadeStart && fadeEnd) {
		return "linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)";
	}
	if (fadeStart) return "linear-gradient(to right, transparent, black 12px)";
	if (fadeEnd) return "linear-gradient(to left, transparent, black 12px)";
	return "none";
}

export function PlaylistTimeline({
	entries,
	selectedUid,
	onSelect,
	zoom,
	onZoomChange,
}: {
	entries: EditorEntry[];
	selectedUid: string | null;
	onSelect: (uid: string) => void;
	/** Controlled: the owning document window holds this in the classicy store
	 * so the View menu can drive it and it survives closing the window. */
	zoom: number;
	onZoomChange: (zoom: number) => void;
}) {
	const [resolved, setResolved] = useState<Map<string, EditorEntry["timelineMeta"]>>(new Map());
	const attemptedRef = useRef(new Set<string>());
	const viewportRef = useRef<HTMLDivElement>(null);
	const anchorRef = useRef<number | null>(null);

	// Zoom about the middle of what the user is currently looking at. Without
	// this, widening the track keeps scrollLeft fixed and the view lurches
	// towards 9 September every time you zoom in.
	//
	// The anchor is captured here rather than in the effect below because by
	// then the track has already been re-laid-out at the new width, so the old
	// scroll position no longer means what it did.
	function changeZoom(direction: 1 | -1) {
		const el = viewportRef.current;
		if (el && el.scrollWidth > 0) {
			anchorRef.current = (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth;
		}
		onZoomChange(steppedZoom(zoom, direction));
	}

	useLayoutEffect(() => {
		const el = viewportRef.current;
		const anchor = anchorRef.current;
		anchorRef.current = null;
		// scrollWidth is 0 under jsdom, so this is a no-op in tests rather than
		// writing NaN into scrollLeft.
		if (!el || anchor === null || el.scrollWidth === 0) return;
		el.scrollLeft = anchor * el.scrollWidth - el.clientWidth / 2;
	}, [zoom]);

	useEffect(() => {
		const toResolve = entries.filter(
			(e) => e.timelineMeta === undefined && !attemptedRef.current.has(e.uid),
		);
		if (toResolve.length === 0) return;
		for (const e of toResolve) attemptedRef.current.add(e.uid);

		let cancelled = false;
		void resolveTimelineMeta(toResolve).then((m) => {
			if (!cancelled && m.size > 0) {
				setResolved((prev) => new Map([...prev, ...m]));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [entries]);

	const merged = useMemo(
		() => entries.map((e) => (resolved.has(e.uid) ? { ...e, timelineMeta: resolved.get(e.uid) } : e)),
		[entries, resolved],
	);
	const bars = useMemo(() => layoutBars(merged), [merged]);
	const flags = useMemo(() => layoutFlags(merged, FLAG_MIN_GAP_FRAC / zoom), [merged, zoom]);
	const flagRows = flags.reduce((m, f) => Math.max(m, f.row), 0) + 1;
	const ticks = useMemo(() => rulerTicks(zoom), [zoom]);
	const labels = useMemo(() => rulerLabels(zoom), [zoom]);

	return (
		<div className="playlistTimelineWrap">
			<div className="playlistTimelineZoom">
				<button
					type="button"
					onClick={() => changeZoom(-1)}
					disabled={zoom <= MIN_ZOOM}
					title="Zoom out"
					aria-label="Zoom out"
				>
					−
				</button>
				<span className="playlistTimelineZoomLevel" data-testid="timeline-zoom-level">
					{zoom}×
				</span>
				<button
					type="button"
					onClick={() => changeZoom(1)}
					disabled={zoom >= MAX_ZOOM}
					title="Zoom in"
					aria-label="Zoom in"
				>
					+
				</button>
			</div>
			<div className="playlistTimeline" data-testid="playlist-timeline" ref={viewportRef}>
				<div
					className="playlistTimelineTrack"
					data-testid="timeline-track"
					style={{ width: `${zoom * 100}%` }}
				>
					<div className="playlistTimelineRuler">
						{labels.map((l) => (
							<span
								key={`label-${l.leftPct}`}
								// The closing label is right-aligned. Left-aligned at
								// left:100% it draws its whole width past the track,
								// which is scrollable overflow — that is what made a
								// fully zoomed-out timeline scroll sideways.
								className={
									l.leftPct >= 100
										? "playlistTimelineDayTick playlistTimelineDayTickEnd"
										: "playlistTimelineDayTick"
								}
								style={{ left: `${l.leftPct}%` }}
							>
								{l.text}
							</span>
						))}
						{ticks.map((leftPct) => (
							<span
								key={`hour-${leftPct}`}
								className="playlistTimelineHourTick"
								style={{ left: `${leftPct}%` }}
							/>
						))}
					</div>
					<div className="playlistTimelineFlagRow" style={{ height: `${flagRows * 18}px` }}>
						{flags.map((f) => (
							<button
								key={f.uid}
								type="button"
								className={`playlistTimelineFlag playlistTimelineFlag-${f.kindGlyph}`}
								style={{ left: `${f.atFrac * 100}%`, top: `${f.row * 18}px` }}
								title={f.label}
								onClick={() => onSelect(f.uid)}
							>
								⚑
							</button>
						))}
						{flags.filter((f) => f.extentEndFrac !== undefined).map((f) => (
							<span
								key={`${f.uid}-extent`}
								className="playlistTimelineFlagExtent"
								style={{
									left: `${f.atFrac * 100}%`,
									width: `${((f.extentEndFrac ?? f.atFrac) - f.atFrac) * 100}%`,
									top: `${f.row * 18 + 14}px`,
								}}
							/>
						))}
					</div>
					<div className="playlistTimelineLanes">
						{bars.map((b) => (
							<div key={b.uid} className={`playlistTimelineLane playlistTimelineLane-${b.group}`}>
								<button
									type="button"
									className={
										b.uid === selectedUid
											? "playlistTimelineBar playlistTimelineBarSelected"
											: "playlistTimelineBar"
									}
									style={{
										left: `${b.startFrac * 100}%`,
										width: `${(b.endFrac - b.startFrac) * 100}%`,
										maskImage: barMaskImage(b.fadeStart, b.fadeEnd),
									}}
									title={b.label}
									onClick={() => onSelect(b.uid)}
								>
									{b.focus === "once" && <span aria-hidden>▸</span>}
									{b.focus === "locked" && <span aria-hidden>🔒</span>}
									{b.label}
									{b.actualStartFrac !== undefined && b.endFrac - b.startFrac > 0 && (
										<span
											className="playlistTimelineActualSpan"
											style={{
												left: `${((b.actualStartFrac - b.startFrac) / (b.endFrac - b.startFrac)) * 100}%`,
												width: `${(((b.actualEndFrac ?? b.endFrac) - b.actualStartFrac) / (b.endFrac - b.startFrac)) * 100}%`,
											}}
										/>
									)}
								</button>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
