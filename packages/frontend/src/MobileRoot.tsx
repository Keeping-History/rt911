// The mobile boot branch: provider tree + the iPod shell, with none of the
// desktop's application code in the chunk graph. IpodShell is imported
// eagerly here — the whole branch is the lazy unit (see app.tsx), so the
// shell no longer needs its own lazy() indirection.
//
// classicy's Platinum fonts (~900 kB of base64 @font-face) are NOT imported
// here: the iPod shell renders in its own typeface (see shell.css), so the
// phone shouldn't pay the decode cost during boot. The one classicy-styled
// component on mobile (TvPlayer's QuickTimeVideoEmbed chrome) falls back to
// system fonts until the deferred import below lands, then picks up the real
// faces — fetched idle-priority, well after first interaction.
import { AppProviders } from "./boot/AppProviders";
import IpodShell from "./Mobile/IpodShell";
import { runWhenIdle } from "./lib/runWhenIdle";

runWhenIdle(() => void import("classicy/dist/fonts.css"));

export default function MobileRoot() {
	return (
		<AppProviders>
			<IpodShell />
		</AppProviders>
	);
}
