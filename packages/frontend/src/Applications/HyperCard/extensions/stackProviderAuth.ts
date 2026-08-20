/**
 * Module-level auth mirror for the Directus stack save provider. classicy's
 * save-provider registry lives outside React, but auth state lives in
 * AuthContext — this bridge (the HyperCardClockBridge idiom) mirrors the
 * signed-in flag into module scope so the provider's canSave() can read it.
 * In-memory only; never persisted.
 */
import { type FC, useEffect } from "react";
import { useAuth } from "../../../Providers/Auth/AuthContext";

let signedIn = false;

export function setStackProviderAuth(value: boolean): void {
	signedIn = value;
}

export function isStackProviderSignedIn(): boolean {
	return signedIn;
}

export const HyperCardStackAuthBridge: FC = () => {
	const { status } = useAuth();
	useEffect(() => {
		setStackProviderAuth(status === "signedIn");
		return () => setStackProviderAuth(false);
	}, [status]);
	return null;
};
