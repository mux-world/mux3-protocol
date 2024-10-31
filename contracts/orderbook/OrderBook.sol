// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "../interfaces/IOrderBook.sol";
import "../interfaces/IWETH9.sol";
import "../libraries/LibConfigMap.sol";
import "../libraries/LibOrderBook.sol";
import "../libraries/LibCodec.sol";
import "./OrderBookStore.sol";
import "./OrderBookGetter.sol";
import "./PriceProvider.sol";

contract OrderBook is
    OrderBookStore,
    ReentrancyGuardUpgradeable,
    OrderBookGetter,
    PriceProvider,
    IOrderBook
{
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.UintSet;

    modifier whenNotPaused(OrderType orderType) {
        require(!isOrderPaused(orderType), "Paused");
        _;
    }

    modifier updateSequence() {
        _;
        unchecked {
            _storage.sequence += 1;
        }
        emit UpdateSequence(_storage.sequence);
    }

    function initialize(address mux3Facet, address weth) external initializer {
        __AccessControlEnumerable_init();
        _storage.mux3Facet = mux3Facet;
        _storage.weth = weth;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MAINTAINER_ROLE, msg.sender);
    }

    /**
     * @dev Trader/LP can wrap ETH to OrderBook, transfer ERC20 to OrderBook, placeOrders
     */
    function multicall(
        bytes[] calldata proxyCalls
    ) external payable returns (bytes[] memory results) {
        results = new bytes[](proxyCalls.length);
        for (uint256 i = 0; i < proxyCalls.length; i++) {
            (bool success, bytes memory returnData) = address(this)
                .delegatecall(proxyCalls[i]);
            AddressUpgradeable.verifyCallResult(
                success,
                returnData,
                "multicallFailed"
            );
            results[i] = returnData;
        }
    }

    /**
     * @dev Trader/LP can wrap ETH to OrderBook
     */
    function wrapNative() external payable {
        IWETH9(_storage.weth).deposit{ value: msg.value }();
    }

    /**
     * @dev Trader/LP can transfer ERC20 to OrderBook
     */
    function transferToken(address token, uint256 amount) external {
        IERC20Upgradeable(token).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );
    }

    /**
     * @dev Delegator can transfer ERC20 from Trader/LP to OrderBook
     */
    function transferTokenFrom(
        address from,
        address token,
        uint256 amount
    ) external {
        require(_isDelegator(msg.sender), "Delegator only");
        IERC20Upgradeable(token).safeTransferFrom(from, address(this), amount);
    }

    /**
     * @notice Open/close position. called by Trader.
     *
     *         Market order will expire after marketOrderTimeout seconds.
     *         Limit/Trigger order will expire after deadline.
     */
    function placePositionOrder(
        PositionOrderParams memory orderParams,
        bytes32 referralCode
    ) public nonReentrant whenNotPaused(OrderType.PositionOrder) {
        (address positionAccount, ) = LibCodec.decodePositionId(
            orderParams.positionId
        );
        if (_isDelegator(msg.sender)) {} else {
            require(positionAccount == msg.sender, "Not authorized");
        }
        // TODO: referral code
        // address referralManager = _referralManager();
        // if (referralCode != bytes32(0) && referralManager != address(0)) {
        //     IReferralManager(referralManager).setReferrerCodeFor(
        //         positionAccount,
        //         referralCode
        //     );
        // }
        LibOrderBook.placePositionOrder(
            _storage,
            orderParams,
            _blockTimestamp()
        );
    }

    /**
     * @notice Add/remove liquidity. called by Liquidity Provider.
     *
     *         Can be filled after liquidityLockPeriod seconds.
     * @param  orderParams   order details includes:
     *         assetId       asset.id that added/removed to.
     *         rawAmount     asset token amount. decimals = erc20.decimals.
     *         isAdding      true for add liquidity, false for remove liquidity.
     */
    function placeLiquidityOrder(
        LiquidityOrderParams memory orderParams
    ) external nonReentrant whenNotPaused(OrderType.LiquidityOrder) {
        LibOrderBook.placeLiquidityOrder(
            _storage,
            orderParams,
            msg.sender,
            _blockTimestamp()
        );
    }

    /**
     * @notice Withdraw collateral/profit. called by Trader.
     *
     *         This order will expire after marketOrderTimeout seconds.
     */
    function placeWithdrawalOrder(
        WithdrawalOrderParams memory orderParams
    ) external nonReentrant whenNotPaused(OrderType.WithdrawalOrder) {
        (address positionAccount, ) = LibCodec.decodePositionId(
            orderParams.positionId
        );
        if (_isDelegator(msg.sender)) {} else {
            require(positionAccount == msg.sender, "Not authorized");
        }
        LibOrderBook.placeWithdrawalOrder(
            _storage,
            orderParams,
            _blockTimestamp()
        );
    }

    /**
     * @dev   Open/close a position. called by Broker.
     */
    function fillPositionOrder(
        uint64 orderId
    )
        external
        onlyRole(BROKER_ROLE)
        nonReentrant
        whenNotPaused(OrderType.PositionOrder)
        updateSequence
        returns (uint256 tradingPrice)
    {
        return
            LibOrderBook.fillPositionOrder(
                _storage,
                _configTable,
                orderId,
                _blockTimestamp()
            );
    }

    /**
     * @dev   Add/remove liquidity. called by Broker.
     */
    function fillLiquidityOrder(
        uint64 orderId
    )
        external
        onlyRole(BROKER_ROLE)
        whenNotPaused(OrderType.LiquidityOrder)
        nonReentrant
        updateSequence
        returns (uint256 outAmount)
    {
        return
            LibOrderBook.fillLiquidityOrder(
                _storage,
                _configTable,
                orderId,
                _blockTimestamp()
            );
    }

    // function donateLiquidity(
    //     uint8 assetId,
    //     uint96 rawAmount // erc20.decimals
    // ) external updateSequence {
    //     _storage.donateLiquidity(msg.sender, assetId, rawAmount);
    // }
    /**
     * @dev   Withdraw collateral/profit. called by Broker.
     */
    function fillWithdrawalOrder(
        uint64 orderId
    )
        external
        onlyRole(BROKER_ROLE)
        nonReentrant
        whenNotPaused(OrderType.WithdrawalOrder)
        updateSequence
    {
        LibOrderBook.fillWithdrawalOrder(
            _storage,
            _configTable,
            orderId,
            _blockTimestamp()
        );
    }

    /**
     * @notice Cancel an Order by orderId.
     */
    function cancelOrder(uint64 orderId) external nonReentrant updateSequence {
        LibOrderBook.cancelOrder(
            _storage,
            _configTable,
            orderId,
            _blockTimestamp(),
            msg.sender
        );
    }

    // function _cancelLiquidityOrder(
    //     LiquidityOrderParams memory orderParams,
    //     address account
    // ) internal {
    //     if (orderParams.isAdding) {
    //         address collateralAddress = IDegenPool(_storage.pool)
    //             .getAssetParameter(
    //                 orderParams.assetId,
    //                 LibConfigKeys.TOKEN_ADDRESS
    //             )
    //             .toAddress();
    //         LibOrderBook._transferOut(
    //             collateralAddress,
    //             account,
    //             orderParams.rawAmount
    //         );
    //     } else {
    //         LibOrderBook.transferOut(_storage.mlpToken,
    //             account,
    //             orderParams.rawAmount
    //         );
    //     }
    //     // if (_storage.callbackWhitelist[orderParams.account]) {
    //     //     try
    //     //         ILiquidityCallback(orderParams.account).afterCancelLiquidityOrder{ gas: _callbackGasLimit() }(order)
    //     //     {} catch {}
    //     // }
    // }
    /**
     * @notice Trader can withdraw all collateral only when position = 0.
     */
    function withdrawAllCollateral(
        bytes32 positionId
    ) external updateSequence whenNotPaused(OrderType.WithdrawalOrder) {
        (address positionAccount, ) = LibCodec.decodePositionId(positionId);
        if (_isDelegator(msg.sender)) {} else {
            require(positionAccount == msg.sender, "Not authorized");
        }
        LibOrderBook.withdrawAllCollateral(_storage, positionId);
    }

    /**
     * @notice Deposit collateral into a subAccount.
     */
    function depositCollateral(
        bytes32 positionId,
        address collateralToken,
        uint256 collateralAmount // token decimals
    ) external updateSequence {
        LibOrderBook.depositCollateral(
            _storage,
            _configTable,
            positionId,
            collateralToken,
            collateralAmount
        );
    }

    function setInitialLeverage(
        bytes32 positionId,
        bytes32 marketId,
        uint256 initialLeverage
    ) external updateSequence {
        (address positionAccount, ) = LibCodec.decodePositionId(positionId);
        if (_isDelegator(msg.sender)) {} else {
            require(positionAccount == msg.sender, "Not authorized");
        }
        LibOrderBook.setInitialLeverage(
            _storage,
            positionId,
            marketId,
            initialLeverage
        );
    }

    /**
     * @dev   Open/close a position. called by Broker.
     */
    function liquidate(
        bytes32 positionId,
        bytes32 marketId
    )
        external
        onlyRole(BROKER_ROLE)
        nonReentrant
        whenNotPaused(OrderType.LiquidityOrder)
        updateSequence
        returns (uint256 tradingPrice)
    {
        return LibOrderBook.liquidatePosition(_storage, positionId, marketId);
    }

    // function fillAdlOrder(
    //     AdlOrderParams memory orderParams,
    //     uint96 tradingPrice,
    //     uint96[] memory markPrices
    // ) public onlyRole(BROKER_ROLE) nonReentrant updateSequence {
    //     _storage.fillAdlOrder(orderParams, tradingPrice, markPrices);
    // }

    // /**
    //  * @dev Broker can withdraw brokerGasRebate.
    //  */
    // function claimBrokerGasRebate(
    //     uint8 assetId
    // ) external onlyRole(BROKER_ROLE) returns (uint256 rawAmount) updateSequence {
    //     return
    //         IDegenPool(_storage.pool).claimBrokerGasRebate(
    //             msg.sender,
    //             assetId
    //         );
    // }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    function setConfig(bytes32 key, bytes32 value) external updateSequence {
        _checkRole(MAINTAINER_ROLE, msg.sender);
        // TODO: add test rules for specified key
        LibConfigMap.setBytes32(_configTable, key, value);
    }
}
