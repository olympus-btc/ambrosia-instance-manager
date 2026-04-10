import { describe, it, expect } from "vitest";
import { resolvePhoenixChain } from "../src/instances.mjs";

describe("resolvePhoenixChain", () => {
  it("returns mainnet by default", () => {
    expect(resolvePhoenixChain()).toBe("mainnet");
  });

  it("returns mainnet for empty string", () => {
    expect(resolvePhoenixChain("")).toBe("mainnet");
  });

  it("returns mainnet for null/undefined", () => {
    expect(resolvePhoenixChain(null)).toBe("mainnet");
    expect(resolvePhoenixChain(undefined)).toBe("mainnet");
  });

  it("accepts mainnet", () => {
    expect(resolvePhoenixChain("mainnet")).toBe("mainnet");
  });

  it("accepts testnet", () => {
    expect(resolvePhoenixChain("testnet")).toBe("testnet");
  });

  it("normalizes to lowercase", () => {
    expect(resolvePhoenixChain("Mainnet")).toBe("mainnet");
    expect(resolvePhoenixChain("TESTNET")).toBe("testnet");
  });

  it("trims whitespace", () => {
    expect(resolvePhoenixChain("  mainnet  ")).toBe("mainnet");
  });

  it("falls back for invalid values", () => {
    expect(resolvePhoenixChain("invalid")).toBe("mainnet");
  });

  it("throws in strict mode for invalid values", () => {
    expect(() => resolvePhoenixChain("invalid", { strict: true })).toThrow("Phoenix chain must be either mainnet or testnet");
  });

  it("does not throw in strict mode for valid values", () => {
    expect(resolvePhoenixChain("testnet", { strict: true })).toBe("testnet");
  });

  it("respects custom fallback", () => {
    expect(resolvePhoenixChain("", { fallback: "testnet" })).toBe("testnet");
  });
});
