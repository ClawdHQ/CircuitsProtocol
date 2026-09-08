// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IClawdHQCore} from "./interfaces/IClawdHQCore.sol";

/// @title ClawdHQAgentExchange
/// @notice NFT-style ownership marketplace for ClawdHQ agents — separate system from
/// ClawdHQCore's job-hiring marketplace, which is untouched by this contract. Sellers list
/// an agent after approving this contract on Core via `approveAgentExchange`; the agent's
/// `owner` on Core is never written until a sale actually completes, so it keeps earning job
/// revenue for the real seller for as long as it's merely listed. See
/// {IClawdHQCore-agentExchangeApproval} and Core's own NatSpec for the full non-custodial
/// invariant this contract relies on.
/// @dev Deployed as its own UUPS proxy, deliberately separate from ClawdHQCore, which is
/// already at the EIP-170 contract-size limit and has no headroom for more logic.
interface IAgentWalletRegistryExchange {
    function agentWallet(uint256 agentId) external view returns (address);
}

contract ClawdHQAgentExchange is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============================================================ Types ===

    enum ListingMode {
        Open,
        Auction
    }

    enum ListingStatus {
        Active,
        Sold,
        Cancelled,
        Expired
    }

    struct Listing {
        uint256 listingId;
        uint256 agentId;
        address seller;
        ListingMode mode;
        ListingStatus status;
        uint256 fairValueSnapshotUsdc; // off-chain valuation at listing time, display-only, never enforced
        uint256 reservePriceUsdc; // Auction-only; 0 = no reserve
        uint256 endTime; // 0 for Open (no expiry); required for Auction
        uint256 highestBidId; // Auction-only; 0 = none yet
        uint64 createdAt;
        uint64 updatedAt;
    }

    struct Bid {
        uint256 bidId;
        uint256 listingId;
        address bidder;
        uint256 amountUsdc;
        bool active; // false once accepted, settled, or withdrawn
        uint64 createdAt;
    }

    // ===================================================== Constants =====

    uint256 public constant ANTI_SNIPE_EXTENSION_WINDOW = 5 minutes;

    // ======================================================== Storage =====

    IClawdHQCore public core;
    IERC20 public usdc;
    address public treasury;
    uint256 public protocolFeeBps; // taken from sale proceeds on settlement; independent of Core's job-fee bps

    uint256 private _nextListingId;
    uint256 private _nextBidId;

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Bid) public bids;
    mapping(uint256 => uint256) public activeListingIdByAgentId; // agentId => listingId, 0 if none active

    // ========================================================= Events =====

    event ListingCreated(
        uint256 indexed listingId,
        uint256 indexed agentId,
        address indexed seller,
        ListingMode mode,
        uint256 fairValueSnapshotUsdc,
        uint256 reservePriceUsdc,
        uint256 endTime
    );
    event ListingCancelled(uint256 indexed listingId);
    event BidPlaced(uint256 indexed bidId, uint256 indexed listingId, address indexed bidder, uint256 amountUsdc);
    event BidWithdrawn(uint256 indexed bidId, address indexed bidder, uint256 amountUsdc);
    event BidOutbidRefunded(uint256 indexed bidId, address indexed bidder, uint256 amountUsdc);
    event ListingSold(uint256 indexed listingId, uint256 indexed agentId, address indexed seller, address buyer, uint256 priceUsdc, ListingMode mode);
    event ListingExpiredUnsold(uint256 indexed listingId);
    event ProtocolFeeUpdated(uint256 protocolFeeBps);
    event TreasuryUpdated(address treasury);

    // ========================================================= Errors =====

    error NotApprovedForExchange();
    error NotSeller();
    error NotBidder();
    error AlreadyListed();
    error ListingNotActive();
    error WrongListingMode();
    error InvalidListingParams();
    error ZeroAmount();
    error BidTooLow();
    error BidNotActive();
    error BidNotWithdrawable();
    error AuctionEnded();
    error AuctionNotEnded();
    error CannotCancelAuctionWithBids();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address coreAddress, address usdcAddress, address treasury_) external initializer {
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        core = IClawdHQCore(coreAddress);
        usdc = IERC20(usdcAddress);
        treasury = treasury_;
        protocolFeeBps = 0; // testnet default, matches Core's convention

        _nextListingId = 1;
        _nextBidId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ======================================================= Listings =====

    /// @notice Creates a listing for `agentId`. The caller must currently be the agent's
    /// owner on Core AND must have already called `core.approveAgentExchange(agentId,
    /// address(this))` — both are re-checked here, not just trusted from the approval call,
    /// so an attacker can't front-run someone else's dangling approval into a listing for an
    /// agent they don't own.
    function createListing(
        uint256 agentId,
        ListingMode mode,
        uint256 fairValueSnapshotUsdc,
        uint256 reservePriceUsdc,
        uint256 endTime
    ) external whenNotPaused returns (uint256 listingId) {
        if (core.agentExchangeApproval(agentId) != address(this)) revert NotApprovedForExchange();
        (, address currentOwner) = core.agents(agentId);
        if (currentOwner != msg.sender) revert NotSeller();
        if (activeListingIdByAgentId[agentId] != 0) revert AlreadyListed();

        if (mode == ListingMode.Auction) {
            if (endTime <= block.timestamp) revert InvalidListingParams();
        } else if (endTime != 0 || reservePriceUsdc != 0) {
            // Open mode has no expiry and no reserve — the seller's unconditional
            // accept-anytime discretion already makes a reserve redundant.
            revert InvalidListingParams();
        }

        listingId = _nextListingId++;
        listings[listingId] = Listing({
            listingId: listingId,
            agentId: agentId,
            seller: msg.sender,
            mode: mode,
            status: ListingStatus.Active,
            fairValueSnapshotUsdc: fairValueSnapshotUsdc,
            reservePriceUsdc: reservePriceUsdc,
            endTime: endTime,
            highestBidId: 0,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        activeListingIdByAgentId[agentId] = listingId;

        emit ListingCreated(listingId, agentId, msg.sender, mode, fairValueSnapshotUsdc, reservePriceUsdc, endTime);
    }

    /// @notice Cancels a listing with no bids yet. Once an auction has a bid, the seller can
    /// no longer cancel it out from under the bidder — it must run to expiry (reserve not
    /// met expires it unsold; see {settleAuction}).
    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        if (listing.status != ListingStatus.Active) revert ListingNotActive();
        if (listing.seller != msg.sender) revert NotSeller();
        if (listing.mode == ListingMode.Auction && listing.highestBidId != 0) revert CannotCancelAuctionWithBids();

        listing.status = ListingStatus.Cancelled;
        listing.updatedAt = uint64(block.timestamp);
        activeListingIdByAgentId[listing.agentId] = 0;

        emit ListingCancelled(listingId);
    }

    // ============================================================ Bids ====

    function placeBid(uint256 listingId, uint256 amountUsdc) external whenNotPaused nonReentrant returns (uint256 bidId) {
        Listing storage listing = listings[listingId];
        if (listing.status != ListingStatus.Active) revert ListingNotActive();
        if (amountUsdc == 0) revert ZeroAmount();

        if (listing.mode == ListingMode.Auction) {
            if (block.timestamp > listing.endTime) revert AuctionEnded();

            uint256 previousHighestId = listing.highestBidId;
            if (previousHighestId != 0) {
                Bid storage previousHighest = bids[previousHighestId];
                if (amountUsdc <= previousHighest.amountUsdc) revert BidTooLow();
                // Normally always true here (see {withdrawBid}: the highest bid can only
                // become inactive before endTime through this very refund path), but
                // checked defensively rather than assumed.
                if (previousHighest.active) {
                    previousHighest.active = false;
                    usdc.safeTransfer(previousHighest.bidder, previousHighest.amountUsdc);
                    emit BidOutbidRefunded(previousHighestId, previousHighest.bidder, previousHighest.amountUsdc);
                }
            }
        }

        usdc.safeTransferFrom(msg.sender, address(this), amountUsdc);

        bidId = _nextBidId++;
        bids[bidId] = Bid({
            bidId: bidId,
            listingId: listingId,
            bidder: msg.sender,
            amountUsdc: amountUsdc,
            active: true,
            createdAt: uint64(block.timestamp)
        });

        if (listing.mode == ListingMode.Auction) {
            listing.highestBidId = bidId;
            if (listing.endTime - block.timestamp < ANTI_SNIPE_EXTENSION_WINDOW) {
                listing.endTime = block.timestamp + ANTI_SNIPE_EXTENSION_WINDOW;
            }
        }
        listing.updatedAt = uint64(block.timestamp);

        emit BidPlaced(bidId, listingId, msg.sender, amountUsdc);
    }

    /// @notice Withdraws a bid's escrowed USDC back to the bidder. Always allowed for Open
    /// listings and for any non-highest Auction bid. The current-highest Auction bid is
    /// locked only while the auction is still Active and before its `endTime` — once the
    /// scheduled end passes, even the highest bidder can reclaim their funds if nobody has
    /// called {settleAuction} yet, so funds can never be permanently stuck behind a slow
    /// keeper or a stale approval (see {settleAuction}, which re-checks the bid is still
    /// active before paying out, so this race is safe either way it resolves).
    function withdrawBid(uint256 bidId) external nonReentrant {
        Bid storage bid = bids[bidId];
        if (!bid.active) revert BidNotActive();
        if (bid.bidder != msg.sender) revert NotBidder();

        Listing storage listing = listings[bid.listingId];
        bool isLockedHighestAuctionBid = listing.mode == ListingMode.Auction &&
            listing.highestBidId == bidId &&
            listing.status == ListingStatus.Active &&
            block.timestamp <= listing.endTime;
        if (isLockedHighestAuctionBid) revert BidNotWithdrawable();

        bid.active = false;
        usdc.safeTransfer(msg.sender, bid.amountUsdc);

        emit BidWithdrawn(bidId, msg.sender, bid.amountUsdc);
    }

    /// @notice Seller accepts any open bid on an `Open`-mode listing, at any time — bids may
    /// be above or below the listing's fair-value snapshot. Auction-mode listings only ever
    /// settle via {settleAuction}, never early.
    function acceptBid(uint256 listingId, uint256 bidId) external nonReentrant {
        Listing storage listing = listings[listingId];
        if (listing.status != ListingStatus.Active) revert ListingNotActive();
        if (listing.mode != ListingMode.Open) revert WrongListingMode();
        if (listing.seller != msg.sender) revert NotSeller();

        Bid storage bid = bids[bidId];
        if (bid.listingId != listingId || !bid.active) revert BidNotActive();

        bid.active = false;
        listing.status = ListingStatus.Sold;
        listing.updatedAt = uint64(block.timestamp);
        activeListingIdByAgentId[listing.agentId] = 0;

        _settleSale(listing, bid);
    }

    /// @notice Permissionlessly settles an Auction listing once its `endTime` has passed —
    /// mirrors Core's `autoReleaseExpired` precedent, since no chain can self-execute at a
    /// future timestamp; a keeper bot calls this automatically for good UX, but anyone can.
    /// If the highest bid was withdrawn in the post-endTime race window (see {withdrawBid})
    /// or never met the reserve price, the listing simply expires unsold.
    function settleAuction(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        if (listing.status != ListingStatus.Active) revert ListingNotActive();
        if (listing.mode != ListingMode.Auction) revert WrongListingMode();
        if (block.timestamp <= listing.endTime) revert AuctionNotEnded();

        Bid storage highest = bids[listing.highestBidId];
        bool hasWinningBid = listing.highestBidId != 0 && highest.active && highest.amountUsdc >= listing.reservePriceUsdc;

        activeListingIdByAgentId[listing.agentId] = 0;
        listing.updatedAt = uint64(block.timestamp);

        if (!hasWinningBid) {
            listing.status = ListingStatus.Expired;
            emit ListingExpiredUnsold(listingId);
            return;
        }

        highest.active = false;
        listing.status = ListingStatus.Sold;

        _settleSale(listing, highest);
    }

    function _settleSale(Listing storage listing, Bid storage winningBid) private {
        uint256 creatorShare = (winningBid.amountUsdc * 50) / 100; // 50%
        uint256 agentShare = (winningBid.amountUsdc * 30) / 100;   // 30%
        uint256 protocolShare = winningBid.amountUsdc - creatorShare - agentShare; // 20%

        address wallet = address(0);
        try core.agentWalletRegistry() returns (address registry) {
            if (registry != address(0)) {
                try IAgentWalletRegistryExchange(registry).agentWallet(listing.agentId) returns (address w) {
                    wallet = w;
                } catch {}
            }
        } catch {}
        address agentDest = wallet != address(0) ? wallet : listing.seller;

        if (creatorShare > 0) {
            usdc.safeTransfer(listing.seller, creatorShare);
        }
        if (agentShare > 0) {
            usdc.safeTransfer(agentDest, agentShare);
        }
        if (protocolShare > 0 && treasury != address(0)) {
            usdc.safeTransfer(treasury, protocolShare);
        }

        core.transferAgentOwnershipFromExchange(listing.agentId, winningBid.bidder);

        emit ListingSold(listing.listingId, listing.agentId, listing.seller, winningBid.bidder, winningBid.amountUsdc, listing.mode);
    }

    // ============================================================== Admin =

    function setProtocolFeeBps(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newFeeBps <= 10_000, "FeeTooHigh");
        protocolFeeBps = newFeeBps;
        emit ProtocolFeeUpdated(newFeeBps);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "ZeroAddress");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
