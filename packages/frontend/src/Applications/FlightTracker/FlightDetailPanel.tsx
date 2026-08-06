import { type FC, Fragment } from "react";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightTrack } from "./useFlightTrack";
import styles from "./FlightTracker.module.scss";
import {
	ClassicyButton,
	ClassicyControlGroup,
	ClassicyControlLabel,
	ClassicyPopUpMenu,
} from "classicy";
import { isNotable, isObserver } from "./notableFlights";
import { PROVENANCE_NOTE, isEstimated, sourceLabel } from "./flightProvenance";
import { formatCoords, formatDurationMs, type LegEstimates } from "./flightEta";
import { type MapPoi, POI_DETAIL_FIELDS, detailTitleFor } from "./mapPois";
import { PHASE_COLORS, DEFAULT_PHASE_COLOR, phaseLabel } from "./flightPhases";

interface FlightDetailPanelProps {
	selected: FlightPosition | null;
	track: FlightTrack | null;
	loading: boolean;
	error: string | null;
	// Virtual-clock UTC ms (already stripped of the display tz by the caller
	// via virtualUtcMs) — gates the fate line so the replay isn't spoiled.
	nowMs: number;
	// Bearing of the track leg at the flight's live position (headingFromTrack);
	// null until a track with >=2 vertices is loaded.
	headingDeg?: number | null;
	// Display-timezone offset in hours (the menu-bar clock's tz) for rendering
	// wheels times as local times.
	tzOffset?: number;
	// Live fix + leg estimates (issue #227). livePos is the current streamed
	// sample (selected is a click-time snapshot); estimates gate their own
	// rows (null = row hidden).
	livePos?: FlightPosition | null;
	estimates?: LegEstimates | null;
	// Area-selection support (issue #225): with >1 entries a dropdown toggles
	// between the selected flights and Save as Filter persists the set.
	selectionOptions?: FlightPosition[];
	onPickFlight?: (flight: string) => void;
	onSaveAsFilter?: () => void;
	// When set, the pane renders this POI (airport) instead of a flight, and the
	// group header switches to the POI's detail title ("Airport Details").
	poi?: MapPoi | null;
	// Ordered-unique phase slugs for the selected flight's track (issue #310).
	// Non-empty only for notable flights with a per-phase profile; drives the
	// color legend under the fields.
	phases?: string[];
	sources?: string[];
}

// "8:14 AM"-style display time for a UTC instant in the app's display tz.
function formatDisplayTime(iso: string, tzOffset: number): string {
	const d = new Date(Date.parse(iso) + tzOffset * 3_600_000);
	const h24 = d.getUTCHours();
	const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
	const mm = String(d.getUTCMinutes()).padStart(2, "0");
	return `${h12}:${mm} ${h24 < 12 ? "AM" : "PM"}`;
}

