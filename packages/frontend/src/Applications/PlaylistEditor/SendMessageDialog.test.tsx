import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SendMessageDialogForm } from "./SendMessageDialog";

afterEach(cleanup);

describe("SendMessageDialogForm", () => {
	it("sends the trimmed message", () => {
		const onSend = vi.fn();
		render(<SendMessageDialogForm onSend={onSend} onCancel={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("Message"), {
			target: { value: "  Look at channel 4  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend).toHaveBeenCalledWith("Look at channel 4");
	});

	// A blank note would pop an empty box on every student's desktop.
	it("refuses to send a blank message", () => {
		const onSend = vi.fn();
		render(<SendMessageDialogForm onSend={onSend} onCancel={vi.fn()} />);

		const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		fireEvent.click(send);

		fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
		fireEvent.click(send);

		expect(onSend).not.toHaveBeenCalled();
	});

	it("cancels without sending", () => {
		const onSend = vi.fn();
		const onCancel = vi.fn();
		render(<SendMessageDialogForm onSend={onSend} onCancel={onCancel} />);

		fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onCancel).toHaveBeenCalled();
		expect(onSend).not.toHaveBeenCalled();
	});
});
