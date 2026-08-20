import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserHistoryEntry } from "./BrowserContext";
import {
	isNavigableUrl,
	normalizeUrl,
	resolveLinkTarget,
	stripProxyUrl,
} from "./browserUtils";

export const DEFAULT_PROXY_ON = true;
export const DEFAULT_PROXY_PROTOCOL = import.meta.env.VITE_PROXY_PROTOCOL ?? "http:";
export const DEFAULT_PROXY_HOST = import.meta.env.VITE_PROXY_HOST ?? "localhost";
export const DEFAULT_PROXY_PORT = Number(import.meta.env.VITE_PROXY_PORT ?? 8765);
export const DEFAULT_ARCHIVE_TIME = "20010912000000";
export const DEFAULT_PROXY_PREFIX = "https://web.archive.org/web";
export const DEFAULT_PROXY_PATH = "";

export interface TimeMachineProxyConfig {
	enabled: boolean;
	protocol: string;
	host: string;
	port: number;
	archiveTime: string;
	proxyPrefix: string;
	path: string;
}

export const DEFAULT_PROXY_CONFIG: TimeMachineProxyConfig = {
	enabled: DEFAULT_PROXY_ON,
	protocol: DEFAULT_PROXY_PROTOCOL,
	host: DEFAULT_PROXY_HOST,
	port: DEFAULT_PROXY_PORT,
	archiveTime: DEFAULT_ARCHIVE_TIME,
	proxyPrefix: DEFAULT_PROXY_PREFIX,
	path: DEFAULT_PROXY_PATH,
};

const formatArchiveTime = (time: string): string => {
	const match = time.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
	if (!match) return time;
	const [, y, mo, d, h, mi, s] = match;
	const utc = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
	return utc.toLocaleString(undefined, {
		dateStyle: "short",
		timeStyle: "short",
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	});
};

interface ProxyFetchResult {
	html: string;
	title: string;
	archiveTime: string;
}

const fetchViaHttp = async (
	proxyBase: string,
	url: string,
	archiveTime: string,
	signal: AbortSignal,
	path: string,
): Promise<ProxyFetchResult> => {
	const pathSegment = path ? `/${path.replace(/^\/+/, "")}` : "";
	const proxyUrl = `${proxyBase}${pathSegment}/?url=${encodeURIComponent(url)}&time=${archiveTime}`;
	const response = await fetch(proxyUrl, { signal });

	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}

	const html = await response.text();
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const actualTime = response.headers.get("X-Archive-Time") || archiveTime;

	return {
		html,
		title: titleMatch ? titleMatch[1].trim() : "",
		archiveTime: actualTime,
	};
};

const fetchViaWebSocket = async (
	proxyBase: string,
	url: string,
	archiveTime: string,
	signal: AbortSignal,
	path: string,
): Promise<ProxyFetchResult> => {
	// Normalize to ws(s) protocol — if protocol is already ws/wss the
	// replaces are no-ops; if http/https they get converted.
	const pathSegment = path ? `/${path.replace(/^\/+/, "")}` : "/ws";
	const wsUrl =
		proxyBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + pathSegment;

	return new Promise<ProxyFetchResult>((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}

		const ws = new WebSocket(wsUrl);
		let settled = false;

		const cleanup = () => {
			if (
				ws.readyState === WebSocket.OPEN ||
				ws.readyState === WebSocket.CONNECTING
			) {
				ws.close();
			}
		};

		const onAbort = () => {
			settled = true;
			cleanup();
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });

		ws.addEventListener("open", () => {
			if (signal.aborted) return;
			ws.send(JSON.stringify({ type: "fetch", url, time: archiveTime }));
		});

		ws.addEventListener("message", (event) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);

			try {
				const data = JSON.parse(String(event.data)) as {
					type: string;
					html?: string;
					archiveTime?: string;
					status?: number;
					message?: string;
				};

				if (data.type === "error") {
					reject(new Error(data.message ?? `Error ${data.status}`));
				} else {
					const html = data.html ?? "";
					const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
					resolve({
						html,
						title: titleMatch ? titleMatch[1].trim() : "",
						archiveTime: data.archiveTime ?? archiveTime,
					});
				}
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			} finally {
				cleanup();
			}
		});

		ws.addEventListener("error", () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(new Error("WebSocket connection failed"));
		});

		ws.addEventListener("close", (event) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(new Error(`WebSocket closed unexpectedly (code ${event.code})`));
		});
	});
};

