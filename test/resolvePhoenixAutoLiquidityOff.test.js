import { describe, it, expect } from "vitest";
import { resolvePhoenixAutoLiquidityOff } from "../src/instances.mjs";

describe("resolvePhoenixAutoLiquidityOff", () => {
  it("returns true for boolean true", () => {
    expect(resolvePhoenixAutoLiquidityOff(true)).toBe(true);
  });

  it("returns false for boolean false", () => {
    expect(resolvePhoenixAutoLiquidityOff(false)).toBe(false);
  });

  it('returns true for string "true"', () => {
    expect(resolvePhoenixAutoLiquidityOff("true")).toBe(true);
  });

  it('returns true for string "1"', () => {
    expect(resolvePhoenixAutoLiquidityOff("1")).toBe(true);
  });

  it('returns true for string "on"', () => {
    expect(resolvePhoenixAutoLiquidityOff("on")).toBe(true);
  });

  it("returns true for uppercase variants", () => {
    expect(resolvePhoenixAutoLiquidityOff("TRUE")).toBe(true);
    expect(resolvePhoenixAutoLiquidityOff("ON")).toBe(true);
  });

  it("returns false for other strings", () => {
    expect(resolvePhoenixAutoLiquidityOff("false")).toBe(false);
    expect(resolvePhoenixAutoLiquidityOff("0")).toBe(false);
    expect(resolvePhoenixAutoLiquidityOff("off")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(resolvePhoenixAutoLiquidityOff(null)).toBe(false);
    expect(resolvePhoenixAutoLiquidityOff(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(resolvePhoenixAutoLiquidityOff("")).toBe(false);
  });
});
