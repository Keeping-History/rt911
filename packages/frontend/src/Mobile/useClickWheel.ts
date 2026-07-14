// Pointer events on the wheel → semantic iPod events. Buttons are child
// elements of the wheel: their pointerdown marks which button is pressed
// (and bubbles up so the wheel starts angle tracking); the wheel's pointerup
// fires the button action only when the gesture stayed a tap (never crossed
// the scroll dead zone). preventDefault() on pointerdown suppresses the
// browser's synthetic click — which is why audioCapture.ts and
// StationPlayer.tsx also listen for pointerdown to unlock audio (Task 10).
import { useCallback, useMemo, useRef, useState } from "react";
import { angleDeg, WheelTracker } from "./wheelMath";

export type WheelButton = "select" | "menu" | "prev" | "next" | "playPause";

export interface ClickWheelHandlers {
	onScroll: (steps: number) => void;
	onSelect: () => void;
	onMenu: () => void;
	onPrev: () => void;
	onNext: () => void;
	onPlayPause: () => void;
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
			const button = pressedRef.current;
			if (button && !trackerRef.current.hasScrolled) {
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
				if (steps !== 0) handlersRef.current.onScroll(steps);
			},
			onPointerUp: () => end(),
			onPointerCancel: () => end(),
		};
	}, [angleOf]);

	const buttonDown = useCallback(
		(b: WheelButton) => () => {
			pressedRef.current = b;
			setPressed(b);
			// No stopPropagation: the event bubbles to the wheel, which starts
			// angle tracking so a drag that began on a button still scrolls.
		},
		[],
	);

	return { wheelRef, wheelHandlers, buttonDown, pressed };
}
