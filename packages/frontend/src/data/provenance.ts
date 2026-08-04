import { AIRCRAFT_CREDITS, WTC_HERO_CREDIT, type ModelCredit } from "./aircraftCredits";

export type ProvenanceSource = {
	/** Human-readable name of the upstream source. */
	name: string;
	/** Absolute https URL. Link-checked before commit — see the plan's Task 8. */
	url: string;
	/** What this source contributes to the app. */
	feeds: string;
	/** License, caveat, or retrieval date. */
	note?: string;
};

export type AppProvenance = {
	appName: string;
	blurb: string;
	sources: ProvenanceSource[];
	/** "How this was built" — disclosed wherever the app presents derived or
	 * reconstructed data as though it were live. */
	method?: string[];
	credits?: ModelCredit[];
};

export const APP_PROVENANCE: Record<string, AppProvenance> = {
	"PagerDecoder.app": {
		appName: "Pager Decoder",
		blurb:
			"Pager traffic from September 11, 2001 — roughly 448,000 messages across the Skytel, Arch, Metrocall and Weblink networks, replayed as each was transmitted.",
		sources: [
			{
				name: "WikiLeaks — 9/11 Pager Intercepts",
				url: "https://911.wikileaks.org/",
				feeds: "Every pager message, with its provider, channel and mode as released.",
				note: "Released November 2009.",
			},
		],
	},

	"Browser.app": {
		appName: "Browser",
		blurb:
			"The web as it looked on September 11, 2001, served from archived captures through a period-accurate proxy.",
		sources: [
			{
				name: "Internet Archive Wayback Machine",
				url: "https://web.archive.org/",
				feeds: "Archived pages, targeting 2001-09-11 or the nearest available capture.",
			},
		],
		method: [
			"Pages are rewritten so links and subresources resolve back through the proxy.",
			"A capture may predate or postdate the virtual clock by hours or days — the Wayback Machine holds what it crawled, not a continuous record.",
		],
	},

	"RadioScanner.app": {
		appName: "Radio Scanner",
		blurb:
			"Air-traffic control, military and commercial radio from the morning of September 11, 2001.",
		sources: [
			{
				name: "Rutgers Law Review — “A New Type of War”",
				url: "https://www.rutgerslawreview.com/a-new-type-of-war/",
				feeds: "The Rutgers channel — FAA and NORAD audio published with the monograph.",
			},
			{
				name: "Audacy",
				url: "https://www.audacy.com/1010wins",
				feeds: "1010 WINS coverage.",
			},
			{
				name: "WCBS Audio Archives",
				url: "https://www.audacy.com/wcbs880",
				feeds: "WCBS Newsradio 880 coverage.",
			},
			{
				name: "Internet Archive",
				url: "https://archive.org/details/911datasets",
				feeds:
					"The remaining clips — the ATC and NORAD channels (atc, NEADS/NORAD, Langley, FAA, ATCSCC, ZNY, ZBW, ZOB, ZDC) and the per-flight channels (AA11, UA175, AA77, UA93, DL1989, GOFER06).",
				note: "From a NIST release or uploaded directly to the Archive.",
			},
		],
		method: [
			"Captions are machine transcriptions (whisper.cpp), not official transcripts — treat wording as approximate.",
			"Audio is loudness-normalized from the archived originals; the originals are retained unmodified.",
		],
	},

	"TV.app": {
		appName: "TV",
		blurb:
			"23 television channels replayed continuously across September 9–18, 2001, in step with the virtual clock.",
		sources: [
			{
				name: "Internet Archive — Understanding 9/11: A Television News Archive",
				url: "https://archive.org/details/sept_11_tv_archive",
				feeds: "The broadcast recordings behind every channel.",
			},
			{
				name: "Internet Archive — 9/11 collection",
				url: "https://archive.org/details/911",
				feeds: "Additional broadcasts not held in the television archive.",
			},
		],
		method: [
			"Recordings are re-encoded to HLS and stitched into continuous nine-day channels; gaps between recordings are filled, so not every moment is an original broadcast.",
			"Captions are machine transcriptions (whisper.cpp), not broadcast captions.",
		],
	},

	"Newsgroups.app": {
		appName: "Newsgroups",
		blurb:
			"Usenet as it was posted — millions of messages across the groups that carried the day's discussion.",
		sources: [
			{
				name: "Internet Archive — Usenet archives",
				url: "https://archive.org/details/usenet",
				feeds: "Per-group mbox archives, converted to individual messages.",
			},
		],
	},

	"News.app": {
		appName: "News",
		blurb:
			"A timeline of what was happening, minute by minute, alongside the back catalogue of the preceding days.",
		sources: [
			{
				name: "History Commons — the Complete 9/11 Timeline",
				url: "https://ic911.org/complete-911-timeline/",
				feeds: "Every timeline entry and its accompanying images.",
				note: "historycommons.org went offline; the timeline was restored by the International Center for 9/11 Justice at ic911.org. Images are mirrored locally from cdn.historycommons.org.",
			},
		],
		method: [
			"This is an investigative timeline compiled afterwards — accurate about what happened, but containing detail that was not public in 2001.",
			"Entry times are when an event occurred, not when it was reported. Much of it was unknown until the 9/11 Commission reported in 2004.",
		],
	},

	"MarketWatch.app": {
		appName: "MarketWatch",
		blurb:
			"Equity and bond markets around the September 2001 halt — the longest closure of the New York Stock Exchange since 1933.",
		sources: [
			{
				name: "Yahoo Finance chart API",
				url: "https://finance.yahoo.com/",
				feeds: "Daily bars for listed lineages that still reach back to 2001.",
			},
			{
				name: "FRED — 10-Year Treasury Constant Maturity Rate (DGS10)",
				url: "https://fred.stlouisfed.org/series/DGS10",
				feeds: "The 10-year Treasury yield.",
			},
			{
				name: "Archival newspaper stock tables and contemporaneous reporting",
				url: "https://web.archive.org/",
				feeds:
					"Delisted paper with no surviving free source — AMR, UAL, DAL, CAL, NWAC, U, MER, LEH, BSC, EK, GM, RTN, HLT and the old AT&T.",
				note: "Every hand-entered figure carries its own citation, chiefly Wayback captures of Yahoo's historical CSVs and CNNfn.",
			},
		],
		method: [
			"Modern quotes are split-adjusted; closes are multiplied back by later split ratios to recover as-printed 2001 prices.",
			"Intraday paths are deterministically synthesized from each day's open, high, low and close — they are not real tick data.",
			"Several 2001 tickers now belong to different companies; where a symbol was reused, the 2001 lineage is used.",
		],
	},

	"Weather.app": {
		appName: "Weather",
		blurb:
			"Observations, radar and forecasts for September 2001 — an unusually clear morning across the northeast.",
		sources: [
			{
				name: "NOAA NCEI — Integrated Surface Database",
				url: "https://www.ncei.noaa.gov/products/land-based-station/integrated-surface-database",
				feeds: "Hourly METAR and SPECI observations for the curated station list.",
			},
			{
				name: "Iowa Environmental Mesonet",
				url: "https://mesonet.agron.iastate.edu/",
				feeds: "Archived NEXRAD CONUS radar composites at five-minute intervals, and the AFOS text products behind the forecasts.",
			},
			{
				name: "OpenStreetMap",
				url: "https://www.openstreetmap.org/copyright",
				feeds: "The radar map's vector base layer — land, lakes and place labels.",
				note: "© OpenStreetMap contributors, ODbL. Tiles built with Protomaps.",
			},
			{
				name: "OpenStreetMap Data — coastlines",
				url: "https://osmdata.openstreetmap.de/data/coastlines.html",
				feeds: "The detailed coastline under the radar map at closer zooms.",
			},
			{
				name: "NASA Visible Earth",
				url: "https://visibleearth.nasa.gov/",
				feeds: "Blue Marble day and City Lights night imagery for the radar map's Satellite style.",
			},
		],
	},

	"FlightTracker.app": {
		appName: "Flight Tracker",
		blurb:
			"United States air traffic on September 11, 2001 — about 8,700 flights, including the four that were hijacked.",
		sources: [
			{
				name: "Bureau of Transportation Statistics — TranStats",
				url: "https://www.transtats.bts.gov/",
				feeds: "On-Time Performance records for September 2001: every scheduled flight, its route and its times.",
			},
			{
				name: "84th RADES radar files (FOIA release)",
				url: "https://archive.org/details/911datasets",
				feeds: "Per-sweep radar positions for AA11, UA175, AA77, UA93 and the C-130 that observed AA77.",
			},
			{
				name: "NTSB Flight Path Studies",
				url: "https://www.ntsb.gov/about/Documents/Flight_Path_Study_AA77.pdf",
				feeds: "Documented altitude and position anchors across radar coverage gaps.",
			},
			{
				name: "9/11 Commission Report",
				url: "https://www.9-11commission.gov/report/",
				feeds: "Corroborating times and course deviations for the hijacked flights.",
			},
			{
				name: "FAA Aircraft Registry (2001 snapshot via the Wayback Machine)",
				url: "https://web.archive.org/web/2001/http://registry.faa.gov/",
				feeds: "Tail numbers and aircraft types as registered in September 2001.",
			},
			{
				name: "OpenFlights",
				url: "https://openflights.org/data.php",
				feeds: "Airport locations and time zones.",
			},
			{
				name: "OurAirports",
				url: "https://ourairports.com/data/",
				feeds: "Airport field elevations, so climbs and descents are anchored to real ground height.",
			},
			{
				name: "NYC Open Data — Building Footprints",
				url: "https://data.cityofnewyork.us/City-Government/Building-Footprints/5zhs-2jue",
				feeds: "Lower Manhattan building footprints and heights, filtered to those standing in 2001.",
			},
			{
				name: "Arlington County GIS Open Data",
				url: "https://gisdata-arlgis.opendata.arcgis.com/",
				feeds: "Pentagon and Arlington building footprints.",
			},
			{
				name: "OpenStreetMap",
				url: "https://www.openstreetmap.org/copyright",
				feeds: "The vector basemap — land, lakes and place labels.",
				note: "© OpenStreetMap contributors, ODbL. Tiles built with Protomaps.",
			},
			{
				name: "OpenStreetMap Data — coastlines",
				url: "https://osmdata.openstreetmap.de/data/coastlines.html",
				feeds: "The detailed coastline used at closer zooms.",
			},
			{
				name: "Natural Earth",
				url: "https://www.naturalearthdata.com/",
				feeds:
					"Country and state/province boundary lines — the coarse 1:50m set for the world view and the detailed 1:10m set over the continental US.",
				note: "Public domain.",
			},
			{
				name: "NASA Visible Earth",
				url: "https://visibleearth.nasa.gov/",
				feeds: "Blue Marble day and City Lights night imagery for satellite view.",
			},
			{
				name: "Mapterhorn",
				url: "https://mapterhorn.com/attribution/",
				feeds: "The terrain elevation data behind the 3D terrain toggle.",
				note: "Mapterhorn aggregates open elevation datasets (e.g. Copernicus DEM, swissALTI3D) rather than publishing its own survey — see its attribution page for the underlying sources covering this map's extent.",
			},
		],
		method: [
			"Flight positions are reconstructed, not recorded. Civil radar tracks for that day were never archived, so paths are interpolated from scheduled departures and arrivals.",
			"The four hijacked flights and the C-130 use real per-sweep radar positions where radar saw them. Where transponders were switched off, the path interpolates through documented NTSB anchors and the coverage gap is marked as such.",
			"Descents are anchored to each airport's real field elevation. Altitudes are exaggerated relative to the terrain so tracks stay readable.",
			"The Pentagon renders as an extruded footprint rather than a detailed model — no license-clean model was sourced.",
		],
		credits: [WTC_HERO_CREDIT, ...AIRCRAFT_CREDITS],
	},
};

export const PROVENANCE_APP_IDS = Object.keys(APP_PROVENANCE);
