// The mobile boot branch: provider tree + the iPod shell, with none of the
// desktop's application code in the chunk graph. IpodShell is imported
// eagerly here — the whole branch is the lazy unit (see app.tsx), so the
// shell no longer needs its own lazy() indirection.
//
// Classicy 3 ships Platinum's fonts as .woff2 files that the Platinum package
// (imported by boot/AppProviders.tsx) registers as @font-face rules, so the
// browser fetches a face only when something renders in it. The iPod shell
// renders in its own typeface (see shell.css), so the phone downloads no
// Platinum font until TvPlayer's QuickTimeVideoEmbed chrome first draws; the
// idle-time import of classicy's base64 fonts.css that this replaced is gone.
import { AppProviders } from "./boot/AppProviders";
import IpodShell from "./Mobile/IpodShell";

export default function MobileRoot() {
	return (
		<AppProviders>
			<IpodShell />
		</AppProviders>
	);
}
