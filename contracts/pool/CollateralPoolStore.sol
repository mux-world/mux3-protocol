// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";

import "../interfaces/IMux3Core.sol";
import "../interfaces/ICollateralPool.sol";
import "./CollateralPoolToken.sol";

contract CollateralPoolStore is CollateralPoolToken {
    address internal immutable _core;
    address internal immutable _orderBook;
    address internal immutable _weth;
    address internal immutable _eventEmitter;

    mapping(bytes32 => bytes32) internal _configTable;
    address internal _unused1; // was _core
    address internal _collateralToken;
    uint8 internal _unused2; // was _collateralDecimals
    uint256 internal _unused3; // was _liquidityBalance
    EnumerableSetUpgradeable.Bytes32Set internal _marketIds;
    mapping(bytes32 => MarketState) internal _marketStates; // marketId => Market
    mapping(address => uint256) internal _liquidityBalances; // token => balance(1e18)

    bytes32[49] private _gaps;

    function __CollateralPoolStore_init(address collateralToken) internal onlyInitializing {
        _collateralToken = collateralToken;
    }
}
