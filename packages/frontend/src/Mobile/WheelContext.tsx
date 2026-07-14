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
	useEffect(
		() =>
			register({
				onScroll: (s) => ref.current.onScroll?.(s),
				onSelect: () => ref.current.onSelect?.(),
				onPrev: () => ref.current.onPrev?.(),
				onNext: () => ref.current.onNext?.(),
			}),
		[register],
	);
}

export interface ScreenNav {
	push: (id: ScreenId) => void;
	pop: () => void;
}

export const ScreenNavContext = createContext<ScreenNav>({
	push: () => {},
	pop: () => {},
});
