import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const windowProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appOpen = vi.hoisted(() => ({ current: true }));

vi.mock("classicy", () => ({
	ClassicyApp: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
		appProps.push(props);
		return <div>{props.children}</div>;
	},
	ClassicyWindow: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
		windowProps.push(props);
		return <div>{props.children}</div>;
	},
	ClassicyIcons: { applications: {} },
	registerClassicyIcons: (icons: Record<string, unknown>) => icons,
	quitMenuItemHelper: () => ({ id: "quit" }),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					Applications: { apps: { "Readme.app": { open: appOpen.current } } },
				},
			},
		}),
}));

const hookCalls = vi.hoisted(() => [] as boolean[]);
vi.mock("./useReadmeArticles", async (importOriginal) => {
	const mod = await importOriginal<typeof import("./useReadmeArticles")>();
	return {
		...mod,
		useReadmeArticles: (enabled: boolean) => {
			hookCalls.push(enabled);
			return {
				articles: [
					{
						id: 1, headline: "Welcome", author: "Robbie Byrd",
						date_created: "2026-07-16T12:00:00", date_updated: null,
						body: "<p>Hello desktop</p>",
					},
				],
				loading: false,
				error: null,
			};
		},
	};
});

import { Readme } from "./README";

afterEach(() => {
	cleanup();
	windowProps.length = 0;
	appProps.length = 0;
	hookCalls.length = 0;
});

describe("Readme", () => {
	it("mounts a Readme.app window with the article content", () => {
		render(<Readme />);
		expect(appProps[0]).toMatchObject({ id: "Readme.app", name: "README", defaultWindow: "readme_main" });
		expect(windowProps[0]).toMatchObject({ id: "readme_main", appId: "Readme.app" });
		expect(screen.getByText("Welcome")).toBeDefined();
		expect(screen.getByText("Hello desktop")).toBeDefined();
	});

	it("passes the app-open state through to the polling hook", () => {
		appOpen.current = false;
		render(<Readme />);
		expect(hookCalls).toEqual([false]);
		appOpen.current = true;
	});
});
