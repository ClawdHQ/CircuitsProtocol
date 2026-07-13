import { Connection } from "@solana/web3.js";

// Portable subset of apps/web/src/lib/chains.ts's Solana chain metadata — same "read process.env
// directly, keep var names in sync by hand" tradeoff already made in evmChainConfig.ts.

export type SolanaPrismaChain = "SOLANA_DEVNET";

export const SOLANA_PRISMA_CHAINS: readonly SolanaPrismaChain[] = ["SOLANA_DEVNET"];

export function isSolanaPrismaChain(value: string): value is SolanaPrismaChain {
  return (SOLANA_PRISMA_CHAINS as readonly string[]).includes(value);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

export function solanaRpcUrlFor(chain: SolanaPrismaChain): string {
  return requireEnv(`NEXT_PUBLIC_${chain}_RPC_URL`);
}

export function solanaConnectionFor(chain: SolanaPrismaChain): Connection {
  return new Connection(solanaRpcUrlFor(chain), "confirmed");
}

export function solanaProgramIdFor(chain: SolanaPrismaChain): string {
  return requireEnv(`NEXT_PUBLIC_${chain}_PROGRAM_ID`);
}

export function solanaUsdcMintFor(chain: SolanaPrismaChain): string {
  return requireEnv(`NEXT_PUBLIC_${chain}_USDC_MINT`);
}

/** Unlike EVM/Sui, the program can't resolve the treasury's token account from on-chain state
 * alone (see SolanaAdapterConfig's doc comment in packages/sdk) — optional because not every
 * instruction this package calls needs it (only confirmDelivery/acceptBid/settleAuction do). */
export function solanaTreasuryFor(chain: SolanaPrismaChain): string | undefined {
  return process.env[`NEXT_PUBLIC_${chain}_TREASURY_ADDRESS`] || undefined;
}
