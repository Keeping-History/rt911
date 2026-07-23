import "maplibre-gl/dist/maplibre-gl.css";
import { ClassicyButton, ClassicyDesktop, ClassicyWindowFrame } from "classicy";
// Side effect: register the Directus-collection HyperCard extension parts and
// stacks with classicy's HyperCard plugin registries. The HyperCard app itself
// is bundled in classicy and auto-mounted by ClassicyDesktop.
import "./Applications/HyperCard";
import { HyperCardClockBridge } from "./Applications/HyperCard/extensions/HyperCardClockBridge";
import { HyperCardStackAuthBridge } from "./Applications/HyperCard/extensions/stackProviderAuth";
import { Account } from "./Applications/Account/Account";
import { Alerts } from "./Applications/Alerts/Alerts";
import { AlertsManager } from "./Applications/Alerts/AlertsManager";
import { Browser } from "./Applications/Browser/Browser";
import { Feedback } from "./Applications/Feedback/Feedback";
import { FlightTracker } from "./Applications/FlightTracker/FlightTracker";
import { MarketWatch } from "./Applications/MarketWatch/MarketWatch";
import { News } from "./Applications/News/News";
import { Newsgroups } from "./Applications/Newsgroups/Newsgroups";
import { PagerDecoder } from "./Applications/PagerDecoder/PagerDecoder";
import { PlaylistEditor } from "./Applications/PlaylistEditor/PlaylistEditor";
import { Readme } from "./Applications/README/README";
import { RadioScanner } from "./Applications/RadioScanner/RadioScanner";
import { TimeMachine } from "./Applications/TimeMachine/TimeMachine";
import { TV } from "./Applications/TV/TV";
import { Weather } from "./Applications/Weather/Weather";

/**
 * The "power on" screen shown before the boot sequence: an About panel that
 * doubles as a content warning, so nobody reaches the September 11 media
 * without first acknowledging what it is. Rendered by ClassicyDesktop's
 * pre-boot overlay (once per browser-tab session); calling `powerOn`
 * dismisses it and starts the boot chime + startup parade.
 */
function PreBootAbout({ powerOn }: { powerOn: () => void }) {
	return (
		<ClassicyWindowFrame title="9/11 in Realtime" width={560}>
			<h1>About 9/11 in Realtime</h1>
			<p>
				9/11 in Realtime is a multimedia experiment for teachers, with the
				purpose of helping their students truly understand and absorb the
				events of September 11, 2001. We've collected media—video, audio and
				other items—available from the days before and after the September 11
				attacks, synchronized them together and built a tool to help students
				be immersed in the events of the day.
			</p>
			<p>
				<b>
					THE FOLLOWING WEBSITE MAY CONTAIN VISUALS, AUDIO AND OTHER CONTENT
					THAT SOME VIEWERS MAY FIND EXTREMELY DISTURBING.
				</b>
			</p>
			<p>
				<b>
					THIS TOOL IS INTENDED TO BE USED ALONGSIDE A CAREFULLY RESEARCHED AND
					APPROPRIATE CURRICULUM.
				</b>
			</p>
			<p>
				For questions regarding this project, please{" "}
				<a href="mailto:robbiebyrd@keepinghistory.org">email Robbie Byrd</a>.
			</p>
			<div style={{ textAlign: "center" }}>
				<ClassicyButton isDefault onClickFunc={powerOn}>
					POWER ON
				</ClassicyButton>
			</div>
		</ClassicyWindowFrame>
	);
}

/** The desktop branch: the Mac OS 8 desktop and every desktop app. */
export default function Desktop() {
	return (
		<ClassicyDesktop
			preBootScreen={(powerOn) => <PreBootAbout powerOn={powerOn} />}
		>
			<Alerts />
			<AlertsManager />
			<HyperCardClockBridge />
			<HyperCardStackAuthBridge />
			<Browser />
			<TimeMachine />
			<Feedback />
			<Account />
			<PlaylistEditor />
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
