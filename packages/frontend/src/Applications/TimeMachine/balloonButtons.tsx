// packages/frontend/src/Applications/TimeMachine/balloonButtons.tsx
//
// Buttons with balloon help bound straight to the button element, via
// useClassicyBalloonHelp, for the places where the <ClassicyBalloonHelp>
// wrapper breaks layout. Everywhere else this app uses the wrapper, which
// is classicy's standard way and works on disabled buttons too.
//
// The wrapper is an inline-block <div> that becomes the flex item in place
// of the button. A flex item can't shrink below its content's min-content
// width, so a wrapped button stops shrinking — and two rows here rely on
// flex shrink to fit the 380px-wide main window: the transport row's six
// square buttons (22px each when shrunk, 48px when wrapped, which pushed
// ⇚/⇛ out of view) and the Capture Bookmark bevel button next to the time
// spinners. The Bookmarks tree's rows are full-width flex children with the
// same problem in the other direction. Binding the hook to the button keeps
// the DOM exactly as it was.
//
// Caveat that decides which to use: React delivers no mouse events to a
// disabled button, so a hook-bound balloon never shows on one. Any button
// that can be disabled (Play/Pause, a dialog's Save) must take the wrapper,
// which hears the hover on the disabled button's behalf. The components
// below are therefore only for buttons that are never disabled.
import {
	ClassicyBevelButton,
	ClassicyButton,
	type ClassicyIconBalloonHelp,
	useClassicyBalloonHelp,
} from "classicy";
import type React from "react";
import {
	type ButtonHTMLAttributes,
	type ComponentProps,
	type MouseEvent,
	useRef,
} from "react";

/** A plain <button> with balloon help. */
export const BalloonButton: React.FC<
	ButtonHTMLAttributes<HTMLButtonElement> & { balloon: ClassicyIconBalloonHelp }
> = ({ balloon: config, children, ...rest }) => {
	const anchorRef = useRef<HTMLButtonElement>(null);
	const { handlers, balloon } = useClassicyBalloonHelp(anchorRef, config);
	return (
		<>
			<button ref={anchorRef} type="button" {...rest} {...handlers}>
				{children}
			</button>
			{balloon}
		</>
	);
};

/**
 * A ClassicyButton with balloon help. ClassicyButton forwards its ref to the
 * underlying <button> and passes mouse-enter/leave through, which is all the
 * hook needs.
 */
export const BalloonClassicyButton: React.FC<
	ComponentProps<typeof ClassicyButton> & { balloon: ClassicyIconBalloonHelp }
> = ({ balloon: config, children, ...rest }) => {
	const anchorRef = useRef<HTMLButtonElement>(null);
	const { handlers, balloon } = useClassicyBalloonHelp(anchorRef, config);
	return (
		<>
			<ClassicyButton ref={anchorRef} {...rest} {...handlers}>
				{children}
			</ClassicyButton>
			{balloon}
		</>
	);
};

/**
 * A ClassicyBevelButton with balloon help. It forwards no ref, but it does
 * pass `onMouseEnter` through to its <button>, and the hook only reads the
 * anchor when the hover timer fires — so the element is captured from the
 * mouse-enter event, which always precedes that. It does NOT pass
 * `onMouseLeave` through: it sets its own after spreading the rest props
 * (for its pressed-state tracking), so a prop handler never runs and the
 * balloon would stay open. A native listener on the element, armed on each
 * mouse-enter, closes it instead.
 */
export const BalloonBevelButton: React.FC<
	ComponentProps<typeof ClassicyBevelButton> & { balloon: ClassicyIconBalloonHelp }
> = ({ balloon: config, children, ...rest }) => {
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const { handlers, balloon } = useClassicyBalloonHelp(anchorRef, config);
	return (
		<>
			<ClassicyBevelButton
				{...rest}
				aria-describedby={handlers["aria-describedby"]}
				onMouseEnter={(e: MouseEvent<HTMLButtonElement>) => {
					const element = e.currentTarget;
					anchorRef.current = element;
					element.addEventListener("mouseleave", handlers.onMouseLeave, { once: true });
					handlers.onMouseEnter();
				}}
			>
				{children}
			</ClassicyBevelButton>
			{balloon}
		</>
	);
};
