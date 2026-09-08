// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {XeroPair} from "./XeroPair.sol";
import {IXeroFactory} from "./interfaces/IXeroFactory.sol";
import {IXeroPair} from "./interfaces/IXeroPair.sol";

/// @title XeroFactory
/// @notice Deploys and tracks XeroPair pools, one per unordered token pair, via CREATE2 — a
/// faithful port of Uniswap V2's UniswapV2Factory. `feeTo`/`feeToSetter` gate the optional
/// protocol fee (see XeroPair's `_mintFee`); `feeTo` starts unset (disabled), matching this
/// app's existing "off until an admin explicitly opts in" convention (e.g.
/// ClawdHQLaunchpad.uniswapV2Router itself starts at address(0)).
contract XeroFactory is IXeroFactory {
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    error IdenticalAddresses();
    error ZeroAddress();
    error PairExists();
    error Forbidden();

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @dev Pair deployment is parameter-free (`XeroPair`'s constructor takes no args) so the
    /// pair's address is a pure function of `(address(this), salt)` — `initialize` sets
    /// token0/token1 separately right after CREATE2 deploy.
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        bytes memory bytecode = type(XeroPair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        IXeroPair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate both directions in one createPair call
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        feeToSetter = _feeToSetter;
    }
}
