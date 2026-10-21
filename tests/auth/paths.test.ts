import { describe, expect, it } from "vitest";
import { loginPath, safeReturnPath } from "@/lib/auth/paths";

describe("frontend redirect paths", () => {
  it.each(["/", "/scores/1", "/a?b=c#d"])("accepts same-origin path %s", (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });
  it.each(["//evil.example", "/\\evil.example", "https://evil.example", "evil", "/a\nb", "", 42, undefined, `/${"a".repeat(2048)}`])(
    "rejects unsafe return path %s", (path) => {
      expect(safeReturnPath(path)).toBeUndefined();
    });
  it("builds login notices without unsafe destinations", () => {
    expect(loginPath()).toBe("/login");
    expect(loginPath({ error: "unavailable" })).toBe("/login?error=unavailable");
    expect(loginPath({ status: "email_confirmed", next: "/" })).toBe("/login?status=email_confirmed");
    expect(loginPath({ next: "//evil.example" })).toBe("/login");
  });
});
