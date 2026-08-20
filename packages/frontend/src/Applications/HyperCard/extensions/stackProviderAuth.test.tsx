import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthContext } from "../../../Providers/Auth/AuthContext";
import {
	HyperCardStackAuthBridge,
	isStackProviderSignedIn,
	setStackProviderAuth,
} from "./stackProviderAuth";

afterEach(cleanup);
afterEach(() => setStackProviderAuth(false));

const authValue = (status: "signedIn" | "anonymous") => ({
	status,
	user: null,
	signInWithEmail: async () => {},
	signInWithProvider: () => {},
	signOut: async () => {},
	refresh: async () => {},
	register: async () => {},
});

describe("HyperCardStackAuthBridge", () => {
	it("mirrors signed-in status into the module holder and resets on unmount", () => {
		expect(isStackProviderSignedIn()).toBe(false);
		const { rerender, unmount } = render(
			<AuthContext.Provider value={authValue("signedIn")}>
				<HyperCardStackAuthBridge />
			</AuthContext.Provider>,
		);
		expect(isStackProviderSignedIn()).toBe(true);
		rerender(
			<AuthContext.Provider value={authValue("anonymous")}>
				<HyperCardStackAuthBridge />
			</AuthContext.Provider>,
		);
		expect(isStackProviderSignedIn()).toBe(false);
		unmount();
		expect(isStackProviderSignedIn()).toBe(false);
	});
});
