import {
	ClassicyApp,
	ClassicyButton,
	ClassicyFileInput,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
} from "classicy";
import appIconPng from "./app.png";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { avatarUrl, uploadAvatar } from "../../Providers/Auth/authApi";
import { SignInForm } from "./SignInForm";

const MAX_AVATAR_BYTES = 50 * 1024 * 1024;

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
	const { status, user, signInWithEmail, signInWithProvider, signOut, refresh } = useAuth();
	const [avatarUploading, setAvatarUploading] = useState(false);
	const [avatarError, setAvatarError] = useState<string | null>(null);

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

	const handleAvatarFiles = useCallback(
		(files: File[]) => {
			// ClassicyFileInput accumulates every selection into its internal
			// entries list (no maxFiles cap here), so the most recent pick is
			// always the last entry, not the first.
			const file = files[files.length - 1];
			if (!file) return;
			setAvatarError(null);
			if (file.size > MAX_AVATAR_BYTES) {
				setAvatarError("Image must be 50 MB or smaller.");
				return;
			}
			if (!file.type.startsWith("image/")) {
				setAvatarError("Please choose an image file.");
				return;
			}
			setAvatarUploading(true);
			void uploadAvatar(file, user?.avatar ?? null)
				.then(() => refresh())
				.catch((err: unknown) => {
					setAvatarError(err instanceof Error ? err.message : "Failed to upload image");
				})
				.finally(() => setAvatarUploading(false));
		},
		[user, refresh],
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
						{user?.avatar && (
							<img src={avatarUrl(user.avatar)} alt="Your avatar" width={74} height={74} />
						)}
						<ClassicyFileInput
							id="account-avatar-file"
							accept="image/*"
							disabled={avatarUploading}
							onChangeFunc={handleAvatarFiles}
						/>
						<ClassicyButton
							disabled={avatarUploading}
							onClickFunc={() => document.getElementById("account-avatar-file")?.click()}
						>
							{user?.avatar ? "Change Avatar" : "Upload Avatar"}
						</ClassicyButton>
						{avatarError && <div>{avatarError}</div>}
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
