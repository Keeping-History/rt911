import { registerApp } from "classicy";

// Description-only manifest: MarketWatch has no custom reducer, but every
// desktop app registers a description — it is the balloon-help copy for the
// app's desktop shortcut (see Components/manifestDescription.ts) and is
// pinned by appManifests.test.ts.
registerApp({
	id: "MarketWatch.app",
	description:
		"Follow stock, index and bond markets around the September 2001 trading halt.",
});
