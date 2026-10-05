import { describe, it, expect } from "vitest";
import { roleLabel } from "./roles";
import { passwordError } from "./passwordRules";
import { friendlyAuthError } from "./authErrors";

describe("roleLabel", () => {
  it("maps API roles to the labels used in the invite dialog", () => {
    expect(roleLabel("MEMBER")).toBe("Associate");
    expect(roleLabel("VIEWER")).toBe("Analyst");
    expect(roleLabel("ADMIN")).toBe("Admin");
    expect(roleLabel("OWNER")).toBe("Owner");
    expect(roleLabel(null)).toBe("");
  });
});

describe("passwordError", () => {
  it("accepts a password that meets every rule", () => {
    expect(passwordError("Str0ng!Passw0rd")).toBeNull();
  });
  it("lists everything that's missing", () => {
    expect(passwordError("abc")).toBe(
      "Password must be at least 10 characters and include an uppercase letter, a number and a special character.",
    );
  });
});

describe("friendlyAuthError", () => {
  it("rewrites common Supabase messages", () => {
    expect(friendlyAuthError("Invalid login credentials")).toMatch(/incorrect email or password/i);
    expect(friendlyAuthError("User already registered")).toMatch(/already exists/i);
    expect(friendlyAuthError("Failed to fetch")).toMatch(/can't reach the server/i);
  });
  it("passes unknown messages through", () => {
    expect(friendlyAuthError("Something specific")).toBe("Something specific");
  });
});
