import {
	ClassicyApp,
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
	useAppManagerDispatch,
} from "classicy";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import appIconPng from "./app.png";
import { ReadmeContent } from "./ReadmeContent";
import "./ReadmeContext";
import readmeStyles from "./README.module.scss";
import { readmeSetSettings, readReadmeSettings, type ReadmeSettings } from "./readmeSettings";
import { allTags, useReadmeArticles } from "./useReadmeArticles";

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
	const appData = useAppManager(
		(state) =>
			state.System.Manager.Applications.apps[appId]?.data as
				| Record<string, unknown>
				| undefined,
	);
	const desktopEventDispatch = useAppManagerDispatch();
	const state = useReadmeArticles(isOpen);

	const settings = useMemo(() => readReadmeSettings(appData), [appData]);
	const tags = useMemo(() => allTags(state.articles), [state.articles]);

	// Settings draft (RadioScanner pattern): seeded on open, dispatched on Save.
	const [showSettings, setShowSettings] = useState(false);
	const [settingsForm, setSettingsForm] = useState<ReadmeSettings>(settings);

	const openSettings = useCallback(() => {
		setSettingsForm(settings);
		setShowSettings(true);
	}, [settings]);

	const saveSettingsForm = useCallback(() => {
		// Prune ids for tags no longer in the feed so they don't accumulate.
		const universe = new Set(tags.map((t) => t.id));
		desktopEventDispatch(
			readmeSetSettings({
				hiddenTagIds: settingsForm.hiddenTagIds.filter((id) => universe.has(id)),
			}),
		);
		setShowSettings(false);
	}, [desktopEventDispatch, settingsForm, tags]);

	const toggleTag = useCallback((id: number, checked: boolean) => {
		setSettingsForm((f) => ({
			hiddenTagIds: checked
				? f.hiddenTagIds.filter((x) => x !== id)      // checked = visible
				: [...new Set([...f.hiddenTagIds, id])],       // unchecked = hidden
		}));
	}, []);

	const appMenu = useMemo(
		() => [
			{
				id:           "file",
				title:        "File",
				menuChildren: [
					{ id: "settings", title: "Settings…", onClickFunc: openSettings },
					quitMenuItemHelper(appId, appName, appIcon),
				],
			},
		],
		[openSettings],
	);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow="readme_main"
			addSystemMenu={false}
		>
			{showSettings && (
				<ClassicyWindow
					id={`${appId}_settings`}
					title="Settings"
					appId={appId}
					icon={appIcon}
					closable={true}
					resizable={false}
					zoomable={false}
					scrollable={false}
					collapsable={false}
					initialSize={[300, 0]}
					initialPosition={[250, 150]}
					modal={true}
					appMenu={appMenu}
					onCloseFunc={() => setShowSettings(false)}
				>
					<div className={readmeStyles.settings}>
						<ClassicyControlGroup label="Show tags">
							{tags.length === 0 && (
								<div className={readmeStyles.status}>No tags yet.</div>
							)}
							{tags.map((t) => (
								<ClassicyCheckbox
									key={t.id}
									id={`readme_settings_tag_${t.id}`}
									label={t.name}
									checked={!settingsForm.hiddenTagIds.includes(t.id)}
									onClickFunc={(checked: boolean) => toggleTag(t.id, checked)}
								/>
							))}
						</ClassicyControlGroup>
						<div className={readmeStyles.settingsButtons}>
							<ClassicyButton onClickFunc={() => setShowSettings(false)}>
								Cancel
							</ClassicyButton>
							<ClassicyButton isDefault={true} onClickFunc={saveSettingsForm}>
								Save
							</ClassicyButton>
						</div>
					</div>
				</ClassicyWindow>
			)}
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
				<ReadmeContent state={state} hiddenTagIds={settings.hiddenTagIds} />
			</ClassicyWindow>
		</ClassicyApp>
	);
};
