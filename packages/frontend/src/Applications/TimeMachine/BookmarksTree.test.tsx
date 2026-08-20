import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BookmarksTree, groupByCategory } from "./BookmarksTree";

afterEach(cleanup);

const globals = [
	{ id: 1, title: "AA11 Impact", full_title: null, start_date: "2001-09-11T12:46:00", category: "General" },
	{ id: 2, title: "Pentagon", full_title: null, start_date: "2001-09-11T13:37:00", category: "Attacks" },
];
const personal = [
	{ id: 10, title: "My moment", category: "General", start_date: "2001-09-11T14:00:00" },
];

const noop = () => {};
const base = {
	loading: false, error: null, tzOffset: -4,
	onJump: noop, onEdit: noop, onDelete: noop,
};

describe("groupByCategory", () => {
	it("puts General first, then alphabetical, treating null/empty as General", () => {
		const groups = groupByCategory([
			{ category: "Zulu" }, { category: null }, { category: "Attacks" }, { category: "" },
		]);
		expect(groups.map((g) => g[0])).toEqual(["General", "Attacks", "Zulu"]);
		expect(groups[0][1]).toHaveLength(2); // null + "" collapse into General
	});
});

describe("BookmarksTree", () => {
	it("groups globals under category branches", () => {
		render(<BookmarksTree {...base} global={globals} personal={[]} signedIn={false} />);
		expect(screen.getByRole("button", { name: /General/ })).not.toBeNull();
		expect(screen.getByRole("button", { name: /Attacks/ })).not.toBeNull();
		expect(screen.getByText("AA11 Impact")).not.toBeNull();
	});

	it("shows a login prompt in Personal when signed out", () => {
		render(<BookmarksTree {...base} global={globals} personal={[]} signedIn={false} />);
		expect(screen.getByText(/Log in to view and create personal bookmarks/i)).not.toBeNull();
	});

	it("renders edit + delete buttons on personal rows and wires them", () => {
		const onEdit = vi.fn();
		const onDelete = vi.fn();
		render(<BookmarksTree {...base} onEdit={onEdit} onDelete={onDelete} global={[]} personal={personal} signedIn />);
		fireEvent.click(screen.getByRole("button", { name: /Edit “My moment”/i }));
		fireEvent.click(screen.getByRole("button", { name: /Delete “My moment”/i }));
		expect(onEdit).toHaveBeenCalledWith(personal[0]);
		expect(onDelete).toHaveBeenCalledWith(personal[0]);
	});

	it("jumps when a bookmark row is clicked", () => {
		const onJump = vi.fn();
		render(<BookmarksTree {...base} onJump={onJump} global={globals} personal={[]} signedIn={false} />);
		fireEvent.click(screen.getByText("AA11 Impact"));
		expect(onJump).toHaveBeenCalledWith("2001-09-11T12:46:00");
	});
});
