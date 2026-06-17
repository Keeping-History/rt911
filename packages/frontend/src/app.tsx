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
import { Demo } from "./Applications/Demo/Demo";
import { EPG } from "./Applications/EPG/EPG";
import { News } from "./Applications/News/News";
import { Newsgroups } from "./Applications/Newsgroups/Newsgroups";
import { PagerDecoder } from "./Applications/PagerDecoder/PagerDecoder";
import { RadioScanner } from "./Applications/RadioScanner/RadioScanner";
import { TV } from "./Applications/TV/TV";
import { MediaStreamProvider } from "./Providers/MediaStream/MediaStreamProvider";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");
createRoot(rootElement).render(
	<StrictMode>
		<ClassicyAppManagerProvider>
			<MediaStreamProvider>
				<ClassicyDesktop>
					<Browser />
					<Controls />
					<Demo />
					<SimpleText />
					<EPG />
					<News />
					<Newsgroups />
					<PagerDecoder />
					<RadioScanner />
					<TV />
					<Controls />
				</ClassicyDesktop>
			</MediaStreamProvider>
		</ClassicyAppManagerProvider>
	</StrictMode>,
);
