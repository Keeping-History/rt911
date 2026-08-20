import {
	ClassicyFileSystemEntryFileType,
	ClassicyIcons,
	type ClassicyFileSystemTree,
} from "classicy";

const VOICES_BASE_URL = "https://files.911realtime.org/videos/voices-of-911";

// "Voices of 9.11" personal video testimonies (recorded 2002–2003), from the
// September 11 Digital Archive collection 267
// (https://911digitalarchive.org/collections/show/267), uploaded to Wasabi
// under videos/voices-of-911/. Display names are the archive's item titles
// with the trailing " W.mov" artifact removed, paired with byte sizes.
const VOICES_OF_911: [originalFilename: string, displayName: string, size: number][] = [
	["carl-mahnken.mp4", "Carl Mahnken.mp4", 122557699],
	["cindy-beazee.mp4", "Cindy Beazee.mp4", 71573334],
	["connie-lindenauer.mp4", "Connie Lindenauer.mp4", 57977780],
	["denton-tillman.mp4", "Denton Tillman.mp4", 70419115],
	["donn-marshall.mp4", "Donn Marshall.mp4", 233227604],
	["genie-norris.mp4", "Genie Norris.mp4", 73368183],
	["james-boyle.mp4", "James Boyle.mp4", 130935283],
	["jennifer-gass.mp4", "Jennifer Gass.mp4", 239141468],
	["joan-goldsmith.mp4", "Joan Goldsmith.mp4", 92481544],
	["kathy-greenwell.mp4", "Kathy Greenwell.mp4", 156555899],
	["louise-rosche-micciulla.mp4", "Louise Rosche-Micciulla.mp4", 53708936],
	["marie-keese.mp4", "Marie Keese.mp4", 63699554],
	["martha-davis.mp4", "Martha Davis.mp4", 39514740],
	["michael-flutie.mp4", "Michael Flutie.mp4", 64985057],
	["michael-westcott.mp4", "Michael Westcott.mp4", 190263487],
	["paul-j-q-lee.mp4", "Paul J Q Lee.mp4", 107229843],
	["robin-sacknoff.mp4", "Robin Sacknoff.mp4", 38529962],
	["samuel-young.mp4", "Samuel Young.mp4", 146730712],
	["tanya-edwards.mp4", "Tanya Edwards.mp4", 100143777],
	["tinka-markham-piper.mp4", "Tinka Markham Piper.mp4", 123705426],
];

export const voicesOf911Entries: ClassicyFileSystemTree = Object.fromEntries(
	VOICES_OF_911.map(([originalFilename, displayName, size]) => [
		displayName,
		{
			_type: ClassicyFileSystemEntryFileType.Video,
			_mimeType: "video/mp4",
			_icon: ClassicyIcons.system.quicktime.movie,
			_url: `${VOICES_BASE_URL}/${originalFilename}`,
			_size: size,
		},
	]),
);
