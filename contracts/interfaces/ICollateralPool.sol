// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "../interfaces/IBorrowingRate.sol";

struct MarketState {
    bool isLong;
    uint256 totalSize;
    uint256 averageEntryPrice;
    uint256 cumulatedBorrowingPerUsd; // $borrowingFee / $positionValue, always increasing
    uint256 lastBorrowingUpdateTime;
}

interface ICollateralPool {
    function setConfig(bytes32 key, bytes32 value) external;

    function configValue(bytes32 key) external view returns (bytes32);

    function collateralToken() external view returns (address);

    function borrowingFeeRateApy(bytes32 marketId) external view returns (uint256 feeRateApy);

    function markets() external view returns (bytes32[] memory);

    function marketState(bytes32 marketId) external view returns (MarketState memory);

    function marketStates() external view returns (bytes32[] memory marketIds, MarketState[] memory states);

    function setMarket(bytes32 marketId, bool isLong) external;

    function liquidityBalances() external view returns (address[] memory tokens, uint256[] memory balances);

    function getCollateralTokenUsd() external view returns (uint256);

    function getAumUsd() external view returns (uint256);

    function getReservedUsd() external view returns (uint256);

    function openPosition(bytes32 marketId, uint256 size, uint256 entryPrice) external;

    function closePosition(bytes32 marketId, uint256 size, uint256 entryPrice) external;

    function realizeProfit(
        uint256 pnlUsd
    )
        external
        returns (
            address token,
            uint256 wad // 1e18
        );

    function realizeLoss(
        address token,
        uint256 rawAmount // token decimals
    ) external;

    struct AddLiquidityArgs {
        address account; // lp address
        uint256 rawCollateralAmount; // token in. token decimals
        bool isUnwrapWeth; // useful for discount
    }

    struct AddLiquidityResult {
        uint256 shares;
        uint256 collateralPrice;
        uint256 lpPrice;
    }

    function addLiquidity(AddLiquidityArgs memory args) external returns (AddLiquidityResult memory result);

    struct RemoveLiquidityArgs {
        address account; // lp address
        uint256 shares; // token in. 1e18
        address token; // token out
        bool isUnwrapWeth; // useful for discount
        uint256 extraFeeCollateral; // 1e18, amount of pool.collateralToken
    }

    struct RemoveLiquidityResult {
        uint256 rawCollateralAmount; // token out. token decimals
        uint256 collateralPrice;
        uint256 lpPrice;
    }

    function removeLiquidity(RemoveLiquidityArgs memory args) external returns (RemoveLiquidityResult memory result);

    function rebalance(
        address rebalancer,
        address token0,
        uint256 rawAmount0, // token0 decimals
        uint256 maxRawAmount1, // collateralToken decimals
        bytes memory userData
    ) external returns (uint256 rawAmount1);

    function receiveFee(
        address token,
        uint256 rawAmount // token.decimals
    ) external;

    function updateMarketBorrowing(bytes32 marketId) external returns (uint256 newCumulatedBorrowingPerUsd);

    function makeBorrowingContext(bytes32 marketId) external view returns (IBorrowingRate.AllocatePool memory);

    function positionPnl(
        bytes32 marketId,
        uint256 size,
        uint256 entryPrice,
        uint256 marketPrice
    ) external view returns (int256 pnlUsd, int256 cappedPnlUsd);
}
