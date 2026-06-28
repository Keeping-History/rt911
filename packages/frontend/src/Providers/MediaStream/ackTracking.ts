import { trackVirtualTimeSet } from "../../openreplay";

export function trackAck(type: string, time: string | undefined): void {
	if (type === "init_ack" && time) {
		trackVirtualTimeSet(time, "init");
	} else if (type === "seek_ack" && time) {
		trackVirtualTimeSet(time, "seek");
	}
}
