import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";

require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
// Under pnpm's symlinked node_modules, hardhat-toolbox's own internal require of
// hardhat-chai-matchers doesn't trigger its chai.use() side effect, so `expect(...).to.be.reverted`
// matchers never register. Requiring it again here directly fixes that.
require("@nomicfoundation/hardhat-chai-matchers");

dotenv.config({ path: "../../.env", quiet: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    return "0x0000000000000000000000000000000000000000000000000000000000000000".slice(0, 66);
  }
  return value;
}

const DEPLOYER_PRIVATE_KEY = requireEnv("EVM_DEPLOYER_PRIVATE_KEY");

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    ],
    overrides: {
      // ClawdHQCore bundles agent registry + job escrow + launchpad in one UUPS singleton
      // and sits right at the EIP-170 24576-byte contract-size limit (currently ~24571
      // bytes deployed — only ~5 bytes of headroom even with runs:1 + stripped metadata).
      // Optimize this one file for size over runtime gas; it's called far less frequently
      // per user than a hot-path DeFi primitive, so that tradeoff is worth it. There is
      // effectively no room left to add more logic here — any new agent-related
      // functionality (the exchange included) belongs in its own contract, not this one.
      "contracts/ClawdHQCore.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          // Strips the ~53-byte trailing CBOR metadata hash from the deployed bytecode.
          // Purely cosmetic for Etherscan source-verification UX (still works via the
          // standard-JSON-input flow); zero effect on runtime behavior.
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
    },
  },
  networks: {
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545",
      accounts: [DEPLOYER_PRIVATE_KEY],
      chainId: 97,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: [DEPLOYER_PRIVATE_KEY],
      chainId: 84532,
    },
    ethSepolia: {
      url: process.env.ETH_SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      accounts: [DEPLOYER_PRIVATE_KEY],
      chainId: 11155111,
    },
    // Circle's Arc — USDC is the *native gas token* here (18 decimals), not a separate
    // ETH-equivalent; nothing Hardhat-specific to configure for that, gas is still quoted and
    // paid in the network's native currency same as any other chain. See chains.ts's
    // ARC_TESTNET doc comment.
    arcTestnet: {
      url: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network",
      accounts: [DEPLOYER_PRIVATE_KEY],
      chainId: 5042002,
    },
    hardhat: {},
  },
  etherscan: {
    apiKey: {
      bscTestnet: process.env.BSCSCAN_API_KEY || "",
      baseSepolia: process.env.BASESCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      // Arcscan's verification-API compatibility is unconfirmed as of this writing — omitted
      // from customChains until confirmed; 03-verify.ts treats Arc's verify step as best-effort
      // or skip rather than a hard failure (see its comment).
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
