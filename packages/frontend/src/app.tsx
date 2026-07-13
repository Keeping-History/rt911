import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import "classicy/dist/classicy.css";
import "maplibre-gl/dist/maplibre-gl.css";
import {
	ClassicyAppManagerProvider,
	ClassicyDesktop,
} from "classicy";
import { DefaultFileSystem } from "./data/DefaultFileSystem";
import { Browser } from "./Applications/Browser/Browser";
import { Feedback } from "./Applications/Feedback/Feedback";
import { FlightTracker } from "./Applications/FlightTracker/FlightTracker";
import { MarketWatch } from "./Applications/MarketWatch/MarketWatch";
import { TimeMachine } from "./Applications/TimeMachine/TimeMachine";
import { News } from "./Applications/News/News";
import { Newsgroups } from "./Applications/Newsgroups/Newsgroups";
import { PagerDecoder } from "./Applications/PagerDecoder/PagerDecoder";
import { RadioScanner } from "./Applications/RadioScanner/RadioScanner";
import { TV } from "./Applications/TV/TV";
import { Weather } from "./Applications/Weather/Weather";
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
			defaultFileSystem={DefaultFileSystem}
			defaultFileSystemMode="exclusive"
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
											"CCTV4",
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
					<TimeMachine />
					<Feedback />
					<FlightTracker />
					<MarketWatch />
					<News />
					<Newsgroups />
					<PagerDecoder />
					<RadioScanner />
					<TV />
					<Weather />
				</ClassicyDesktop>
			</MediaStreamProvider>
		</ClassicyAppManagerProvider>
	</StrictMode>,
);
