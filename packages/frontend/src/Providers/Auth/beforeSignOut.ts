// Generic hooks that run BEFORE AuthProvider clears the Directus session cookie.
// Lets features (e.g. filesystem sync) flush pending server writes while the
// session is still valid, without AuthProvider depending on those features.
type BeforeSignOutHook = () => Promise<void> | void;

const hooks = new Set<BeforeSignOutHook>();

/** Register a hook; returns an unregister function. */
export function registerBeforeSignOut(fn: BeforeSignOutHook): () => void {
	hooks.add(fn);
	return () => hooks.delete(fn);
}

/** Run all hooks concurrently. A failing hook is logged and swallowed — sign-out must never be blocked. */
export async function runBeforeSignOutHooks(): Promise<void> {
	await Promise.all(
		[...hooks].map(async (fn) => {
			try {
				await fn();
			} catch (err) {
				console.warn("beforeSignOut hook failed", err);
			}
		}),
	);
}
