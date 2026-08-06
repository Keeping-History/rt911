import { ClassicyButton, ClassicyIcons } from "classicy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DIRECTUS_URL } from "../lib/endpoints";
import { renderPageHtml } from "../lib/renderPageHtml";
import { classicyThemeVars } from "./classicyTheme";
import type { PageNode } from "./pageTree";
import { pagesRouteSlug } from "./route";
import { usePages } from "./usePages";
import styles from "./PagesSite.module.scss";

/**
 * The CMS pages surface: one authored page inside Classicy chrome, with the
 * page tree in the menu bar.
 *
 * Deliberately not a Classicy app. It mounts no ClassicyDesktop and no
 * ClassicyAppManagerProvider, which is why app.tsx can lazy-load it — the
 * eager-import constraint documented there applies to ClassicyDesktop, not to
 * arbitrary lazy children.
 *
 * The chrome uses Classicy's own global class names and DOM shape rather than a
 * lookalike — `classicyDesktop`, the `classicyDesktopMenuBar` nav, and the
 * `classicyWindow` structure a real ClassicyWindow renders (frame edges, title
 * bar with control boxes and pinstripe fills, contents/contentsInner). Those
 * class names are load-bearing, not cosmetic: classicy.css scopes its title-bar
 * and content rules under `.classicyWindow`, so a different wrapper renders
 * visibly wrong.
 *
 * Because the app manager is absent, the theme's CSS custom properties are
 * applied to the root element here instead — see classicyTheme.ts.
 */

/**
 * Slug for the current location, sharing app.tsx's routing rule rather than
 * reimplementing it — two copies would drift the moment the reserved list moves.
 * The empty-string fallback is unreachable in practice: app.tsx only mounts this
 * surface once pagesRouteSlug has already returned non-null.
 */
function currentSlug(): string {
	return pagesRouteSlug(window.location.pathname) ?? "";
}

function flattenForMenu(nodes: PageNode[], depth = 0): { node: PageNode; depth: number }[] {
	return nodes.flatMap((node) => [
		{ node, depth },
		...flattenForMenu(node.children, depth + 1),
	]);
}

function cx(...parts: (string | false | undefined)[]): string {
	return parts.filter(Boolean).join(" ");
}

/**
 * The Apple menu icon, taken from Classicy's own desktop menu bar.
 *
 * Inlined rather than referenced as a glyph: U+F8FF renders as nothing in the
 * Charcoal/ChicagoFLF web fonts, so the menu item came out blank. 586 bytes.
 */
const APPLE_ICON =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAAXNSR0IArs4c6QAAAAZiS0dEAP8A/wD/oL2nkwAAAAlwSFlzAAAN1wAADdcBQiibeAAAAAd0SU1FB9sJBRIcJEs1Gp0AAAElSURBVDjL7ZOhUsNAEIa/MIiTxeUVKg8Hso/AK1xcJRZZWWRcInkE6ops3K1rHqGydcT9iHSmGdKEwiC7Zud29/75/p07uMZorBFLNDZy8ysxA1b/RbdEzMbpfiaKiEVHJCLW48LnLS/QfBbY+gIejuJrxB4wwMPFtCpmkpC0PWak6KUCqfBSQMWzHxS77Zf2gICkPVqn1UDpIHu15GLBujKmAbAC6gw+ATOsASYGm3GHvR027hustWTegTu05Xc/vL8e+g6Uxgh5pC4z7jq97TFX7Rz5mfs9y+m8oA6RaRmYApSnBe69owFSYGdVtzlsOcmzpAEslDA51c07GgcRqMwAd5nlzmOUD0/gGixfgU/x949Y/AA7AC/JH77LQvCm4fM1gC+rGoNLjWKRdwAAAABJRU5ErkJggg==";

