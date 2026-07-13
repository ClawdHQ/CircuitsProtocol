import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClawMem } from "./client.js";

describe("ClawMem", () => {
  let mem: ClawMem;

  beforeEach(() => {
    mem = new ClawMem({ databaseUrl: ":memory:" });
  });

  afterEach(() => {
    mem.close();
  });

  it("remembers and recalls a value scoped by agent and namespace", () => {
    mem.registerAgent("agent-1", "Agent One");
    mem.remember("agent-1", "conversation", "greeting", { text: "hello" });

    expect(mem.recall("agent-1", "conversation", "greeting")).toEqual({ text: "hello" });
    expect(mem.recall("agent-1", "conversation", "missing")).toBeUndefined();
    expect(mem.recall("agent-2", "conversation", "greeting")).toBeUndefined();
  });

  it("overwrites an existing key on remember and updates updatedAt", () => {
    mem.remember("agent-1", "task", "status", "pending");
    const [first] = mem.list("agent-1", "task");

    mem.remember("agent-1", "task", "status", "done");
    const [second] = mem.list("agent-1", "task");

    expect(mem.recall("agent-1", "task", "status")).toBe("done");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it("forgets a key", () => {
    mem.remember("agent-1", "note", "draft", "v1");
    mem.forget("agent-1", "note", "draft");
    expect(mem.recall("agent-1", "note", "draft")).toBeUndefined();
  });

  it("lists memories scoped by namespace", () => {
    mem.remember("agent-1", "task", "a", 1);
    mem.remember("agent-1", "task", "b", 2);
    mem.remember("agent-1", "note", "c", 3);

    expect(mem.list("agent-1", "task")).toHaveLength(2);
    expect(mem.list("agent-1")).toHaveLength(3);
  });

  it("links and resolves cross-chain identities", () => {
    mem.registerAgent("agent-1", "Agent One");
    mem.linkChainIdentity("agent-1", "bsc", "42", "0xabc");
    mem.linkChainIdentity("agent-1", "solana", "7", "SoLanaAddr");

    expect(mem.resolveAgentKey("bsc", "42")).toBe("agent-1");
    expect(mem.resolveAgentKey("solana", "7")).toBe("agent-1");
    expect(mem.resolveAgentKey("sui", "99")).toBeUndefined();

    const identities = mem.getChainIdentities("agent-1");
    expect(identities).toHaveLength(2);
    expect(identities.map((i) => i.chain).sort()).toEqual(["bsc", "solana"]);
  });

  it("re-linking the same (chain, chainAgentId) pair repoints to the new agent", () => {
    mem.linkChainIdentity("agent-1", "bsc", "42", "0xabc");
    mem.linkChainIdentity("agent-2", "bsc", "42", "0xdef");

    expect(mem.resolveAgentKey("bsc", "42")).toBe("agent-2");
  });

  it("clearAgent removes memories, identities, and the agent row", () => {
    mem.registerAgent("agent-1", "Agent One");
    mem.linkChainIdentity("agent-1", "bsc", "42", "0xabc");
    mem.remember("agent-1", "task", "a", 1);

    mem.clearAgent("agent-1");

    expect(mem.list("agent-1")).toHaveLength(0);
    expect(mem.getChainIdentities("agent-1")).toHaveLength(0);
    expect(mem.resolveAgentKey("bsc", "42")).toBeUndefined();
  });
});
