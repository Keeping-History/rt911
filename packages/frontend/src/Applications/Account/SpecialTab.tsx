// Account → Special: the two irreversible actions. Both run entirely on the
// server (profile-api extension) because neither is possible with user
// credentials. Spec: plans/2026-07-28-account-special-tab-design.md
import { ClassicyAlert, ClassicyButton, ClassicyControlLabel, ClassicyInput } from "classicy";
import type React from "react";
import { useState } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import {
	clearLocalSettings,
	deleteMyAccount,
	deleteMyData,
	reloadDesktop,
} from "../../Providers/Auth/accountApi";
import styles from "./Account.module.scss";

type Pending = "data" | "account" | null;

export const SpecialTab: React.FC = () => {
	const { user } = useAuth();
	const [pending, setPending] = useState<Pending>(null);
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// What the user must type to arm account deletion. Screen name is the
	// identity they actually recognise; email is the fallback for accounts
	// that never set one.
	const confirmName = user?.username ?? user?.email ?? "";

	const close = () => {
		setPending(null);
		setTyped("");
	};

	const run = (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		action()
			.then(() => {
				// Order matters: the server wipe must have succeeded before we
				// drop local state, and the reload is what makes clearing the
				// keys stick (see accountApi.reloadDesktop).
				clearLocalSettings();
				reloadDesktop();
			})
			.catch((err: Error) => {
				setError(err.message);
				close();
			})
			.finally(() => setBusy(false));
	};

	return (
		<div className={styles.tabPanel}>
			<div className={styles.destructive}>
				<ClassicyControlLabel label="Delete my data" />
				<div className={styles.riskCopy}>
					Erases your profile, desktop settings, playlists, stacks, bookmarks and chat
					history. Your account and your uploaded files are kept.
				</div>
				<ClassicyButton disabled={busy} onClickFunc={() => setPending("data")}>
					Delete My Data
				</ClassicyButton>
			</div>

			<div className={styles.destructive}>
				<ClassicyControlLabel label="Delete my account" />
				<div className={styles.riskCopy}>
					Everything above, and then your account itself. You will be signed out and
					cannot sign back in. Your uploaded files are kept.
				</div>
				<ClassicyButton disabled={busy} onClickFunc={() => setPending("account")}>
					Delete My Account
				</ClassicyButton>
			</div>

			{error && <div className={styles.error}>{error}</div>}

			{pending === "data" && (
				<ClassicyAlert
					id="account_delete_data"
					appId="Account.app"
					alertType="stop"
					title="Account"
					label="This cannot be undone."
					message="Deletes your profile, settings, playlists, stacks, bookmarks and chat history. Keeps your files and your login."
					// HIG: when an action risks data loss the SAFE choice is the
					// default, so Return dismisses rather than destroys.
					defaultButtonId="account_delete_data_cancel"
					buttons={[
						{
							id: "account_delete_data_cancel",
							label: "Cancel",
							role: "cancel",
							onClick: close,
						},
						{
							id: "account_delete_data_go",
							label: "Delete",
							role: "normal",
							disabled: busy,
							onClick: () => run(deleteMyData),
						},
					]}
				/>
			)}

			{pending === "account" && (
				<ClassicyAlert
					id="account_delete_account"
					appId="Account.app"
					alertType="stop"
					title="Account"
					label="This cannot be undone."
					message={
						<div>
							<p>
								Your account and everything in it will be permanently removed. Your
								uploaded files are kept.
							</p>
							<ClassicyInput
								id="account-delete-confirm"
								labelTitle="Type your screen name to confirm"
								prefillValue={typed}
								disabled={busy}
								onChangeFunc={(e) => setTyped(e.target.value)}
							/>
						</div>
					}
					defaultButtonId="account_delete_account_cancel"
					buttons={[
						{
							id: "account_delete_account_cancel",
							label: "Cancel",
							role: "cancel",
							onClick: close,
						},
						{
							id: "account_delete_account_go",
							label: "Delete",
							role: "normal",
							// Exact match only. A near-miss is a near-miss.
							disabled: busy || typed !== confirmName,
							onClick: () => run(deleteMyAccount),
						},
					]}
				/>
			)}
		</div>
	);
};
