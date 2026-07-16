import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
} from "classicy";
import type React from "react";
import { useMemo } from "react";
import appIconPng from "./app.png";
import { ReadmeContent } from "./ReadmeContent";
import { useReadmeArticles } from "./useReadmeArticles";

const appId   = "Readme.app";
const appName = "README";

// This app's own icon, registered into the shared registry — same shallow
// spread as Feedback.tsx so classicy's bundled icons stay intact.
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		readme: { app: appIconPng },
	},
});
const appIcon = ICONS.applications.readme.app;

export const Readme: React.FC = () => {
	// Poll Directus only while the app is open (MarketWatch precedent).
	const isOpen = useAppManager(
		(state) => state.System.Manager.Applications.apps[appId]?.open ?? false,
	);
	const state = useReadmeArticles(isOpen);

	const appMenu = useMemo(
		() => [
			{
				id:           "file",
				title:        "File",
				menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
			},
		],
		[],
	);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow="readme_main"
			addSystemMenu={false}
		>
			<ClassicyWindow
				id="readme_main"
				title="README"
				appId={appId}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				scrollable={false}
				collapsable={false}
				initialSize={[560, 380]}
				initialPosition={[220, 120]}
				modal={false}
				appMenu={appMenu}
			>
				<ReadmeContent state={state} />
			</ClassicyWindow>
		</ClassicyApp>
	);
};
