// The streamer's virtual clock lives in UTC. Item start_dates, the backend's
// stored times, the seek instant, and every consuming app's calcSeekSeconds all
// compare in UTC. The Classicy hook's `localDate` is a *display* value — the UTC
// instant shifted by the user's timezone offset for the menu-bar clock — and it
// is the one value that ticks every second. Stripping the offset back off
// recovers the per-second-ticking UTC instant the stream must send, gate, and
// seek on. At a minute boundary this equals `new Date(dateTime).getTime()`.
//
// Using `localDate` directly here is a bug: for any user whose offset is non-zero
// (the default is their real local offset) the reveal gate sits `tzOffset` hours
// away from the instant the server windows around, so short-lived items (radio
// recordings, instant news headlines) never leave the future buffer.
export function virtualUtcMs(localDate: Date, tzOffsetHours: number): number {
	return localDate.getTime() - tzOffsetHours * 60 * 60 * 1000;
}
