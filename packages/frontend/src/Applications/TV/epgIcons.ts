import { ClassicyIcons, registerClassicyIcons } from "classicy";
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
import cctv3 from "./epgIcons/channels/cctv3.png";
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
 * The EPG icon set, moved out of classicy: everything here is specific to this
 * product's TV lineup and guide data, not to the desktop chrome. Key names
 * match the guide JSON — `EPGProgram.icons[]` entries index EPG_ICONS
 * (closed-captioning, language, and ratings badges) and `EPGChannel.icon`
 * indexes CHANNEL_LOGOS (lowercase station slugs).
 */
export const EPG_ICONS: Record<string, string> = {
	app: tv,
	cc, esp, mpaaG, mpaaNc17, mpaaPg, mpaaPg13, mpaaR, mpaaUnrated,
	tv14, tvG, tvMa, tvPg, tvY, tvY7, tv,
};

/**
 * TV station logos, keyed by lowercase channel slug.
 *
 * Known data quirk: the CCTV channel's canonical slug is `cctv4` (CCTV
 * International) but its stream, EPG icon key, and this artwork all still say
 * `cctv3` — the IA archive's identifier. The artwork really is CCTV-3's logo;
 * swapping in true CCTV-4 art is tracked separately.
 */
export const CHANNEL_LOGOS: Record<string, string> = {
	ant1, azt, bbc, bet, cbs, cctv3, cnn, glvsn, iraq, mcm, msnbc, newsw,
	newsworld, nhk, ntv, psc, tcn, weta, wjla, wnyw, worldnet, wrc, wsbk,
	wttg, wusa,
};

// Re-injected at ClassicyIcons.applications.epg so generic classicy consumers
// keep finding the set at its historical address. registerClassicyIcons
// assigns shallowly at the TOP level only, so the applications namespace must
// be spread in — dropping that spread would clobber classicy's bundled app
// icons and other apps' registrations. The epg namespace itself is replaced
// wholesale: this module now owns every key in it.
registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		epg: { ...EPG_ICONS, channels: CHANNEL_LOGOS },
	},
});
