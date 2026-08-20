// The mobile/desktop branch is decided ONCE at boot with the same media query
// the old MobileBlocker overlay used (`@media (pointer: coarse)`), so the set
// of devices that get the mobile experience is exactly the set that used to be
// blocked. `?ipod` in the URL forces the mobile shell on any device — the
// testing escape hatch for desktop browsers. No live re-branching on
// resize/orientation.
export function isMobileDevice(
	mm: (query: string) => MediaQueryList = (q) => window.matchMedia(q),
	search: string = window.location.search,
): boolean {
	if (new URLSearchParams(search).has("ipod")) return true;
	return mm("(pointer: coarse)").matches;
}
