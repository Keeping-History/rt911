// Session boot check against Directus. Never persisted — no localStorage, no
// ClassicyStore; every reload re-derives status from the httpOnly session
// cookie via fetchMe(), same non-persistence stance as PlaylistProvider.
import { type FC, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchMe, loginEmail, logout, providerLoginUrl, type AuthUser } from "./authApi";
import { AuthContext, type AuthContextValue, type AuthStatus } from "./AuthContext";

export const AuthProvider: FC<{ children: ReactNode }> = ({ children }) => {
	const [status, setStatus] = useState<AuthStatus>("loading");
	const [user, setUser] = useState<AuthUser | null>(null);

	const refresh = useCallback(async () => {
		try {
			const me = await fetchMe();
			setUser(me);
			setStatus(me ? "signedIn" : "anonymous");
		} catch (err) {
			// Fail-open: an unreachable/erroring Directus degrades to anonymous
			// rather than wedging the desktop in "loading" forever.
			console.warn("AuthProvider: fetchMe failed, treating session as anonymous", err);
			setUser(null);
			setStatus("anonymous");
		}
	}, []);

	// Boot check once at mount (StrictMode double-mount guarded by the ref,
	// same pattern as PlaylistProvider's loadStartedRef).
	const loadStartedRef = useRef(false);
	useEffect(() => {
		if (loadStartedRef.current) return;
		loadStartedRef.current = true;
		void refresh();
	}, [refresh]);

	const signInWithEmail = useCallback(
		async (email: string, password: string) => {
			await loginEmail(email, password); // throws on failure; caller handles
			await refresh();
		},
		[refresh],
	);

	const signInWithProvider = useCallback((provider: "google" | "facebook" | "apple") => {
		// Use bare origin, not href, to avoid including query strings that
		// Directus's AUTH_GOOGLE_REDIRECT_ALLOW_LIST would reject (exact match only).
		window.location.assign(providerLoginUrl(provider, window.location.origin + "/"));
	}, []);

	const signOut = useCallback(async () => {
		await logout(); // best-effort; authApi swallows its own failures
		setUser(null);
		setStatus("anonymous");
	}, []);

	const value = useMemo<AuthContextValue>(
		() => ({ status, user, signInWithEmail, signInWithProvider, signOut, refresh }),
		[status, user, signInWithEmail, signInWithProvider, signOut, refresh],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
