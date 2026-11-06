import { registerClassicyIcons } from "@classicy/classicy";
import cc from "./epgIcons/cc.png";
import esp from "./epgIcons/esp.png";
import mpaaG from "./epgIcons/mpaa-g.png";
import mpaaNc17 from "./epgIcons/mpaa-nc17.png";
import mpaaPg from "./epgIcons/mpaa-pg.png";
import mpaaPg13 from "./epgIcons/mpaa-pg13.png";
import mpaaR from "./epgIcons/mpaa-r.png";
import mpaaUnrated from "./epgIcons/mpaa-unrated.png";
import tv14 from "./epgIcons/tv-14.png";
import tvG from "./epgIcons/tv-g.png";
import tvMa from "./epgIcons/tv-ma.png";
import tvPg from "./epgIcons/tv-pg.png";
import tvY from "./epgIcons/tv-y.png";
import tvY7 from "./epgIcons/tv-y7.png";
import tv from "./epgIcons/tv.png";
import ant1 from "./epgIcons/channels/ant1.png";
import azt from "./epgIcons/channels/azt.png";
import bbc from "./epgIcons/channels/bbc.png";
import bet from "./epgIcons/channels/bet.png";
import cbs from "./epgIcons/channels/cbs.png";
import cctv4 from "./epgIcons/channels/cctv4.png";
import cnn from "./epgIcons/channels/cnn.png";
import glvsn from "./epgIcons/channels/glvsn.png";
import iraq from "./epgIcons/channels/iraq.png";
import mcm from "./epgIcons/channels/mcm.png";
import msnbc from "./epgIcons/channels/msnbc.png";
import newsw from "./epgIcons/channels/newsw.png";
import newsworld from "./epgIcons/channels/newsworld.png";
import nhk from "./epgIcons/channels/nhk.png";
import ntv from "./epgIcons/channels/ntv.png";
import psc from "./epgIcons/channels/psc.png";
import tcn from "./epgIcons/channels/tcn.png";
import weta from "./epgIcons/channels/weta.png";
import wjla from "./epgIcons/channels/wjla.png";
import wnyw from "./epgIcons/channels/wnyw.png";
import worldnet from "./epgIcons/channels/worldnet.png";
import wrc from "./epgIcons/channels/wrc.png";
import wsbk from "./epgIcons/channels/wsbk.png";
import wttg from "./epgIcons/channels/wttg.png";
import wusa from "./epgIcons/channels/wusa.png";

/**
 * The EPG icon set (moved out of classicy: it is product-lineup-specific, not
 * desktop chrome), registered into Classicy's icon registry at
 * `applications.epg` and exported as `epgIcons`, the ONE object consumers read
 * them from. Classicy 3's `ClassicyIcons` constant is a snapshot of the
 * shipped tree that never shows registrations, so the old address
 * (`ClassicyIcons.applications.epg`) is `undefined` there; read `epgIcons`, or
 * `resolveClassicyAsset("icons", "applications.epg.<key>")` for a single
 * leaf. `EPGProgram.icons[]` entries in
 * the guide JSON index the flat keys (cc/esp/ratings badges) and
 * `EPGChannel.icon` indexes `channels` (lowercase station slugs).
 *
 * The shape consumers cast the namespace to lives in `EpgIconNamespace` below.
 *
 * Known data quirk: the CCTV channel's canonical slug is `cctv4` (CCTV
 * International) but the IA archive used CCTV3 identifiers, so its stream
 * path and older guide data still say `cctv3` — that key stays as an alias
 * for the same CCTV-4 artwork.
 */
export type EpgIconNamespace = Record<string, string> & {
	channels: Record<string, string>;
};

// registerClassicyIcons deep-merges and returns its argument, so this touches
// nothing else in the tree and hands back the registered namespace. The cast
// widens it to EpgIconNamespace, whose index signature lets guide JSON keys
// index the flat badges.
export const epgIcons = registerClassicyIcons({
	applications: {
		epg: {
			app: tv,
			cc, esp, mpaaG, mpaaNc17, mpaaPg, mpaaPg13, mpaaR, mpaaUnrated,
			tv14, tvG, tvMa, tvPg, tvY, tvY7, tv,
			channels: {
				ant1, azt, bbc, bet, cbs, cctv4, cctv3: cctv4, cnn, glvsn, iraq,
				mcm, msnbc, newsw, newsworld, nhk, ntv, psc, tcn, weta, wjla,
				wnyw, worldnet, wrc, wsbk, wttg, wusa,
			},
		},
	},
}).applications.epg as unknown as EpgIconNamespace;
