import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../Providers/Auth/stackApi", () => ({
	createStack: vi.fn(),
	updateStack: vi.fn(),
	listMyStacks: vi.fn(),
	getStack: vi.fn(),
}));

import { createStack, getStack, listMyStacks, updateStack } from "../../../Providers/Auth/stackApi";
import { directusStackSaveProvider } from "./directusStackProvider";
import { setStackProviderAuth } from "./stackProviderAuth";

const VALID = { name: "My Stack", cards: [{ id: "c1" }] };

beforeEach(() => {
	vi.clearAllMocks();
	setStackProviderAuth(false);
});

describe("directusStackSaveProvider", () => {
	it("canSave mirrors the auth holder", () => {
		expect(directusStackSaveProvider.canSave()).toBe(false);
		setStackProviderAuth(true);
		expect(directusStackSaveProvider.canSave()).toBe(true);
	});

	it("save creates for non-provider stackIds and updates for saved:directus ids", async () => {
		vi.mocked(createStack).mockResolvedValue({ id: 7, name: "My Stack", definition: VALID, date_updated: null, user_created: "u" });
		await expect(
			directusStackSaveProvider.save(VALID as never, { stackId: "getting-started" }),
		).resolves.toEqual({
			ok: true,
			// The created row's ref lets the host rebind to saved:directus:7 so the
			// next save updates instead of duplicating.
			ref: { id: "7", name: "My Stack", updatedAt: undefined },
		});
		expect(createStack).toHaveBeenCalledWith("My Stack", VALID);

		vi.mocked(updateStack).mockResolvedValue({ id: 7, name: "My Stack", definition: VALID, date_updated: "2026-07-18T17:00:00Z", user_created: "u" });
		await expect(
			directusStackSaveProvider.save(VALID as never, { stackId: "saved:directus:7" }),
		).resolves.toEqual({
			ok: true,
			ref: { id: "7", name: "My Stack", updatedAt: "2026-07-18T17:00:00Z" },
		});
		expect(updateStack).toHaveBeenCalledWith(7, { name: "My Stack", definition: VALID });
	});

	it("save returns {ok:false} instead of rejecting when the API throws", async () => {
		vi.mocked(createStack).mockRejectedValue(new Error("session expired"));
		await expect(
			directusStackSaveProvider.save(VALID as never, { stackId: "x" }),
		).resolves.toEqual({ ok: false, error: "session expired" });
	});

	it("list maps rows to refs and load returns the definition", async () => {
		vi.mocked(listMyStacks).mockResolvedValue([
			{ id: 7, name: "A", date_updated: "2026-07-18T00:00:00Z", user_created: "u" },
		]);
		await expect(directusStackSaveProvider.list?.()).resolves.toEqual([
			{ id: "7", name: "A", updatedAt: "2026-07-18T00:00:00Z" },
		]);
		vi.mocked(getStack).mockResolvedValue({ id: 7, name: "A", definition: VALID, date_updated: null, user_created: "u" });
		await expect(
			directusStackSaveProvider.load?.({ id: "7", name: "A" }),
		).resolves.toEqual(VALID);
	});
});
