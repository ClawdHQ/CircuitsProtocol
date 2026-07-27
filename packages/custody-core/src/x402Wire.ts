import { z } from "zod";

// Wire format for the x402 protocol (https://github.com/coinbase/x402) — matched for
// interoperability with the published spec's shapes even though settlement underneath differs:
// real x402 "exact" typically settles via an EIP-3009 signed transferWithAuthorization the
// resource server (or its facilitator) verifies and submits itself, fully non-custodially.
// MockUSDC has no EIP-3009/permit, so ClawdHQ's facilitator instead pulls an already-agreed
// amount through a payer-granted ERC-20 allowance (see X402Facilitator.sol) — a real payment,
// on real MockUSDC, gated by a real on-chain idempotency check, just custodial rather than
// trustless. `scheme` is named "exact" to match the spec's field, but `extra.settlement` always
// says "circuitsprotocol-facilitator-pull" so nothing here is misrepresented as textbook x402.
//
// Lives in custody-core (not apps/web) so both an app route (agentX402.ts, knowledgeX402.ts) and
// a portable client (a2aClient.ts, knowledgeResolveClient.ts) can use the identical encode/decode
// — packages/hosted-agent-runtime (used by apps/indexer's standalone scheduler process, not just
// apps/web's Next.js server) can never import from apps/web, so this couldn't stay there once a
// package-side x402 client needed it too.

export const X402_VERSION = 1;

const PaymentRequirementsSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  maxAmountRequired: z.string(),
  resource: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().optional(),
  asset: z.string(),
  extra: z.object({ settlement: z.string().optional() }).passthrough().optional(),
});

const X402ResponseBodySchema = z.object({
  x402Version: z.number(),
  error: z.string().optional(),
  accepts: z.array(PaymentRequirementsSchema),
});

export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

/** Parses a 402 response body into its `accepts` payment requirements — returns null if the
 * body doesn't match x402's shape (an agent that returns a bare 402 with no structured body, or
 * a differently-shaped payment scheme this app doesn't understand). */
export function parseX402Body(body: unknown): PaymentRequirements[] | null {
  const parsed = X402ResponseBodySchema.safeParse(body);
  if (!parsed.success || parsed.data.accepts.length === 0) return null;
  return parsed.data.accepts;
}

/** ClawdHQ's own "exact" scheme payload — proof that a specific, already-confirmed on-chain
 * pull happened, rather than a signed authorization the resource server verifies itself. */
export interface FacilitatorPullPayload {
  chain: string;
  payer: string;
  recipient: string;
  amount: string;
  idempotencyKey: string;
  txHashOrRef: string;
}

export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: FacilitatorPullPayload;
}

/** Builds the base64-encoded X-PAYMENT request header a paid retry sends back. */
export function encodePaymentHeader(requirements: PaymentRequirements, pull: FacilitatorPullPayload): string {
  const payload: X402PaymentPayload = { x402Version: X402_VERSION, scheme: requirements.scheme, network: requirements.network, payload: pull };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Server-side counterpart, for anything that needs to verify an inbound X-PAYMENT header —
 * returns null rather than throwing on anything malformed, matching a2aClient.ts's "parse
 * defensively" convention for data an external party controls. */
export function decodePaymentHeader(header: string): X402PaymentPayload | null {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (
      typeof decoded?.x402Version !== "number" ||
      typeof decoded?.scheme !== "string" ||
      typeof decoded?.network !== "string" ||
      typeof decoded?.payload !== "object"
    ) {
      return null;
    }
    return decoded as X402PaymentPayload;
  } catch {
    return null;
  }
}
