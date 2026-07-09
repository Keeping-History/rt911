import type { FC } from "react";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightTrack } from "./useFlightTrack";
import styles from "./FlightTracker.module.scss";
import { ClassicyControlGroup, ClassicyControlLabel } from "classicy";

interface FlightDetailPanelProps {
	selected: FlightPosition | null;
	track: FlightTrack | null;
	loading: boolean;
	error: string | null;
}

export const FlightDetailPanel: FC<FlightDetailPanelProps> = ({ selected, track, loading, error }) => {
	if (!selected) {
		return <ClassicyControlGroup label="Flight Details">
			<ClassicyControlLabel label="Select a flight to view its track." />
			</ClassicyControlGroup>;
	}
	const route =
		track?.origin || track?.scheduled_dest
			? `${track?.origin ?? "?"} → ${track?.scheduled_dest ?? "?"}`
			: null;
	return (
		<div className={styles.detailWrapper}>
		<ClassicyControlGroup label="Flight Details">
			<div className={styles.detailHeader}>
				<span className={styles.detailFlight}>{selected.flight}</span>
				{track && <span className={styles.detailBadge}>ACTIVE TRACK</span>}
			</div>
			<dl className={styles.detailFields}>
				{selected.carrier && (<><dt>Carrier</dt><dd>{selected.carrier}</dd></>)}
				<dt>Altitude</dt><dd>{selected.alt_ft.toLocaleString()} ft</dd>
				{selected.phase && (<><dt>Phase</dt><dd>{selected.phase}</dd></>)}
				{route && (<><dt>Route</dt><dd>{route}</dd></>)}
				{track?.diverted && (<><dt>Status</dt><dd>Diverted</dd></>)}
			</dl>
			{loading && <p className={styles.detailNote}>Loading track…</p>}
			{error && <p className={styles.detailNote}>{error}</p>}
		</ClassicyControlGroup>
		</div>
	);
};
