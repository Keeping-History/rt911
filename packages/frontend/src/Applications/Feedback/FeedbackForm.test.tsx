import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeedbackFields } from "./useFeedback";
import { FeedbackForm } from "./FeedbackForm";

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

// Suppress classicy's analytics no-provider warning — expected in test environment
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });

function fillRequired() {
    fireEvent.change(screen.getByLabelText("Name"),        { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("Email"),       { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText("Title"),       { target: { value: "Bug report" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Something broke" } });
}

const noop = vi.fn();

describe("FeedbackForm", () => {
    it("submit button is disabled when required fields are empty", () => {
        render(<FeedbackForm onSubmit={noop} submitting={false} error={null} onCaptureScreenshot={noop} />);
        expect((screen.getByRole("button", { name: /send feedback/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("submit button is enabled when all required fields are filled", () => {
        render(<FeedbackForm onSubmit={noop} submitting={false} error={null} onCaptureScreenshot={noop} />);
        fillRequired();
        expect((screen.getByRole("button", { name: /send feedback/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("submit button shows 'Sending…' and is disabled while submitting", () => {
        render(<FeedbackForm onSubmit={noop} submitting={true} error={null} onCaptureScreenshot={noop} />);
        const btn = screen.getByRole("button", { name: /sending/i }) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });

    it("calls onSubmit with form fields and empty attachments on submit", async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        render(<FeedbackForm onSubmit={onSubmit} submitting={false} error={null} onCaptureScreenshot={noop} />);
        fillRequired();
        fireEvent.change(screen.getByLabelText(/github/i), { target: { value: "alice" } });
        fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
        const [fields, attachments] = onSubmit.mock.calls[0] as [FeedbackFields, File[]];
        expect(fields).toMatchObject({
            name: "Alice", email: "alice@example.com", github: "alice",
            title: "Bug report", description: "Something broke",
        });
        expect(attachments).toHaveLength(0);
    });

    it("shows inline error message when error prop is set", () => {
        render(<FeedbackForm onSubmit={noop} submitting={false} error="GitHub API error" onCaptureScreenshot={noop} />);
        expect(screen.getByText("GitHub API error")).not.toBeNull();
    });

    it("adds a file to the attachment list when selected via file input", async () => {
        render(<FeedbackForm onSubmit={noop} submitting={false} error={null} onCaptureScreenshot={noop} />);
        const file = new File(["content"], "photo.png", { type: "image/png" });
        const input = screen.getByLabelText(/attachments/i) as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        fireEvent.change(input);
        await waitFor(() => expect(screen.getByText("photo.png")).not.toBeNull());
    });

    it("removes a file when its remove button is clicked", async () => {
        render(<FeedbackForm onSubmit={noop} submitting={false} error={null} onCaptureScreenshot={noop} />);
        const file = new File(["content"], "photo.png", { type: "image/png" });
        const input = screen.getByLabelText(/attachments/i) as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        fireEvent.change(input);
        await waitFor(() => screen.getByText("photo.png"));
        fireEvent.click(screen.getByRole("button", { name: /remove photo\.png/i }));
        expect(screen.queryByText("photo.png")).toBeNull();
    });

    it("shows a validation error when more than 5 files are selected", async () => {
        render(<FeedbackForm onSubmit={noop} submitting={false} error={null} onCaptureScreenshot={noop} />);
        const files = Array.from({ length: 6 }, (_, i) => new File(["x"], `f${i}.png`, { type: "image/png" }));
        const input = screen.getByLabelText(/attachments/i) as HTMLInputElement;
        Object.defineProperty(input, "files", { value: files, configurable: true });
        fireEvent.change(input);
        await waitFor(() => expect(screen.getByText(/max 5 files/i)).not.toBeNull());
    });

    it("shows a validation error when a file exceeds 5 MB", async () => {
        render(<FeedbackForm onSubmit={noop} submitting={false} error={null} onCaptureScreenshot={noop} />);
        const big = new File([new Uint8Array(6 * 1024 * 1024)], "big.png", { type: "image/png" });
        const input = screen.getByLabelText(/attachments/i) as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [big], configurable: true });
        fireEvent.change(input);
        await waitFor(() => expect(screen.getByText(/exceeds 5 mb/i)).not.toBeNull());
    });

    it("calls onCaptureScreenshot and appends the result to attachments", async () => {
        const screenshotFile = new File(["png"], "screenshot.png", { type: "image/png" });
        const onCapture = vi.fn().mockResolvedValue(screenshotFile);
        render(<FeedbackForm onSubmit={noop} submitting={false} error={null} onCaptureScreenshot={onCapture} />);
        fireEvent.click(screen.getByRole("button", { name: /capture screenshot/i }));
        await waitFor(() => expect(screen.getByText("screenshot.png")).not.toBeNull());
        expect(onCapture).toHaveBeenCalledOnce();
    });

    it("does not call onSubmit when submit button is clicked with empty fields", async () => {
        const onSubmit = vi.fn();
        render(<FeedbackForm onSubmit={onSubmit} submitting={false} error={null} onCaptureScreenshot={noop} />);
        fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(onSubmit).not.toHaveBeenCalled();
    });
});
