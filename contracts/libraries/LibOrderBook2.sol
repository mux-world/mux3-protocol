// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/IAccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

import "../interfaces/ICollateralPool.sol";
import "../interfaces/IMux3Core.sol";
import "../interfaces/IMux3FeeDistributor.sol";
import "../interfaces/IMarket.sol";
import "../interfaces/IOrderBook.sol";
import "../interfaces/IWETH9.sol";
import "../interfaces/ICallback.sol";
import "../interfaces/ICallbackRegister.sol";
import "../libraries/LibCodec.sol";
import "../libraries/LibConfigMap.sol";
import "../libraries/LibEthUnwrapper.sol";
import "../libraries/LibOrder.sol";
import "../libraries/LibOrderBook.sol";

library LibOrderBook2 {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using LibTypeCast for bytes32;
    using LibTypeCast for uint256;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.UintSet;
    using LibConfigMap for mapping(bytes32 => bytes32);

    function placeLiquidityOrder(
        OrderBookStorage storage orderBook,
        LiquidityOrderParams memory orderParams,
        address account,
        uint64 blockTimestamp
    ) external {
        require(orderParams.rawAmount != 0, "Zero amount");
        LibOrderBook._validatePool(orderBook, orderParams.poolAddress);
        if (orderParams.isAdding) {
            require(!LibOrderBook._isPoolDraining(orderParams.poolAddress), "Draining pool");
            address collateralToken = ICollateralPool(orderParams.poolAddress).collateralToken();
            require(orderParams.token == collateralToken, "Token mismatch");
            LibOrderBook._transferIn(orderBook, orderParams.token, orderParams.rawAmount); // collateral
        } else {
            LibOrderBook._transferIn(orderBook, orderParams.poolAddress, orderParams.rawAmount); // share
            LibOrderBook._validateCollateral(orderBook, orderParams.token);
        }
        uint64 orderId = orderBook.nextOrderId++;
        uint64 gasFeeGwei = LibOrderBook._orderGasFeeGwei(orderBook);
        LibOrderBook._deductGasFee(orderBook, account, gasFeeGwei);
        OrderData memory orderData = LibOrder.encodeLiquidityOrder(
            orderParams,
            orderId,
            account,
            blockTimestamp,
            gasFeeGwei
        );
        LibOrderBook._appendOrder(orderBook, orderData);
        emit IOrderBook.NewLiquidityOrder(account, orderId, orderParams);
    }

    function fillLiquidityOrder(
        OrderBookStorage storage orderBook,
        uint64 orderId,
        IFacetOpen.ReallocatePositionArgs[] memory reallocateArgs,
        uint64 blockTimestamp
    ) external returns (uint256 outAmount) {
        require(orderBook.orders.contains(orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[orderId];
        LibOrderBook._removeOrder(orderBook, orderData);
        require(orderData.orderType == OrderType.LiquidityOrder, "Order type mismatch");
        // fill
        LiquidityOrderParams memory orderParams = LibOrder.decodeLiquidityOrder(orderData);
        uint256 lockPeriod = LibOrderBook._liquidityLockPeriod(orderBook);
        require(blockTimestamp >= orderData.placeOrderTime + lockPeriod, "Liquidity order is under lock period");
        uint256 lpPrice;
        uint256 collateralPrice;
        if (orderParams.isAdding) {
            require(!LibOrderBook._isPoolDraining(orderParams.poolAddress), "Draining pool");
            (outAmount, lpPrice, collateralPrice) = _fillAddLiquidityOrder(
                orderBook,
                orderData,
                orderParams,
                reallocateArgs
            );
        } else {
            (outAmount, lpPrice, collateralPrice) = _fillRemoveLiquidityOrder(
                orderBook,
                orderData,
                orderParams,
                reallocateArgs
            );
        }
        emit IOrderBook.FillOrder(orderData.account, orderId, orderData);
        // gas
        LibOrderBook._payGasFee(orderBook, orderData, msg.sender);
        _runLiquidityCallback(orderBook, orderId, orderData, orderParams, outAmount, lpPrice, collateralPrice);
    }

    function _runLiquidityCallback(
        OrderBookStorage storage orderBook,
        uint64 orderId,
        OrderData memory orderData,
        LiquidityOrderParams memory orderParams,
        uint256 outAmount,
        uint256 lpPrice,
        uint256 collateralPrice
    ) internal {
        address callback = orderData.account;
        address register = _callbackRegister(orderBook);
        if (!ICallbackRegister(register).isCallbackRegistered(callback)) {
            return;
        }
        uint256 assetAmount = orderParams.isAdding ? orderParams.rawAmount : outAmount;
        uint256 lpAmount = orderParams.isAdding ? outAmount : orderParams.rawAmount;
        try
            ICallback(callback).afterLiquidityOrderFilled{ gas: _callbackGasLimit(orderBook) }(
                orderId,
                assetAmount,
                lpAmount,
                collateralPrice,
                lpPrice
            )
        {} catch (bytes memory reason) {
            emit IOrderBook.CallbackFailed(callback, orderId, reason);
        }
    }

    function _callbackRegister(OrderBookStorage storage orderBook) internal view returns (address register) {
        register = orderBook.configTable.getAddress(MCO_CALLBACK_REGISTER);
        require(register != address(0), "Callback register not set");
    }

    function _callbackGasLimit(OrderBookStorage storage orderBook) internal view returns (uint256) {
        uint256 callbackGasLimit = orderBook.configTable.getUint256(MCO_CALLBACK_GAS_LIMIT);
        return callbackGasLimit == 0 ? gasleft() : callbackGasLimit;
    }

    function _fillAddLiquidityOrder(
        OrderBookStorage storage orderBook,
        OrderData memory orderData,
        LiquidityOrderParams memory orderParams,
        IFacetOpen.ReallocatePositionArgs[] memory reallocateArgs
    ) internal returns (uint256 outAmount, uint256 lpPrice, uint256 collateralPrice) {
        // reallocate
        // when adding liquidity to a pool (called focusPool), its utilization will decrease.
        // the focusPool is eager to receive positions from other pools.
        // however, since this is not absolutely necessary, reallocate is temporarily not supported here for simplicity.
        require(reallocateArgs.length == 0, "addLiquidity + reallocate is not supported");
        // min order protection
        address collateralAddress = ICollateralPool(orderParams.poolAddress).collateralToken();
        {
            uint256 price = LibOrderBook._priceOf(orderBook, collateralAddress);
            uint256 value = (LibOrderBook._collateralToWad(orderBook, collateralAddress, orderParams.rawAmount) *
                price) / 1e18;
            uint256 minUsd = LibOrderBook._minLiquidityOrderUsd(orderBook);
            require(value >= minUsd, "Min liquidity order value");
        }
        // send collateral
        LibOrderBook._transferOut(
            orderBook,
            collateralAddress, // token
            orderParams.poolAddress, // receipt
            orderParams.rawAmount,
            false // isUnwrapWeth. CollateralPool never accepts ETH
        );
        // add liquidity
        ICollateralPool.AddLiquidityResult memory result = ICollateralPool(orderParams.poolAddress).addLiquidity(
            ICollateralPool.AddLiquidityArgs({
                account: orderData.account,
                rawCollateralAmount: orderParams.rawAmount,
                isUnwrapWeth: orderParams.isUnwrapWeth
            })
        );
        outAmount = result.shares;
        lpPrice = result.lpPrice;
        collateralPrice = result.collateralPrice;
    }

    function _fillRemoveLiquidityOrder(
        OrderBookStorage storage orderBook,
        OrderData memory orderData,
        LiquidityOrderParams memory orderParams,
        IFacetOpen.ReallocatePositionArgs[] memory reallocateArgs
    ) internal returns (uint256 outAmount, uint256 lpPrice, uint256 collateralPrice) {
        // reallocate is only allowed when withdrawing pool.collateralToken
        address poolCollateralToken = ICollateralPool(orderParams.poolAddress).collateralToken();
        if (orderParams.token != poolCollateralToken) {
            require(reallocateArgs.length == 0, "reallocate not allowed");
        }
        // reallocate
        // when removing liquidity from a pool (called focusPool), its utilization will increase.
        // the focusPool is eager to send positions to other pools.
        // 1. reallocate from focusPool to any pools, where `fromPool` = focusPool = orderParams.poolAddress
        // 2. the current lp will pay the position fees of the `toPool`
        // 3. removeLiquidity will deduct fees from returned collateral, the fees temporarily saved in `fromPool`
        // 4. `fromPool` then transfer fees to `toPool`
        uint256[] memory reallocateFeeCollaterals;
        uint256 totalReallocateFeeCollateral;
        if (reallocateArgs.length > 0) {
            (reallocateFeeCollaterals, totalReallocateFeeCollateral) = _getReallocatePositionFees(
                orderBook,
                reallocateArgs,
                orderParams.poolAddress, // focusPool
                false
            );
            for (uint256 i = 0; i < reallocateArgs.length; i++) {
                IFacetOpen(orderBook.mux3Facet).reallocatePosition(reallocateArgs[i]);
            }
        }
        // send share
        LibOrderBook._transferOut(
            orderBook,
            orderParams.poolAddress, // mlp
            orderParams.poolAddress, // receipt
            orderParams.rawAmount,
            false
        );
        // remove liquidity
        ICollateralPool.RemoveLiquidityResult memory result = ICollateralPool(orderParams.poolAddress).removeLiquidity(
            ICollateralPool.RemoveLiquidityArgs({
                account: orderData.account,
                shares: orderParams.rawAmount,
                token: orderParams.token,
                isUnwrapWeth: orderParams.isUnwrapWeth,
                extraFeeCollateral: totalReallocateFeeCollateral
            })
        );
        outAmount = result.rawCollateralAmount;
        lpPrice = result.lpPrice;
        collateralPrice = result.collateralPrice;
        // min order protection
        address collateralAddress = ICollateralPool(orderParams.poolAddress).collateralToken();
        {
            uint256 price = LibOrderBook._priceOf(orderBook, orderParams.token);
            uint256 value = (LibOrderBook._collateralToWad(orderBook, orderParams.token, outAmount) * price) / 1e18;
            uint256 minUsd = LibOrderBook._minLiquidityOrderUsd(orderBook);
            require(value >= minUsd, "Min liquidity order value");
        }
        // reallocate fees are temporarily held in OrderBook, now transfer them to other pools
        if (reallocateArgs.length > 0) {
            uint256 rawReallocationFee = LibOrderBook._collateralToRaw(
                orderBook,
                collateralAddress,
                totalReallocateFeeCollateral
            );
            address feeDistributor = LibOrderBook._feeDistributor(orderBook);
            if (rawReallocationFee > 0) {
                LibOrderBook._transferIn(orderBook, collateralAddress, rawReallocationFee);
                LibOrderBook._transferOut(orderBook, collateralAddress, feeDistributor, rawReallocationFee, false);
            }
            for (uint256 i = 0; i < reallocateArgs.length; i++) {
                address toPool = reallocateArgs[i].toPool;
                require(!LibOrderBook._isPoolDraining(toPool), "toPool is draining");
                require(toPool != reallocateArgs[i].fromPool, "fromPool and toPool should be different");
                uint256 rawFee = LibOrderBook._collateralToRaw(
                    orderBook,
                    collateralAddress,
                    reallocateFeeCollaterals[i]
                );
                if (rawFee > 0) {
                    IMux3FeeDistributor(LibOrderBook._feeDistributor(orderBook)).updateLiquidityFees(
                        orderData.account, // lp
                        toPool, // pool = the other pool
                        collateralAddress,
                        rawFee,
                        orderParams.isUnwrapWeth
                    );
                }
            }
        }
    }

    function _getReallocatePositionFees(
        OrderBookStorage storage orderBook,
        IFacetOpen.ReallocatePositionArgs[] memory reallocateArgs,
        address focusPool,
        bool isAdding
    )
        internal
        view
        returns (
            uint256[] memory feeCollaterals, // 1e18
            uint256 totalFeeCollateral // 1e18
        )
    {
        // the focusPool is always paying positionFee
        uint256 collateralPrice;
        {
            address collateralAddress = ICollateralPool(focusPool).collateralToken();
            collateralPrice = LibOrderBook._priceOf(orderBook, collateralAddress);
        }
        // the opposite pool
        feeCollaterals = new uint256[](reallocateArgs.length);
        for (uint256 i = 0; i < reallocateArgs.length; i++) {
            IFacetOpen.ReallocatePositionArgs memory arg = reallocateArgs[i];
            if (isAdding) {
                require(arg.toPool == focusPool, "toPool should be the focusPool");
            } else {
                require(arg.fromPool == focusPool, "fromPool should be the focusPool");
            }
            // feeCollateral = marketPrice * size * positionFeeRate / collateralPrice
            uint256 positionFeeCollateral = arg.size;
            {
                uint256 price = LibOrderBook._priceOf(orderBook, LibOrderBook._marketOracleId(orderBook, arg.marketId));
                positionFeeCollateral = (positionFeeCollateral * price) / 1e18;
            }
            {
                uint256 positionFeeRate = LibOrderBook._positionFeeRate(orderBook, arg.marketId);
                positionFeeCollateral = (positionFeeCollateral * positionFeeRate) / collateralPrice;
            }
            feeCollaterals[i] = positionFeeCollateral;
            totalFeeCollateral += positionFeeCollateral;
        }
    }

    function depositCollateral(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        address collateralToken,
        uint256 collateralAmount
    ) external {
        require(collateralAmount != 0, "Zero collateral");
        LibOrderBook._transferIn(orderBook, collateralToken, collateralAmount);
        LibOrderBook._transferOut(orderBook, collateralToken, address(orderBook.mux3Facet), collateralAmount, false);
        IFacetPositionAccount(orderBook.mux3Facet).deposit(positionId, collateralToken, collateralAmount);
    }

    function updateBorrowingFee(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        bytes32 marketId,
        address lastConsumedToken,
        bool isUnwrapWeth
    ) external {
        IFacetPositionAccount(orderBook.mux3Facet).updateBorrowingFee(
            positionId,
            marketId,
            lastConsumedToken,
            isUnwrapWeth
        );
    }

    function placeRebalanceOrder(
        OrderBookStorage storage orderBook,
        address rebalancer,
        RebalanceOrderParams memory orderParams,
        uint64 blockTimestamp
    ) external returns (uint64 newOrderId) {
        require(orderParams.rawAmount0 != 0, "Zero amount");
        newOrderId = orderBook.nextOrderId++;
        OrderData memory orderData = LibOrder.encodeRebalanceOrder(orderParams, newOrderId, blockTimestamp, rebalancer);
        LibOrderBook._appendOrder(orderBook, orderData);
        emit IOrderBook.NewRebalanceOrder(rebalancer, newOrderId, orderParams);
    }

    function fillRebalanceOrder(OrderBookStorage storage orderBook, uint64 orderId) external {
        require(orderBook.orders.contains(orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[orderId];
        LibOrderBook._removeOrder(orderBook, orderData);
        require(orderData.orderType == OrderType.RebalanceOrder, "Order type mismatch");
        RebalanceOrderParams memory orderParams = LibOrder.decodeRebalanceOrder(orderData);
        ICollateralPool(orderParams.poolAddress).rebalance(
            orderData.account,
            orderParams.token0,
            orderParams.rawAmount0,
            orderParams.maxRawAmount1,
            orderParams.userData
        );
        emit IOrderBook.FillOrder(orderData.account, orderId, orderData);
    }

    function withdrawAllCollateral(
        OrderBookStorage storage orderBook,
        WithdrawAllOrderParams memory orderParams
    ) external {
        require(
            LibOrderBook._isPositionAccountFullyClosed(orderBook, orderParams.positionId),
            "Position account is not fully closed"
        );
        IFacetPositionAccount(orderBook.mux3Facet).withdrawAll(
            IFacetPositionAccount.WithdrawAllArgs({
                positionId: orderParams.positionId,
                isUnwrapWeth: orderParams.isUnwrapWeth,
                // OrderBook.withdrawAll can not support swap. because OrderBook.withdrawAll is not called by broker,
                // so there is no reference prices.
                withdrawSwapToken: address(0),
                withdrawSwapSlippage: 0
            })
        );
    }

    function placeWithdrawalOrder(
        OrderBookStorage storage orderBook,
        WithdrawalOrderParams memory orderParams,
        uint64 blockTimestamp
    ) external {
        LibOrderBook._validateCollateral(orderBook, orderParams.tokenAddress);
        if (orderParams.lastConsumedToken != address(0)) {
            LibOrderBook._validateCollateral(orderBook, orderParams.lastConsumedToken);
        }
        if (orderParams.withdrawSwapToken != address(0)) {
            LibOrderBook._validateCollateral(orderBook, orderParams.withdrawSwapToken);
        }
        require(orderParams.rawAmount != 0, "Zero amount");
        require(orderParams.withdrawSwapSlippage <= 1e18, "withdrawSwapSlippage too large");
        (address withdrawAccount, ) = LibCodec.decodePositionId(orderParams.positionId);
        uint64 newOrderId = orderBook.nextOrderId++;
        uint64 gasFeeGwei = LibOrderBook._orderGasFeeGwei(orderBook);
        LibOrderBook._deductGasFee(orderBook, withdrawAccount, gasFeeGwei);
        OrderData memory orderData = LibOrder.encodeWithdrawalOrder(
            orderParams,
            newOrderId,
            blockTimestamp,
            withdrawAccount,
            gasFeeGwei
        );
        LibOrderBook._appendOrder(orderBook, orderData);
        emit IOrderBook.NewWithdrawalOrder(withdrawAccount, newOrderId, orderParams);
    }

    function fillWithdrawalOrder(OrderBookStorage storage orderBook, uint64 orderId, uint64 blockTimestamp) external {
        require(orderBook.orders.contains(orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[orderId];
        LibOrderBook._removeOrder(orderBook, orderData);
        require(orderData.orderType == OrderType.WithdrawalOrder, "Order type mismatch");
        WithdrawalOrderParams memory orderParams = LibOrder.decodeWithdrawalOrder(orderData);
        uint64 deadline = orderData.placeOrderTime + LibOrderBook._withdrawalOrderTimeout(orderBook);
        require(blockTimestamp <= deadline, "Order expired");
        // fill
        IFacetPositionAccount(orderBook.mux3Facet).withdraw(
            IFacetPositionAccount.WithdrawArgs({
                positionId: orderParams.positionId,
                collateralToken: orderParams.tokenAddress,
                amount: orderParams.rawAmount,
                lastConsumedToken: orderParams.lastConsumedToken,
                isUnwrapWeth: orderParams.isUnwrapWeth,
                withdrawSwapToken: orderParams.withdrawSwapToken,
                withdrawSwapSlippage: orderParams.withdrawSwapSlippage
            })
        );
        emit IOrderBook.FillOrder(orderData.account, orderId, orderData);
        // gas
        LibOrderBook._payGasFee(orderBook, orderData, msg.sender);
    }

    function modifyPositionOrder(
        OrderBookStorage storage orderBook,
        ModifyPositionOrderParams memory modifyParams,
        uint64 blockTimestamp
    ) external {
        require(orderBook.orders.contains(modifyParams.orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[modifyParams.orderId];
        // verify order
        require(orderData.orderType == OrderType.PositionOrder, "Order type mismatch");
        PositionOrderParams memory orderParams = LibOrder.decodePositionOrder(orderData);
        require(modifyParams.positionId == orderParams.positionId, "PositionId mismatch");
        // check cool down and expiration
        uint256 coolDown = LibOrderBook._cancelCoolDown(orderBook);
        require(blockTimestamp >= orderData.placeOrderTime + coolDown, "Cool down");
        uint256 deadline = MathUpgradeable
            .min(
                orderData.placeOrderTime + LibOrderBook._positionOrderTimeout(orderBook, orderParams),
                orderParams.expiration
            )
            .toUint64();
        require(blockTimestamp <= deadline, "Order expired");
        // modify limitPrice
        if (modifyParams.limitPrice > 0) {
            orderParams.limitPrice = modifyParams.limitPrice;
        }
        // modify tp/sl
        if (LibOrder.isOpenPosition(orderParams)) {
            bool isLong = LibOrderBook._isMarketLong(orderBook, orderParams.marketId);
            // open position
            if (modifyParams.tpPriceDiff > 0) {
                require(orderParams.tpPriceDiff > 0, "Original order has no tp");
                if (!isLong) {
                    // close a short means buy, tp means limitPrice = tradingPrice * (1 - tpPriceDiff)
                    require(modifyParams.tpPriceDiff < 1e18, "tpPriceDiff too large");
                }
                orderParams.tpPriceDiff = modifyParams.tpPriceDiff;
            }
            if (modifyParams.slPriceDiff > 0) {
                require(orderParams.slPriceDiff > 0, "Original order has no sl");
                if (isLong) {
                    // close a long means sell, sl means limitPrice = tradingPrice * (1 - slPriceDiff)
                    require(modifyParams.slPriceDiff < 1e18, "slPriceDiff too large");
                }
                orderParams.slPriceDiff = modifyParams.slPriceDiff;
            }
        } else {
            // tp/sl strategy is not supported
            require(
                modifyParams.tpPriceDiff == 0 && modifyParams.slPriceDiff == 0,
                "Place multiple close-position orders instead"
            );
        }
        // done
        orderBook.orderData[orderData.id] = LibOrder.encodePositionOrder(
            orderParams,
            orderData.id,
            orderData.account,
            orderData.placeOrderTime,
            orderData.gasFeeGwei
        );
        emit IOrderBook.ModifyPositionOrder(orderData.account, modifyParams.orderId, modifyParams);
    }
}
