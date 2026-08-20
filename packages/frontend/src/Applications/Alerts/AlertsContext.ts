import { registerApp } from "classicy";

// Description-only manifests: neither Alerts app has a custom reducer, but
// every desktop app registers a description — it is the balloon-help copy for
// the app's desktop shortcut (see Components/manifestDescription.ts) and is
// pinned by appManifests.test.ts. Alerts.app itself is a background extension
// with no desktop icon; its description still documents it for manifest-driven
// surfaces.
registerApp({
	id: "Alerts.app",
	description:
		"Surfaces alerts about the day's events as they happen, one at a time.",
});

registerApp({
	id: "AlertsManager.app",
	description:
		"Choose whether alerts about the day's events appear as they happen.",
});
