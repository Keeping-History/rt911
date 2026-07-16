import { createContext, useContext } from "react";
import type { AuthUser } from "./authApi";

export type AuthStatus = "loading" | "anonymous" | "signedIn";

export interface AuthContextValue {
	status: AuthStatus;
	user: AuthUser | null;
	signInWithEmail: (email: string, password: string) => Promise<void>;
	signInWithProvider: (provider: "google" | "facebook" | "apple") => void;
	signOut: () => Promise<void>;
	refresh: () => Promise<void>;
	/** Self-service email+password registration (verify-email required). */
	register: (email: string, password: string) => Promise<void>;
}

// Default = anonymous, no-op actions: safe for any consumer mounted outside
// AuthProvider (isolated tests, storybook-style rendering).
export const AuthContext = createContext<AuthContextValue>({
	status: "anonymous",
	user: null,
	signInWithEmail: async () => {},
	signInWithProvider: () => {},
	signOut: async () => {},
	refresh: async () => {},
	register: async () => {},
});

export const useAuth = (): AuthContextValue => useContext(AuthContext);
