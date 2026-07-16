import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { FC } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the API layer directly — AuthProvider doesn't touch classicy, so no
// classicy mock is needed here (unlike PlaylistProvider.test.tsx).
const fetchMe = vi.fn();
const loginEmail = vi.fn();
const logout = vi.fn();
const providerLoginUrl = vi.fn(
	(provider: string, redirectTo: string) =>
		`https://api.example/auth/login/${provider}?redirect=${encodeURIComponent(redirectTo)}`,
);
vi.mock("./authApi", () => ({
	fetchMe: () => fetchMe(),
	loginEmail: (email: string, password: string) => loginEmail(email, password),
	logout: () => logout(),
	providerLoginUrl: (provider: string, redirectTo: string) => providerLoginUrl(provider, redirectTo),
}));

import { AuthProvider } from "./AuthProvider";
import { useAuth } from "./AuthContext";

const user1 = { id: "u1", email: "t@x.org", first_name: "T", last_name: "X" };

const Probe: FC = () => {
	const { status, user, signInWithEmail, signInWithProvider, signOut } = useAuth();
	return (
		<div>
			<p data-testid="status">{status}</p>
			<p data-testid="email">{user?.email ?? ""}</p>
			<button onClick={() => void signInWithEmail("t@x.org", "pw")}>sign in</button>
			<button onClick={() => signInWithProvider("google")}>sign in google</button>
			<button onClick={() => void signOut()}>sign out</button>
		</div>
	);
};

describe("AuthProvider", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("boots signed in when fetchMe resolves a user", async () => {
		fetchMe.mockResolvedValue(user1);
		const { getByTestId } = render(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
		);
		await waitFor(() => expect(getByTestId("status").textContent).toBe("signedIn"));
		expect(getByTestId("email").textContent).toBe("t@x.org");
	});

	it("boots anonymous when fetchMe resolves null", async () => {
		fetchMe.mockResolvedValue(null);
		const { getByTestId } = render(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
		);
		await waitFor(() => expect(getByTestId("status").textContent).toBe("anonymous"));
		expect(getByTestId("email").textContent).toBe("");
	});

	it("fails open to anonymous when fetchMe throws, and warns", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		fetchMe.mockRejectedValue(new Error("network down"));
		const { getByTestId } = render(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
		);
		await waitFor(() => expect(getByTestId("status").textContent).toBe("anonymous"));
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("signOut flips to anonymous and calls logout", async () => {
		fetchMe.mockResolvedValue(user1);
		logout.mockResolvedValue(undefined);
		const { getByTestId, getByText } = render(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
		);
		await waitFor(() => expect(getByTestId("status").textContent).toBe("signedIn"));
		fireEvent.click(getByText("sign out"));
		await waitFor(() => expect(getByTestId("status").textContent).toBe("anonymous"));
		expect(getByTestId("email").textContent).toBe("");
		expect(logout).toHaveBeenCalledTimes(1);
	});

	it("signInWithEmail calls loginEmail then re-fetches and flips to signedIn", async () => {
		fetchMe.mockResolvedValueOnce(null); // boot: anonymous
		const { getByTestId, getByText } = render(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
		);
		await waitFor(() => expect(getByTestId("status").textContent).toBe("anonymous"));

		loginEmail.mockResolvedValue(undefined);
		fetchMe.mockResolvedValueOnce(user1); // post-login refresh
		fireEvent.click(getByText("sign in"));

		await waitFor(() => expect(getByTestId("status").textContent).toBe("signedIn"));
		expect(loginEmail).toHaveBeenCalledWith("t@x.org", "pw");
		expect(getByTestId("email").textContent).toBe("t@x.org");
	});

	it("signInWithEmail rethrows loginEmail's error and leaves status unchanged", async () => {
		// Start SIGNED IN (not the default anonymous) so "status unchanged" is a
		// meaningful assertion: if a bug swallowed the rejection and ran
		// refresh() anyway, or corrupted status in a catch branch, this would
		// visibly flip away from "signedIn" instead of trivially staying at
		// whatever the boot default already was.
		fetchMe.mockResolvedValue(user1);

		// Single provider instance exposes both the status probe AND the
		// signInWithEmail trigger, so the query and the exercised instance are
		// provably the same DOM tree (getByTestId binds to document.body, which
		// only ever contains one instance's markup here).
		let caught: unknown;
		const ProbeWithSignIn: FC = () => {
			const { status, signInWithEmail } = useAuth();
			return (
				<div>
					<p data-testid="status">{status}</p>
					<button
						onClick={() => {
							signInWithEmail("t@x.org", "wrong").catch((e) => {
								caught = e;
							});
						}}
					>
						attempt sign in
					</button>
				</div>
			);
		};

		const { getByTestId, getByText } = render(
			<AuthProvider>
				<ProbeWithSignIn />
			</AuthProvider>,
		);
		await waitFor(() => expect(getByTestId("status").textContent).toBe("signedIn"));

		loginEmail.mockRejectedValue(new Error("Invalid user credentials."));
		fireEvent.click(getByText("attempt sign in"));

		await waitFor(() => expect(caught).toBeInstanceOf(Error));
		expect(getByTestId("status").textContent).toBe("signedIn");
	});

	it("signInWithProvider navigates to the provider login URL, stripping query strings from the redirect", async () => {
		fetchMe.mockResolvedValue(null);
		const assignSpy = vi.fn();
		const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
		// Mock window.location with both origin and href; set href to include a query
		// string to prove that signInWithProvider strips it and uses bare origin instead.
		Object.defineProperty(window, "location", {
			value: {
				...window.location,
				assign: assignSpy,
				href: "https://beta.911realtime.org/?reason=denied",
				origin: "https://beta.911realtime.org",
			},
			writable: true,
			configurable: true,
		});
		try {
			const { getByTestId, getByText } = render(
				<AuthProvider>
					<Probe />
				</AuthProvider>,
			);
			await waitFor(() => expect(getByTestId("status").textContent).toBe("anonymous"));
			fireEvent.click(getByText("sign in google"));
			// Verify providerLoginUrl receives the bare origin + "/", not the full href
			// with query string—this is the key assertion that proves the fix works.
			expect(providerLoginUrl).toHaveBeenCalledWith("google", "https://beta.911realtime.org/");
			expect(assignSpy).toHaveBeenCalledWith(
				"https://api.example/auth/login/google?redirect=" +
					encodeURIComponent("https://beta.911realtime.org/"),
			);
		} finally {
			// Restore the real window.location so later tests (and test-order
			// changes) can't be poisoned by this replacement.
			if (originalLocation) Object.defineProperty(window, "location", originalLocation);
		}
	});
});
