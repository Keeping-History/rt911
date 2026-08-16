import { ClassicyButton, ClassicyIcons } from "classicy";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { EditorEntry } from "./editorState";
import "./PlaylistEditor.scss";
import { resolveTimelineMeta } from "./resolveTimelineMeta";
import {
	dragEdgeIso,
	layoutBars,
	layoutFlags,
	MAX_ZOOM,
	MIN_ZOOM,
	rulerLabels,
	rulerTicks,
	steppedZoom,
	timelineBounds,
	timeToFraction,
} from "./timelineLayout";

// Flags stack into rows when they fall within this fraction of each other. It is
// a fraction of the whole span, so it has to shrink as the track widens —
// otherwise zooming in spreads the flags apart on screen while still stacking
// them, which defeats the main reason to zoom into a crowded stretch.
const FLAG_MIN_GAP_FRAC = 0.015;

/**
 * The Platinum resize cursors the Classicy View Pane dividers use, verbatim:
 * the double-arrow on an idle handle, and the single direction-of-travel arrow
 * mid-drag (Mac OS 8 window-edge idiom — the bar is the edge, the arrow is
 * where it's headed). They come from ClassicyIcons because the published
 * package inlines cursor PNGs as data URIs in its own CSS — there is no asset
 * file a stylesheet here could reference — so the cursor is set inline.
 * Hotspot 8 8 = the center of the 16px cursor, where the bar meets the arrow.
 */
export function edgeCursor(dir: "l" | "r" | "lr"): string {
	const { resizeL, resizeR, resizeLr } = ClassicyIcons.ui.cursors;
	const [img, fallback] =
		dir === "l" ? [resizeL, "w-resize"] : dir === "r" ? [resizeR, "e-resize"] : [resizeLr, "col-resize"];
	return `url(${img}) 8 8, ${fallback}`;
}