export const FlightDetailPanel: FC<FlightDetailPanelProps> = ({
	selected, track, loading, error, nowMs, headingDeg = null, tzOffset = -4,
	livePos = null, estimates = null,
	selectionOptions = [], onPickFlight, onSaveAsFilter, poi = null, phases = [], sources = [],
}) => {
	if (poi) {
		const locale = [poi.city, poi.region].filter(Boolean).join(", ");
		const codes = [poi.iata, poi.icao].filter(Boolean).join(" / ");
		const subline = [locale, codes].filter(Boolean).join(" · ");
		const details = poi.details ?? {};
		const rows = POI_DETAIL_FIELDS.filter((f) => details[f.key] != null);
		return (
			<div className={styles.detailWrapper}>
				<ClassicyControlGroup label={detailTitleFor(poi)}>
					<div className={styles.detailHeader}>
						<span className={styles.detailFlight}>{poi.name}</span>
					</div>
					{subline && <p className={styles.detailNote}>{subline}</p>}
					<dl className={styles.detailFields}>
						{rows.map((f) => (
							<Fragment key={f.key}>
								<dt>{f.label}</dt>
								<dd>{f.format(details[f.key])}</dd>
							</Fragment>
						))}
					</dl>
				</ClassicyControlGroup>
			</div>
		);
	}
	if (!selected) {
		return (
			<div className={styles.detailWrapper}>
				<ClassicyControlGroup label="Flight Details">
					<ClassicyControlLabel label="Select a flight to view its track." />
				</ClassicyControlGroup>
			</div>
		);
	}
	const route =
		track?.origin || track?.scheduled_dest
			? `${track?.origin ?? "?"} → ${track?.scheduled_dest ?? "?"}`
			: null;
	const details = track?.details ?? null;
	const souls = details?.souls;
	const soulsLine = souls
		? [
				souls.passengers != null ? `${souls.passengers} passengers` : null,
				souls.crew != null ? `${souls.crew} crew` : null,
				souls.hijackers != null ? `${souls.hijackers} hijackers` : null,
				souls.total != null ? `${souls.total} aboard` : null,
			]
				.filter(Boolean)
				.join(" · ")
		: null;
	// A fate line with no timestamp can't be gated, so it never shows.
	const fateText =
		details?.fate?.text && details.fate.utc && nowMs >= Date.parse(details.fate.utc)
			? details.fate.text
			: null;
	return (
		<div className={styles.detailWrapper}>
		<ClassicyControlGroup label="Flight Details">
			<div className={styles.detailHeader}>
				<span className={styles.detailFlight}>{selected.flight}</span>
				{isNotable(selected.flight) && <span className={styles.detailBadge}>ACTIVE TRACK</span>}
				{isObserver(selected.flight) && <span className={styles.detailBadge}>OBSERVER</span>}
				{selected.flight.startsWith("RDR-") && (
					<span className={styles.detailBadge}>UNIDENTIFIED</span>
				)}
			</div>
			{/* The route slot states the route, or that there isn't one — an
			    unidentified radar target filed no flight plan. Provenance is
			    disclosed once, in the note below the fields. */}
			<ClassicyControlLabel labelSize={"small"} label={route ?? "Route unknown"} />
			{selectionOptions.length > 1 && (
				<div className={styles.detailSelection}>
					<ClassicyPopUpMenu
						id="flight_detail_selection"
						size="small"
						options={selectionOptions.map((p) => ({ value: p.flight, label: p.flight }))}
						selected={selected.flight}
						onChangeFunc={(e) => onPickFlight?.(e.target.value)}
					/>
					<ClassicyButton buttonSize="small" onClickFunc={onSaveAsFilter}>
						Save as Filter
					</ClassicyButton>
				</div>
			)}
			<div className={styles.detailScroll}>
			<dl className={styles.detailFields}>
				{selected.carrier && (<><dt>Carrier</dt><dd>{selected.carrier}</dd></>)}
				<dt>Altitude</dt><dd>{selected.alt_ft.toLocaleString()} ft</dd>
				{selected.phase && (<><dt>Phase</dt><dd>{selected.phase}</dd></>)}
				{headingDeg != null && (<><dt>Heading</dt><dd>{`${Math.round(headingDeg) % 360}°`}</dd></>)}
				{livePos && (<><dt>Position</dt><dd>{formatCoords(livePos.lat, livePos.lon)}</dd></>)}
				{estimates?.fromOrigin && (
					<><dt>{`From ${track?.origin ?? "origin"}`}</dt><dd>
						{`${Math.round(estimates.fromOrigin.distanceNm)} nm · ${formatDurationMs(estimates.fromOrigin.elapsedMs)}`}
					</dd></>
				)}
				{estimates?.toDest && (
					<><dt>{`To ${track?.scheduled_dest ?? "dest."}`}</dt><dd>
						{`${Math.round(estimates.toDest.distanceNm)} nm${
							estimates.toDest.etaMs != null
								? ` · ${formatDurationMs(estimates.toDest.etaMs)} (est.)`
								: ""
						}`}
					</dd></>
				)}
				{route && (<><dt>Route</dt><dd>{route}</dd></>)}
				{track?.wheels_off_utc && (
					<><dt>Wheels Up</dt><dd>{formatDisplayTime(track.wheels_off_utc, tzOffset)}</dd></>
				)}
				{track?.wheels_on_utc && (
					// In-world an unlanded flight's arrival is an estimate; the
					// suffix drops once the replay clock passes the actual time.
					<><dt>Wheels Down</dt><dd>
						{formatDisplayTime(track.wheels_on_utc, tzOffset) +
							(nowMs < Date.parse(track.wheels_on_utc) ? " (est.)" : "")}
					</dd></>
				)}
				{track?.diverted && (<><dt>Status</dt><dd>Diverted</dd></>)}
				{track?.aircraft_type && (<><dt>Aircraft</dt><dd>{track.aircraft_type}</dd></>)}
				{track?.tail_number && (<><dt>Tail</dt><dd>{track.tail_number}</dd></>)}
				{details?.crew?.captain && (<><dt>Captain</dt><dd>{details.crew.captain}</dd></>)}
				{details?.crew?.first_officer && (<><dt>First Officer</dt><dd>{details.crew.first_officer}</dd></>)}
				{soulsLine && (<><dt>Souls</dt><dd>{soulsLine}</dd></>)}
				{details?.hijackers?.length ? (<><dt>Hijackers</dt><dd>{details.hijackers.join(", ")}</dd></>) : null}
				{fateText && (<><dt>Fate</dt><dd>{fateText}</dd></>)}
			</dl>
			</div>
			{sources.length > 0 && (
				<dl className={styles.phaseLegend} aria-label="Track provenance">
					{sources.map((src) => (
						<div key={src} className={styles.phaseLegendItem}>
							<dt>
								<span
									className={styles.phaseSwatch}
									style={{
										backgroundColor: DEFAULT_PHASE_COLOR,
										opacity: isEstimated(src) ? 0.55 : 1,
										// mirror the map: estimated stretches read as dashes
										backgroundImage: isEstimated(src)
											? "repeating-linear-gradient(90deg, transparent 0 2px, rgba(255,255,255,0.9) 2px 4px)"
											: undefined,
									}}
								/>
							</dt>
							<dd>{sourceLabel(src)}</dd>
						</div>
					))}
				</dl>
			)}
			{/* Unconditional: every flight on the map is a reconstruction, so the
			    disclosure can't depend on whether a track happens to be loaded. */}
			<p className={styles.detailNote}>{PROVENANCE_NOTE}</p>
			{phases.length > 0 && (
				<dl className={styles.phaseLegend} aria-label="Phase colors">
					{phases.map((ph) => (
						<div key={ph} className={styles.phaseLegendItem}>
							<dt>
								<span
									className={styles.phaseSwatch}
									style={{ backgroundColor: PHASE_COLORS[ph] ?? DEFAULT_PHASE_COLOR }}
								/>
							</dt>
							<dd>{phaseLabel(ph)}</dd>
						</div>
					))}
				</dl>
			)}
			{loading && <p className={styles.detailNote}>Loading track…</p>}
			{error && <p className={styles.detailNote}>{error}</p>}
		</ClassicyControlGroup>
		</div>
	);
};