export default function PagesSite() {
	const [slug, setSlug] = useState(currentSlug);
	// Which top-level menu is open, by page id. Only one at a time, as a menu
	// bar behaves; null means none.
	const [openMenu, setOpenMenu] = useState<number | null>(null);
	// Zoom toggles the window between reading width and full width, the way a
	// classic zoom box does. Kept functional so the control is not decoration.
	const [zoomed, setZoomed] = useState(false);
	const barRef = useRef<HTMLDivElement>(null);

	const { nav, page, loading, notFound, error } = usePages(slug);

	// Theme variables are stable for the session; computing them once avoids
	// re-deriving the whole map on every render.
	const themeVars = useMemo(() => classicyThemeVars(), []);

	// Back/forward must swap content rather than reloading the bundle.
	useEffect(() => {
		const onPop = () => setSlug(currentSlug());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	// Click-away closes an open menu.
	useEffect(() => {
		if (openMenu === null) return;
		const onDown = (e: MouseEvent) => {
			if (!barRef.current?.contains(e.target as Node)) setOpenMenu(null);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [openMenu]);

	// Nav items stay real anchors so they remain right-clickable and copyable;
	// the handler only intercepts plain left clicks, leaving modified clicks
	// (new tab, new window) to the browser.
	const navigate = useCallback((e: React.MouseEvent<HTMLAnchorElement>, next: string) => {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
			return;
		}
		e.preventDefault();
		// Without this the click keeps bubbling to the enclosing menu title,
		// whose onClick toggles the menu straight back open — so picking an item
		// would leave the menu hanging open over the page it just navigated to.
		e.stopPropagation();
		setOpenMenu(null);
		window.history.pushState({}, "", `/${next}`);
		setSlug(next);
	}, []);

	// Printing the live document rather than opening a print-only copy in a
	// hidden iframe: one source of markup, so an author's page can never render
	// one way on screen and another on paper. What the printed sheet drops or
	// reflows is decided entirely in the stylesheet's @media print block.
	const handlePrint = useCallback(() => window.print(), []);

	const html = useMemo(() => renderPageHtml(page?.body), [page?.body]);

	useEffect(() => {
		document.title = page ? `${page.title} — 911 Realtime` : "911 Realtime";
	}, [page]);

	return (
		<div className={cx("classicyDesktop", styles.root)} style={themeVars}>
			{/* The real desktop renders <nav class="classicyDesktopMenuBar"> wrapping
			    a .classicyMenuWrapper around the <ul>. That wrapper is also where
			    classicy applies --ui-font / --ui-font-size, so omitting it left the
			    menu bar unstyled. */}
			<nav className="classicyDesktopMenuBar" ref={barRef}>
				<div className="classicyMenuWrapper">
					<ul className="classicyDesktopMenu">
					<li
						className="classicyMenuItem classicyMenuItemNoImage classicyDesktopMenuAppleMenu"
						role="menuitem"
						tabIndex={-1}
					>
						<p>
							<a href="/" title="Back to the desktop" aria-label="Back to the desktop">
								<img src={APPLE_ICON} alt="" />
							</a>
						</p>
					</li>

					{nav.length === 0 && (
						<li className="classicyMenuItem classicyMenuItemDisabled" role="menuitem" tabIndex={-1}>
							<p>(no pages)</p>
						</li>
					)}

					{/* Every page without a parent is its own menu-bar title, and its
					    descendants hang beneath it — so the tree the author builds in
					    Directus is the menu bar itself.

					    A childless root is a plain link and navigates on click. A root
					    with children opens a menu instead, and lists itself first so the
					    parent page stays reachable rather than becoming a label for its
					    own children.

					    Classicy's show/hide rule is
					    `.classicyMenuItemOpen > .classicyMenuWrapper > ul { display: flex }`,
					    so each submenu is always rendered and the open class drives
					    visibility. The nesting below is what that selector requires. */}
					{nav.map((root) => {
						const hasChildren = root.children.length > 0;
						const isOpen = openMenu === root.id;
						// Highlight the title when the current page is anywhere beneath it.
						const containsCurrent =
							root.slug === slug ||
							flattenForMenu(root.children).some(({ node }) => node.slug === slug);

						if (!hasChildren) {
							return (
								<li
									key={root.id}
									className={cx(
										"classicyMenuItem",
										styles.menuTitle,
										// Marked on the <li> in both branches, so "is this title
										// current?" is answered the same way regardless of whether
										// the root happens to have children.
										containsCurrent && styles.menuCurrent,
									)}
									role="menuitem"
									tabIndex={-1}
								>
									<p>
										<a href={`/${root.slug}`} onClick={(e) => navigate(e, root.slug)}>
											{root.title}
										</a>
									</p>
								</li>
							);
						}

						return (
							<li
								key={root.id}
								className={cx(
									"classicyMenuItem",
									"classicyMenuItemChildMenuIndicator",
									styles.menuTitle,
									containsCurrent && styles.menuCurrent,
									isOpen && "classicyMenuItemOpen",
								)}
								role="menuitem"
								tabIndex={0}
								aria-haspopup="menu"
								aria-expanded={isOpen}
								onClick={() => setOpenMenu((o) => (o === root.id ? null : root.id))}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										setOpenMenu((o) => (o === root.id ? null : root.id));
									} else if (e.key === "Escape") {
										setOpenMenu(null);
									}
								}}
							>
								<p>{root.title}</p>
								<div className="classicyMenuWrapper">
									<ul className="classicySubMenu">
										{[{ node: root, depth: 0 }, ...flattenForMenu(root.children)].map(
											({ node, depth }) => (
												<li key={node.id} className="classicyMenuItem">
													<p>
														<a
															href={`/${node.slug}`}
															className={cx(
																depth > 0 && styles.menuChild,
																node.slug === slug && styles.menuCurrent,
															)}
															onClick={(e) => navigate(e, node.slug)}
														>
															{node.title}
														</a>
													</p>
												</li>
											),
										)}
									</ul>
								</div>
							</li>
						);
					})}
					</ul>
				</div>
			</nav>

			<div className={styles.desktopArea}>
				{/* Mirrors what ClassicyWindow actually renders — verified against a
				    live window in the running desktop. The class names matter beyond
				    naming: every title-bar rule in classicy.css is scoped under
				    `.classicyWindow`, so the outer class is what makes the pinstriped
				    title bar, control boxes and content bevel style at all.
				    classicyWindowFrame, used here previously, is a different
				    component entirely and looked visibly wrong. */}
				<div
					className={cx(
						"classicyWindow",
						"classicyWindowDocument",
						"classicyWindowActive",
						styles.window,
						zoomed && styles.windowZoomed,
					)}
				>
					<div className="classicyWindowFrameEdge classicyWindowFrameEdge-top" />
					<div className="classicyWindowFrameEdge classicyWindowFrameEdge-right" />
					<div className="classicyWindowFrameEdge classicyWindowFrameEdge-bottom" />
					<div className="classicyWindowFrameEdge classicyWindowFrameEdge-left" />

					<div className="classicyWindowTitleBar">
						<div className="classicyWindowControlBox">
							{/* A real control, not decoration: closing a page returns you
							    to the desktop. A dead close box would be worse than none. */}
							<div
								className="classicyWindowCloseBox"
								role="button"
								tabIndex={0}
								title="Back to the desktop"
								aria-label="Back to the desktop"
								onClick={() => {
									window.location.href = "/";
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") window.location.href = "/";
								}}
							/>
						</div>

						<div className="classicyWindowTitle">
							{/* Left and Right carry the pinstripe fill and flex-grow around
							    the title text — that is how the classic title bar is drawn. */}
							<div className="classicyWindowTitleLeft" />
							<div className="classicyWindowTitleText">
								<p className={styles.pageTitle}>{page?.title ?? "911 Realtime"}</p>
							</div>
							<div className="classicyWindowTitleRight" />
						</div>

						<div className="classicyWindowControlBox">
							<div
								className="classicyWindowZoomBox"
								role="button"
								tabIndex={0}
								title={zoomed ? "Reduce" : "Zoom"}
								aria-label={zoomed ? "Reduce window" : "Zoom window"}
								aria-pressed={zoomed}
								onClick={() => setZoomed((z) => !z)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") setZoomed((z) => !z);
								}}
							/>
						</div>
					</div>

					<div className="classicyWindowContents">
						{!loading && !error && page && (
							<>
								<div className={styles.actions}>
									<ClassicyButton margin="sm" onClickFunc={handlePrint}>
										{/* Decorative: the label beside it already names the
										    action, so alt text here would be announced twice. */}
										<img
											className={styles.buttonIcon}
											src={ClassicyIcons.system.printer as string}
											alt=""
										/>
										Print…
									</ClassicyButton>
								</div>
							</>
						)}

						<div className={cx("classicyWindowContentsInner", styles.document)}>
							{loading && <p className={styles.status}>Loading…</p>}

							{!loading && error && (
								<p className={styles.status}>Could not load this page: {error}</p>
							)}

							{!loading && !error && notFound && (
								<div className={styles.body}>
									<h2>Page not found</h2>
									<p>
										No published page has the address <code>/{slug}</code>.
									</p>
								</div>
							)}

							{!loading && !error && page && (
								<>
									{/* Print-only, and first in the flow so it heads the sheet.
									    Built from origin + slug rather than location.href so it
									    never depends on whether this render happened before or
									    after the pushState in `navigate`. */}
									<div className={styles.printSource} aria-hidden="true">
										911realtime.org — {`${window.location.origin}/${slug}`}
									</div>

									{page.title && <h1 className={styles.docTitle}>{page.title}</h1>}
									{page.author && (
										<div className={styles.byline}>
											{page.author.avatar && (
												<img
													className={styles.avatar}
													src={`${DIRECTUS_URL}/assets/${page.author.avatar}`}
													alt=""
												/>
											)}
											<div>
												<div className={styles.bylineName}>{page.author.name}</div>
												{page.author.email && (
													<div className={styles.bylineMeta}>
														<a href={`mailto:${page.author.email}`}>{page.author.email}</a>
													</div>
												)}
											</div>
										</div>
									)}
									{/* Sanitized by renderPageHtml: DOMPurify plus an iframe
									    src allowlist. Browser.tsx / ReadmeContent.tsx precedent. */}
									<div className={styles.body} dangerouslySetInnerHTML={{ __html: html }} />
								</>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
