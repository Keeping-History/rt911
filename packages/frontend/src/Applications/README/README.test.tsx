import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const windowProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const dispatched = vi.hoisted(() => [] as Array<Record<string, unknown>>);
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
	ClassicyButton: (props: { children?: React.ReactNode; onClickFunc?: () => void }) => (
		<button type="button" onClick={props.onClickFunc}>{props.children}</button>
	),
	ClassicyCheckbox: (props: { id: string; label: string; checked: boolean; onClickFunc: (c: boolean) => void }) => (
		<label>
			<input
				type="checkbox"
				checked={props.checked}
				onChange={(e) => props.onClickFunc(e.target.checked)}
			/>
			{props.label}
		</label>
	),
	ClassicyControlGroup: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	ClassicyIcons: { applications: {} },
	registerClassicyIcons: (icons: Record<string, unknown>) => icons,
	registerAppEventHandler: () => {},
	quitMenuItemHelper: () => ({ id: "quit" }),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					Applications: { apps: { "Readme.app": { open: appOpen.current, data: undefined } } },
				},
			},
		}),
	useAppManagerDispatch: () => (action: Record<string, unknown>) => {
		dispatched.push(action);
	},
}));

vi.mock("./useReadmeArticles", async (importOriginal) => {
	const mod = await importOriginal<typeof import("./useReadmeArticles")>();
	return {
		...mod,
		useReadmeArticles: () => ({
			articles: [
				{
					id: 1, headline: "Welcome", author: "Robbie Byrd",
					date_created: "2026-07-16T12:00:00", date_updated: null,
					body: "<p>Hello desktop</p>", sort: null, featured: false,
					tags: [{ id: 5, name: "Announcement", color: "#cc3333" }],
				},
			],
			loading: false,
			error: null,
		}),
	};
});

import { Readme } from "./README";

afterEach(() => {
	cleanup();
	windowProps.length = 0;
	appProps.length = 0;
	dispatched.length = 0;
	appOpen.current = true;
});

function fileSettingsItem() {
	const menu = windowProps[0].appMenu as Array<{ id: string; menuChildren: Array<{ id: string; title: string; onClickFunc?: () => void }> }>;
	const file = menu.find((m) => m.id === "file");
	return file?.menuChildren.find((c) => c.id === "settings");
}

describe("Readme", () => {
	it("mounts a Readme.app window with the article content", () => {
		render(<Readme />);
		expect(appProps[0]).toMatchObject({ id: "Readme.app", name: "README", defaultWindow: "readme_main" });
		expect(windowProps[0]).toMatchObject({ id: "readme_main", appId: "Readme.app" });
		expect(screen.getAllByText("Welcome").length).toBeGreaterThan(0);
		expect(screen.getByText("Hello desktop")).toBeDefined();
	});

	it("offers a File → Settings… menu item", () => {
		render(<Readme />);
		expect(fileSettingsItem()?.title).toBe("Settings…");
	});

	it("opens a settings window listing a checkbox per tag", () => {
		render(<Readme />);
		// No settings window yet → no checkboxes (the pills are plain spans).
		expect(screen.queryAllByRole("checkbox").length).toBe(0);
		act(() => fileSettingsItem()?.onClickFunc?.());
		// One checkbox per tag from the mocked feed (just "Announcement").
		expect(screen.getAllByRole("checkbox").length).toBe(1);
		// And its label is the tag name (appears here plus in the pills → ≥1).
		expect(screen.getAllByText("Announcement").length).toBeGreaterThan(0);
	});

	it("unchecks a tag and dispatches the pruned filter on Save", () => {
		render(<Readme />);
		act(() => fileSettingsItem()?.onClickFunc?.());
		// The only tag (Announcement, id 5) starts checked (visible).
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
		// Unchecking marks id 5 hidden; Save dispatches the persisted filter.
		fireEvent.click(checkbox);
		fireEvent.click(screen.getByText("Save"));
		expect(dispatched).toContainEqual({
			type: "ClassicyAppReadmeSetSettings",
			settings: { hiddenTagIds: [5] },
		});
	});
});
