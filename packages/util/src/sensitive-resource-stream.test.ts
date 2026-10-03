import { describe, expect, it } from "vitest";
import { sensitiveResourcePolicy } from "./sensitive-resource.js";

describe("streaming content policy", () => {
  it("accepts large binary bodies and finds credential signatures across every chunk split", () => {
    const tokens = [
      "ghp_" + "a".repeat(32),
      "sk-ant-" + "b".repeat(28),
      "AKIA" + "A".repeat(16),
      "Bearer " + "x".repeat(32),
      "eyJ" + "x".repeat(12) + "." + "y".repeat(12) + "." + "z".repeat(10),
    ];
    for (const token of tokens)
      for (let split = 1; split < token.length; split++) {
        const scanner = sensitiveResourcePolicy.createContentScanner();
        scanner.write("\0".repeat(80000) + token.slice(0, split));
        scanner.write(token.slice(split));
        expect(scanner.finish()).toBe(sensitiveResourcePolicy.containsSensitiveContent(token));
      }
    const scanner = sensitiveResourcePolicy.createContentScanner();
    for (let i = 0; i < 1024; i++) scanner.write("\0".repeat(65536));
    expect(scanner.finish()).toBe(false);
  });
  it("retains a private-key delimiter across a large body without retaining that body", () => {
    const scanner = sensitiveResourcePolicy.createContentScanner();
    scanner.write("-----BEGIN " + "PRIVATE KEY-----\n");
    for (let i = 0; i < 64; i++) scanner.write("a".repeat(65536) + "\n");
    scanner.write("-----END " + "PRIVATE KEY-----");
    expect(scanner.finish()).toBe(true);
    const reversed = sensitiveResourcePolicy.createContentScanner();
    reversed.write("-----END " + "PRIVATE KEY-----\n-----BEGIN " + "PRIVATE KEY-----");
    expect(reversed.finish()).toBe(false);
  });
  it("does not manufacture a fixed-length AWS key at a chunk boundary", () => {
    const scanner = sensitiveResourcePolicy.createContentScanner();
    scanner.write("AKIA" + "A".repeat(16));
    scanner.write("A");
    expect(scanner.finish()).toBe(false);
  });
});
