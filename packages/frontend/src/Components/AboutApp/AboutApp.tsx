import {
	ClassicyButton,
	ClassicyWindow,
	useAppManagerDispatch,
	useClassicyHelpMenu,
} from "classicy";
import { type FC, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { APP_PROVENANCE, type AppProvenance } from "../../data/provenance";
import { AIRCRAFT_MODEL_DERIVATIVE_NOTICE } from "../../data/aircraftCredits";
import "./AboutApp.scss";

/**
 * Publishes an "About <App>…" item into the Help menu and returns the window
 * it opens. Render the returned node inside the app's `ClassicyApp`.
 *
 * The item goes to the Help menu via Classicy's `Desktop.helpMenu` slot
 * rather than the app's own `appMenu`, because the menu bar hoists any About
 * entry it finds in `appMenu` into the Apple menu and strips it from where
 * the app put it. The item's id deliberately does not end in `_about` and
 * its title is not exactly "About" — both are defense-in-depth against that
 * hoist heuristic matching this item by accident.
 */
export function useAboutApp(appId: string, appIcon: string): ReactNode {
	const [show, setShow] = useState(false);
	const provenance = APP_PROVENANCE[appId];

	// Memoized: an array rebuilt each render would re-fire the registration
	// effect inside useClassicyHelpMenu every render (per that hook's own doc
	// comment).
	const helpItems = useMemo(
		() =>
			provenance
				? [
						{
							id: `${appId}_about_data`,
							title: `About ${provenance.appName}…`,
							onClickFunc: () => setShow(true),
						},
					]
				: [],
		[appId, provenance],
	);

	// Called unconditionally regardless of whether this appId has a registry
	// entry -- skipping the call would be a conditional hook invocation, which
	// violates react-hooks/rules-of-hooks. An app with no entry simply
	// publishes zero items, which is equivalent to no Help menu entry.
	useClassicyHelpMenu(appId, helpItems);

	if (!provenance || !show) return null;
	return (
		<AboutAppWindow
			appId={appId}
			appIcon={appIcon}
			provenance={provenance}
			hideFunc={() => setShow(false)}
		/>
	);
}

const AboutAppWindow: FC<{
	appId: string;
	appIcon: string;
	provenance: AppProvenance;
	hideFunc: () => void;
}> = ({ appId, appIcon, provenance, hideFunc }) => {
	const dispatch = useAppManagerDispatch();
	const windowId = `${appId}_about_data`;

	useEffect(() => {
		// ClassicyWindow's own ClassicyWindowOpen effect fires first (it's the
		// child; child effects run before parent effects in the same commit)
		// and only focuses a *genuinely new* window -- a re-registered
		// persisted window (i.e. this About window on every reopen after the
		// first) is deliberately left unfocused so it doesn't steal focus from
		// a window that's merely re-rendering. That means a reopened About
		// window would otherwise stay in the unfocused/background z-index band
		// (classicyWindowActiveApp, 150) behind the app's own main window,
		// unclickable because it's underneath. Focusing explicitly here, after
		// ClassicyWindow's effect has run, fixes both the first open (already
		// focused -- a harmless re-dispatch) and every reopen after it.
		dispatch({
			type: "ClassicyWindowFocus",
			app: { id: appId },
			window: { id: windowId },
		});
	}, [dispatch, appId, windowId]);

	const closeWindow = useCallback(() => {
		// Mirrors the two steps classicy's own useClassicyWindowClose hook
		// packages for menu-triggered closes: dispatch ClassicyWindowClose --
		// which marks the window closed/unfocused in the store and, when this
		// app holds focus, promotes a sibling window (the app's main window)
		// back to focus -- before running local cleanup. We don't use that
		// hook directly: its second argument is an ActionMessage dispatched
		// through the app-manager reducer, and our cleanup is local component
		// state (setShow(false) via hideFunc), not a reducer action.
		//
		// ClassicyWindow's own close box already dispatches ClassicyWindowClose
		// itself before calling onCloseFunc, so wiring this same function as
		// onCloseFunc makes that path idempotent (a second, no-op dispatch);
		// it's what the OK button -- which otherwise bypasses ClassicyWindow's
		// close() entirely -- was missing.
		dispatch({
			type: "ClassicyWindowClose",
			app: { id: appId },
			window: { id: windowId },
		});
		hideFunc();
	}, [dispatch, appId, windowId, hideFunc]);

	return (
		<ClassicyWindow
			id={windowId}
			appId={appId}
			title={`About ${provenance.appName}`}
			icon={appIcon}
			closable={true}
			resizable={true}
			zoomable={false}
			scrollable={true}
			collapsable={false}
			initialSize={[440, 420]}
			initialPosition={[120, 60]}
			modal={false}
			onCloseFunc={closeWindow}
		>
			<div className="aboutAppWindow">
				<header className="aboutAppHeader">
					<img src={appIcon} alt="" />
					<h1>{provenance.appName}</h1>
				</header>

				<p className="aboutAppBlurb">{provenance.blurb}</p>

				<h2>Sources</h2>
				<ul className="aboutAppSources">
					{provenance.sources.map((source) => (
						<li key={source.url}>
							<a href={source.url} target="_blank" rel="noreferrer noopener">
								{source.name}
							</a>
							<span className="aboutAppFeeds">{source.feeds}</span>
							{source.note && <span className="aboutAppNote">{source.note}</span>}
						</li>
					))}
				</ul>

				{provenance.method && provenance.method.length > 0 && (
					<>
						<h2>How this was built</h2>
						<ul className="aboutAppMethod">
							{provenance.method.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					</>
				)}

				{provenance.credits && provenance.credits.length > 0 && (
					<>
						<h2>3D models</h2>
						<p className="aboutAppDerivativeNotice">
							{AIRCRAFT_MODEL_DERIVATIVE_NOTICE}
						</p>
						<ul className="aboutAppCredits">
							{provenance.credits.map((credit) => (
								<li key={credit.url}>
									<a href={credit.url} target="_blank" rel="noreferrer noopener">
										{credit.model}
									</a>
									<span className="aboutAppFeeds">
										{credit.author} — {credit.license}
									</span>
									{credit.note && <span className="aboutAppNote">{credit.note}</span>}
								</li>
							))}
						</ul>
					</>
				)}

				<footer className="aboutAppFooter">
					<ClassicyButton onClickFunc={closeWindow}>OK</ClassicyButton>
				</footer>
			</div>
		</ClassicyWindow>
	);
};
