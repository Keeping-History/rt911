// Registry-driven metadata for playlist "settings" entries: which desktop
// apps a settings entry can target, and what fields the chosen app's
// registered state schema declares — the data behind the Add Settings
// dropdown and the Settings window's generated form.
import { getAppManifest, listAppManifests } from "classicy";
import { z } from "zod";
import { playlistAppMeta } from "../../Providers/Playlist/playlistApps";

export interface SettingsApp {
	appId: string;
	name: string;
}

/** "PagerDecoder.app" → "Pager Decoder" for apps playlistAppMeta has no
 * curated name for. */
function prettyAppName(appId: string): string {
	const meta = playlistAppMeta(appId).name;
	if (meta !== appId) return meta;
	return appId.replace(/\.app$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Apps a settings entry can target: every registered manifest that declares a
 * `state` schema — no schema means the app has declared nothing a playlist
 * could set. PlaylistEditor.app itself registers no state, so it drops out
 * here rather than via a special case. Computed lazily on every call:
 * registration happens at each context module's import, so a module-scope
 * snapshot could run before the other apps had loaded.
 */
export function listSettingsApps(): SettingsApp[] {
	return listAppManifests()
		.filter((m) => m.state !== undefined)
		.map((m) => ({ appId: m.id, name: prettyAppName(m.id) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export type SettingsField = {
	key: string;
	/** The schema field's .describe() text — balloon copy, written for users. */
	description?: string;
} & (
	| { control: "boolean" | "number" | "string" }
	| { control: "enum"; options: string[] }
	/** Arrays, records, nested objects, unions: edited as raw JSON. */
	| { control: "json" }
);

type ZodDefLike = { type?: string; innerType?: z.ZodType };

/** Strip optional/default/nullable wrappers down to the value schema. */
function unwrap(field: z.ZodType): z.ZodType {
	let inner = field;
	for (;;) {
		const def = (inner as unknown as { def?: ZodDefLike }).def;
		if (
			def?.innerType &&
			(def.type === "optional" || def.type === "default" || def.type === "nullable")
		) {
			inner = def.innerType;
		} else {
			return inner;
		}
	}
}

/**
 * The form fields declared by an app's registered state schema, in declaration
 * order. Only top-level fields: a settings entry's `values` are merged
 * shallowly into the app's data (ClassicyAppPlaylistMergeData), so top-level
 * keys are exactly the grain a teacher can force.
 */
export function settingsFieldsOf(appId: string): SettingsField[] {
	const state = getAppManifest(appId)?.state;
	if (!(state instanceof z.ZodObject)) return [];
	return Object.entries(state.shape as Record<string, z.ZodType>).map(([key, field]) => {
		const inner = unwrap(field);
		// .describe() may sit on the outer optional() or on the inner type,
		// depending on call order in the app's schema.
		const description = field.description ?? inner.description;
		const type = (inner as unknown as { def?: ZodDefLike }).def?.type;
		if (type === "boolean" || type === "number" || type === "string") {
			return { key, description, control: type };
		}
		if (type === "enum") {
			const options = (inner as z.ZodEnum<Record<string, string>>).options.map(String);
			return { key, description, control: "enum", options };
		}
		return { key, description, control: "json" };
	});
}

/** Seed value when a field is first included in a settings entry. */
export function defaultValueFor(field: SettingsField): unknown {
	switch (field.control) {
		case "boolean":
			return false;
		case "number":
			return 0;
		case "string":
			return "";
		case "enum":
			return field.options[0];
		case "json":
			return null;
	}
}
