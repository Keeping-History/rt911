import { describe, it, expect, vi } from "vitest";
import { registerBeforeSignOut, runBeforeSignOutHooks } from "./beforeSignOut";

describe("beforeSignOut hooks", () => {
	it("runs registered hooks and honors unregister", async () => {
		const a = vi.fn().mockResolvedValue(undefined);
		const b = vi.fn().mockResolvedValue(undefined);
		const offA = registerBeforeSignOut(a);
		registerBeforeSignOut(b);
		await runBeforeSignOutHooks();
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
		offA();
		await runBeforeSignOutHooks();
		expect(a).toHaveBeenCalledTimes(1); // not called again
		expect(b).toHaveBeenCalledTimes(2);
	});
	it("swallows a rejecting hook so sign-out is never blocked", async () => {
		registerBeforeSignOut(() => Promise.reject(new Error("boom")));
		const ok = vi.fn().mockResolvedValue(undefined);
		registerBeforeSignOut(ok);
		await expect(runBeforeSignOutHooks()).resolves.toBeUndefined();
		expect(ok).toHaveBeenCalled();
	});
});
