import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeedbackFields } from "./useFeedback";
import type { FeedbackDefaults } from "./feedbackSettings";
import { FeedbackForm } from "./FeedbackForm";

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

// Suppress classicy's analytics no-provider warning — expected in test environment
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });

const noop = vi.fn();
const BLANK: FeedbackDefaults = { name: "", email: "", github: "" };

type FormProps = Parameters<typeof FeedbackForm>[0];

function props(over: Partial<FormProps> = {}): FormProps {
    return {
        onSubmit:            noop,
        submitting:          false,
        error:               null,
        onCaptureScreenshot: noop,
        defaults:            BLANK,
        ...over,
    };
}

const renderForm = (over: Partial<FormProps> = {}) => render(<FeedbackForm {...props(over)} />);

function fillRequired() {
    fireEvent.change(screen.getByLabelText("Name"),        { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("Email"),       { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText("Title"),       { target: { value: "Bug report" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Something broke" } });
}

// classicy puts the labelPosition class on the control's outermost holder, which
// is the input's parent for text fields but its grandparent for the file input.
const holderOf = (labelText: string | RegExp) =>
    screen.getByLabelText(labelText).closest(
        ".classicyInputHolder, .classicyTextEditorHolder, .classicyFileInputHolder",
    ) as HTMLElement;

describe("FeedbackForm", () => {
    it("submit button is disabled when required fields are empty", () => {
        renderForm();
        expect((screen.getByRole("button", { name: /send feedback/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("submit button is enabled when all required fields are filled", () => {
        renderForm();
        fillRequired();
        expect((screen.getByRole("button", { name: /send feedback/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("submit button shows 'Sending…' and is disabled while submitting", () => {
        renderForm({ submitting: true });
        const btn = screen.getByRole("button", { name: /sending/i }) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });

    it("calls onSubmit with form fields and empty attachments on submit", async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        renderForm({ onSubmit });
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
        renderForm({ error: "GitHub API error" });
        expect(screen.getByText("GitHub API error")).not.toBeNull();
    });

    it("adds a file to the attachment list when selected via file input", async () => {
        renderForm();
        const file = new File(["content"], "photo.png", { type: "image/png" });
        const input = screen.getByLabelText(/attachments/i) as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        fireEvent.change(input);
        await waitFor(() => expect(screen.getByText("photo.png")).not.toBeNull());
    });

    it("removes a file when its remove button is clicked", async () => {
        renderForm();
        const file = new File(["content"], "photo.png", { type: "image/png" });
        const input = screen.getByLabelText(/attachments/i) as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        fireEvent.change(input);
        await waitFor(() => screen.getByText("photo.png"));
        fireEvent.click(screen.getByRole("button", { name: /remove photo\.png/i }));
        expect(screen.queryByText("photo.png")).toBeNull();
    });

    it("shows a validation error when more than 5 files are selected", async () => {
        renderForm();
        const files = Array.from({ length: 6 }, (_, i) => new File(["x"], `f${i}.png`, { type: "image/png" }));
        const input = screen.getByLabelText(/attachments/i) as HTMLInputElement;
        Object.defineProperty(input, "files", { value: files, configurable: true });
        fireEvent.change(input);
        await waitFor(() => expect(screen.getByText(/max 5 files/i)).not.toBeNull());
    });

    it("shows a validation error when a file exceeds 5 MB", async () => {
        renderForm();
        const big = new File([new Uint8Array(6 * 1024 * 1024)], "big.png", { type: "image/png" });
        const input = screen.getByLabelText(/attachments/i) as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [big], configurable: true });
        fireEvent.change(input);
        await waitFor(() => expect(screen.getByText(/exceeds 5 mb/i)).not.toBeNull());
    });

    it("calls onCaptureScreenshot and appends the result to attachments", async () => {
        const screenshotFile = new File(["png"], "screenshot.png", { type: "image/png" });
        const onCapture = vi.fn().mockResolvedValue(screenshotFile);
        renderForm({ onCaptureScreenshot: onCapture });
        fireEvent.click(screen.getByRole("button", { name: /capture screenshot/i }));
        await waitFor(() => expect(screen.getByText("screenshot.png")).not.toBeNull());
        expect(onCapture).toHaveBeenCalledOnce();
    });

    it("does not call onSubmit when submit button is clicked with empty fields", async () => {
        const onSubmit = vi.fn();
        renderForm({ onSubmit });
        fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(onSubmit).not.toHaveBeenCalled();
    });

    describe("pre-filled identity", () => {
        it("prefills name, email and github from defaults", () => {
            renderForm({ defaults: { name: "Ada Lovelace", email: "ada@example.com", github: "octocat" } });
            expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ada Lovelace");
            expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com");
            expect((screen.getByLabelText(/github/i) as HTMLInputElement).value).toBe("octocat");
        });

        it("is submittable straight away when identity supplies the required fields", () => {
            renderForm({ defaults: { name: "Ada Lovelace", email: "ada@example.com", github: "" } });
            fireEvent.change(screen.getByLabelText("Title"),       { target: { value: "Bug report" } });
            fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Something broke" } });
            expect((screen.getByRole("button", { name: /send feedback/i }) as HTMLButtonElement).disabled).toBe(false);
        });

        it("adopts defaults that resolve after the form has mounted", () => {
            // The Feedback app mounts at desktop boot, long before AuthProvider's
            // session check returns — so identity almost always arrives late.
            const { rerender } = renderForm();
            expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
            rerender(
                <FeedbackForm
                    {...props({ defaults: { name: "Ada Lovelace", email: "ada@example.com", github: "octocat" } })}
                />,
            );
            expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ada Lovelace");
            expect((screen.getByLabelText(/github/i) as HTMLInputElement).value).toBe("octocat");
        });

        it("does not overwrite a field the reporter already typed into", () => {
            const { rerender } = renderForm();
            fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grace" } });
            rerender(
                <FeedbackForm
                    {...props({ defaults: { name: "Ada Lovelace", email: "ada@example.com", github: "" } })}
                />,
            );
            expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Grace");
            // …while an untouched field still picks the late default up.
            expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com");
        });

        it("keeps a field the reporter cleared empty when a default arrives", () => {
            const { rerender } = renderForm({ defaults: { name: "Ada Lovelace", email: "", github: "octocat" } });
            fireEvent.change(screen.getByLabelText(/github/i), { target: { value: "" } });
            rerender(
                <FeedbackForm
                    {...props({ defaults: { name: "Ada Lovelace", email: "ada@example.com", github: "octocat" } })}
                />,
            );
            expect((screen.getByLabelText(/github/i) as HTMLInputElement).value).toBe("");
        });
    });

    describe("label layout", () => {
        it("sets the single-line field labels beside their input", () => {
            renderForm();
            for (const label of ["Name", "Email", /github/i, "Title"] as const) {
                expect(holderOf(label).className).toContain("classicyLabelLeft");
            }
            expect(holderOf(/attachments/i).className).toContain("classicyLabelLeft");
        });

        it("leaves the Description label above its textarea", () => {
            renderForm();
            expect(holderOf("Description").className).toContain("classicyLabelAbove");
        });
    });
});
