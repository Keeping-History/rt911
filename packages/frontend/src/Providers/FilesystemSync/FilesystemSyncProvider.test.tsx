import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const reconcileWithAdapters = vi.fn();
const load = vi.fn();
const snapshot = vi.fn(() => JSON.stringify({ "Macintosh HD": { _type: "directory" } }));
const dispatch = vi.fn();
vi.mock("classicy", () => ({
	useClassicyFileSystem: () => ({ reconcileWithAdapters, load, snapshot }),
	dispatch: (...a: unknown[]) => dispatch(...a),
}));

const authState: { status: string; user: unknown } = { status: "loading", user: null };
vi.mock("../Auth/AuthContext", () => ({ useAuth: () => authState }));

const setSyncUser = vi.fn();
const pushCurrentTree = vi.fn().mockResolvedValue(undefined);
vi.mock("./directusFilesystemAdapter", () => ({
	setSyncUser: (...a: unknown[]) => setSyncUser(...a),
	pushCurrentTree: (...a: unknown[]) => pushCurrentTree(...a),
}));

let registeredHook: (() => Promise<void> | void) | null = null;
vi.mock("../Auth/beforeSignOut", () => ({
	registerBeforeSignOut: (fn: () => Promise<void> | void) => {
		registeredHook = fn;
		return () => { registeredHook = null; };
	},
}));

vi.mock("../../data/DefaultFileSystem", () => ({ DefaultFileSystem: { "Macintosh HD": { _type: "drive" } } }));

import { FilesystemSyncProvider } from "./FilesystemSyncProvider";

const user = { id: "u1", email: "a@b.c" };

const rerenderWith = (status: string, u: unknown) => {
	authState.status = status;
	authState.user = u;
	return render(
		<FilesystemSyncProvider>
			<div>child</div>
		</FilesystemSyncProvider>,
	);
};

beforeEach(() => {
	vi.clearAllMocks();
	authState.status = "loading";
	authState.user = null;
	registeredHook = null;
});
afterEach(cleanup);

describe("FilesystemSyncProvider", () => {
	it("mirrors the user into the adapter and renders children", () => {
		const { getByText } = rerenderWith("signedIn", user);
		expect(setSyncUser).toHaveBeenCalledWith(user);
		expect(getByText("child")).toBeTruthy();
	});

	it("on login with a remote tree, reconciles and bumps the desktop", async () => {
		reconcileWithAdapters.mockResolvedValue(true);
		await act(async () => {
			rerenderWith("signedIn", user);
		});
		expect(reconcileWithAdapters).toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalledWith({ type: "ClassicyDesktopFileSystemVersionBump" });
		expect(pushCurrentTree).not.toHaveBeenCalled();
	});

	it("on first login with no remote tree, seeds the account from the local desktop", async () => {
		reconcileWithAdapters.mockResolvedValue(false);
		await act(async () => {
			rerenderWith("signedIn", user);
		});
		expect(pushCurrentTree).toHaveBeenCalledTimes(1);
	});

	it("registers a pre-sign-out flush that pushes the current tree", async () => {
		rerenderWith("signedIn", user);
		expect(registeredHook).toBeTypeOf("function");
		await act(async () => {
			await registeredHook?.();
		});
		expect(pushCurrentTree).toHaveBeenCalled();
	});
});
