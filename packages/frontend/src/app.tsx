import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import "classicy/dist/classicy.css";
import {
	ClassicyAppManagerProvider,
	ClassicyDesktop,
	SimpleText,
} from "classicy";
import { Browser } from "./Applications/Browser/Browser";
import { Controls } from "./Applications/Controls/Controls";
import { News } from "./Applications/News/News";
import { Newsgroups } from "./Applications/Newsgroups/Newsgroups";
import { PagerDecoder } from "./Applications/PagerDecoder/PagerDecoder";
import { RadioScanner } from "./Applications/RadioScanner/RadioScanner";
import { TV } from "./Applications/TV/TV";
import { MobileBlocker } from "./MobileBlocker";
import { MediaStreamProvider } from "./Providers/MediaStream/MediaStreamProvider";
import { initTracker } from "./openreplay";

initTracker();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");
createRoot(rootElement).render(
	<StrictMode>
		<ClassicyAppManagerProvider
			gaMeasurementIds={["G-YV25XK2Y3R"]}
			defaultState={{
				System: {
					Manager: {
						DateAndTime: {
							// Boot the desktop clock at 8:40 AM US Eastern on
							// 2001-09-11 (EDT, UTC-4 → 12:40 UTC). Seed-only: applies
							// on a fresh visit; persisted state wins on reload.
							dateTime: "2001-09-11T12:40:00.000Z",
							timeZoneOffset: "-4",
						},
						Applications: {
							apps: {
								"TV.app": {
									data: {
										// Hide lower-priority / non-US channels by default.
										// Users can re-enable any of these via TV Settings.
										disabledChannels: [
											"ANT1",
											"AZT",
											"BET",
											"CCTV3",
											"IRAQ",
											"MCM",
											"MSNBC",
											"PSC",
											"WETA",
										],
									},
								},
							},
						},
					},
				},
			}}
		>
			<MediaStreamProvider>
				<ClassicyDesktop>
					<MobileBlocker />
					<Browser />
					<Controls />
					<SimpleText />
					<News />
					<Newsgroups />
					<PagerDecoder />
					<RadioScanner />
					<TV />
				</ClassicyDesktop>
			</MediaStreamProvider>
		</ClassicyAppManagerProvider>
	</StrictMode>,
);
