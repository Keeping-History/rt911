import {
	ClassicyApp,
	ClassicyBevelButton,
	ClassicyButton,
	ClassicyControlLabel,
	ClassicyFileInput,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
} from "classicy";
import appIconPng from "./app.png";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { avatarUrl, uploadAvatar, verifyRegistration } from "../../Providers/Auth/authApi";
import { confirmEmailChange } from "../../Providers/Auth/profileApi";
import styles from "./Account.module.scss";
import { ProfileEditor } from "./ProfileEditor";
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
	const { status, user, signInWithEmail, signInWithProvider, signOut, refresh, register } = useAuth();
	const [avatarUploading, setAvatarUploading] = useState(false);
	const [avatarError, setAvatarError] = useState<string | null>(null);

	// Verified-email-change landing: capture ?confirm-email=<token> once, strip
	// it from the URL, keep it IN MEMORY ONLY. Confirm as soon as we're signed
	// in (which may be immediately, or after the teacher signs in below).
	const [confirmToken, setConfirmToken] = useState<string | null>(() => {
		const params = new URLSearchParams(window.location.search);
		const token = params.get("confirm-email");
		if (token) {
			params.delete("confirm-email");
			const rest = params.toString();
			window.history.replaceState({}, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
		}
		return token;
	});
	// Seamless-registration landing: Directus appends ?token=<t> to the
	// verification_url. Verified anonymously (the user isn't signed in yet);
	// ref-guarded against StrictMode double-fire like the confirm-email flow.
	const [regToken] = useState<string | null>(() => {
		const params = new URLSearchParams(window.location.search);
		const token = params.get("token");
		if (token) {
			params.delete("token");
			const rest = params.toString();
			window.history.replaceState({}, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
		}
		return token;
	});
	const [regResult, setRegResult] = useState<string | null>(null);
	const regSentRef = useRef<string | null>(null);
	useEffect(() => {
		if (!regToken || regSentRef.current === regToken) return;
		regSentRef.current = regToken;
		verifyRegistration(regToken)
			.then(() => setRegResult("Email verified — you can now sign in."))
			.catch((err: Error) => setRegResult(err.message));
	}, [regToken]);

	const [confirmResult, setConfirmResult] = useState<string | null>(null);
	// Ref guard, not just state: StrictMode double-invokes effects against the
	// same render closure, so setConfirmToken(null) alone would still send the
	// single-use token twice (the second attempt 400s as "already in use" and
	// stomps the success banner). Same pattern as AuthProvider's loadStartedRef.
	const confirmSentRef = useRef<string | null>(null);
	useEffect(() => {
		if (!confirmToken || status !== "signedIn") return;
		if (confirmSentRef.current === confirmToken) return;
		confirmSentRef.current = confirmToken;
		setConfirmToken(null);
		confirmEmailChange(confirmToken)
			.then((email) => {
				setConfirmResult(`Your email is now ${email}.`);
				// refresh() failure must not overwrite the (real) success message —
				// the change already applied; the profile view just re-syncs later.
				void Promise.resolve(refresh()).catch(() => undefined);
			})
			.catch((err: Error) => setConfirmResult(err.message));
	}, [confirmToken, status, refresh]);
	const confirmBanner =
		confirmResult ??
		(confirmToken && status === "anonymous"
			? "Sign in to confirm your new email address."
			: null);

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
				{regResult && <div className={styles.banner}>{regResult}</div>}
				{confirmBanner && <div className={styles.banner}>{confirmBanner}</div>}
				{status === "loading" ? (
					<div />
				) : status === "signedIn" ? (
					<div className={styles.accountContent}>
						<div className={styles.identity}>
							{/* Profile image doubles as the avatar picker: a bevel
							    button showing the current avatar (or an "Add Photo"
							    prompt) that clicks through to the hidden file input. */}
							<ClassicyBevelButton
								bevelWidth="large"
								disabled={avatarUploading}
								aria-label={user?.avatar ? "Change Avatar" : "Upload Avatar"}
								onClickFunc={() =>
									document.getElementById("account-avatar-file")?.click()
								}
							>
								{user?.avatar ? (
									<img
										className={styles.avatarImage}
										src={avatarUrl(user.avatar)}
										alt="Your avatar"
										width={74}
										height={74}
									/>
								) : (
									<span className={styles.avatarPlaceholder}>Add Photo</span>
								)}
							</ClassicyBevelButton>
							<div className={styles.identityInfo}>
								<div className={styles.identityName}>
									<ClassicyControlLabel label="Signed in as" />
									<ClassicyControlLabel label={`${user?.first_name ?? user?.email}`} />
								</div>
								<div className={styles.playlists}>
									<ClassicyControlLabel label="Manage your playlists in the Playlists app." />
								</div>
								<ClassicyButton onClickFunc={() => void signOut()}>
									Sign Out
								</ClassicyButton>
							</div>
						</div>
						<div className={styles.hiddenFileInput}>
							<ClassicyFileInput
								id="account-avatar-file"
								accept="image/*"
								disabled={avatarUploading}
								onChangeFunc={handleAvatarFiles}
							/>
						</div>
						{avatarError && <div className={styles.error}>{avatarError}</div>}
						<ProfileEditor />
					</div>
				) : (
					<SignInForm
						onSignInWithEmail={signInWithEmail}
						onSignInWithProvider={signInWithProvider}
						onRegister={register}
						hostnameForTest={hostnameForTest}
					/>
				)}
			</ClassicyWindow>
		</ClassicyApp>
	);
};
