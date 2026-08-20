import { registerApp } from "classicy";

// Description-only manifest: Newsgroups has no custom reducer, but every
// desktop app registers a description — it is the balloon-help copy for the
// app's desktop shortcut (see Components/manifestDescription.ts) and is
// pinned by appManifests.test.ts.
registerApp({
	id: "Newsgroups.app",
	description:
		"Read Usenet newsgroups as messages were posted in September 2001.",
});
