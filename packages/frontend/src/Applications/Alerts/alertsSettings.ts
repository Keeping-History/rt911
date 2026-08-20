import { useSyncExternalStore } from "react";

/**
 * Desktop-wide "show alerts" preference, written by the Alerts Manager control
 * panel and read by the Alerts extension. Lives outside React (plus a
 * localStorage mirror) because the two apps mount independently under
 * ClassicyDesktop with no shared ancestor that owns this state.
 */
const STORAGE_KEY = "rt911AlertsEnabled";

const readStored = (): boolean => {
	try {
		return window.localStorage.getItem(STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
};

let enabled = readStored();
const listeners = new Set<() => void>();

export const getAlertsEnabled = (): boolean => enabled;

export const setAlertsEnabled = (value: boolean): void => {
	if (enabled === value) return;
	enabled = value;
	try {
		window.localStorage.setItem(STORAGE_KEY, String(value));
	} catch {
		// Storage unavailable (private-mode Safari): setting is session-only.
	}
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const useAlertsEnabled = (): boolean =>
	useSyncExternalStore(subscribe, getAlertsEnabled);

/** Test-only: re-hydrate the module cache after tests mutate localStorage. */
export const resetAlertsSettingsForTests = (): void => {
	enabled = readStored();
};
