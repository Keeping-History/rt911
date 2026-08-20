/**
 * The Directus-backed HyperCard save destination: signed-in users save stacks
 * to the `stacks` collection (own rows only) and reopen them via File → Open
 * Saved Stack. Contract notes (classicy save-provider seam): save() must
 * RESOLVE {ok:false} on failure — never reject; meta.stackId of
 * "saved:directus:<id>" means the open stack came from this provider, so save
 * updates that row instead of creating a new one.
 */
import type { HCSavedStackRef, HCStack, HyperCardSaveProvider } from "classicy";
import { registerHyperCardSaveProvider } from "classicy";
import {
	createStack,
	getStack,
	listMyStacks,
	updateStack,
} from "../../../Providers/Auth/stackApi";
import { isStackProviderSignedIn } from "./stackProviderAuth";

const SAVED_ID = /^saved:directus:(\d+)$/;

export const directusStackSaveProvider: HyperCardSaveProvider = {
	id: "directus",
	label: "911realtime",
	canSave: () => isStackProviderSignedIn(),
	save: async (stack: HCStack, meta: { stackId: string }) => {
		try {
			const match = SAVED_ID.exec(meta.stackId);
			// Return the saved row's ref either way: after a first-time create the
			// host rebinds the open stack to saved:directus:<id>, so the next save
			// updates that row instead of creating a duplicate.
			const record = match
				? await updateStack(Number(match[1]), { name: stack.name, definition: stack })
				: await createStack(stack.name, stack);
			return {
				ok: true,
				ref: {
					id: String(record.id),
					name: record.name,
					updatedAt: record.date_updated ?? undefined,
				},
			} as const;
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			} as const;
		}
	},
	list: async (): Promise<HCSavedStackRef[]> => {
		const rows = await listMyStacks();
		return rows.map((row) => ({
			id: String(row.id),
			name: row.name,
			updatedAt: row.date_updated ?? undefined,
		}));
	},
	load: async (ref: HCSavedStackRef): Promise<HCStack> => {
		const record = await getStack(Number(ref.id));
		return record.definition as HCStack;
	},
};

export function registerDirectusStackProvider(): void {
	registerHyperCardSaveProvider(directusStackSaveProvider);
}
