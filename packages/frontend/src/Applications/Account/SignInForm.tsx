import type React from "react";
import { useState } from "react";
import { ClassicyButton, ClassicyInput } from "classicy";
import { isHostOf } from "../../Providers/Auth/authApi";

type Provider = "google" | "facebook" | "apple";

// Facebook joins this list once its Directus provider is configured — see
// scripts/playlist-auth/README.md (the ops log documents the identical
// AUTH_FACEBOOK_DRIVER env pattern for when the Meta client exists).
const PROVIDERS: Provider[] = ["google", "apple"];

const PROVIDER_LABEL: Record<Provider, string> = {
	google:   "Google",
	facebook: "Facebook",
	apple:    "Apple",
};

export interface SignInFormProps {
	onSignInWithEmail:    (email: string, password: string) => Promise<void>;
	onSignInWithProvider: (provider: Provider) => void;
	onRegister:           (email: string, password: string) => Promise<void>;
	/** Overrides window.location.hostname for tests. */
	hostnameForTest?: string;
}

export const SignInForm: React.FC<SignInFormProps> = ({
	onSignInWithEmail,
	onSignInWithProvider,
	onRegister,
	hostnameForTest,
}) => {
	const [view,        setView]        = useState<"signin" | "register">("signin");
	const [email,       setEmail]       = useState("");
	const [password,    setPassword]    = useState("");
	const [confirmPw,   setConfirmPw]   = useState("");
	const [submitting,  setSubmitting]  = useState(false);
	const [error,       setError]       = useState<string | null>(null);
	const [registered,  setRegistered]  = useState(false);

	const hostname = hostnameForTest ?? window.location.hostname;
	const reason   = new URLSearchParams(window.location.search).get("reason");

	if (isHostOf(hostname, "github.io")) {
		return <div>Sign-in is unavailable on preview builds.</div>;
	}

	const canSubmit =
		!submitting &&
		email.trim() !== "" &&
		password.trim() !== "" &&
		(view === "signin" || confirmPw.trim() !== "");

	const handleSignIn = () => {
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		onSignInWithEmail(email, password)
			.catch((err) => {
				setError(err instanceof Error ? err.message : "Sign-in failed");
			})
			.finally(() => setSubmitting(false));
	};

	const handleRegister = () => {
		setError(null);
		if (password.length < 8) {
			setError("Password must be at least 8 characters.");
			return;
		}
		if (password !== confirmPw) {
			setError("Passwords do not match.");
			return;
		}
		setSubmitting(true);
		onRegister(email.trim(), password)
			.then(() => setRegistered(true))
			.catch((err) => {
				setError(err instanceof Error ? err.message : "Could not create the account.");
			})
			.finally(() => setSubmitting(false));
	};

	const switchView = (next: "signin" | "register") => {
		setView(next);
		setError(null);
		setRegistered(false);
		setPassword("");
		setConfirmPw("");
	};

	if (registered) {
		return (
			<div>
				<div>Check your email to verify your account, then sign in.</div>
				<ClassicyButton onClickFunc={() => switchView("signin")}>
					Back to Sign In
				</ClassicyButton>
			</div>
		);
	}

	return (
		<div>
			{view === "signin" && (
				<>
					{PROVIDERS.map((provider) => (
						<ClassicyButton key={provider} onClickFunc={() => onSignInWithProvider(provider)}>
							{`Sign in with ${PROVIDER_LABEL[provider]}`}
						</ClassicyButton>
					))}
				</>
			)}
			<ClassicyInput
				id="account-email"
				labelTitle="Email"
				prefillValue={email}
				onChangeFunc={(e) => setEmail(e.target.value)}
			/>
			<ClassicyInput
				id="account-password"
				labelTitle="Password"
				type="password"
				prefillValue={password}
				onChangeFunc={(e) => setPassword(e.target.value)}
			/>
			{view === "register" && (
				<ClassicyInput
					id="account-confirm-password"
					labelTitle="Confirm Password"
					type="password"
					prefillValue={confirmPw}
					onChangeFunc={(e) => setConfirmPw(e.target.value)}
				/>
			)}
			{view === "signin" ? (
				<>
					<ClassicyButton isDefault disabled={!canSubmit} onClickFunc={handleSignIn}>
						{submitting ? "Signing In…" : "Sign In"}
					</ClassicyButton>
					<ClassicyButton disabled={submitting} onClickFunc={() => switchView("register")}>
						Create an Account
					</ClassicyButton>
				</>
			) : (
				<>
					<ClassicyButton isDefault disabled={!canSubmit} onClickFunc={handleRegister}>
						{submitting ? "Creating…" : "Create Account"}
					</ClassicyButton>
					<ClassicyButton disabled={submitting} onClickFunc={() => switchView("signin")}>
						Back to Sign In
					</ClassicyButton>
				</>
			)}
			{reason && <div>{reason}</div>}
			{error && <div>{error}</div>}
		</div>
	);
};
