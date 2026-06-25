// navigator.deviceMemory is a non-standard (Chromium-only) signal: approximate
// device RAM in GiB, bucketed to 0.25/0.5/1/2/4/8. Absent on Firefox/Safari.
interface Navigator {
	readonly deviceMemory?: number;
}
