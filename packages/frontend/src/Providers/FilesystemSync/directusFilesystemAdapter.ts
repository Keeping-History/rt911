// The Classicy filesystem adapter: pushes debounced snapshots to Directus (Wasabi)
// and pulls the tree back on reconcile. Registration is global/non-React
// (see app.tsx); it learns "who is signed in" from FilesystemSyncProvider via
// setSyncUser. Per-user caches keep pushes cheap and correct across user switches.
import type {
	ClassicyFileSystemAdapter,
	ClassicyFileSystemEntry,
	ClassicyFileSystemReconcileResult,
	ClassicyFileSystemSnapshot,
} from "classicy";
import type { AuthUser } from "../Auth/authApi";
import { downloadTree, fetchFilesystemFileId, pushTree } from "./directusFilesystemApi";

let currentUser: AuthUser | null = null;
const lastPushedHash = new Map<string, string>();
const cachedFileId = new Map<string, string>();

export function setSyncUser(user: AuthUser | null): void {
	currentUser = user;
}
export function getSyncUser(): AuthUser | null {
	return currentUser;
}
export function getCachedFileId(userId: string): string | null {
	return cachedFileId.get(userId) ?? null;
}

/** Push the tree for the current user (dedupe-free). No-op when anonymous. */
export async function pushCurrentTree(tree: ClassicyFileSystemEntry): Promise<void> {
	const user = currentUser;
	if (!user) return;
	const id = await pushTree(tree, cachedFileId.get(user.id) ?? null);
	cachedFileId.set(user.id, id);
}

/** Test-only: clear module state between cases. */
export function __resetFilesystemSyncStateForTests(): void {
	currentUser = null;
	lastPushedHash.clear();
	cachedFileId.clear();
}

export const directusFilesystemAdapter: ClassicyFileSystemAdapter = {
	id: "rt911-directus-wasabi",

	async onSnapshot(snapshot: ClassicyFileSystemSnapshot): Promise<void> {
		const user = currentUser;
		if (!user) return; // anonymous: browser-local only
		if (lastPushedHash.get(user.id) === snapshot.hash) return; // unchanged since last push
		// pushTree throws on failure -> we never advance lastPushedHash, so the
		// next snapshot retries. classicy isolates the throw from the filesystem.
		const id = await pushTree(snapshot.tree, cachedFileId.get(user.id) ?? null);
		cachedFileId.set(user.id, id);
		lastPushedHash.set(user.id, snapshot.hash);
	},

	async reconcile(): Promise<ClassicyFileSystemReconcileResult> {
		const user = currentUser;
		if (!user) return { action: "useLocal" }; // anonymous: keep local, no network
		const fileId = await fetchFilesystemFileId();
		if (!fileId) return { action: "useLocal" }; // first login: local seeds the account
		const tree = await downloadTree(fileId);
		if (!tree) return { action: "useLocal" }; // corrupt/missing remote: fall back to local
		cachedFileId.set(user.id, fileId);
		return { action: "replace", tree };
	},
};
