/**
 * The HyperCard inspector's picker for directusFlightMap's `flight` field
 * (issue #560) — checks off the flight(s) to focus from whatever's
 * *currently* on the live flight channel (resolved open question: live data
 * only, not historical/replay positions), the same `MediaStreamContext` read
 * `DirectusFlightMapPart.tsx` itself uses, with the same "notable flights
 * only" toggle `FlightTracker.tsx` exposes. `flight` stores an array, so this
 * picker always runs in multi-select mode.
 */
import { ClassicyCheckbox } from "classicy";
import { useCallback, useContext, useEffect } from "react";
import { MediaStreamContext } from "../../../Providers/MediaStream/MediaStreamContext";
import { isNotable } from "../../FlightTracker/notableFlights";
import { filterRowsByQuery, HyperCardOptionPickerField, type HyperCardItemPickerFilters, type HyperCardItemPickerRow } from "./HyperCardItemPicker";

const PICKER_APP_ID = "hypercard-flight-map-picker";

export function FlightMapPicker({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
	// Subscribing here (ref-counted, same as the part itself) means the live
	// flight list is populated for authoring even if no other app currently
	// has the flight channel open.
	const { flightPositions, subscribeFlights, unsubscribeFlights } = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeFlights(PICKER_APP_ID);
		return () => unsubscribeFlights(PICKER_APP_ID);
	}, [subscribeFlights, unsubscribeFlights]);

	const fetchItems = useCallback(
		(query: string, filters: HyperCardItemPickerFilters) => {
			const notablesOnly = filters.notablesOnly === true;
			const seen = new Set<string>();
			const rows: HyperCardItemPickerRow[] = [];
			for (const p of flightPositions) {
				if (notablesOnly && !isNotable(p.flight)) continue;
				if (seen.has(p.flight)) continue;
				seen.add(p.flight);
				rows.push({ id: p.flight, label: p.carrier ? `${p.flight} (${p.carrier})` : p.flight });
			}
			return filterRowsByQuery(rows, query);
		},
		[flightPositions],
	);

	return (
		<HyperCardOptionPickerField
			label="Flights"
			value={value}
			onChange={onChange}
			pickerKey="flight_map"
			title="Choose Flights"
			fetchItems={fetchItems}
			initialFilters={{ notablesOnly: false }}
			searchPlaceholder="Search callsign"
			emptyMessage="No flights are currently on the map."
			renderFilterBar={(filters, setFilters) => (
				<ClassicyCheckbox
					id="flight_map_picker_notables_only"
					label="Notable flights only"
					checked={filters.notablesOnly === true}
					onClickFunc={(checked) => setFilters({ notablesOnly: checked })}
				/>
			)}
		/>
	);
}