interface UseBrowserNavigationOptions {
	defaultUrl: string;
	proxyConfig: TimeMachineProxyConfig;
	onShowError: () => void;
	onRecordVisit: (url: string) => void;
	/** Persisted visit log, used to color previously-visited links. */
	visitedHistory: BrowserHistoryEntry[];
}

export const useBrowserNavigation = ({
	defaultUrl,
	proxyConfig,
	onShowError,
	onRecordVisit,
	visitedHistory,
}: UseBrowserNavigationOptions) => {
	const proxyBase = useMemo(
		() => `${proxyConfig.protocol}//${proxyConfig.host}:${proxyConfig.port}`,
		[proxyConfig.protocol, proxyConfig.host, proxyConfig.port],
	);
	const proxyEnabled = proxyConfig.enabled;
	const archiveTime = proxyConfig.archiveTime;
	const proxyHost = proxyConfig.host;

	const [history, setHistory] = useState<string[]>([defaultUrl]);
	const [historyIndex, setHistoryIndex] = useState(0);
	const [htmlContent, setHtmlContent] = useState<string>("");
	const [addressBarValue, setAddressBarValue] = useState(defaultUrl);
	const [isLoading, setIsLoading] = useState(true);
	const [statusText, setStatusText] = useState("");
	const [pageTitle, setPageTitle] = useState("");
	const abortControllerRef = useRef<AbortController | null>(null);

	const canGoBack = historyIndex > 0;
	const canGoForward = historyIndex < history.length - 1;

	const fetchPage = useCallback(
		async (url: string) => {
			abortControllerRef.current?.abort();
			const controller = new AbortController();
			abortControllerRef.current = controller;

			setIsLoading(true);
			setStatusText(`Loading ${url}...`);

			if (!proxyEnabled) {
				setStatusText("TimeMachine proxy is disabled");
				setHtmlContent(
					"<p>TimeMachine proxy is disabled. Enable it in File → Settings.</p>",
				);
				setIsLoading(false);
				return;
			}

			let handler: typeof fetchViaHttp;
			switch (proxyConfig.protocol) {
				case "ws:":
				case "wss:":
					handler = fetchViaWebSocket;
					break;
				case "http:":
				case "https:":
				default:
					handler = fetchViaHttp;
					break;
			}

			try {
				const result = await handler(
					proxyBase,
					url,
					archiveTime,
					controller.signal,
					proxyConfig.path,
				);
				setHtmlContent(result.html);
				setPageTitle(result.title);
				setStatusText(
					`Viewing page archived ${formatArchiveTime(result.archiveTime)}`,
				);
			} catch (e: unknown) {
				if (e instanceof DOMException && e.name === "AbortError") return;
				console.error("[Browser] Failed to fetch page", { url, error: e });
				const msg = e instanceof Error ? e.message : "Error loading page";
				setStatusText(`Error: ${msg}`);
				setHtmlContent(
					`<p>${msg.includes("not yet implemented") ? msg : "Could not connect to TimeMachine server. Is it running?"}</p>`,
				);
			} finally {
				if (!controller.signal.aborted) {
					setIsLoading(false);
				}
			}
		},
		[archiveTime, proxyBase, proxyConfig.path, proxyConfig.protocol, proxyEnabled],
	);

	// Load default page on mount
	useEffect(() => {
		onRecordVisit(defaultUrl);
		fetchPage(defaultUrl);
	}, [defaultUrl, fetchPage, onRecordVisit]);

	// Cleanup abort controller on unmount
	useEffect(() => {
		return () => abortControllerRef.current?.abort();
	}, []);

	const navigateTo = useCallback(
		(rawUrl: string) => {
			// De-proxy first so history, the address bar, and the fetch all use the
			// original URL — proxy-rewritten links resolve to <proxyHost>/web/<url>.
			const url = stripProxyUrl(rawUrl, proxyHost);
			// Skip if already on this page (normalize trailing slash and www.)
			setHistory((h) => {
				const idx = historyIndexRef.current;
				const currentUrl = h[idx];
				if (currentUrl && normalizeUrl(currentUrl) === normalizeUrl(url)) {
					return h;
				}
				const newHistory = [...h.slice(0, idx + 1), url];
				setHistoryIndex(newHistory.length - 1);
				return newHistory;
			});
			setAddressBarValue(url);
			onRecordVisit(url);
			fetchPage(url);
		},
		[fetchPage, onRecordVisit, proxyHost],
	);

	// Stable refs so handleContentClick doesn't churn
	const navigateToRef = useRef(navigateTo);
	useEffect(() => {
		navigateToRef.current = navigateTo;
	}, [navigateTo]);

	const historyRef = useRef(history);
	useEffect(() => {
		historyRef.current = history;
	}, [history]);

	const historyIndexRef = useRef(historyIndex);
	useEffect(() => {
		historyIndexRef.current = historyIndex;
	}, [historyIndex]);

	const goTo = useCallback(
		(urlOverride?: string) => {
			const value = (urlOverride ?? addressBarValue).trim();
			if (!isNavigableUrl(value)) {
				onShowError();
				return;
			}
			navigateTo(value);
		},
		[addressBarValue, navigateTo, onShowError],
	);

	const goBack = useCallback(() => {
		if (!canGoBack) return;
		const newIndex = historyIndex - 1;
		setHistoryIndex(newIndex);
		setAddressBarValue(history[newIndex]);
		fetchPage(history[newIndex]);
	}, [canGoBack, historyIndex, history, fetchPage]);

	const goForward = useCallback(() => {
		if (!canGoForward) return;
		const newIndex = historyIndex + 1;
		setHistoryIndex(newIndex);
		setAddressBarValue(history[newIndex]);
		fetchPage(history[newIndex]);
	}, [canGoForward, historyIndex, history, fetchPage]);

	const handleContentClick = useCallback(
		(link: { href: string; rawHref: string }) => {
			if (!link.rawHref) return;
			const currentUrl = historyRef.current[historyIndexRef.current];
			const target = resolveLinkTarget(
				link.href,
				link.rawHref,
				currentUrl,
				proxyHost,
			);
			if (target) navigateToRef.current(target);
		},
		[proxyHost],
	);

	// Set of normalized URLs the user has already visited, for link coloring.
	const visitedUrls = useMemo(
		() => new Set(visitedHistory.map((h) => normalizeUrl(h.url))),
		[visitedHistory],
	);

	// Resolve a link the same way a click would, then check it against history.
	// Stays a callback (not bound to a specific anchor) so ShadowContent can run
	// it across every link as pages and history change.
	const isVisited = useCallback(
		(href: string, rawHref: string): boolean => {
			const currentUrl = historyRef.current[historyIndexRef.current];
			const target = resolveLinkTarget(href, rawHref, currentUrl, proxyHost);
			return target ? visitedUrls.has(normalizeUrl(target)) : false;
		},
		[proxyHost, visitedUrls],
	);

	return {
		isVisited,
		htmlContent,
		pageTitle,
		addressBarValue,
		setAddressBarValue,
		isLoading,
		statusText,
		canGoBack,
		canGoForward,
		goTo,
		goBack,
		goForward,
		handleContentClick,
	};
};
