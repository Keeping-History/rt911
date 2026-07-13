package model

import "time"

// WeatherObservation is one hourly METAR/ISD surface observation for a station
// (packages/tools/weather-recon, weather_observations). StartDate carries
// observed_at — named StartDate to match every other channel's reveal-gating
// field. Most numeric fields are nullable in the NCEI source data (a station
// may report temp but not gust, or vice versa), so they scan as pointers
// rather than COALESCEing to 0 — a real 0 kt gust and "not reported" must stay
// distinguishable to the client.
type WeatherObservation struct {
	ID             int       `json:"id"`
	StationID      string    `json:"station_id"`
	StartDate      time.Time `json:"start_date"`
	TempC          *float64  `json:"temp_c,omitempty"`
	DewpointC      *float64  `json:"dewpoint_c,omitempty"`
	WindDirDeg     *int      `json:"wind_dir_deg,omitempty"`
	WindSpeedKt    *float64  `json:"wind_speed_kt,omitempty"`
	GustKt         *float64  `json:"gust_kt,omitempty"`
	PressureHpa    *float64  `json:"pressure_hpa,omitempty"`
	SkyCondition   string    `json:"sky_condition,omitempty"`
	PresentWeather string    `json:"present_weather,omitempty"`
	VisibilityKm   *float64  `json:"visibility_km,omitempty"`
	RawMetar       string    `json:"raw_metar,omitempty"`
}

// WeatherForecast is one archived NWS zone forecast text product (ZFP/AFD)
// (packages/tools/weather-recon, weather_forecasts). StartDate carries
// issued_at. Zone is the comma-joined 6-char UGC zone ids the product covers.
type WeatherForecast struct {
	ID          int       `json:"id"`
	Wfo         string    `json:"wfo"`
	Zone        string    `json:"zone"`
	ProductType string    `json:"product_type"`
	StartDate   time.Time `json:"start_date"`
	RawText     string    `json:"raw_text"`
}
