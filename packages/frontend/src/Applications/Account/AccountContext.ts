import { registerApp } from "classicy";

// Description-only manifest: Account has no custom reducer, but every desktop
// app registers a description — it is the balloon-help copy for the app's
// desktop shortcut (see Components/manifestDescription.ts) and is pinned by
// appManifests.test.ts.
registerApp({
	id: "Account.app",
	description:
		"Sign in to your account and manage your profile, avatar, and saved desktop.",
});
