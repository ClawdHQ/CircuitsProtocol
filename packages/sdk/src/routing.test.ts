import { ClawMem } from "@clawdhq/clawmem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvmAdapter } from "./adapters/evm.js";
import { EvmAgentExchangeAdapter } from "./adapters/evm-exchange.js";
import { RoutingEngine } from "./routing.js";

describe("RoutingEngine", () => {
  let clawMem: ClawMem;

  beforeEach(() => {
    clawMem = new ClawMem({ databaseUrl: ":memory:" });
  });

  afterEach(() => {
    clawMem.close();
  });

  it("throws a clear error when an unconfigured chain's adapter is requested", () => {
    const routing = new RoutingEngine({ clawMem });
    expect(() => routing.getEvmAdapter("bsc")).toThrowError(/No EVM adapter configured for chain "bsc"/);
    expect(() => routing.getEvmExchangeAdapter("bsc")).toThrowError(/No EVM agent-exchange adapter configured for chain "bsc"/);
    expect(() => routing.getSolanaAdapter()).toThrowError(/No Solana adapter configured/);
    expect(() => routing.getSuiAdapter()).toThrowError(/No Sui adapter configured/);
  });

  it("getEvmExchangeAdapter returns the configured adapter for that chain", () => {
    const bscExchangeAdapter = Object.create(EvmAgentExchangeAdapter.prototype) as EvmAgentExchangeAdapter;
    const routing = new RoutingEngine({ clawMem, evmExchange: { bsc: bscExchangeAdapter } });
    expect(routing.getEvmExchangeAdapter("bsc")).toBe(bscExchangeAdapter);
  });

  it("hasChain reflects which adapters were configured", () => {
    const bscAdapter = Object.create(EvmAdapter.prototype) as EvmAdapter;
    const routing = new RoutingEngine({ clawMem, evm: { bsc: bscAdapter } });

    expect(routing.hasChain("bsc")).toBe(true);
    expect(routing.hasChain("base")).toBe(false);
    expect(routing.hasChain("solana")).toBe(false);
    expect(routing.hasChain("sui")).toBe(false);
  });

  it("resolves a logical agent key via ClawMem across chains", () => {
    const routing = new RoutingEngine({ clawMem });
    clawMem.linkChainIdentity("agent-1", "bsc", "42", "0xabc");
    clawMem.linkChainIdentity("agent-1", "solana", "7", "SoLanaAddr");

    expect(routing.resolveAgentKey("bsc", "42")).toBe("agent-1");
    expect(routing.getAgentIdentities("agent-1")).toHaveLength(2);
  });
});
