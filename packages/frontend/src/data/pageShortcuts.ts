import {
	ClassicyFileSystemEntryFileType,
	ClassicyIcons,
	type ClassicyFileSystemTree,
} from "classicy";

/**
 * The present-day CMS pages, as web shortcuts — the single source of truth
 * shared by the desktop icons (Desktop.tsx) and the Finder drive root
 * (DefaultFileSystem.ts).
 *
 * Both surfaces exist deliberately and both read from here: rt911 runs
 * `defaultFileSystemMode="exclusive"` and syncs each signed-in user's tree to
 * Directus, so a new default-tree entry may never arrive for someone who
 * already has a synced filesystem. Icon registration re-runs on every mount
 * and has no such gap — so the desktop icons and the Finder shortcuts reach
 * different users, but they must always agree on where each one points.
 */
export const PAGE_SHORTCUTS = [
	{ iconId: "shortcut_press", name: "Press Room", url: "/press" },
	{ iconId: "shortcut_teachers", name: "For Teachers", url: "/teachers" },
] as const;

/**
 * These open in a real browser tab rather than the in-desktop viewer: they
 * are current content to be read, printed and shared, and the desktop (and
 * the replay running on it) survives untouched in the original tab.
 */
export const PAGE_SHORTCUT_DISPOSITION = "browser-new";

export const pageShortcutIcon =
	ClassicyIcons.applications.internetExplorer.document;

/** Drive-root Finder entries for the CMS page shortcuts, keyed by display name. */
export const pageShortcutEntries: ClassicyFileSystemTree = Object.fromEntries(
	PAGE_SHORTCUTS.map(({ name, url }) => [
		name,
		{
			_type: ClassicyFileSystemEntryFileType.Shortcut,
			_icon: pageShortcutIcon,
			_url: url,
			_openIn: PAGE_SHORTCUT_DISPOSITION,
		},
	]),
);
