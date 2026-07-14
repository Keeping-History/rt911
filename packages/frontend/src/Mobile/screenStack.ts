// iPod navigation is a stack: selecting a list item pushes a screen, the
// MENU button pops one. Only the top screen is mounted (Task 9 renders it
// with a slide-in animation on mount rather than keeping two live panes).

export type ScreenId =
	| "menu"
	| "radio"
	| "nowPlaying"
	| "timeTravel"
	| "bookmarks"
	| "scrub"
	| "about";

export interface ScreenStackState {
	stack: ScreenId[];
}

export type ScreenStackAction = { type: "push"; id: ScreenId } | { type: "pop" };

export const initialScreenStack: ScreenStackState = { stack: ["menu"] };

export function screenStackReducer(
	state: ScreenStackState,
	action: ScreenStackAction,
): ScreenStackState {
	switch (action.type) {
		case "push":
			return { stack: [...state.stack, action.id] };
		case "pop":
			return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
	}
}

export function currentScreen(state: ScreenStackState): ScreenId {
	return state.stack[state.stack.length - 1];
}

/** Status-bar title per screen (the real iPod titles the top bar per menu). */
export const SCREEN_TITLES: Record<ScreenId, string> = {
	menu: "iPod",
	radio: "Radio",
	nowPlaying: "Now Playing",
	timeTravel: "Time Travel",
	bookmarks: "Bookmarks",
	scrub: "Scrub",
	about: "About",
};
