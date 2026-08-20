import type {
	ActionMessage,
	ClassicyStore,
} from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";
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

const favoriteSchema = z.object({
	id: z.string().describe("Stable favorite id."),
	title: z.string().describe("Display title."),
	url: z.string().describe("Destination URL."),
	icon: z.string().describe("Icon asset URL."),
});

export const BrowserDataSchema = z.looseObject({
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each navigation applies exactly once."),
			kind: z.literal("navigate").describe("Command kind; only \"navigate\" exists."),
			url: z.string().describe("URL to navigate the Browser window to."),
		})
		.optional()
		.describe("Pending one-shot remote navigation (playlist scheduled browser entries)."),
	homePage: z
		.object({
			url: z.string().describe("Home page URL."),
			label: z.string().describe("Home button label."),
			icon: z.string().describe("Home button icon URL."),
		})
		.optional()
		.describe("The user's chosen home page."),
	favorites: z.array(favoriteSchema).optional().describe("The favorites bar's entries, in order."),
	history: z
		.array(
			z.object({
				url: z.string().describe("Visited URL."),
				visitedAt: z.string().describe("ISO-8601 visit timestamp."),
			}),
		)
		.optional()
		.describe("Visit history, deduplicated by normalized URL, capped at 500."),
	proxyConfig: z
		.looseObject({
			enabled: z.boolean().describe("Whether the Time Machine web proxy is used."),
			protocol: z.string().describe("Proxy scheme, e.g. \"https\"."),
			host: z.string().describe("Proxy host."),
			port: z.number().describe("Proxy port."),
			archiveTime: z.string().describe("Wayback timestamp the proxy pins pages to."),
			proxyPrefix: z.string().describe("Path prefix the proxy expects."),
			path: z.string().describe("Extra path segment appended after the prefix."),
		})
		.partial()
		.optional()
		.describe("Time Machine proxy configuration (mirrors TimeMachineProxyConfig)."),
	showFavoritesBar: z.boolean().optional().describe("Whether the favorites bar is visible."),
});

export type BrowserData = z.infer<typeof BrowserDataSchema>;

registerApp({
	id: "Browser.app",
	description: "Browse the September 2001 web through the Time Machine archive proxy.",
	prefix: "ClassicyAppBrowser",
	handler: classicyBrowserEventHandler,
	actions: {
		ClassicyAppBrowserNavigate: {
			description: "Navigate the Browser window to a URL (one-shot).",
			params: z.object({ url: z.string().describe("URL to open.") }),
		},
		ClassicyAppBrowserSetHomePage: {
			description: "Set the home page (URL, label, and icon).",
			params: z.object({
				url: z.string().describe("Home page URL."),
				label: z.string().describe("Home button label."),
				icon: z.string().describe("Home button icon URL."),
			}),
		},
		ClassicyAppBrowserInitFavorites: {
			description: "Seed the favorites list, only if none exists yet.",
			params: z.object({ favorites: z.array(favoriteSchema).describe("Initial favorites.") }),
		},
		ClassicyAppBrowserAddFavorite: {
			description: "Append one favorite.",
			params: z.object({ favorite: favoriteSchema }),
		},
		ClassicyAppBrowserRemoveFavorite: {
			description: "Remove the favorite with this id.",
			params: z.object({ id: z.string().describe("Favorite id to remove.") }),
		},
		ClassicyAppBrowserRecordVisit: {
			description: "Record a visit in history (deduplicated by normalized URL, capped at 500).",
			params: z.object({ url: z.string().describe("Visited URL.") }),
		},
		ClassicyAppBrowserClearHistory: {
			description: "Clear all browsing history.",
		},
		ClassicyAppBrowserUpdateProxyConfig: {
			description: "Replace the Time Machine proxy configuration.",
			params: z.object({
				proxyConfig: z.record(z.string(), z.unknown()).describe("Full TimeMachineProxyConfig object."),
			}),
		},
		ClassicyAppBrowserSetShowFavoritesBar: {
			description: "Show or hide the favorites bar.",
			params: z.object({ showFavoritesBar: z.boolean().describe("true = show the bar.") }),
		},
	},
	state: BrowserDataSchema,
});
