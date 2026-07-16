import {
	ClassicyApp,
	ClassicyButton,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
} from "classicy";
import appIconPng from "./app.png";
import type React from "react";
import { useMemo } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { SignInForm } from "./SignInForm";

const appId   = "Account.app";
const appName = "Account";

// This app's own icon, registered into the shared registry at
// ClassicyIcons.applications.account.app. registerClassicyIcons assigns
// shallowly, so the existing applications namespace is spread in to keep
// classicy's bundled app icons (and other apps' registrations) intact.
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		account: { app: appIconPng },
	},
});
const appIcon = ICONS.applications.account.app;

export interface AccountProps {
	/** Overrides window.location.hostname for tests (preview-origin detection). */
	hostnameForTest?: string;
}

export const Account: React.FC<AccountProps> = ({ hostnameForTest }) => {
	const { status, user, signInWithEmail, signInWithProvider, signOut } = useAuth();

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
			defaultWindow="account_main"
			addSystemMenu={false}
		>
			<ClassicyWindow
				id="account_main"
				title="Account"
				appId={appId}
				icon={appIcon}
				closable={true}
				resizable={false}
				zoomable={false}
				scrollable={false}
				collapsable={false}
				initialSize={["35%", 0]}
				initialPosition={[280, 160]}
				modal={false}
				appMenu={appMenu}
			>
				{status === "loading" ? (
					<div />
				) : status === "signedIn" ? (
					<div>
						<div>{`Signed in as ${user?.first_name ?? user?.email}`}</div>
						<ClassicyButton onClickFunc={() => void signOut()}>Sign Out</ClassicyButton>
						<div>My Playlists — coming soon</div>
					</div>
				) : (
					<SignInForm
						onSignInWithEmail={signInWithEmail}
						onSignInWithProvider={signInWithProvider}
						hostnameForTest={hostnameForTest}
					/>
				)}
			</ClassicyWindow>
		</ClassicyApp>
	);
};
