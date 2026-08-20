import { registerApp } from "classicy";

// Description-only manifest: Instant Messenger has no custom reducer, but
// every desktop app registers a description — it is the balloon-help copy for
// the app's desktop shortcut (see Components/manifestDescription.ts) and is
// pinned by appManifests.test.ts.
registerApp({
	id: "IMBuddies.app",
	description:
		"An instant messenger for chatting with buddies who follow the events of September 11, 2001 as they unfold.",
});
