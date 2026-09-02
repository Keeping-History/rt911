import type { ClassicyFileSystemSeedMigration } from "classicy";

// One-time corrections for content that shipped with a typo/error in
// DefaultFileSystem.ts and is now baked into returning visitors' persisted
// localStorage trees. Fixing DefaultFileSystem.ts itself only ever reaches a
// fresh visitor — see ClassicyFileSystemSeedMigrations.ts in classicy for why.
export const defaultFileSystemSeedMigrations: ClassicyFileSystemSeedMigration[] =
	[
		{
			op: "rename",
			from: "Macintosh HD:Documents:Newspapers:September 11",
			to: "Macintosh HD:Documents:Newspapers:September 12",
		},
	];
