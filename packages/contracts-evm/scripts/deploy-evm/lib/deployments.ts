import * as fs from "node:fs";
import * as path from "node:path";

export interface DeploymentRecord {
  chainId: number;
  network: string;
  proxyAddress: string;
  implementationAddress: string;
  usdcAddress: string;
  treasury: string;
  deployer: string;
  rolesGranted: boolean;
  bondingParamsSet: boolean;
  verified: boolean;
  deployedAt: string;
  exchangeProxyAddress?: string;
  exchangeImplementationAddress?: string;
  exchangeDeployedAt?: string;
  /** AgentWalletRegistry.sol — deployed before Core, since Core's `_agentWalletRegistry` is an
   * immutable constructor argument (see ClawdHQCore.sol's doc comment on why). Not a proxy —
   * plain constructor deploy, no implementation/proxy split. */
  agentWalletRegistryAddress?: string;
  launchpadProxyAddress?: string;
  launchpadImplementationAddress?: string;
  launchpadDeployedAt?: string;
  stakingProxyAddress?: string;
  stakingImplementationAddress?: string;
  stakingDeployedAt?: string;
  evaluatorPoolProxyAddress?: string;
  evaluatorPoolImplementationAddress?: string;
  evaluatorPoolDeployedAt?: string;
  negotiationProxyAddress?: string;
  negotiationImplementationAddress?: string;
  negotiationDeployedAt?: string;
  crossChainIdentityProxyAddress?: string;
  crossChainIdentityImplementationAddress?: string;
  crossChainIdentityDeployedAt?: string;
  governorProxyAddress?: string;
  governorImplementationAddress?: string;
  governorDeployedAt?: string;
  /// Xero Protocol (the Uniswap V2 fork) — plain constructor deploys, not proxies, same as
  /// AgentWalletRegistry above. xeroRouterAddress is what gets wired into
  /// ClawdHQLaunchpad.uniswapV2Router via 06-configure-fees-and-router.ts's existing
  /// UNISWAP_V2_ROUTER_ADDRESS env var (no code change needed there).
  xeroFactoryAddress?: string;
  xeroRouterAddress?: string;
  xeroDeployedAt?: string;
  predictionVaultProxyAddress?: string;
  predictionVaultImplementationAddress?: string;
  predictionVaultDeployedAt?: string;
  perpVaultProxyAddress?: string;
  perpVaultImplementationAddress?: string;
  perpVaultDeployedAt?: string;
  agentTradingVaultProxyAddress?: string;
  agentTradingVaultImplementationAddress?: string;
  agentTradingVaultDeployedAt?: string;
}

const DEPLOYMENTS_DIR = path.resolve(__dirname, "../../../deployments");

function deploymentPath(chainId: number): string {
  return path.join(DEPLOYMENTS_DIR, `${chainId}.json`);
}

export function readDeployment(chainId: number): DeploymentRecord | null {
  const file = deploymentPath(chainId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as DeploymentRecord;
}

export function writeDeployment(chainId: number, record: DeploymentRecord): void {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
  fs.writeFileSync(deploymentPath(chainId), JSON.stringify(record, null, 2) + "\n");
}

export function updateDeployment(chainId: number, patch: Partial<DeploymentRecord>): DeploymentRecord {
  const existing = readDeployment(chainId);
  if (!existing) throw new Error(`No deployment record found for chain ${chainId}`);
  const updated = { ...existing, ...patch };
  writeDeployment(chainId, updated);
  return updated;
}
