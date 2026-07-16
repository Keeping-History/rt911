import type React from "react";
import { useState } from "react";
import { ClassicyButton, ClassicyInput } from "classicy";

type Provider = "google" | "facebook" | "apple";

// v1 ships Google only. Add "facebook" / "apple" here once their Directus
// providers are configured — see scripts/playlist-auth/README.md (the ops
// log documents the identical AUTH_FACEBOOK_DRIVER / AUTH_APPLE_DRIVER env
// pattern for when those clients exist).
const PROVIDERS: Provider[] = ["google"];

const PROVIDER_LABEL: Record<Provider, string> = {
	google:   "Google",
	facebook: "Facebook",
	apple:    "Apple",
};

export interface SignInFormProps {
	onSignInWithEmail:    (email: string, password: string) => Promise<void>;
	onSignInWithProvider: (provider: Provider) => void;
	/** Overrides window.location.hostname for tests. */
	hostnameForTest?: string;
}

export const SignInForm: React.FC<SignInFormProps> = ({
	onSignInWithEmail,
	onSignInWithProvider,
	hostnameForTest,
}) => {
	const [email,       setEmail]       = useState("");
	const [password,    setPassword]    = useState("");
	const [submitting,  setSubmitting]  = useState(false);
	const [error,       setError]       = useState<string | null>(null);

	const hostname = hostnameForTest ?? window.location.hostname;
	const reason   = new URLSearchParams(window.location.search).get("reason");

	if (hostname.endsWith("github.io")) {
		return <div>Sign-in is unavailable on preview builds.</div>;
	}

	const canSubmit = !submitting && email.trim() !== "" && password.trim() !== "";

	const handleSubmit = () => {
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		onSignInWithEmail(email, password)
			.catch((err) => {
				setError(err instanceof Error ? err.message : "Sign-in failed");
			})
			.finally(() => setSubmitting(false));
	};

	return (
		<div>
			{PROVIDERS.map((provider) => (
				<ClassicyButton key={provider} onClickFunc={() => onSignInWithProvider(provider)}>
					{`Sign in with ${PROVIDER_LABEL[provider]}`}
				</ClassicyButton>
			))}
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
			<ClassicyButton
				isDefault
				disabled={!canSubmit}
				onClickFunc={handleSubmit}
			>
				{submitting ? "Signing In…" : "Sign In"}
			</ClassicyButton>
			{reason && <div>{reason}</div>}
			{error && <div>{error}</div>}
		</div>
	);
};
