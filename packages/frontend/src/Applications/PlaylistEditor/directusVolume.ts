import type { ClassicyFileDialogEntry, ClassicyFileDialogVolume } from "classicy";
import { ClassicyIcons } from "classicy";
import { NOTABLE_FLIGHTS } from "../FlightTracker/notableFlights";
import { directusGet } from "./directusQueue";

export const MEDIA_FILE_TYPES = {
	tv: "tv-channel",
	radio: "radio-station",
	news: "news-document",
	flight: "flight",
} as const;

export const AIRLINES: [string, string][] = [
	["AA", "American Airlines"], ["UA", "United Airlines"], ["DL", "Delta Air Lines"],
	["US", "US Airways"], ["CO", "Continental Airlines"], ["NW", "Northwest Airlines"],
	["TW", "Trans World Airlines"], ["WN", "Southwest Airlines"], ["AS", "Alaska Airlines"],
	["HP", "America West Airlines"],
];

export const FLIGHT_DATES = [
	"2001-09-09", "2001-09-10", "2001-09-11", "2001-09-12", "2001-09-13",
	"2001-09-14", "2001-09-15", "2001-09-16", "2001-09-17", "2001-09-18",
];

export type DirectusVolumeOptions = {
	tvSlugs: () => string[];
	radioSlugs: () => string[];
	fetchFn?: typeof fetch;
};

const cache = new Map<string, ClassicyFileDialogEntry[]>();
// publication folder name → source row id, filled when ["News"] is listed
const publicationIds = new Map<string, number>();

export function __clearDirectusVolumeCache(): void {
	cache.clear();
	publicationIds.clear();
}

const folder = (id: string, name: string, icon?: string): ClassicyFileDialogEntry => ({
	id, name, kind: "folder", icon: icon ?? ClassicyIcons.system.folders.directory,
});

const FLIGHT_FIELDS = "flight,origin,scheduled_dest,wheels_off_utc,wheels_on_utc";

type FlightRow = {
	flight: string; origin: string; scheduled_dest: string;
	wheels_off_utc: string | null; wheels_on_utc: string | null;
};

const flightEntry = (row: FlightRow): ClassicyFileDialogEntry => ({
	id: `flight-${row.flight}`,
	name: `${row.flight} — ${row.origin}→${row.scheduled_dest}`,
	kind: "file",
	fileType: MEDIA_FILE_TYPES.flight,
	meta: {
		app: "flights",
		itemId: row.flight,
		departure: row.wheels_off_utc,
		arrival: row.wheels_on_utc,
	},
});

export function createDirectusVolume(
	opts: DirectusVolumeOptions,
): ClassicyFileDialogVolume {
	const { tvSlugs, radioSlugs, fetchFn } = opts;

	const cached = async (
		key: string,
		make: () => Promise<ClassicyFileDialogEntry[]>,
	): Promise<ClassicyFileDialogEntry[]> => {
		const hit = cache.get(key);
		if (hit) return hit;
		const made = await make();
		cache.set(key, made);
		return made;
	};

	const list = async (path: string[]): Promise<ClassicyFileDialogEntry[]> => {
		const key = path.join("/");

		if (path.length === 0) {
			return [
				folder("tv", "TV Channels"),
				folder("radio", "Radio Stations"),
				folder("news", "News"),
				folder("flights", "Flights"),
			];
		}

		if (path[0] === "TV Channels") {
			return tvSlugs().map((slug) => ({
				id: `tv-${slug}`, name: slug, kind: "file" as const,
				fileType: MEDIA_FILE_TYPES.tv, meta: { app: "tv", itemId: slug },
			}));
		}

		if (path[0] === "Radio Stations") {
			return radioSlugs().map((slug) => ({
				id: `radio-${slug}`, name: slug, kind: "file" as const,
				fileType: MEDIA_FILE_TYPES.radio, meta: { app: "radio", itemId: slug },
			}));
		}

		if (path[0] === "News" && path.length === 1) {
			return cached(key, async () => {
				const sources = (await directusGet(
					"/items/sources?fields=id,slug,name&limit=500", fetchFn,
				)) as { id: number; slug: string; name: string | null }[];
				const groups = (await directusGet(
					"/items/news_items?aggregate[count]=*&groupBy=source", fetchFn,
				)) as { source: number }[];
				const withNews = new Set(groups.map((g) => g.source));
				return sources
					.filter((s) => withNews.has(s.id))
					.map((s) => {
						const name = s.name || s.slug;
						publicationIds.set(name, s.id);
						return folder(`news-src-${s.id}`, name);
					})
					.sort((a, b) => a.name.localeCompare(b.name));
			});
		}

		if (path[0] === "News" && path.length === 2) {
			const sourceId = publicationIds.get(path[1]);
			if (sourceId === undefined) return [];
			return cached(key, async () => {
				const rows = (await directusGet(
					`/items/news_items?filter[source][_eq]=${sourceId}&fields=id,title,start_date&sort=start_date&limit=1000`,
					fetchFn,
				)) as { id: number; title: string; start_date: string }[];
				return rows.map((r) => ({
					id: `news-${r.id}`, name: r.title, kind: "file" as const,
					fileType: MEDIA_FILE_TYPES.news,
					meta: { app: "news", itemId: String(r.id), publishedAt: r.start_date },
				}));
			});
		}

		if (path[0] === "Flights" && path.length === 1) {
			return [
				folder("notable", "Notable Flights"),
				...AIRLINES.map(([code, name]) => folder(`airline-${code}`, name)),
			];
		}

		if (path[0] === "Flights" && path[1] === "Notable Flights") {
			return cached(key, async () => {
				const entries: ClassicyFileDialogEntry[] = [];
				for (const callsign of NOTABLE_FLIGHTS) {
					const rows = (await directusGet(
						`/items/flight_tracks?filter[flight][_eq]=${callsign}&filter[flight_date][_eq]=2001-09-11&fields=${FLIGHT_FIELDS}&limit=1`,
						fetchFn,
					)) as FlightRow[];
					if (rows[0]) entries.push(flightEntry(rows[0]));
				}
				return entries;
			});
		}

		if (path[0] === "Flights" && path.length === 2) {
			return FLIGHT_DATES.map((d) => folder(`date-${path[1]}-${d}`, d));
		}

		if (path[0] === "Flights" && path.length === 3) {
			const code = AIRLINES.find(([, name]) => name === path[1])?.[0];
			if (!code) return [];
			return cached(key, async () => {
				const rows = (await directusGet(
					`/items/flight_tracks?filter[flight][_starts_with]=${code}&filter[flight_date][_eq]=${path[2]}&fields=${FLIGHT_FIELDS}&sort=flight&limit=3000`,
					fetchFn,
				)) as FlightRow[];
				return rows.map(flightEntry);
			});
		}

		return [];
	};

	return {
		id: "rt911-archive",
		label: "911 Realtime Archive",
		icon: ClassicyIcons.system.drives.networkDrive,
		list,
	};
}
