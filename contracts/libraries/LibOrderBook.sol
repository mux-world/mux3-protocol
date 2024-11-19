// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/IAccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

import "../interfaces/ICollateralPool.sol";
import "../interfaces/IMux3Core.sol";
import "../interfaces/IMarket.sol";
import "../interfaces/IOrderBook.sol";
import "../interfaces/IWETH9.sol";
import "../libraries/LibCodec.sol";
import "../libraries/LibConfigMap.sol";
import "../libraries/LibEthUnwrapper.sol";
import "../libraries/LibOrder.sol";

library LibOrderBook {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using LibTypeCast for bytes32;
    using LibTypeCast for uint256;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.UintSet;
    using LibConfigMap for mapping(bytes32 => bytes32);

    function _appendOrder(OrderBookStorage storage orderBook, OrderData memory orderData) internal {
        orderBook.orderData[orderData.id] = orderData;
        require(
            orderBook.orders.add(orderData.id) && orderBook.userOrders[orderData.account].add(orderData.id),
            "Failed to append order"
        );
    }

    function _removeOrder(OrderBookStorage storage orderBook, OrderData memory orderData) internal {
        require(
            orderBook.userOrders[orderData.account].remove(orderData.id) && orderBook.orders.remove(orderData.id),
            "Failed to remove order"
        );
        delete orderBook.orderData[orderData.id];
    }

    function placeLiquidityOrder(
        OrderBookStorage storage orderBook,
        LiquidityOrderParams memory orderParams,
        address account,
        uint64 blockTimestamp
    ) external {
        require(orderParams.rawAmount != 0, "Zero amount");
        _validatePool(orderBook, orderParams.poolAddress);
        if (orderParams.isAdding) {
            address collateralAddress = ICollateralPool(orderParams.poolAddress).collateralToken();
            _transferIn(orderBook, collateralAddress, orderParams.rawAmount);
        } else {
            _transferIn(orderBook, orderParams.poolAddress, orderParams.rawAmount);
        }
        uint64 orderId = orderBook.nextOrderId++;
        uint64 gasFeeGwei = _orderGasFeeGwei(orderBook);
        _deductGasFee(orderBook, account, gasFeeGwei);
        OrderData memory orderData = LibOrder.encodeLiquidityOrder(
            orderParams,
            orderId,
            account,
            blockTimestamp,
            gasFeeGwei
        );
        _appendOrder(orderBook, orderData);
        emit IOrderBook.NewLiquidityOrder(account, orderId, orderParams);
    }

    function fillLiquidityOrder(
        OrderBookStorage storage orderBook,
        uint64 orderId,
        uint64 blockTimestamp
    ) external returns (uint256 outAmount) {
        require(orderBook.orders.contains(orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[orderId];
        _removeOrder(orderBook, orderData);
        require(orderData.orderType == OrderType.LiquidityOrder, "Order type mismatch");
        // fill
        LiquidityOrderParams memory orderParams = LibOrder.decodeLiquidityOrder(orderData);
        uint256 lockPeriod = _liquidityLockPeriod(orderBook);
        require(blockTimestamp >= orderData.placeOrderTime + lockPeriod, "Liquidity order is under lock period");
        if (orderParams.isAdding) {
            address collateralAddress = ICollateralPool(orderParams.poolAddress).collateralToken();
            _transferOut(
                orderBook,
                collateralAddress, // token
                orderParams.poolAddress, // receipt
                orderParams.rawAmount,
                false // unwrap eth
            );
            outAmount = ICollateralPool(orderParams.poolAddress).addLiquidity(orderData.account, orderParams.rawAmount);
        } else {
            // note: lp token is still in the OrderBook
            outAmount = ICollateralPool(orderParams.poolAddress).removeLiquidity(
                orderData.account,
                orderParams.rawAmount,
                orderParams.isUnwrapWeth
            );
        }
        _payGasFee(orderBook, orderData, msg.sender);
        emit IOrderBook.FillOrder(orderData.account, orderId, orderData);
    }

    function donateLiquidity(
        OrderBookStorage storage orderBook,
        address poolAddress,
        address collateralAddress,
        uint256 rawAmount // token.decimals
    ) external {
        require(rawAmount != 0, "Zero amount");
        _validateCollateral(orderBook, collateralAddress);
        _validatePool(orderBook, poolAddress);
        _transferIn(orderBook, collateralAddress, rawAmount);
        _transferOut(orderBook, collateralAddress, poolAddress, rawAmount, false);
        ICollateralPool(poolAddress).receiveFee(collateralAddress, rawAmount);
    }

    function fillWithdrawalOrder(OrderBookStorage storage orderBook, uint64 orderId, uint64 blockTimestamp) external {
        require(orderBook.orders.contains(orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[orderId];
        _removeOrder(orderBook, orderData);
        require(orderData.orderType == OrderType.WithdrawalOrder, "Order type mismatch");
        WithdrawalOrderParams memory orderParams = LibOrder.decodeWithdrawalOrder(orderData);
        uint64 deadline = orderData.placeOrderTime + _withdrawalOrderTimeout(orderBook);
        require(blockTimestamp <= deadline, "Order expired");
        // fill
        IFacetPositionAccount(orderBook.mux3Facet).withdraw(
            orderParams.positionId,
            orderParams.tokenAddress,
            orderParams.rawAmount,
            orderParams.lastConsumedToken,
            orderParams.isUnwrapWeth,
            orderParams.withdrawSwapToken,
            orderParams.withdrawSwapSlippage
        );
        _payGasFee(orderBook, orderData, msg.sender);
        emit IOrderBook.FillOrder(orderData.account, orderId, orderData);
    }

    function placePositionOrder(
        OrderBookStorage storage orderBook,
        PositionOrderParams memory orderParams,
        uint64 blockTimestamp
    ) external {
        _validateMarketId(orderBook, orderParams.marketId);
        require(orderParams.size != 0, "Position order size = 0");
        {
            uint256 lotSize = _lotSize(orderBook, orderParams.marketId);
            require(orderParams.size % lotSize == 0, "size must be a multiple of lot size");
        }
        require(!LibOrder.isAdl(orderParams), "ADL is not allowed");
        require(orderParams.limitPrice > 0, "Position order must have limitPrice");
        require(orderParams.expiration > blockTimestamp, "Expiration is earlier than now");
        if (orderParams.lastConsumedToken != address(0)) {
            _validateCollateral(orderBook, orderParams.lastConsumedToken);
        }
        if (LibOrder.isOpenPosition(orderParams)) {
            _placeOpenPositionOrder(orderBook, orderParams, blockTimestamp);
        } else {
            _placeClosePositionOrder(orderBook, orderParams, blockTimestamp);
        }
    }

    function _placeOpenPositionOrder(
        OrderBookStorage storage orderBook,
        PositionOrderParams memory orderParams,
        uint64 blockTimestamp
    ) private {
        require(orderParams.withdrawUsd == 0, "WithdrawUsd is not suitable for open-position");
        require(orderParams.withdrawSwapToken == address(0), "WithdrawSwapToken is not suitable for open-position");
        require(orderParams.withdrawSwapSlippage == 0, "WithdrawSwapSlippage is not suitable for open-position");
        // fetch collateral
        if (orderParams.collateralToken != address(0)) {
            _validateCollateral(orderBook, orderParams.collateralToken);
            if (orderParams.collateralAmount > 0) {
                // deposit collateral
                _transferIn(orderBook, orderParams.collateralToken, orderParams.collateralAmount);
            }
        }
        // add order
        uint64 gasFeeGwei = _orderGasFeeGwei(orderBook);
        _appendPositionOrder(orderBook, orderParams, blockTimestamp, gasFeeGwei);
        // tp/sl strategy
        if (orderParams.tpPriceDiff > 0 || orderParams.slPriceDiff > 0) {
            require(orderParams.tpslExpiration > blockTimestamp, "tpslExpiration is earlier than now");
            uint256 validFlags = POSITION_WITHDRAW_ALL_IF_EMPTY | POSITION_WITHDRAW_PROFIT | POSITION_UNWRAP_ETH;
            require((orderParams.tpslFlags & (~validFlags)) == 0, "Unsupported tpslFlags");
            if (orderParams.tpslWithdrawSwapToken != address(0)) {
                _validateCollateral(orderBook, orderParams.tpslWithdrawSwapToken);
            }
        }
    }

    function _placeClosePositionOrder(
        OrderBookStorage storage orderBook,
        PositionOrderParams memory orderParams,
        uint64 blockTimestamp
    ) private {
        require(orderParams.collateralToken == address(0) && orderParams.collateralAmount == 0, "Use withdraw instead");
        if (orderParams.withdrawSwapToken != address(0)) {
            _validateCollateral(orderBook, orderParams.withdrawSwapToken);
        }
        uint64 gasFeeGwei = _orderGasFeeGwei(orderBook);
        _appendPositionOrder(orderBook, orderParams, blockTimestamp, gasFeeGwei);
        // tp/sl strategy is not supported
        require(
            orderParams.tpPriceDiff == 0 &&
                orderParams.slPriceDiff == 0 &&
                orderParams.tpslExpiration == 0 &&
                orderParams.tpslFlags == 0 &&
                orderParams.tpslWithdrawSwapToken == address(0) &&
                orderParams.tpslWithdrawSwapSlippage == 0,
            "Place multiple close-position orders instead"
        );
    }

    function cancelActivatedTpslOrders(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        bytes32 marketId
    ) public {
        EnumerableSetUpgradeable.UintSet storage orderIds = orderBook.tpslOrders[positionId][marketId];
        uint256 length = orderIds.length();
        for (uint256 i = 0; i < length; i++) {
            uint64 orderId = uint64(orderIds.at(i));
            require(orderBook.orders.contains(orderId), "No such orderId");
            OrderData memory orderData = orderBook.orderData[orderId];
            OrderType orderType = OrderType(orderData.orderType);
            require(orderType == OrderType.PositionOrder, "Order type mismatch");
            PositionOrderParams memory orderParams = LibOrder.decodePositionOrder(orderData);
            require(
                !LibOrder.isOpenPosition(orderParams) && orderParams.collateralAmount == 0,
                "TP/SL order should be a CLOSE order and without collateralAmount"
            );
            _removeOrder(orderBook, orderData);
            emit IOrderBook.CancelOrder(orderData.account, orderId, orderData);
        }
        delete orderBook.tpslOrders[positionId][marketId];
    }

    function withdrawAllCollateral(
        OrderBookStorage storage orderBook,
        WithdrawAllOrderParams memory orderParams
    ) external {
        require(
            _isPositionAccountFullyClosed(orderBook, orderParams.positionId),
            "Position account is not fully closed"
        );
        if (orderParams.withdrawSwapToken != address(0)) {
            _validateCollateral(orderBook, orderParams.withdrawSwapToken);
        }
        IFacetPositionAccount(orderBook.mux3Facet).withdrawAll(
            orderParams.positionId,
            orderParams.isUnwrapWeth,
            orderParams.withdrawSwapToken,
            orderParams.withdrawSwapSlippage
        );
    }

    function placeWithdrawalOrder(
        OrderBookStorage storage orderBook,
        WithdrawalOrderParams memory orderParams,
        uint64 blockTimestamp
    ) external {
        if (orderParams.tokenAddress != address(0)) {
            _validateCollateral(orderBook, orderParams.tokenAddress);
        }
        if (orderParams.lastConsumedToken != address(0)) {
            _validateCollateral(orderBook, orderParams.lastConsumedToken);
        }
        if (orderParams.withdrawSwapToken != address(0)) {
            _validateCollateral(orderBook, orderParams.withdrawSwapToken);
        }
        require(orderParams.rawAmount != 0, "Zero amount");
        (address withdrawAccount, ) = LibCodec.decodePositionId(orderParams.positionId);
        uint64 newOrderId = orderBook.nextOrderId++;
        uint64 gasFeeGwei = _orderGasFeeGwei(orderBook);
        _deductGasFee(orderBook, withdrawAccount, gasFeeGwei);
        OrderData memory orderData = LibOrder.encodeWithdrawalOrder(
            orderParams,
            newOrderId,
            blockTimestamp,
            withdrawAccount,
            gasFeeGwei
        );
        _appendOrder(orderBook, orderData);
        emit IOrderBook.NewWithdrawalOrder(withdrawAccount, newOrderId, orderParams);
    }

    function fillPositionOrder(
        OrderBookStorage storage orderBook,
        uint64 orderId,
        uint64 blockTimestamp
    ) external returns (uint256 tradingPrice) {
        require(orderBook.orders.contains(orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[orderId];
        _removeOrder(orderBook, orderData);
        require(orderData.orderType == OrderType.PositionOrder, "Order type mismatch");
        PositionOrderParams memory orderParams = LibOrder.decodePositionOrder(orderData);
        uint256 deadline = MathUpgradeable
            .min(orderData.placeOrderTime + _positionOrderTimeout(orderBook, orderParams), orderParams.expiration)
            .toUint64();
        require(blockTimestamp <= deadline, "Order expired");
        // fill
        if (LibOrder.isOpenPosition(orderParams)) {
            tradingPrice = fillOpenPositionOrder(orderBook, orderParams, blockTimestamp);
        } else {
            tradingPrice = fillClosePositionOrder(orderBook, orderParams, orderId);
        }
        // price check
        // open,long      0,0   0,1   1,1   1,0
        // limitOrder     <=    >=    <=    >=
        // triggerOrder   >=    <=    >=    <=
        bool isLong = _isMarketLong(orderBook, orderParams.marketId);
        bool isLess = (isLong == LibOrder.isOpenPosition(orderParams));
        if (LibOrder.isTriggerOrder(orderParams)) {
            isLess = !isLess;
        }
        if (isLess) {
            require(tradingPrice <= orderParams.limitPrice, "limitPrice");
        } else {
            require(tradingPrice >= orderParams.limitPrice, "limitPrice");
        }
        _payGasFee(orderBook, orderData, msg.sender);
        emit IOrderBook.FillOrder(orderData.account, orderId, orderData);
    }

    function fillOpenPositionOrder(
        OrderBookStorage storage orderBook,
        PositionOrderParams memory orderParams,
        uint64 blockTimestamp
    ) internal returns (uint256 tradingPrice) {
        // auto deposit
        if (orderParams.collateralToken != address(0) && orderParams.collateralAmount > 0) {
            // deposit collateral
            _transferOut(
                orderBook,
                orderParams.collateralToken,
                address(orderBook.mux3Facet),
                orderParams.collateralAmount,
                false // unwrap eth
            );
            IFacetPositionAccount(orderBook.mux3Facet).deposit(
                orderParams.positionId,
                orderParams.collateralToken,
                orderParams.collateralAmount
            );
        }
        // open
        (tradingPrice, , ) = IFacetOpen(orderBook.mux3Facet).openPosition(
            orderParams.positionId,
            orderParams.marketId,
            orderParams.size,
            orderParams.lastConsumedToken
        );
        // tp/sl strategy
        if (orderParams.tpPriceDiff > 0 || orderParams.slPriceDiff > 0) {
            _placeTpslOrders(orderBook, orderParams, tradingPrice, blockTimestamp);
        }
    }

    function fillClosePositionOrder(
        OrderBookStorage storage orderBook,
        PositionOrderParams memory orderParams,
        uint64 orderId
    ) internal returns (uint256 tradingPrice) {
        // close
        int256[] memory poolPnlUsds;
        uint256 borrowingFeeUsd;
        uint256 positionFeeUsd;
        (tradingPrice, poolPnlUsds, borrowingFeeUsd, positionFeeUsd) = IFacetClose(orderBook.mux3Facet).closePosition(
            orderParams.positionId,
            orderParams.marketId,
            orderParams.size,
            orderParams.lastConsumedToken
        );
        // auto withdraw
        uint256 withdrawUsd = orderParams.withdrawUsd;
        if (LibOrder.isWithdrawProfit(orderParams)) {
            int256 pnlUsd = 0;
            for (uint256 i = 0; i < poolPnlUsds.length; i++) {
                pnlUsd += poolPnlUsds[i];
            }
            pnlUsd -= borrowingFeeUsd.toInt256();
            pnlUsd -= positionFeeUsd.toInt256();
            if (pnlUsd > 0) {
                withdrawUsd += uint256(pnlUsd);
            }
        }
        // auto withdraw
        if (withdrawUsd > 0) {
            IFacetPositionAccount(orderBook.mux3Facet).withdrawUsd(
                orderParams.positionId,
                withdrawUsd,
                orderParams.lastConsumedToken,
                LibOrder.isUnwrapWeth(orderParams),
                orderParams.withdrawSwapToken,
                orderParams.withdrawSwapSlippage
            );
        }
        // remove the current order from tp/sl list
        orderBook.tpslOrders[orderParams.positionId][orderParams.marketId].remove(uint256(orderId));
        // is the position completely closed
        if (_isPositionAccountFullyClosed(orderBook, orderParams.positionId)) {
            // auto withdraw
            if (LibOrder.isWithdrawIfEmpty(orderParams)) {
                IFacetPositionAccount(orderBook.mux3Facet).withdrawAll(
                    orderParams.positionId,
                    LibOrder.isUnwrapWeth(orderParams),
                    orderParams.withdrawSwapToken,
                    orderParams.withdrawSwapSlippage
                );
            }
        }
        if (_isPositionAccountMarketFullyClosed(orderBook, orderParams.positionId, orderParams.marketId)) {
            // cancel activated tp/sl orders
            cancelActivatedTpslOrders(orderBook, orderParams.positionId, orderParams.marketId);
        }
    }

    function liquidatePosition(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        bytes32 marketId,
        address lastConsumedToken,
        bool isWithdrawAll
    ) external returns (uint256 tradingPrice) {
        // close
        (tradingPrice, , , ) = IFacetClose(orderBook.mux3Facet).liquidatePosition(
            positionId,
            marketId,
            lastConsumedToken
        );
        // auto withdraw, equivalent to POSITION_WITHDRAW_ALL_IF_EMPTY
        if (isWithdrawAll) {
            // default values of isUnwrapWeth, withdrawSwapToken, withdrawSwapSlippage
            // so that mux3 looks like mux1
            IFacetPositionAccount(orderBook.mux3Facet).withdrawAll(
                positionId,
                true, // isUnwrapWeth
                address(0), // withdrawSwapToken
                0 // withdrawSwapSlippage
            );
        }
        // cancel activated tp/sl orders
        cancelActivatedTpslOrders(orderBook, positionId, marketId);
    }

    function setInitialLeverage(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        bytes32 marketId,
        uint256 initialLeverage
    ) internal {
        require(initialLeverage > 0, "initialLeverage must be greater than 0");
        IFacetPositionAccount(orderBook.mux3Facet).setInitialLeverage(positionId, marketId, initialLeverage);
    }

    /**
     * @dev Check if position account is closed
     */
    function _isPositionAccountFullyClosed(
        OrderBookStorage storage orderBook,
        bytes32 positionId
    ) internal view returns (bool) {
        PositionReader[] memory positions = IFacetReader(orderBook.mux3Facet).listAccountPositions(positionId);
        for (uint256 i = 0; i < positions.length; i++) {
            PositionPoolReader[] memory positionForPool = positions[i].pools;
            for (uint256 j = 0; j < positionForPool.length; j++) {
                if (positionForPool[j].size != 0) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * @dev Check if sepecific market position is closed in a position account
     */
    function _isPositionAccountMarketFullyClosed(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        bytes32 marketId
    ) internal view returns (bool) {
        PositionReader[] memory positions = IFacetReader(orderBook.mux3Facet).listAccountPositions(positionId);
        for (uint256 i = 0; i < positions.length; i++) {
            PositionPoolReader[] memory positionForPool = positions[i].pools;
            for (uint256 j = 0; j < positionForPool.length; j++) {
                if (positionForPool[j].size != 0) {
                    if (positions[i].marketId == marketId) {
                        return false;
                    }
                }
            }
        }
        return true;
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
        _appendOrder(orderBook, orderData);
        emit IOrderBook.NewRebalanceOrder(rebalancer, newOrderId, orderParams);
    }

    function fillRebalanceOrder(OrderBookStorage storage orderBook, uint64 orderId) external {
        require(orderBook.orders.contains(orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[orderId];
        _removeOrder(orderBook, orderData);
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

    function fillAdlOrder(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        bytes32 marketId,
        address lastConsumedToken,
        bool isWithdrawAll,
        bool isUnwrapWeth
    ) external returns (uint256 tradingPrice) {
        // pre-check
        require(IFacetReader(orderBook.mux3Facet).isDeleverageAllowed(positionId, marketId), "ADL safe");
        // close all
        uint256 size = 0;
        {
            PositionReader memory position = IFacetReader(orderBook.mux3Facet).getPositionAccount(positionId, marketId);
            for (uint256 i = 0; i < position.pools.length; i++) {
                size += position.pools[i].size;
            }
        }
        (tradingPrice, , , ) = IFacetClose(orderBook.mux3Facet).closePosition(
            positionId,
            marketId,
            size,
            lastConsumedToken
        );
        {
            (address positionOwner, ) = LibCodec.decodePositionId(positionId);
            emit IOrderBook.FillAdlOrder(
                positionOwner,
                AdlOrderParams({
                    positionId: positionId,
                    marketId: marketId,
                    size: size,
                    price: tradingPrice,
                    isUnwrapWeth: isUnwrapWeth
                })
            );
        }
        // auto withdraw, equivalent to POSITION_WITHDRAW_ALL_IF_EMPTY
        if (isWithdrawAll) {
            // default values of isUnwrapWeth, withdrawSwapToken, withdrawSwapSlippage
            // so that mux3 looks like mux1
            IFacetPositionAccount(orderBook.mux3Facet).withdrawAll(
                positionId,
                isUnwrapWeth,
                address(0), // withdrawSwapToken
                0 // withdrawSwapSlippage
            );
        }

        // cancel activated tp/sl orders
        cancelActivatedTpslOrders(orderBook, positionId, marketId);
        return tradingPrice;
    }

    function reallocate(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        bytes32 marketId,
        address fromPool,
        address toPool,
        uint256 size,
        address lastConsumedToken
    ) external returns (uint256 tradingPrice) {
        // reallocate
        IFacetOpen.ReallocatePositionResult memory result = IFacetOpen(orderBook.mux3Facet).reallocatePosition(
            IFacetOpen.ReallocatePositionArgs({
                positionId: positionId,
                marketId: marketId,
                fromPool: fromPool,
                toPool: toPool,
                size: size,
                lastConsumedToken: lastConsumedToken
            })
        );
        tradingPrice = result.tradingPrice;
        // positionFee is not charged from the trader
        // TODO: we can charge positionFee from LP (ex: If an LP is removing liquidity, they pay the close position fee.
        //       Otherwise, all LPs in toPool share the close position fee.)
    }

    function _placeTpslOrders(
        OrderBookStorage storage orderBook,
        PositionOrderParams memory orderParams,
        uint256 tradingPrice,
        uint64 blockTimestamp
    ) private {
        bool isLong = _isMarketLong(orderBook, orderParams.marketId);
        if (orderParams.tpPriceDiff > 0) {
            // close a long means sell, tp means limitPrice = tradingPrice * (1 + tpPriceDiff)
            // close a short means buy, tp means limitPrice = tradingPrice * (1 - tpPriceDiff)
            uint256 limitPrice = isLong
                ? (tradingPrice * (1e18 + orderParams.tpPriceDiff)) / 1e18
                : (tradingPrice * (1e18 - orderParams.tpPriceDiff)) / 1e18;
            uint64 orderId = _appendPositionOrder(
                orderBook,
                PositionOrderParams({
                    positionId: orderParams.positionId,
                    marketId: orderParams.marketId,
                    size: orderParams.size,
                    flags: orderParams.tpslFlags,
                    limitPrice: limitPrice,
                    expiration: orderParams.tpslExpiration,
                    lastConsumedToken: orderParams.lastConsumedToken,
                    collateralToken: address(0), // a close-order never contains collateral
                    collateralAmount: 0, // a close-order never contains collateral
                    withdrawUsd: 0,
                    withdrawSwapToken: orderParams.tpslWithdrawSwapToken,
                    withdrawSwapSlippage: orderParams.tpslWithdrawSwapSlippage,
                    tpPriceDiff: 0,
                    slPriceDiff: 0,
                    tpslExpiration: 0,
                    tpslFlags: 0,
                    tpslWithdrawSwapToken: address(0),
                    tpslWithdrawSwapSlippage: 0
                }),
                blockTimestamp,
                0
            );
            orderBook.tpslOrders[orderParams.positionId][orderParams.marketId].add(uint256(orderId));
            require(
                orderBook.tpslOrders[orderParams.positionId][orderParams.marketId].length() <= MAX_TP_SL_ORDERS,
                "Too Many TP/SL Orders"
            );
        }
        if (orderParams.slPriceDiff > 0) {
            // close a long means sell, sl means limitPrice = tradingPrice * (1 - slPriceDiff)
            // close a short means buy, sl means limitPrice = tradingPrice * (1 + slPriceDiff)
            uint256 limitPrice = isLong
                ? (tradingPrice * (1e18 - orderParams.slPriceDiff)) / 1e18
                : (tradingPrice * (1e18 + orderParams.slPriceDiff)) / 1e18;
            uint64 orderId = _appendPositionOrder(
                orderBook,
                PositionOrderParams({
                    positionId: orderParams.positionId,
                    marketId: orderParams.marketId,
                    size: orderParams.size,
                    flags: orderParams.tpslFlags | POSITION_TRIGGER_ORDER,
                    limitPrice: limitPrice,
                    expiration: orderParams.tpslExpiration,
                    lastConsumedToken: orderParams.lastConsumedToken,
                    collateralToken: address(0), // a close-order never contains collateral
                    collateralAmount: 0, // a close-order never contains collateral
                    withdrawUsd: 0,
                    withdrawSwapToken: orderParams.tpslWithdrawSwapToken,
                    withdrawSwapSlippage: orderParams.tpslWithdrawSwapSlippage,
                    tpPriceDiff: 0,
                    slPriceDiff: 0,
                    tpslExpiration: 0,
                    tpslFlags: 0,
                    tpslWithdrawSwapToken: address(0),
                    tpslWithdrawSwapSlippage: 0
                }),
                blockTimestamp,
                0
            );
            orderBook.tpslOrders[orderParams.positionId][orderParams.marketId].add(uint256(orderId));
            require(
                orderBook.tpslOrders[orderParams.positionId][orderParams.marketId].length() <= MAX_TP_SL_ORDERS,
                "Too Many TP/SL Orders"
            );
        }
    }

    function cancelOrder(
        OrderBookStorage storage orderBook,
        uint64 orderId,
        uint64 blockTimestamp,
        address msgSender
    ) external {
        require(orderBook.orders.contains(orderId), "No such orderId");
        OrderData memory orderData = orderBook.orderData[orderId];
        _removeOrder(orderBook, orderData);
        // check cancel cool down
        uint256 coolDown = _cancelCoolDown(orderBook);
        require(blockTimestamp >= orderData.placeOrderTime + coolDown, "Cool down");
        if (orderData.orderType == OrderType.PositionOrder) {
            _cancelPositionOrder(orderBook, orderData, blockTimestamp, msgSender);
        } else if (orderData.orderType == OrderType.LiquidityOrder) {
            _cancelLiquidityOrder(orderBook, orderData, msgSender);
        } else if (orderData.orderType == OrderType.WithdrawalOrder) {
            _cancelWithdrawalOrder(orderBook, orderData, blockTimestamp, msgSender);
        } else {
            revert();
        }
        _refundGasFee(orderBook, orderData);
        emit IOrderBook.CancelOrder(orderData.account, orderId, orderData);
    }

    function _cancelPositionOrder(
        OrderBookStorage storage orderBook,
        OrderData memory orderData,
        uint64 blockTimestamp,
        address msgSender
    ) private {
        PositionOrderParams memory orderParams = LibOrder.decodePositionOrder(orderData);
        if (_isBroker(msgSender)) {
            // broker can cancel expired order
            uint64 deadline = MathUpgradeable
                .min(orderData.placeOrderTime + _positionOrderTimeout(orderBook, orderParams), orderParams.expiration)
                .toUint64();
            require(blockTimestamp > deadline, "Not expired");
        } else if (_isDelegator(msgSender)) {} else {
            // account owner can cancel order
            require(msgSender == orderData.account, "Not authorized");
        }
        // return deposited collateral for open-position
        if (
            LibOrder.isOpenPosition(orderParams) &&
            orderParams.collateralToken != address(0) &&
            orderParams.collateralAmount > 0
        ) {
            _transferOut(
                orderBook,
                orderParams.collateralToken,
                orderData.account,
                orderParams.collateralAmount,
                LibOrder.isUnwrapWeth(orderParams)
            );
        }
        // remove ths current order from tp/sl list
        orderBook.tpslOrders[orderParams.positionId][orderParams.marketId].remove(uint256(orderData.id));
    }

    function _cancelLiquidityOrder(
        OrderBookStorage storage orderBook,
        OrderData memory orderData,
        address msgSender
    ) private {
        require(msgSender == orderData.account, "Not authorized");
        LiquidityOrderParams memory orderParams = LibOrder.decodeLiquidityOrder(orderData);
        if (orderParams.isAdding) {
            address collateralAddress = ICollateralPool(orderParams.poolAddress).collateralToken();
            _transferOut(
                orderBook,
                collateralAddress,
                orderData.account,
                orderParams.rawAmount,
                orderParams.isUnwrapWeth
            );
        } else {
            _transferOut(
                orderBook,
                orderParams.poolAddress,
                orderData.account,
                orderParams.rawAmount,
                false // unwrap eth
            );
        }
    }

    function _cancelWithdrawalOrder(
        OrderBookStorage storage orderBook,
        OrderData memory orderData,
        uint64 blockTimestamp,
        address msgSender
    ) private view {
        if (_isBroker(msgSender)) {
            uint64 deadline = orderData.placeOrderTime + _withdrawalOrderTimeout(orderBook);
            require(blockTimestamp > deadline, "Not expired");
        } else {
            require(msgSender == orderData.account, "Not authorized");
        }
    }

    function _appendPositionOrder(
        OrderBookStorage storage orderBook,
        PositionOrderParams memory orderParams, // NOTE: id, placeOrderTime, expire10s will be ignored
        uint64 blockTimestamp,
        uint64 gasFeeGwei
    ) private returns (uint64 newOrderId) {
        (address positionAccount, ) = LibCodec.decodePositionId(orderParams.positionId);
        newOrderId = orderBook.nextOrderId++;
        _deductGasFee(orderBook, positionAccount, gasFeeGwei);
        OrderData memory orderData = LibOrder.encodePositionOrder(
            orderParams,
            newOrderId,
            positionAccount,
            blockTimestamp,
            gasFeeGwei
        );
        _appendOrder(orderBook, orderData);
        emit IOrderBook.NewPositionOrder(positionAccount, newOrderId, orderParams);
    }

    function depositCollateral(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        address collateralToken,
        uint256 collateralAmount
    ) external {
        require(collateralAmount != 0, "Zero collateral");
        _transferIn(orderBook, collateralToken, collateralAmount);
        _transferOut(orderBook, collateralToken, address(orderBook.mux3Facet), collateralAmount, false);
        IFacetPositionAccount(orderBook.mux3Facet).deposit(positionId, collateralToken, collateralAmount);
    }

    function updateBorrowingFee(
        OrderBookStorage storage orderBook,
        bytes32 positionId,
        bytes32 marketId,
        address lastConsumedToken
    ) external {
        IFacetPositionAccount(orderBook.mux3Facet).updateBorrowingFee(positionId, marketId, lastConsumedToken);
    }

    function depositGas(OrderBookStorage storage orderBook, uint256 amount, address sender) internal {
        _transferIn(orderBook, orderBook.weth, amount);
        orderBook.gasBalances[sender] += amount;
    }

    function withdrawGas(OrderBookStorage storage orderBook, uint256 amount, address sender) internal {
        require(orderBook.gasBalances[sender] >= amount, "Insufficient gas balance");
        orderBook.gasBalances[sender] -= amount;
        _transferOut(orderBook, orderBook.weth, sender, amount, true);
    }

    function _transferIn(OrderBookStorage storage orderBook, address tokenAddress, uint256 rawAmount) internal {
        uint256 oldBalance = orderBook.previousTokenBalance[tokenAddress];
        uint256 newBalance = IERC20Upgradeable(tokenAddress).balanceOf(address(this));
        require(newBalance >= oldBalance, "Token balance decreased");
        uint256 realRawAmount = newBalance - oldBalance;
        require(realRawAmount >= rawAmount, "Token balance not enough");
        orderBook.previousTokenBalance[tokenAddress] = newBalance;
    }

    function _transferOut(
        OrderBookStorage storage orderBook,
        address tokenAddress,
        address recipient,
        uint256 rawAmount,
        bool isUnwrapWeth
    ) internal {
        if (tokenAddress == address(orderBook.weth) && isUnwrapWeth) {
            LibEthUnwrapper.unwrap(orderBook.weth, payable(recipient), rawAmount);
        } else {
            IERC20Upgradeable(tokenAddress).safeTransfer(recipient, rawAmount);
        }
        orderBook.previousTokenBalance[tokenAddress] = IERC20Upgradeable(tokenAddress).balanceOf(address(this));
    }

    function _validateMarketId(OrderBookStorage storage orderBook, bytes32 marketId) private view {
        BackedPoolState[] memory pools = IFacetReader(orderBook.mux3Facet).listMarketPools(marketId);
        require(pools.length > 0, "Invalid marketId");
    }

    function _validateCollateral(OrderBookStorage storage orderBook, address tokenAddress) private view {
        (bool enabled, ) = IFacetReader(orderBook.mux3Facet).getCollateralToken(tokenAddress);
        require(enabled, "Invalid collateralToken");
    }

    function _validatePool(OrderBookStorage storage orderBook, address poolAddress) private view {
        bool enabled = IFacetReader(orderBook.mux3Facet).getCollateralPool(poolAddress);
        require(enabled, "Invalid pool");
    }

    function _isBroker(address msgSender) private view returns (bool) {
        return IAccessControlUpgradeable(address(this)).hasRole(BROKER_ROLE, msgSender);
    }

    function _isDelegator(address msgSender) private view returns (bool) {
        return IAccessControlUpgradeable(address(this)).hasRole(DELEGATOR_ROLE, msgSender);
    }

    function _positionOrderTimeout(
        OrderBookStorage storage orderBook,
        PositionOrderParams memory orderParams
    ) private view returns (uint64 timeout) {
        timeout = LibOrder.isMarketOrder(orderParams)
            ? orderBook.configTable.getUint256(MCO_MARKET_ORDER_TIMEOUT).toUint64()
            : orderBook.configTable.getUint256(MCO_LIMIT_ORDER_TIMEOUT).toUint64();
        // 0 is valid
    }

    function _withdrawalOrderTimeout(OrderBookStorage storage orderBook) private view returns (uint64 timeout) {
        timeout = orderBook.configTable.getUint256(MCO_MARKET_ORDER_TIMEOUT).toUint64();
        // 0 is valid
    }

    function _cancelCoolDown(OrderBookStorage storage orderBook) private view returns (uint64 timeout) {
        timeout = orderBook.configTable.getUint256(MCO_CANCEL_COOL_DOWN).toUint64();
        // 0 is valid
    }

    function _lotSize(OrderBookStorage storage orderBook, bytes32 marketId) private view returns (uint256 lotSize) {
        lotSize = IFacetReader(orderBook.mux3Facet).marketConfigValue(marketId, MM_LOT_SIZE).toUint256();
        require(lotSize > 0, "Lot size not set");
    }

    function _liquidityLockPeriod(OrderBookStorage storage orderBook) private view returns (uint64 timeout) {
        timeout = orderBook.configTable.getUint256(MCO_LIQUIDITY_LOCK_PERIOD).toUint64();
        // 0 is valid
    }

    function _isMarketLong(OrderBookStorage storage orderBook, bytes32 marketId) private view returns (bool isLong) {
        (, isLong) = IFacetReader(orderBook.mux3Facet).marketState(marketId);
    }

    function _collateralToWad(
        OrderBookStorage storage orderBook,
        address collateralToken,
        uint256 rawAmount
    ) internal view returns (uint256 wadAmount) {
        (bool enabled, uint8 decimals) = IFacetReader(orderBook.mux3Facet).getCollateralToken(collateralToken);
        require(enabled, "Collateral token not enabled");
        if (decimals <= 18) {
            wadAmount = rawAmount * (10 ** (18 - decimals));
        } else {
            wadAmount = rawAmount / (10 ** (decimals - 18));
        }
    }

    function _collateralToRaw(
        OrderBookStorage storage orderBook,
        address collateralToken,
        uint256 wadAmount
    ) internal view returns (uint256 rawAmount) {
        (bool enabled, uint8 decimals) = IFacetReader(orderBook.mux3Facet).getCollateralToken(collateralToken);
        require(enabled, "Collateral token not enabled");
        if (decimals <= 18) {
            rawAmount = wadAmount / 10 ** (18 - decimals);
        } else {
            rawAmount = wadAmount * 10 ** (decimals - 18);
        }
    }

    function _deductGasFee(OrderBookStorage storage orderBook, address trader, uint64 gasFeeGwei) internal {
        if (gasFeeGwei > 0) {
            uint256 gasFee = gasFeeGwei * 1 gwei;
            require(orderBook.gasBalances[trader] >= gasFee, "Insufficient gas fee");
            orderBook.gasBalances[trader] -= gasFee;
        }
    }

    function _payGasFee(OrderBookStorage storage orderBook, OrderData memory orderData, address broker) internal {
        uint256 gasFeeGwei = orderData.gasFeeGwei;
        if (gasFeeGwei > 0) {
            uint256 gasFee = gasFeeGwei * 1 gwei;
            _transferOut(orderBook, orderBook.weth, broker, gasFee, true);
        }
    }

    function _refundGasFee(OrderBookStorage storage orderBook, OrderData memory orderData) internal {
        uint256 gasFeeGwei = orderData.gasFeeGwei;
        if (gasFeeGwei > 0) {
            uint256 gasFee = gasFeeGwei * 1 gwei;
            _transferOut(orderBook, orderBook.weth, orderData.account, gasFee, true);
        }
    }

    function _orderGasFeeGwei(OrderBookStorage storage orderBook) internal view returns (uint64) {
        uint256 gasGwei = orderBook.configTable.getUint256(MCO_ORDER_GAS_FEE_GWEI);
        require(gasGwei <= type(uint64).max, "Gas fee overflow");
        return uint64(gasGwei);
    }
}
