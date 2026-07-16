// Cross-app remote-control API for the News app (TVContext's pattern):
// commands and published state ride apps["News.app"].data through a handler
// registered ahead of the core app reducer.
import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";

const appId = "News.app";

/**
 * One-shot focus command: open the per-article detail window for docId. `seq`
 * is monotonic so the component applies each command exactly once, retrying
 * while the article (or its window) doesn't exist yet.
 */
export interface NewsRemoteCommand {
	seq: number;
	kind: "focus";
	docId: number;
}

/** Focus a news article by its document (MediaItem) id. */
export const newsFocusItem = (docId: number): ActionMessage => ({
	type: "ClassicyAppNewsFocusItem",
	docId,
});

/** Publish which article detail windows are open (playlist locked-focus reads this). */
export const newsSetOpenDocuments = (openDocuments: number[]): ActionMessage => ({
	type: "ClassicyAppNewsSetOpenDocuments",
	openDocuments,
});

export const classicyNewsEventHandler = (ds: ClassicyStore, action: ActionMessage) => {
	const app = ds.System.Manager.Applications.apps[appId];
	if (!app) return ds;
	const appData = app.data ?? {};

	switch (action.type) {
		case "ClassicyAppNewsFocusItem":
			app.data = {
				...appData,
				command: {
					seq: ((appData.command as NewsRemoteCommand | undefined)?.seq ?? 0) + 1,
					kind: "focus",
					docId: action.docId as number,
				} satisfies NewsRemoteCommand,
			};
			return ds;
		case "ClassicyAppNewsSetOpenDocuments":
			app.data = { ...appData, openDocuments: action.openDocuments as number[] };
			return ds;
		default:
			return ds;
	}
};

registerAppEventHandler("ClassicyAppNews", classicyNewsEventHandler);
