import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorEntry } from "./editorState";
import "./PlaylistEditor.scss";
import { resolveTimelineMeta } from "./resolveTimelineMeta";
import {
	layoutBars,
	layoutFlags,
	TIMELINE_START_MS,
} from "./timelineLayout";

const DAY_MS = 24 * 3600_000;
const HOUR_TICK_COUNT = 40; // 10 days * 4 six-hour ticks/day

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
}: {
	entries: EditorEntry[];
	selectedUid: string | null;
	onSelect: (uid: string) => void;
}) {
	const [resolved, setResolved] = useState<Map<string, EditorEntry["timelineMeta"]>>(new Map());
	const attemptedRef = useRef(new Set<string>());

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
	const flags = useMemo(() => layoutFlags(merged), [merged]);
	const flagRows = flags.reduce((m, f) => Math.max(m, f.row), 0) + 1;

	return (
		<div className="playlistTimeline" data-testid="playlist-timeline">
			<div className="playlistTimelineRuler">
				{Array.from({ length: 11 }, (_, day) => (
					<span key={day} className="playlistTimelineDayTick" style={{ left: `${day * 10}%` }}>
						{new Date(TIMELINE_START_MS + day * DAY_MS).toISOString().slice(5, 10)}
					</span>
				))}
				{Array.from({ length: HOUR_TICK_COUNT }, (_, i) => (
					<span
						key={`hour-${i}`}
						className="playlistTimelineHourTick"
						style={{ left: `${i * 2.5}%` }}
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
	);
}
