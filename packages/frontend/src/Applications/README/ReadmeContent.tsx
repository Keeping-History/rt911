import DOMPurify from "dompurify";
import type React from "react";
import { useState } from "react";
import readmeStyles from "./README.module.scss";
import starPng from "./star.png";
import { TagPills } from "./TagPills";
import type { ReadmeArticle, ReadmeArticlesState } from "./useReadmeArticles";
import { visibleArticles } from "./useReadmeArticles";

export function formatArticleDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day:   "numeric",
		year:  "numeric",
	});
}

// The two-pane README window body: article list on the left, the selected
// article's sanitized HTML on the right. Pure presentation — data arrives via
// props so this renders (and tests) without classicy or the network.
export const ReadmeContent: React.FC<{
	state: ReadmeArticlesState;
	hiddenTagIds?: number[];
}> = ({ state, hiddenTagIds = [] }) => {
	const { loading, error } = state;
	const [selectedId, setSelectedId] = useState<number | null>(null);

	// Filter the feed by the reader's tag preferences before rendering/selecting.
	const articles = visibleArticles(state.articles, hiddenTagIds);

	// Newest (first) visible article by default; if a refresh or filter removed
	// the selected article, fall back to the newest visible one rather than a
	// blank pane.
	const selected: ReadmeArticle | null =
		articles.find((a) => a.id === selectedId) ?? articles[0] ?? null;

	if (loading) return <div className={readmeStyles.status}>Loading…</div>;
	if (error) return <div className={readmeStyles.status}>Couldn’t load articles: {error}</div>;
	if (!selected) return <div className={readmeStyles.status}>No articles yet.</div>;

	return (
		<div className={readmeStyles.split}>
			<ul className={readmeStyles.list}>
				{articles.map((a) => (
					<li key={a.id}>
						<button
							type="button"
							className={a.id === selected.id ? readmeStyles.rowSelected : readmeStyles.row}
							onClick={() => setSelectedId(a.id)}
						>
							<span className={readmeStyles.headline}>
								{a.featured && (
									<img className={readmeStyles.star} src={starPng} alt="Featured" />
								)}
								{a.headline}
							</span>
							<span className={readmeStyles.byline}>
								{a.author ? `${a.author} — ` : ""}
								{formatArticleDate(a.date_created)}
							</span>
							<TagPills tags={a.tags} />
						</button>
					</li>
				))}
			</ul>
			<article className={readmeStyles.body}>
				<h1 className={readmeStyles.bodyHeadline}>{selected.headline}</h1>
				<TagPills tags={selected.tags} />
				<div
					className={readmeStyles.bodyText}
					// Sanitized via DOMPurify before injection — Browser.tsx precedent.
					dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selected.body) }}
				/>
			</article>
		</div>
	);
};
