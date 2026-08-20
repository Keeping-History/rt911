import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";

const mockAuth = vi.hoisted(() => ({ status: "anonymous" as string }));
vi.mock("../../Providers/Auth/AuthContext", () => ({ useAuth: () => mockAuth }));

import { useBookmarks } from "./useBookmarks";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function Probe() {
	const b = useBookmarks();
	return (
		<div>
			<span data-testid="loading">{String(b.loading)}</span>
			<span data-testid="global">{b.global.map((g) => g.id).join(",")}</span>
			<span data-testid="personal">{b.personal.map((p) => p.id).join(",")}</span>
			<button type="button" onClick={() => b.addPersonal({ id: 99, title: "X", category: "General", start_date: "2001-09-11T12:00:00" })}>add</button>
			<button type="button" onClick={() => b.removePersonalLocal(99)}>remove</button>
		</div>
	);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { mockAuth.status = "anonymous"; });

describe("useBookmarks", () => {
	it("fetches only globals when signed out", async () => {
		const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			expect(String(url)).toContain("/items/tm_bookmarks?");
			return jsonResponse({ data: [{ id: 1, title: "G1", full_title: null, start_date: "2001-09-11T12:46:00", category: "General" }] });
		});
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
		expect(screen.getByTestId("global").textContent).toBe("1");
		expect(screen.getByTestId("personal").textContent).toBe("");
		// signed-out must NOT hit the personal collection
		expect(f.mock.calls.every((c) => !String(c[0]).includes("tm_bookmarks_personal"))).toBe(true);
	});

	it("fetches personal (serialized) when signed in", async () => {
		mockAuth.status = "signedIn";
		const order: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			const u = String(url);
			order.push(u.includes("_personal") ? "personal" : "global");
			if (u.includes("_personal")) return jsonResponse({ data: [{ id: 7, title: "P1", category: "General", start_date: "2001-09-11T13:00:00" }] });
			return jsonResponse({ data: [{ id: 1, title: "G1", full_title: null, start_date: "2001-09-11T12:46:00", category: "General" }] });
		});
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId("personal").textContent).toBe("7"));
		expect(order).toEqual(["global", "personal"]); // globals resolved before personal started
	});

	it("keeps globals when the personal fetch fails", async () => {
		mockAuth.status = "signedIn";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			const u = String(url);
			if (u.includes("_personal")) return jsonResponse({ error: "no such collection" }, 500);
			return jsonResponse({ data: [{ id: 1, title: "G1", full_title: null, start_date: "2001-09-11T12:46:00", category: "General" }] });
		});
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
		expect(screen.getByTestId("global").textContent).toBe("1");
		expect(screen.getByTestId("personal").textContent).toBe("");
	});

	it("optimistic add/remove mutate personal without refetch", async () => {
		mockAuth.status = "signedIn";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
			String(url).includes("_personal") ? jsonResponse({ data: [] }) : jsonResponse({ data: [] }));
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
		act(() => { screen.getByText("add").click(); });
		expect(screen.getByTestId("personal").textContent).toBe("99");
		act(() => { screen.getByText("remove").click(); });
		expect(screen.getByTestId("personal").textContent).toBe("");
	});
});
