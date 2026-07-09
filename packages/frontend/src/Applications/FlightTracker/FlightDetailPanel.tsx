import type { FC } from "react";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightTrack } from "./useFlightTrack";
import styles from "./FlightTracker.module.scss";
import { ClassicyControlGroup, ClassicyControlLabel } from "classicy";
import { isNotable } from "./notableFlights";

interface FlightDetailPanelProps {
	selected: FlightPosition | null;
	track: FlightTrack | null;
	loading: boolean;
	error: string | null;
	// Virtual-clock UTC ms (already stripped of the display tz by the caller
	// via virtualUtcMs) — gates the fate line so the replay isn't spoiled.
	nowMs: number;
}

export const FlightDetailPanel: FC<FlightDetailPanelProps> = ({ selected, track, loading, error, nowMs }) => {
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
			</div>
			<dl className={styles.detailFields}>
				{selected.carrier && (<><dt>Carrier</dt><dd>{selected.carrier}</dd></>)}
				<dt>Altitude</dt><dd>{selected.alt_ft.toLocaleString()} ft</dd>
				{selected.phase && (<><dt>Phase</dt><dd>{selected.phase}</dd></>)}
				{route && (<><dt>Route</dt><dd>{route}</dd></>)}
				{track?.diverted && (<><dt>Status</dt><dd>Diverted</dd></>)}
				{track?.aircraft_type && (<><dt>Aircraft</dt><dd>{track.aircraft_type}</dd></>)}
				{track?.tail_number && (<><dt>Tail</dt><dd>{track.tail_number}</dd></>)}
				{details?.crew?.captain && (<><dt>Captain</dt><dd>{details.crew.captain}</dd></>)}
				{details?.crew?.first_officer && (<><dt>First Officer</dt><dd>{details.crew.first_officer}</dd></>)}
				{soulsLine && (<><dt>Souls</dt><dd>{soulsLine}</dd></>)}
				{details?.hijackers?.length ? (<><dt>Hijackers</dt><dd>{details.hijackers.join(", ")}</dd></>) : null}
				{fateText && (<><dt>Fate</dt><dd>{fateText}</dd></>)}
			</dl>
			{loading && <p className={styles.detailNote}>Loading track…</p>}
			{error && <p className={styles.detailNote}>{error}</p>}
		</ClassicyControlGroup>
		</div>
	);
};
