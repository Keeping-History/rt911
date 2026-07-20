import {
	ClassicyApp,
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyWindow,
	closeWindowMenuItemHelper,
	quitAppHelper,
	quitMenuItemHelper,
	useAppManagerDispatch,
	useClassicyAboutMenu,
	useClassicyWindowClose,
} from "classicy";
import type React from "react";
import { setAlertsEnabled, useAlertsEnabled } from "./alertsSettings";

const APP_ID = "AlertsManager.app";
const APP_NAME = "Alerts Manager";
const WINDOW_ID = "AlertsManager_1";
const appIcon = ClassicyIcons.applications.internetExplorer
	.documentWarning as string;

/**
 * Control panel for the Alerts extension: an Apple-menu app (no desktop icon)
 * whose single checkbox writes the shared alertsSettings store. While off, the
 * extension unsubscribes from the alerts channel entirely — alerts whose
 * moment passes are skipped, not queued (see the design doc,
 * plans/2026-07-20-alerts-manager-design.md).
 */
export const AlertsManager: React.FC = () => {
	const enabled = useAlertsEnabled();
	const desktopEventDispatch = useAppManagerDispatch();

	const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(
		APP_ID,
		APP_NAME,
		appIcon,
	);
	const windowClose = useClassicyWindowClose(APP_ID);

	const quitApp = () => {
		desktopEventDispatch(quitAppHelper(APP_ID, APP_NAME, appIcon));
	};

	// Mac OS 8 HIG control-panel menu bar. The About entry is discovery data:
	// ClassicyDesktopMenuBar hoists it into the Apple menu and strips it from
	// this menu before rendering. No Edit menu — there are no entry fields.
	const appMenu = [
		{
			id: `${APP_ID}_file`,
			title: "File",
			menuChildren: [
				{ ...aboutMenuItem, title: `About ${APP_NAME}` },
				{
					...closeWindowMenuItemHelper(`${APP_ID}_close_window`, () =>
						windowClose(WINDOW_ID, quitAppHelper(APP_ID, APP_NAME, appIcon)),
					),
					keyboardShortcut: "⌥W",
				},
				{ id: "spacer" },
				{
					...quitMenuItemHelper(APP_ID, APP_NAME, appIcon),
					keyboardShortcut: "⌥Q",
				},
			],
		},
	];

	return (
		<ClassicyApp
			id={APP_ID}
			name={APP_NAME}
			icon={appIcon}
			defaultWindow={WINDOW_ID}
			noDesktopIcon={true}
			addSystemMenu={true}
		>
			<ClassicyWindow
				id={WINDOW_ID}
				title={APP_NAME}
				appId={APP_ID}
				icon={appIcon}
				closable={true}
				resizable={false}
				zoomable={false}
				scrollable={false}
				collapsable={false}
				initialSize={[280, 130]}
				initialPosition={[320, 80]}
				modal={false}
				appMenu={appMenu}
				background="var(--color-system-03)"
			>
					<ClassicyCheckbox
						id={"show_alerts"}
						label={"Show Alerts"}
						checked={enabled}
						onClickFunc={(checked: boolean) => setAlertsEnabled(checked)}
					/>
				<ClassicyButton isDefault={false} onClickFunc={quitApp}>
					Quit
				</ClassicyButton>
			</ClassicyWindow>
			{aboutWindow}
		</ClassicyApp>
	);
};
