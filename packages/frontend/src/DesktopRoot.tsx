// The desktop boot branch: provider tree + ClassicyDesktop in one chunk.
//
// Desktop is imported EAGERLY within this module on purpose: mounting
// ClassicyDesktop lazily (a tick after ClassicyAppManagerProvider) corrupts
// classicy's manager state — early dispatches hit a reducer that iterates
// state the desktop hasn't seeded yet, and every dispatch after that throws
// (windows can no longer open). Verified empirically 2026-07-14: `lazy(() =>
// import("./Desktop"))` under an already-mounted provider reproduces it.
// This module sidesteps the bug instead of depending on a classicy fix: the
// provider and the desktop live in the SAME lazy chunk and mount in the same
// commit, so there is never a provider-without-desktop tick. That is what
// lets app.tsx lazy-load the whole branch and keep desktop-only code
// (Applications, html2canvas, …) out of the phone's boot path.
import "classicy/dist/fonts.css";
import { AppProviders } from "./boot/AppProviders";
import Desktop from "./Desktop";

export default function DesktopRoot() {
	return (
		<AppProviders>
			<Desktop />
		</AppProviders>
	);
}
