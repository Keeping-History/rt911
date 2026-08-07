import {
	ClassicyFileSystemEntryFileType,
	ClassicyIcons,
	type ClassicyFileSystemTree,
} from "classicy";
import {newspaperEntries} from "./NewspaperFiles";
import {photoEntries} from "./PhotoFiles"

// HyperCard stack documents ship in public/stacks/ and are served by the
// frontend itself (not Wasabi). Their URLs must respect Vite's configured base:
// production serves from the domain root (base "/"), but the PR-preview build
// (`vite build --base=./`) is served from a subpath, where an absolute "/stacks/…"
// URL would 404. Prefixing with import.meta.env.BASE_URL keeps prod/dev/test
// identical ("/stacks/…") while making the preview resolve relative to its subpath.
const stackUrl = (filename: string): string =>
	`${import.meta.env.BASE_URL}stacks/${filename}`;

export const DefaultFileSystem: ClassicyFileSystemTree = {
	"Macintosh HD": {
		_type: ClassicyFileSystemEntryFileType.Drive,
		_icon: ClassicyIcons.system.drives.disk,
		"System Folder": {
			_type: ClassicyFileSystemEntryFileType.Directory,
			_icon: ClassicyIcons.system.folders.directory,
			"Finder": {
				_type: ClassicyFileSystemEntryFileType.File,
				_icon: ClassicyIcons.system.macos,
				_system: true,
			},
		},
		// The interactive user-guide tour, served from public/stacks/. Finder
		// routes Stack-type files to HyperCard via its handlesFileTypes
		// registration — double-clicking this opens the guide in HyperCard.
		"Getting Started.stack": {
			_type: ClassicyFileSystemEntryFileType.Stack,
			_mimeType: "application/json",
			_icon: ClassicyIcons.system.files.document,
			_url: stackUrl("getting-started.stack.json"),
			_size: 21169,
		},
		// The Oregon Trail — a classic Apple II / MECC educational game rebuilt as
		// a portable HyperCard JSON stack (outfit a wagon, then manage food, health
		// and money across the 1848 trail to Oregon). Same Stack-type Finder routing
		// as Getting Started: double-clicking opens it in HyperCard.
		"The Oregon Trail.stack": {
			_type: ClassicyFileSystemEntryFileType.Stack,
			_mimeType: "application/json",
			_icon: ClassicyIcons.system.files.document,
			_url: stackUrl("oregon-trail.stack.json"),
			_size: 130901,
		},
		// The present-day CMS pages, as web shortcuts. These open in a real
		// browser tab rather than the in-desktop viewer: they are current
		// content to be read, printed and shared, and the desktop (and the
		// replay running on it) survives untouched in the original tab.
		"Press Room": {
			_type: ClassicyFileSystemEntryFileType.Shortcut,
			_icon: ClassicyIcons.applications.internetExplorer.documentShortcut,
			_url: "/press",
			_openIn: "browser-new",
		},
		"For Teachers": {
			_type: ClassicyFileSystemEntryFileType.Shortcut,
			_icon: ClassicyIcons.applications.internetExplorer.documentShortcut,
			_url: "/teachers",
			_openIn: "browser-new",
		},
		Documents: {
			_type: ClassicyFileSystemEntryFileType.Directory,
			_icon: ClassicyIcons.system.folders.directory,
			Newspapers: {
				_type: ClassicyFileSystemEntryFileType.Directory,
				_icon: ClassicyIcons.system.folders.directory,
				"September 11": {
					_type: ClassicyFileSystemEntryFileType.Directory,
					_icon: ClassicyIcons.system.folders.directory,
					...newspaperEntries,
				},
			},
			Photos: {
				_type: ClassicyFileSystemEntryFileType.Directory,
				_icon: ClassicyIcons.system.folders.directory,
				...photoEntries,
			},
		},
	},
};
