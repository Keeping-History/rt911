import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DIRECTUS_URL } from "../lib/endpoints";
import { renderPageHtml } from "../lib/renderPageHtml";
import type { PageNode } from "./pageTree";
import { pagesRouteSlug } from "./route";
import { usePages } from "./usePages";
import styles from "./PagesSite.module.scss";

/**
 * The CMS pages surface: static Classicy-styled chrome around one authored page,
 * with the page tree in the menu bar.
 *
 * Deliberately not a Classicy app. It mounts no ClassicyDesktop and no
 * ClassicyAppManagerProvider, which is why app.tsx can lazy-load it — the
 * eager-import constraint documented there applies to ClassicyDesktop, not to
 * arbitrary lazy children.
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

export default function PagesSite() {
	const [slug, setSlug] = useState(currentSlug);
	const [menuOpen, setMenuOpen] = useState<string | null>(null);
	const barRef = useRef<HTMLDivElement>(null);

	const { nav, page, loading, notFound, error } = usePages(slug);

	// Back/forward must swap content rather than reloading the bundle.
	useEffect(() => {
		const onPop = () => setSlug(currentSlug());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	// Click-away closes an open menu.
	useEffect(() => {
		if (menuOpen === null) return;
		const onDown = (e: MouseEvent) => {
			if (!barRef.current?.contains(e.target as Node)) setMenuOpen(null);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [menuOpen]);

	// Nav items stay real anchors so they remain right-clickable and copyable;
	// the handler only intercepts plain left clicks, leaving modified clicks
	// (new tab, new window) to the browser.
	const navigate = useCallback((e: React.MouseEvent<HTMLAnchorElement>, next: string) => {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
			return;
		}
		e.preventDefault();
		setMenuOpen(null);
		window.history.pushState({}, "", `/${next}`);
		setSlug(next);
	}, []);

	const menuItems = useMemo(() => flattenForMenu(nav), [nav]);
	const html = useMemo(() => renderPageHtml(page?.body), [page?.body]);

	useEffect(() => {
		document.title = page ? `${page.title} — 911 Realtime` : "911 Realtime";
	}, [page]);

	return (
		<div className={styles.root}>
			<div className={styles.menuBar} ref={barRef}>
				<a className={`${styles.menuItem} ${styles.appleItem}`} href="/" title="Back to the desktop">
					&#63743;
				</a>

				{/* The dropdown is a SIBLING of the button, not a child: a <ul>
				    inside a <button> is invalid HTML, and nesting it would make every
				    menu-item click re-trigger the button that opened it. */}
				<div className={styles.menuGroup}>
					<button
						type="button"
						className={styles.menuItem}
						aria-expanded={menuOpen === "pages"}
						aria-haspopup="menu"
						onClick={() => setMenuOpen((m) => (m === "pages" ? null : "pages"))}
					>
						Pages
					</button>
					{menuOpen === "pages" && (
						<ul className={styles.menuDropdown} role="menu">
							{menuItems.length === 0 && (
								<li role="none">
									<span className={styles.menuLink}>(no pages)</span>
								</li>
							)}
							{menuItems.map(({ node, depth }) => (
								<li key={node.id} role="none">
									<a
										role="menuitem"
										href={`/${node.slug}`}
										className={[
											styles.menuLink,
											depth > 0 ? styles.menuLinkChild : "",
											node.slug === slug ? styles.menuCurrent : "",
										]
											.filter(Boolean)
											.join(" ")}
										onClick={(e) => navigate(e, node.slug)}
									>
										{node.title}
									</a>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>

			<div className={styles.desktop}>
				<div className={styles.window}>
					<div className={styles.titleBar}>
						<span className={styles.titleBarBox} aria-hidden="true" />
						<span className={styles.titleBarText}>{page?.title ?? "911 Realtime"}</span>
						<span className={styles.titleBarBox} aria-hidden="true" />
					</div>

					<div className={styles.content}>
						{loading && <p className={styles.status}>Loading…</p>}

						{!loading && error && (
							<p className={styles.status}>Could not load this page: {error}</p>
						)}

						{!loading && !error && notFound && (
							<>
								<h2>Page not found</h2>
								<p>
									No published page has the address <code>/{slug}</code>.
								</p>
							</>
						)}

						{!loading && !error && page && (
							<>
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
	);
}
