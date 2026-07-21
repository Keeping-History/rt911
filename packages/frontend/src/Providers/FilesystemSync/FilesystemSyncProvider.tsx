// Bridges React auth state to the (non-React) Classicy filesystem adapter.
// Boot-time reconcile runs before auth resolves, and email login doesn't remount,
// so this component owns the login-pull / first-login-seed / logout-reset
// transitions and the pre-sign-out flush. Mount it INSIDE AuthProvider.
import { type FC, type ReactNode, useEffect, useRef } from "react";
import { dispatch, useClassicyFileSystem } from "classicy";
import type { ClassicyFileSystemEntry } from "classicy";
import { useAuth } from "../Auth/AuthContext";
import { registerBeforeSignOut } from "../Auth/beforeSignOut";
import { DefaultFileSystem } from "../../data/DefaultFileSystem";
import { pushCurrentTree, setSyncUser } from "./directusFilesystemAdapter";

const bumpDesktop = () => dispatch({ type: "ClassicyDesktopFileSystemVersionBump" });

export const FilesystemSyncProvider: FC<{ children: ReactNode }> = ({ children }) => {
	const { status, user } = useAuth();
	const fs = useClassicyFileSystem();
	const prev = useRef<{ signedIn: boolean }>({ signedIn: false });

	// Best-effort flush BEFORE the session cookie is cleared on sign-out.
	useEffect(
		() => registerBeforeSignOut(() => pushCurrentTree(JSON.parse(fs.snapshot()) as ClassicyFileSystemEntry)),
		[fs],
	);

	useEffect(() => {
		setSyncUser(user);
		const wasSignedIn = prev.current.signedIn;
		const nowSignedIn = status === "signedIn";

		if (!wasSignedIn && nowSignedIn && user) {
			void (async () => {
				try {
					const replaced = await fs.reconcileWithAdapters();
					if (replaced) bumpDesktop();
					else await pushCurrentTree(JSON.parse(fs.snapshot()) as ClassicyFileSystemEntry); // seed account
				} catch (err) {
					// Network/Directus failure: leave lastPushedHash unchanged so the next snapshot retries.
					console.warn("FilesystemSyncProvider: login-transition sync failed", err);
				}
			})();
		} else if (wasSignedIn && !nowSignedIn) {
			// Tree already flushed by the pre-sign-out hook; reset to the anonymous default.
			fs.load(JSON.stringify(DefaultFileSystem));
			bumpDesktop();
		}

		prev.current.signedIn = nowSignedIn;
	}, [status, user, fs]);

	return <>{children}</>;
};
