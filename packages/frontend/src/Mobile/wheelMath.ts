// Click-wheel rotation math, ported from robbiebyrd/ipod_ui js/controls.js
// (MIT — see VENDORED.md). Pure and framework-free so it can be tested
// without pointer events: useClickWheel feeds it angles, it emits whole
// scroll steps.

export const ROTATION_THRESHOLD = 25; // degrees of rotation per scroll step
export const SCROLL_DEAD_ZONE = 5; // degrees before a drag counts as a scroll
export const STALE_MS = 150; // pause longer than this re-anchors tracking
export const MAX_JUMP_DEG = 60; // a bigger single-move delta is a teleport

/** Angle (degrees, −180..180) of point (x, y) around center (cx, cy). */
export function angleDeg(cx: number, cy: number, x: number, y: number): number {
	return Math.atan2(y - cy, x - cx) * (180 / Math.PI);
}

/** Shortest signed angular difference, wrapping across the ±180° seam. */
function angleDelta(prev: number, next: number): number {
	let d = next - prev;
	if (d > 180) d -= 360;
	if (d < -180) d += 360;
	return d;
}

export class WheelTracker {
	private lastAngle = 0;
	private lastMoveTime = 0;
	private total = 0;
	private scrolled = false;

	get hasScrolled(): boolean {
		return this.scrolled;
	}

	start(angle: number, now: number): void {
		this.lastAngle = angle;
		this.lastMoveTime = now;
		this.total = 0;
		this.scrolled = false;
	}

	/** Feed one pointer move; returns whole steps to scroll (may be 0 or ±n). */
	move(angle: number, now: number): number {
		if (now - this.lastMoveTime > STALE_MS) {
			this.lastAngle = angle;
			this.lastMoveTime = now;
			this.total = 0;
			return 0;
		}
		const delta = angleDelta(this.lastAngle, angle);
		this.lastAngle = angle;
		this.lastMoveTime = now;
		if (Math.abs(delta) > MAX_JUMP_DEG) return 0;

		this.total += delta;
		if (Math.abs(this.total) > SCROLL_DEAD_ZONE) this.scrolled = true;

		const steps = Math.trunc(this.total / ROTATION_THRESHOLD);
		this.total -= steps * ROTATION_THRESHOLD;
		return steps;
	}

	end(): void {
		this.total = 0;
	}
}
