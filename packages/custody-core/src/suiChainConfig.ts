import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

// Portable subset of apps/web/src/lib/chains.ts's Sui chain metadata — same "read process.env
// directly, keep var names in sync by hand" tradeoff already made in evmChainConfig.ts/
// solanaChainConfig.ts.

export type SuiPrismaChain = "SUI_TESTNET";

export const SUI_PRISMA_CHAINS: readonly SuiPrismaChain[] = ["SUI_TESTNET"];

export function isSuiPrismaChain(value: string): value is SuiPrismaChain {
  return (SUI_PRISMA_CHAINS as readonly string[]).includes(value);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

export function suiRpcUrlFor(chain: SuiPrismaChain): string {
  return process.env[`NEXT_PUBLIC_${chain}_RPC_URL`] || getJsonRpcFullnodeUrl("testnet");
}

export function suiClientFor(chain: SuiPrismaChain): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ network: "testnet", url: suiRpcUrlFor(chain) });
}

export function suiPackageIdFor(chain: SuiPrismaChain): string {
  return requireEnv(`NEXT_PUBLIC_${chain}_PACKAGE_ID`);
}

export function suiProtocolStateIdFor(chain: SuiPrismaChain): string {
  return requireEnv(`NEXT_PUBLIC_${chain}_REGISTRY_OBJECT_ID`);
}

export function suiUsdcCoinTypeFor(chain: SuiPrismaChain): string {
  return requireEnv(`NEXT_PUBLIC_${chain}_USDC_TYPE`);
}
