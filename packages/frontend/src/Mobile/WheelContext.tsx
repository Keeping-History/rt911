// packages/frontend/src/Mobile/WheelContext.tsx
// The shell owns the physical wheel; the active (top-of-stack) screen owns
// what scrolling/selecting means. Screens register their handlers on mount;
// only one screen is mounted at a time, so last-register-wins is exact.
import { createContext, useContext, useEffect, useRef } from "react";
import type { ClickWheelHandlers } from "./useClickWheel";
import type { ScreenId } from "./screenStack";

export type ScreenWheelHandlers = Partial<
	Pick<ClickWheelHandlers, "onScroll" | "onSelect" | "onPrev" | "onNext">
>;

export interface WheelRegistry {
	register: (h: ScreenWheelHandlers) => () => void;
}

export const WheelContext = createContext<WheelRegistry>({
	register: () => () => {},
});

/** Register this screen's wheel behavior for as long as it is mounted. */
export function useScreenWheel(handlers: ScreenWheelHandlers): void {
	const { register } = useContext(WheelContext);
	const ref = useRef(handlers);
	ref.current = handlers;
	useEffect(() => {
		// Register ONLY the meanings this screen actually has. The shell gives
		// unclaimed buttons a default meaning (⏮/⏭ skip the clock), and it
		// detects a claim by the key being present — registering an
		// always-defined wrapper for a handler the screen never passed would
		// silently swallow the default. A screen's handler SET is static for
		// its lifetime (the values stay fresh through the ref).
		const h = ref.current;
		return register({
			onScroll: h.onScroll ? (s) => ref.current.onScroll?.(s) : undefined,
			onSelect: h.onSelect ? () => ref.current.onSelect?.() : undefined,
			onPrev: h.onPrev ? () => ref.current.onPrev?.() : undefined,
			onNext: h.onNext ? () => ref.current.onNext?.() : undefined,
		});
	}, [register]);
}

export interface ScreenNav {
	push: (id: ScreenId) => void;
	pop: () => void;
}

export const ScreenNavContext = createContext<ScreenNav>({
	push: () => {},
	pop: () => {},
});
