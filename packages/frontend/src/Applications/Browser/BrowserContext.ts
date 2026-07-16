import type {
	ActionMessage,
	ClassicyStore,
} from "classicy";
import { registerAppEventHandler } from "classicy";
import { normalizeUrl } from "./browserUtils";

export interface BrowserFavorite {
	id: string;
	title: string;
	url: string;
	icon: string;
}

export interface BrowserHistoryEntry {
	url: string;
	visitedAt: string;
}

export interface BrowserHomePage {
	url: string;
	label: string;
	icon: string;
}

const MAX_HISTORY = 500;

/**
 * One-shot remote navigation command (TVContext's pattern): `seq` is monotonic
 * so the component applies each command exactly once. Used by the playlist
 * engine's scheduled browser entries.
 */
export interface BrowserRemoteCommand {
	seq: number;
	kind: "navigate";
	url: string;
}

/** Navigate the (single) Browser window to a URL. */
export const browserNavigate = (url: string): ActionMessage => ({
	type: "ClassicyAppBrowserNavigate",
	url,
});

export const classicyBrowserEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const appId = "Browser.app";
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	let appData: Record<string, unknown> = ds.System.Manager.Applications.apps[appId].data ?? {};

	switch (action.type) {
		case "ClassicyAppBrowserNavigate": {
			appData = {
				...appData,
				command: {
					seq: ((appData.command as BrowserRemoteCommand | undefined)?.seq ?? 0) + 1,
					kind: "navigate",
					url: action.url as string,
				} satisfies BrowserRemoteCommand,
			};
			break;
		}
		case "ClassicyAppBrowserSetHomePage": {
			appData = { ...appData, homePage: { url: action.url, label: action.label, icon: action.icon } };
			break;
		}
		case "ClassicyAppBrowserInitFavorites": {
			if (!("favorites" in appData)) {
				appData = { ...appData, favorites: action.favorites };
			}
			break;
		}
		case "ClassicyAppBrowserAddFavorite": {
			appData = { ...appData, favorites: [...(appData.favorites as BrowserFavorite[] ?? []), action.favorite] };
			break;
		}
		case "ClassicyAppBrowserRemoveFavorite": {
			if (!appData.favorites) break;
			appData = { ...appData, favorites: (appData.favorites as BrowserFavorite[]).filter((f) => f.id !== action.id) };
			break;
		}
		case "ClassicyAppBrowserRecordVisit": {
			if (!("history" in appData)) {
				appData = { ...appData, history: [] };
			}
			const normalizedUrl = normalizeUrl(action.url as string);
			const history: BrowserHistoryEntry[] = (appData.history as BrowserHistoryEntry[]).filter(
				(h: BrowserHistoryEntry) => normalizeUrl(h.url) !== normalizedUrl,
			);
			history.push({ url: action.url as string, visitedAt: new Date().toISOString() });
			appData = { ...appData, history: history.slice(-MAX_HISTORY) };
			break;
		}
		case "ClassicyAppBrowserClearHistory": {
			appData = { ...appData, history: [] };
			break;
		}
		case "ClassicyAppBrowserUpdateProxyConfig": {
			appData = { ...appData, proxyConfig: action.proxyConfig };
			break;
		}
		case "ClassicyAppBrowserSetShowFavoritesBar": {
			appData = { ...appData, showFavoritesBar: action.showFavoritesBar };
			break;
		}
		default:
			break;
	}
	ds.System.Manager.Applications.apps[appId].data = appData;
	return ds;
};

registerAppEventHandler("ClassicyAppBrowser", classicyBrowserEventHandler);
