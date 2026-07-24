import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError } from "../../Providers/Auth/authApi";
import {
  createPersonalBookmark, updatePersonalBookmark, deletePersonalBookmark,
} from "./bookmarksApi";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const emptyResponse = (status = 204) => new Response(null, { status });

describe("createPersonalBookmark", () => {
  it("POSTs the collection with credentials and returns the row", async () => {
    const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(String(args[0])).toContain("/items/tm_bookmarks_personal");
      const init = args[1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      expect(JSON.parse(String(init.body))).toEqual({ title: "T", category: "General", start_date: "2001-09-11T12:46:40" });
      return jsonResponse({ data: { id: 5, title: "T", category: "General", start_date: "2001-09-11T12:46:40" } });
    });
    const row = await createPersonalBookmark({ title: "T", category: "General", start_date: "2001-09-11T12:46:40" }, f);
    expect(row.id).toBe(5);
  });
  it("maps 401 and 403", async () => {
    await expect(createPersonalBookmark({ title: "T", category: "G", start_date: "x" }, vi.fn(async () => jsonResponse({}, 401)))).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(createPersonalBookmark({ title: "T", category: "G", start_date: "x" }, vi.fn(async () => jsonResponse({}, 403)))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("updatePersonalBookmark", () => {
  it("PATCHes /:id and returns the row", async () => {
    const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(String(args[0])).toContain("/items/tm_bookmarks_personal/7");
      const init = args[1] as RequestInit;
      expect(init.method).toBe("PATCH");
      expect(init.credentials).toBe("include");
      expect(JSON.parse(String(init.body))).toEqual({ title: "New" });
      return jsonResponse({ data: { id: 7, title: "New", category: "General", start_date: "2001-09-11T12:46:40" } });
    });
    const row = await updatePersonalBookmark(7, { title: "New" }, f);
    expect(row.title).toBe("New");
  });
});

describe("deletePersonalBookmark", () => {
  it("DELETEs /:id with credentials", async () => {
    const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(String(args[0])).toContain("/items/tm_bookmarks_personal/9");
      expect((args[1] as RequestInit).method).toBe("DELETE");
      expect((args[1] as RequestInit).credentials).toBe("include");
      return emptyResponse(204);
    });
    await expect(deletePersonalBookmark(9, f)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledOnce();
  });
  it("maps 403 on delete", async () => {
    await expect(deletePersonalBookmark(9, vi.fn(async () => jsonResponse({}, 403)))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
