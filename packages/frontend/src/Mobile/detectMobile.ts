// The mobile/desktop branch is decided ONCE at boot with the same media query
// the old MobileBlocker overlay used (`@media (pointer: coarse)`), so the set
// of devices that get the mobile experience is exactly the set that used to be
// blocked. No live re-branching on resize/orientation.
export function isMobileDevice(
	mm: (query: string) => MediaQueryList = (q) => window.matchMedia(q),
): boolean {
	return mm("(pointer: coarse)").matches;
}
