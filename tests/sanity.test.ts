import { describe, it, expect } from "bun:test";

describe("Sanity Check", () => {
  it("should pass basic assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("should verify bun:test is working", () => {
    expect(true).toBe(true);
  });
});
