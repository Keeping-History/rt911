package model

import "time"

// FlightPosition is one per-minute reconstructed aircraft sample (BTS On-Time
// great-circle interpolation, produced by packages/tools/flight-recon). Like
// PagerItem it is instant — a start_date with no duration. Unlike pager the
// rows are immutable bulk data loaded via COPY, so there is no NOTIFY path.
// start_date carries the flight_positions.utc column; run_id / et_seconds /
// clock_seconds / flight_date are deliberately not exposed (flight_date is
// derivable, the rest is pipeline provenance the client never needs).
type FlightPosition struct {
	ID        int       `json:"id"`
	Flight    string    `json:"flight"` // e.g. "AA11"
	Carrier   string    `json:"carrier,omitempty"`
	StartDate time.Time `json:"start_date"`
	Lat       float64   `json:"lat"`
	Lon       float64   `json:"lon"`
	AltFt     int       `json:"alt_ft"`
	Phase     string    `json:"phase,omitempty"` // taxi / climb / enroute / descent …
	Diverted  bool      `json:"diverted,omitempty"`
}
