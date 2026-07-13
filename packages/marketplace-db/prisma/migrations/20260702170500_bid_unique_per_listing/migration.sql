-- Sui's `next_bid_id` is scoped per-Listing (each listing's own Table starts counting bids
-- from 1), unlike EVM/Solana's protocol-wide counter — so `(chain, chainBidId)` alone can
-- collide across two different Sui listings, silently overwriting one bid's row with an
-- unrelated bid's data on upsert. Scope the uniqueness to the listing too.

-- DropIndex
DROP INDEX "Bid_chain_chainBidId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Bid_chain_listingDbId_chainBidId_key" ON "Bid"("chain", "listingDbId", "chainBidId");
