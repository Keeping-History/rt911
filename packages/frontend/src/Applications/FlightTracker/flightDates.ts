// Shared UTC-day helpers for the flight|date metadata join. Leaf module —
// import nothing from FlightTracker siblings, so nothing here can create an
// import cycle with the modules (useFlightTrack, flightFilter, useRouteIndex,
// useAltitudeProfile, ...) that depend on it.

// flight_date is the UTC date component of the flight's own start_date — the
// streamer serves the 2001-09-09..09-18 window, so this is not hardcoded.
export function flightDateOf(startDate: string): string {
	return startDate.slice(0, 10);
}

// flight_tracks.flight_date is the BTS *local* departure date, but a
// FlightPosition's start_date (and flightDateOf, which takes its UTC date
// component) is a UTC instant. An evening flight departing e.g. 8:30 PM ET on
// 9/12 has flight_date = "2001-09-12" while every one of its samples is dated
// "2001-09-13" UTC (00:30Z onward) — so joining strictly on
// routeKey(flight, flightDateOf(start_date)) misses it. Across every US
// timezone in this dataset, flight_date is always either the sample's UTC
// date or the day before it, so a lookup falls back one UTC day before
// giving up.
export function prevUtcDay(flightDate: string): string {
	return new Date(Date.parse(`${flightDate}T00:00:00Z`) - 86_400_000)
		.toISOString()
		.slice(0, 10);
}
