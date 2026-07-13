import { getContract, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

interface Erc20Contract {
  read: { allowance: (args: readonly [Address, Address]) => Promise<bigint> };
  write: { approve: (args: readonly [Address, bigint]) => Promise<Hex> };
}

/** Ensures `owner` has approved `spender` to pull at least `amount` of the ERC20 token at
 * `tokenAddress`, calling `approve` first if the current allowance is insufficient. Shared
 * by every adapter whose write methods pull USDC via `safeTransferFrom` — Core's jobs and
 * launches, and the agent exchange's bids. */
export async function ensureErc20Allowance(
  clients: { public: PublicClient; wallet?: WalletClient },
  tokenAddress: Address,
  owner: Address,
  spender: Address,
  amount: bigint
): Promise<void> {
  if (amount === 0n) return;
  const token = getContract({ address: tokenAddress, abi: erc20Abi, client: clients }) as unknown as Erc20Contract;
  const allowance = await token.read.allowance([owner, spender]);
  if (allowance < amount) {
    await token.write.approve([spender, amount]);
  }
}
