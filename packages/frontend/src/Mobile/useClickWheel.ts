// Pointer events on the wheel → semantic iPod events. Buttons are child
// elements of the wheel: their pointerdown marks which button is pressed
// (and bubbles up so the wheel starts angle tracking); the wheel's pointerup
// fires the button action only when the gesture stayed a tap (never crossed
// the scroll dead zone). The ⏮/⏭ buttons additionally support hold-repeat:
// held past HOLD_DELAY_MS they fire onPrevHold/onNextHold on an interval
// instead of the tap action. preventDefault() on pointerdown suppresses the
// browser's synthetic click — which is why audioCapture.ts and
// StationPlayer.tsx also listen for pointerdown to unlock audio (Task 10).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { angleDeg, WheelTracker } from "./wheelMath";

export type WheelButton = "select" | "menu" | "prev" | "next" | "playPause";

/** Holding ⏮/⏭ this long arms hold-repeat (a normal tap stays well under it). */
export const HOLD_DELAY_MS = 550;
/** While held, the hold handler repeats at this interval. */
export const HOLD_REPEAT_MS = 500;

export interface ClickWheelHandlers {
	onScroll: (steps: number) => void;
	onSelect: () => void;
	onMenu: () => void;
	onPrev: () => void;
	onNext: () => void;
	onPlayPause: () => void;
	/**
	 * Optional hold-repeat for the ⏮/⏭ buttons: fired once when the press has
	 * been held for {@link HOLD_DELAY_MS}, then every {@link HOLD_REPEAT_MS}
	 * until release. `heldMs` is how long the repeat has been running (0 on
	 * the first fire), so handlers can accelerate with hold duration. Once a
	 * hold has fired, the release does NOT also fire the tap handler
	 * (onPrev/onNext) — a hold is a different gesture, not a long tap.
	 * Scrolling cancels a pending or active hold, same as it cancels taps.
	 */
	onPrevHold?: (heldMs: number) => void;
	onNextHold?: (heldMs: number) => void;
}

export interface ClickWheel {
	wheelRef: React.RefObject<HTMLElement | null>;
	wheelHandlers: {
		onPointerDown: (e: React.PointerEvent) => void;
		onPointerMove: (e: React.PointerEvent) => void;
		onPointerUp: (e: React.PointerEvent) => void;
		onPointerCancel: (e: React.PointerEvent) => void;
	};
	buttonDown: (b: WheelButton) => (e: React.PointerEvent) => void;
	pressed: WheelButton | null;
}

export function useClickWheel(handlers: ClickWheelHandlers): ClickWheel {
	const wheelRef = useRef<HTMLElement | null>(null);
	const trackerRef = useRef(new WheelTracker());
	const draggingRef = useRef(false);
	const [pressed, setPressed] = useState<WheelButton | null>(null);
	const pressedRef = useRef<WheelButton | null>(null);
	// Latest handlers behind a ref so the returned callbacks stay stable.
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;

	// Hold-repeat state for the ⏮/⏭ buttons: a delay timer arms the repeat,
	// an interval drives it, and holdFiredRef suppresses the tap on release.
	const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const holdIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const holdFiredRef = useRef(false);

	const stopHold = useCallback(() => {
		if (holdTimerRef.current !== null) {
			clearTimeout(holdTimerRef.current);
			holdTimerRef.current = null;
		}
		if (holdIntervalRef.current !== null) {
			clearInterval(holdIntervalRef.current);
			holdIntervalRef.current = null;
		}
	}, []);

	const startHold = useCallback(
		(b: WheelButton) => {
			stopHold();
			holdFiredRef.current = false;
			const holdHandler = () =>
				b === "prev"
					? handlersRef.current.onPrevHold
					: handlersRef.current.onNextHold;
			if (!holdHandler()) return; // no hold behavior registered
			let repeatStartedAt = 0;
			const tick = () => {
				// A drag that crossed the scroll dead zone turns the gesture into a
				// scroll — stop repeating, exactly as taps are cancelled by scrolls.
				if (trackerRef.current.hasScrolled) {
					stopHold();
					return;
				}
				holdFiredRef.current = true;
				holdHandler()?.(Date.now() - repeatStartedAt);
			};
			holdTimerRef.current = setTimeout(() => {
				holdTimerRef.current = null;
				repeatStartedAt = Date.now();
				tick();
				holdIntervalRef.current = setInterval(tick, HOLD_REPEAT_MS);
			}, HOLD_DELAY_MS);
		},
		[stopHold],
	);

	// Never leave a repeat running past unmount.
	useEffect(() => stopHold, [stopHold]);

	const angleOf = useCallback((e: React.PointerEvent): number => {
		const rect = (wheelRef.current as HTMLElement).getBoundingClientRect();
		return angleDeg(
			rect.left + rect.width / 2,
			rect.top + rect.height / 2,
			e.clientX,
			e.clientY,
		);
	}, []);

	const wheelHandlers = useMemo(() => {
		const end = () => {
			stopHold();
			const button = pressedRef.current;
			// A hold that fired consumed the gesture — release is not also a tap.
			if (button && !trackerRef.current.hasScrolled && !holdFiredRef.current) {
				const h = handlersRef.current;
				(
					{
						select: h.onSelect,
						menu: h.onMenu,
						prev: h.onPrev,
						next: h.onNext,
						playPause: h.onPlayPause,
					}
				)[button]();
			}
			pressedRef.current = null;
			setPressed(null);
			draggingRef.current = false;
			trackerRef.current.end();
		};
		return {
			onPointerDown: (e: React.PointerEvent) => {
				e.preventDefault();
				draggingRef.current = true;
				trackerRef.current.start(angleOf(e), Date.now());
				(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
			},
			onPointerMove: (e: React.PointerEvent) => {
				if (!draggingRef.current) return;
				const steps = trackerRef.current.move(angleOf(e), Date.now());
				// Crossing the scroll dead zone re-types the gesture as a scroll:
				// cancel any pending or running hold-repeat along with the tap.
				if (trackerRef.current.hasScrolled) stopHold();
				if (steps !== 0) handlersRef.current.onScroll(steps);
			},
			onPointerUp: () => end(),
			onPointerCancel: () => end(),
		};
	}, [angleOf, stopHold]);

	const buttonDown = useCallback(
		(b: WheelButton) => () => {
			pressedRef.current = b;
			setPressed(b);
			// ⏮/⏭ support hold-repeat (see ClickWheelHandlers.onPrevHold).
			if (b === "prev" || b === "next") startHold(b);
			// No stopPropagation: the event bubbles to the wheel, which starts
			// angle tracking so a drag that began on a button still scrolls.
		},
		[startHold],
	);

	// Stable object identity (only `pressed` varies): IpodChrome's artwork is
	// memoized on it, so the shell's per-second re-renders (clock tick, stream
	// frames) don't reconcile the wheel/button subtree at all.
	return useMemo(
		() => ({ wheelRef, wheelHandlers, buttonDown, pressed }),
		[wheelHandlers, buttonDown, pressed],
	);
}
