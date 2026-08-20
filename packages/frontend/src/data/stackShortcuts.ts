/**
 * HyperCard stacks that also get a desktop icon — the single source of truth
 * shared by the desktop shortcut (Desktop.tsx) and the Finder drive-root entry
 * (DefaultFileSystem.ts).
 *
 * Both surfaces exist for the same reason the CMS page shortcuts have both (see
 * pageShortcuts.ts): rt911 runs `defaultFileSystemMode="exclusive"` and syncs
 * each signed-in user's tree to Directus, so a new default-tree entry may never
 * reach someone who already has a synced filesystem. Icon registration re-runs
 * on every mount and has no such gap. The two must therefore always agree on
 * what the shortcut points at, which is what this module guarantees.
 */

/** Drive the shortcut resolves within. */
export const STACK_DRIVE = "Macintosh HD";

/** Filename of the guide stack at the drive root. */
export const GETTING_STARTED_FILE = "Getting Started.stack";

/** Label on the desktop icon — the document name without its extension. */
export const GETTING_STARTED_NAME = "Getting Started";

export const GETTING_STARTED_ICON_ID = "shortcut_getting_started";

/**
 * Classicy file-system paths are **colon**-separated, not slash-separated —
 * the classic Mac convention, and what `ClassicyFileSystem.pathArray` splits on.
 * A slash here would resolve to nothing and the icon would silently do nothing.
 */
export const GETTING_STARTED_PATH = `${STACK_DRIVE}:${GETTING_STARTED_FILE}`;

/**
 * Opening a stack means handing its path to HyperCard, which fetches and
 * validates the document and then opens it. The kernel's generic `*OpenFile`
 * handler appends the path to `HyperCard.app`'s `data.openFiles` and launches
 * the app — the same route Finder takes when the stack is double-clicked, so
 * the desktop icon and the Finder entry behave identically.
 */
export const HYPERCARD_APP_ID = "HyperCard.app";
export const HYPERCARD_OPEN_FILE_EVENT = "ClassicyAppHyperCardOpenFile";
