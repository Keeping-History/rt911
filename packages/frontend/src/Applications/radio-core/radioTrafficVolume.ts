/**
 * The Radio Traffic tag tree — namespace → tag value → clips — for anything
 * that needs to browse the comm-traffic catalogue by tag rather than by the
 * live app's own filter sidebar. Built from one direct Directus REST call
 * (bypassing the streamer entirely, matching directusVolume.ts's existing
 * TV/News/Flights folders), memoized at module scope so every caller shares
 * one fetch and one tree.
 *
 * Two current consumers: PlaylistEditor's "Add Media" → Radio Traffic folder,
 * and HyperCard's directusAudio clip picker.
 */
import type { ClassicyFileDialogEntry, ClassicyFileDialogVolume } from "classicy";
import { directusGet } from "../../lib/directusQueue";
import { BROADCAST_STATIONS, stationKey } from "./stationGrouping";

interface Mp3TagJoin {
	mp3_tags_id: { tag: string; namespace: string | null; value: string | null } | null;
}
interface Mp3ItemRow {
	id: number;
	title: string;
	full_title: string | null;
	source?: { slug: string | null } | null;
	tags?: Mp3TagJoin[];
}

/** namespace → tag value → clips carrying that tag. */
type RadioTrafficTree = Map<string, Map<string, ClassicyFileDialogEntry[]>>;

const FIELDS =
	"id,title,full_title,source.slug,tags.mp3_tags_id.tag,tags.mp3_tags_id.namespace,tags.mp3_tags_id.value";
const QUERY = `/items/mp3_items?fields=${FIELDS}&filter[tags][mp3_tags_id][namespace][_nnull]=true&limit=-1`;

let cached: Promise<RadioTrafficTree> | null = null;

/** "aircraft" → "Aircraft" — every namespace is one lowercase word, matching tagFilter.ts's labelFor. */
function labelFor(namespace: string): string {
	return namespace.charAt(0).toUpperCase() + namespace.slice(1);
}

async function loadTree(fetchFn: typeof fetch): Promise<RadioTrafficTree> {
	const rows = (await directusGet(QUERY, fetchFn)) as Mp3ItemRow[];
	const tree: RadioTrafficTree = new Map();
	for (const row of rows) {
		// stationKey wants {source, title} with source as string|undefined; raw
		// Directus JSON sends null for an empty nullable column (not undefined), and
		// source is a relation object {slug: string|null}, not a bare string — extract .slug.
		const key = stationKey({ source: row.source?.slug ?? undefined, title: row.title });
		if (BROADCAST_STATIONS.has(key.toUpperCase())) continue;
		const entry: ClassicyFileDialogEntry = {
			id: `radio-traffic-${row.id}`,
			name: row.full_title ?? row.title,
			kind: "file",
			fileType: "radio-traffic",
			meta: { app: "radio", itemId: row.id },
		};
		for (const join of row.tags ?? []) {
			const tag = join.mp3_tags_id;
			if (!tag?.namespace || !tag.value) continue;
			let byValue = tree.get(tag.namespace);
			if (!byValue) {
				byValue = new Map();
				tree.set(tag.namespace, byValue);
			}
			let clips = byValue.get(tag.value);
			if (!clips) {
				clips = [];
				byValue.set(tag.value, clips);
			}
			clips.push(entry);
		}
	}
	return tree;
}

export function __clearRadioTrafficVolumeCache(): void {
	cached = null;
}

export function buildRadioTrafficVolume(fetchFn: typeof fetch = fetch): ClassicyFileDialogVolume {
	const list = async (path: string[]): Promise<ClassicyFileDialogEntry[]> => {
		if (!cached) {
			cached = loadTree(fetchFn).catch((e) => {
				cached = null;
				throw e;
			});
		}
		const tree = await cached;
		if (path.length === 0) {
			return [...tree.keys()]
				.map((namespace) => ({
					id: `radio-traffic-ns-${namespace}`,
					name: labelFor(namespace),
					kind: "folder" as const,
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
		}
		const namespace = path[0].toLowerCase();
		const byValue = tree.get(namespace);
		if (!byValue) return [];
		if (path.length === 1) {
			return [...byValue.keys()]
				.map((value) => ({
					id: `radio-traffic-ns-${namespace}-${value}`,
					name: value,
					kind: "folder" as const,
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
		}
		return byValue.get(path[1]) ?? [];
	};
	return { id: "radio-traffic-tags", label: "Radio Traffic", list };
}
