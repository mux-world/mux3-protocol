// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "../../interfaces/IFeeDistributor.sol";
import "../../interfaces/IFacetReader.sol";
import "../../interfaces/IPositionAccount.sol";
import "../../interfaces/IMarket.sol";
import "../../interfaces/IRoles.sol";

contract MockFeeDistributor is IFeeDistributor {
    address private _mux3Facet;

    constructor(address mux3Facet) {
        _mux3Facet = mux3Facet;
    }
    function updateLiquidityFees(
        address lp,
        address poolAddress,
        uint256 amount // decimals = 18
    ) external override {}
    function updatePositionFees(
        address trader,
        bytes32 marketId,
        bytes32 positionId,
        address[] memory feeAddresses,
        uint256[] memory feeAmounts, // [amount foreach feeAddresses], decimals = 18
        uint256[] memory allocations // [amount foreach backed pools], decimals = 18
    ) external override {}
}