type EdgeDrag = {
	uid: string;
	edge: "start" | "end";
	/** The minute-snapped value the drag currently points at — what the bar
	 * previews, and what commits on release. */
	iso: string;
	/** Direction of travel, for the mid-drag cursor; null until first movement. */
	dir: "l" | "r" | null;
};

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
	onSetEntryBound,
	zoom,
	onZoomChange,
	start,
	end,
}: {
	entries: EditorEntry[];
	selectedUid: string | null;
	onSelect: (uid: string) => void;
	/** Commit an edge drag: set one bound of a media entry's window. Handles
	 * only render when this is wired, so a read-only host shows plain bars. */
	onSetEntryBound?: (uid: string, edge: "start" | "end", iso: string) => void;
	/** Controlled: the owning document window holds this in the classicy store
	 * so the View menu can drive it and it survives closing the window. */
	zoom: number;
	onZoomChange: (zoom: number) => void;
	/** Playlist-level window: when set, the timeline rescales to show just the
	 * bounded stretch (rounded outward to whole hours) instead of all ten days. */
	start?: string;
	end?: string;
}) {
	const [resolved, setResolved] = useState<Map<string, EditorEntry["timelineMeta"]>>(new Map());
	const attemptedRef = useRef(new Set<string>());
	const viewportRef = useRef<HTMLDivElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const anchorRef = useRef<number | null>(null);
	const [drag, setDrag] = useState<EdgeDrag | null>(null);
	const lastDragXRef = useRef(0);

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
	const bounds = useMemo(() => timelineBounds(start, end), [start, end]);
	const bars = useMemo(() => layoutBars(merged, bounds), [merged, bounds]);
	const flags = useMemo(
		() => layoutFlags(merged, FLAG_MIN_GAP_FRAC / zoom, bounds),
		[merged, zoom, bounds],
	);
	const flagRows = flags.reduce((m, f) => Math.max(m, f.row), 0) + 1;
	const ticks = useMemo(() => rulerTicks(zoom, bounds), [zoom, bounds]);
	const labels = useMemo(() => rulerLabels(zoom, bounds), [zoom, bounds]);

	// Pointer-X → the minute-snapped ISO the dragged edge points at. Null when
	// the track has no measurable width (jsdom, or a not-yet-laid-out mount).
	function edgeIsoAt(clientX: number, uid: string, edge: "start" | "end"): string | null {
		const rect = trackRef.current?.getBoundingClientRect();
		if (!rect || rect.width === 0) return null;
		const entry = entries.find((e) => e.uid === uid)?.entry;
		if (entry?.kind !== "media") return null;
		const opposite = edge === "start" ? entry.end : entry.start;
		return dragEdgeIso(edge, (clientX - rect.left) / rect.width, bounds, opposite);
	}

	function beginEdgeDrag(e: ReactPointerEvent, uid: string, edge: "start" | "end") {
		// The handle lives inside the bar's <button>; without this the drag would
		// also press the button and steal focus mid-gesture.
		e.preventDefault();
		e.stopPropagation();
		const iso = edgeIsoAt(e.clientX, uid, edge);
		if (!iso) return;
		// Optional-called: jsdom has no pointer capture. In browsers, capture is
		// what keeps move/up flowing to the handle once the pointer leaves it.
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		lastDragXRef.current = e.clientX;
		setDrag({ uid, edge, iso, dir: null });
	}

	function moveEdgeDrag(e: ReactPointerEvent) {
		if (!drag) return;
		const dx = e.clientX - lastDragXRef.current;
		lastDragXRef.current = e.clientX;
		// The 1px dead zone keeps sub-pixel jitter from flapping the arrow.
		const dir = dx > 1 ? "r" : dx < -1 ? "l" : drag.dir;
		const iso = edgeIsoAt(e.clientX, drag.uid, drag.edge) ?? drag.iso;
		if (iso !== drag.iso || dir !== drag.dir) setDrag({ ...drag, iso, dir });
	}

	function endEdgeDrag() {
		if (!drag) return;
		onSetEntryBound?.(drag.uid, drag.edge, drag.iso);
		setDrag(null);
	}

	// While a drag is live the pointer can outrun the 6px handle even under
	// capture (capture keeps the EVENTS coming, but not every browser keeps the
	// captured element's cursor), so the direction cursor is mirrored onto the
	// body the same way classicy's own useClassicyCursor does. Keyed on the
	// direction, not the drag object — the object changes every snapped minute.
	const dragCursorDir = drag ? (drag.dir ?? "lr") : null;
	useEffect(() => {
		if (!dragCursorDir) return;
		document.body.style.cursor = edgeCursor(dragCursorDir);
		return () => {
			document.body.style.cursor = "";
		};
	}, [dragCursorDir]);

	return (
		<div className="playlistTimelineContainer">
			<div className="playlistTimelineZoom classicyWindowHeader">
				<ClassicyButton
					buttonShape="square"
					buttonSize="small"
					padding="sm"
					margin="sm"
					onClickFunc={() => changeZoom(-1)}
					disabled={zoom <= MIN_ZOOM}
					title="Zoom out"
					aria-label="Zoom out"
				>
					−
				</ClassicyButton>
				{/* ClassicyControlLabel forwards no data-* attributes, so the testid
				  * the zoom tests read lives on this wrapper. */}
				{/* <span className="playlistTimelineZoomLevel" data-testid="timeline-zoom-level">
					<ClassicyControlLabel label={`${zoom}×`} />
				</span> */}
				<ClassicyButton
					buttonShape="square"
					padding="sm"
					margin="sm"
					buttonSize="small"
					onClickFunc={() => changeZoom(1)}
					disabled={zoom >= MAX_ZOOM}
					title="Zoom in"
					aria-label="Zoom in"
				>
					+
				</ClassicyButton>
			</div>
			<div className="playlistTimelineWrap">
				<div className="playlistTimeline" data-testid="playlist-timeline" ref={viewportRef}>
					<div
						className="playlistTimelineTrack"
						data-testid="timeline-track"
						ref={trackRef}
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
							{bars.map((b) => {
								// A live drag previews on the bar itself: the dragged edge
								// tracks the snapped value, and its fade lifts because the
								// edge is now bound. Everything below reads these instead of
								// b.* so the actual-span overlay stays proportioned.
								const dragging = drag?.uid === b.uid ? drag : null;
								const previewFrac = dragging ? timeToFraction(dragging.iso, bounds) : null;
								const startFrac = dragging?.edge === "start" ? (previewFrac ?? b.startFrac) : b.startFrac;
								const endFrac = dragging?.edge === "end" ? (previewFrac ?? b.endFrac) : b.endFrac;
								const fadeStart = b.fadeStart && dragging?.edge !== "start";
								const fadeEnd = b.fadeEnd && dragging?.edge !== "end";
								const handleCursor = (edge: "start" | "end") =>
									edgeCursor(dragging?.edge === edge ? (dragging.dir ?? "lr") : "lr");
								return (
									<div key={b.uid} className={`playlistTimelineLane playlistTimelineLane-${b.group}`}>
										<button
											type="button"
											className={
												b.uid === selectedUid
													? "playlistTimelineBar playlistTimelineBarSelected"
													: "playlistTimelineBar"
											}
											style={{
												left: `${startFrac * 100}%`,
												width: `${(endFrac - startFrac) * 100}%`,
												maskImage: barMaskImage(fadeStart, fadeEnd),
											}}
											title={b.label}
											onClick={() => onSelect(b.uid)}
										>
											{b.focus === "once" && <span aria-hidden>▸</span>}
											{b.focus === "locked" && <span aria-hidden>🔒</span>}
											{b.label}
											{b.actualStartFrac !== undefined && endFrac - startFrac > 0 && (
												<span
													className="playlistTimelineActualSpan"
													style={{
														left: `${((b.actualStartFrac - startFrac) / (endFrac - startFrac)) * 100}%`,
														width: `${(((b.actualEndFrac ?? endFrac) - b.actualStartFrac) / (endFrac - startFrac)) * 100}%`,
													}}
												/>
											)}
											{onSetEntryBound &&
												(["start", "end"] as const).map((edge) => (
													<span
														key={edge}
														aria-hidden
														className={`playlistTimelineBarHandle playlistTimelineBarHandle-${edge}`}
														data-testid={`bar-handle-${edge}-${b.uid}`}
														style={{ cursor: handleCursor(edge) }}
														onPointerDown={(e) => beginEdgeDrag(e, b.uid, edge)}
														onPointerMove={moveEdgeDrag}
														onPointerUp={endEdgeDrag}
														onPointerCancel={() => setDrag(null)}
													/>
												))}
										</button>
									</div>
								);
							})}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
