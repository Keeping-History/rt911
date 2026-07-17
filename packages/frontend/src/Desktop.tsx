import "maplibre-gl/dist/maplibre-gl.css";
import { ClassicyDesktop } from "classicy";
// Side effect: register the Directus-collection HyperCard extension parts and
// stacks with classicy's HyperCard plugin registries. The HyperCard app itself
// is bundled in classicy and auto-mounted by ClassicyDesktop.
import "./Applications/HyperCard";
import { Account } from "./Applications/Account/Account";
import { Browser } from "./Applications/Browser/Browser";
import { Feedback } from "./Applications/Feedback/Feedback";
import { FlightTracker } from "./Applications/FlightTracker/FlightTracker";
import { MarketWatch } from "./Applications/MarketWatch/MarketWatch";
import { News } from "./Applications/News/News";
import { Newsgroups } from "./Applications/Newsgroups/Newsgroups";
import { PagerDecoder } from "./Applications/PagerDecoder/PagerDecoder";
import { Readme } from "./Applications/README/README";
import { RadioScanner } from "./Applications/RadioScanner/RadioScanner";
import { TimeMachine } from "./Applications/TimeMachine/TimeMachine";
import { TV } from "./Applications/TV/TV";
import { Weather } from "./Applications/Weather/Weather";

/** The desktop branch: the Mac OS 8 desktop and every desktop app. */
export default function Desktop() {
	return (
		<ClassicyDesktop>
			<Browser />
			<TimeMachine />
			<Feedback />
			<Account />
			<FlightTracker />
			<MarketWatch />
			<News />
			<Newsgroups />
			<PagerDecoder />
			<Readme />
			<RadioScanner />
			<TV />
			<Weather />
		</ClassicyDesktop>
	);
}
