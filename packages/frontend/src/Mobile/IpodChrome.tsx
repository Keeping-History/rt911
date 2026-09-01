// packages/frontend/src/Mobile/IpodChrome.tsx
// The iPod device: vendored static artwork + interactive wheel/buttons.
// Layout geometry (the inline percentage styles) comes from the DoodleDev
// export and must not be "cleaned up" — it is the device's proportions.
import { memo } from "react";
import type { ClickWheel } from "./useClickWheel";
import {
	BASE_HTML,
	MID_BUTTON_SVG,
	SCREEN_BEZEL_SVG,
	SHELL_DEFS_SVG,
	WHEEL_RING_HTML,
} from "./ipodChromeMarkup";
import menuIcon from "./icons/menu.svg";
import nextIcon from "./icons/next.svg";
import prevIcon from "./icons/prev.svg";
import playPauseIcon from "./icons/play-pause.svg";
import "./shell.css";

interface IpodChromeProps {
	wheel: ClickWheel;
	children: React.ReactNode;
}

const vendored = (html: string) => (
	// Static vendored artwork, not user input — see VENDORED.md. No react-dom
	// lint rule fires on dangerouslySetInnerHTML in this project's eslint
	// config (eslint-plugin-react isn't installed), so no disable is needed.
	<div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: html }} />
);

// Module-level constant elements: the shell re-renders every clock tick and
// stream frame, and an identical element reference lets React skip these
// subtrees entirely instead of re-diffing the (large) vendored markup.
const SHELL_DEFS = vendored(SHELL_DEFS_SVG);
const BASE = vendored(BASE_HTML);
const SCREEN_BEZEL = vendored(SCREEN_BEZEL_SVG);
const WHEEL_RING = vendored(WHEEL_RING_HTML);

// The wheel + buttons only depend on the ClickWheel object, whose identity
// changes only when a button's pressed state does (useClickWheel memoizes
// it) — so ambient shell re-renders skip this whole section.
const ControlWheel = memo(function ControlWheel({ wheel }: { wheel: ClickWheel }) {
	const { wheelRef, wheelHandlers, buttonDown, pressed } = wheel;
	const rockClass = {
		menu: " rock-menu",
		next: " rock-next",
		prev: " rock-prev",
		playPause: " rock-play-pause",
		select: "",
	}[pressed ?? "select"] ?? "";

	return (
		<section
			className={`item${rockClass}`}
			id="control-wheel"
			style={{ height: "37.721%", isolation: "isolate", left: "18.3288%", top: "52.1669%", width: "63.3423%", zIndex: 3 }}
			ref={wheelRef as React.RefObject<HTMLElement>}
			{...wheelHandlers}
		>
			{WHEEL_RING}
			<div
				className={`item interactive${pressed === "select" ? " pressed" : ""}`}
				id="mid-button"
				style={{ height: "35%", left: "32.5%", top: "32.5%", width: "35%", zIndex: 3 }}
				onPointerDown={buttonDown("select")}
				// Static vendored artwork, not user input — see VENDORED.md.
				dangerouslySetInnerHTML={{ __html: MID_BUTTON_SVG }}
			/>
			<div
				className={`item interactive${pressed === "menu" ? " pressed" : ""}`}
				id="menu-btn"
				style={{ height: "6.86%", left: "41.61%", opacity: 0.28, top: "5.47%", width: "16.78%", zIndex: 4 }}
				onPointerDown={buttonDown("menu")}
			>
				<img className="shape" src={menuIcon} alt="Menu" draggable={false} />
			</div>
			<div
				className={`item interactive${pressed === "next" ? " pressed" : ""}`}
				id="next-btn"
				style={{ height: "4.63%", left: "84.56%", opacity: 0.28, top: "47.685%", width: "12.16%", zIndex: 5 }}
				onPointerDown={buttonDown("next")}
			>
				<img className="shape" src={nextIcon} alt="Next" draggable={false} />
			</div>
			<div
				className={`item interactive${pressed === "prev" ? " pressed" : ""}`}
				id="prev-btn"
				style={{ height: "4.63%", left: "3%", opacity: 0.28, top: "47.685%", width: "12.16%", zIndex: 6 }}
				onPointerDown={buttonDown("prev")}
			>
				<img className="shape" src={prevIcon} alt="Previous" draggable={false} />
			</div>
			<div
				className={`item interactive${pressed === "playPause" ? " pressed" : ""}`}
				id="play-pause-btn"
				style={{ height: "6.77%", left: "45.53%", opacity: 0.28, top: "89.62%", width: "8.94%", zIndex: 7 }}
				onPointerDown={buttonDown("playPause")}
			>
				<img className="shape" src={playPauseIcon} alt="Play/Pause" draggable={false} />
			</div>
		</section>
	);
});

export function IpodChrome({ wheel, children }: IpodChromeProps) {
	return (
		<div className="ipodDevice">
			{SHELL_DEFS}
			{BASE}
			<section
				className="item"
				id="viewport"
				style={{ height: "42.3756%", isolation: "isolate", left: "8.08625%", top: "0.321027%", width: "91.3747%", zIndex: 4 }}
			>
				<div
					className="item"
					id="screen"
					style={{ height: "88.6364%", left: "0%", opacity: 1, top: "11.3636%", width: "91.7404%", zIndex: 2 }}
				>
					{SCREEN_BEZEL}
					<div id="ipod-screen-content">{children}</div>
				</div>
			</section>
			<ControlWheel wheel={wheel} />
		</div>
	);
}
