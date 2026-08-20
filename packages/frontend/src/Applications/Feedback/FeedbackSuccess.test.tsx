import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackSuccess } from "./FeedbackSuccess";

afterEach(cleanup);

describe("FeedbackSuccess", () => {
	it("renders a link to the created issue", () => {
		render(
			<FeedbackSuccess
				issueUrl="https://github.com/Keeping-History/rt911/issues/42"
				onReset={vi.fn()}
			/>,
		);
		const link = screen.getByRole("link");
		expect(link.getAttribute("href")).toBe(
			"https://github.com/Keeping-History/rt911/issues/42",
		);
	});

	it("calls onReset when Send Another button is clicked", () => {
		const onReset = vi.fn();
		render(
			<FeedbackSuccess
				issueUrl="https://github.com/Keeping-History/rt911/issues/42"
				onReset={onReset}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /send another/i }));
		expect(onReset).toHaveBeenCalledOnce();
	});
});
