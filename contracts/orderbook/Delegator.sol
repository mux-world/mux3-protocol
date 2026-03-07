// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    IOrderBook as IMux3OrderBook,
    IOrderBookGetter as IMux3OrderBookGetter,
    PositionOrderParams as Mux3PositionOrderParams
} from "../interfaces/IOrderBook.sol";
import {
    WithdrawalOrderParams as Mux3WithdrawalOrderParams,
    WithdrawAllOrderParams as Mux3WithdrawAllOrderParams
} from "../interfaces/IOrderBook.sol";
import {
    OrderData as Mux3OrderData,
    ModifyPositionOrderParams as Mux3ModifyPositionOrderParams
} from "../interfaces/IOrderBook.sol";
import { LibCodec as LibMux3Codec } from "../libraries/LibCodec.sol";
import { IMuxOrderBook } from "../interfaces/IMuxOrderBook.sol";
import { IMux2ProxyFactory } from "../interfaces/IMux2ProxyFactory.sol";
import { IMuxDegenOrderBook } from "../interfaces/IMuxDegenOrderBook.sol";

contract Delegator is Initializable {
    event SetDelegator(address indexed owner, address indexed delegator, uint256 actionCount);

    struct Delegation {
        address delegator;
        uint256 actionCount;
    }

    address internal immutable _mux3OrderBook;
    address internal immutable _mux2ProxyFactory;
    address internal immutable _muxOrderBook;
    address internal immutable _muxDegenOrderBook;
    bytes32 private _reserved1;
    bytes32 private _reserved2;
    bytes32 private _reserved3;
    bytes32 private _reserved4;
    mapping(address => Delegation) internal _delegations; // owner => Delegation

    constructor(address mux3OrderBook, address mux2ProxyFactory, address muxOrderBook, address muxDegenOrderBook) {
        _mux3OrderBook = mux3OrderBook;
        _mux2ProxyFactory = mux2ProxyFactory;
        _muxOrderBook = muxOrderBook;
        _muxDegenOrderBook = muxDegenOrderBook;
    }

    function initialize() external initializer {
        // do nothing
    }

    function getDelegationByOwner(address owner) external view returns (Delegation memory) {
        return _delegations[owner];
    }

    /**
     * @notice A cold-wallet (msg.sender) can approve a hot-wallet (delegator) to act on its behalf.
     *         The hot-wallet can then deposit collateral from the cold-wallet into a PositionAccount,
     *         and openPositions on behalf of the cold-wallet.
     */
    function delegate(address delegator, uint256 actionCount) public payable {
        address owner = msg.sender;
        require(delegator != address(0), "Invalid delegator address");
        _delegations[owner] = Delegation(delegator, actionCount);
        if (msg.value > 0) {
            // forward eth to delegator
            AddressUpgradeable.sendValue(payable(delegator), msg.value);
        }
    }

    /**
     * @notice Executes multiple function calls in a single transaction
     *
     *         note: Delegator.multicall is slightly different from OrderBook.multicall,
     *               Delegator does not support wrap ETH as collateral (WETH is supported).
     * @param proxyCalls Array of function calls to execute
     * @return results Array of return values from each call
     * @dev Trader/LP can wrap ETH to OrderBook, transfer ERC20 to OrderBook, placeOrders
     *
     *      example for collateral = USDC or WETH:
     *        multicall([
     *          mux3DepositGas(gas),
     *          mux3PlacePositionOrder(positionOrderParams, referralCode),
     *        ])
     */
    function multicall(bytes[] calldata proxyCalls) external payable returns (bytes[] memory results) {
        results = new bytes[](proxyCalls.length);
        for (uint256 i = 0; i < proxyCalls.length; i++) {
            (bool success, bytes memory returnData) = address(this).delegatecall(proxyCalls[i]);
            AddressUpgradeable.verifyCallResult(success, returnData, "multicallFailed");
            results[i] = returnData;
        }
    }

    // ============================ MUX1 ============================

    function muxFunctionCall(bytes memory muxCallData, uint256 value) external payable {
        bytes32 subAccountId = _decodeSubAccountId(muxCallData);
        address account = _getSubAccountOwner(subAccountId);
        _consumeDelegation(account, 1);
        bytes4 sig = _decodeFunctionSig(muxCallData);
        require(
            sig == IMuxOrderBook.placePositionOrder3.selector ||
                sig == IMuxOrderBook.depositCollateral.selector ||
                sig == IMuxOrderBook.placeWithdrawalOrder.selector,
            "Forbidden"
        );
        IMux2ProxyFactory(_mux2ProxyFactory).muxFunctionCall{ value: value }(muxCallData, value);
    }

    // note: you can only cancel PositionOrder and WithdrawalOrder (which is restricted in the OrderBook)
    function muxCancelOrder(uint64 orderId) external payable {
        (bytes32[3] memory order, bool isOrderExist) = IMuxOrderBook(_muxOrderBook).getOrder(orderId);
        require(isOrderExist, "orderNotExist");
        address orderOwner = _getSubAccountOwner(order[0]);
        _consumeDelegation(orderOwner, 1);
        IMuxOrderBook(_muxOrderBook).cancelOrder(orderId);
    }

    // ============================ MUX2 ============================

    function mux2TransferToken(
        uint256 projectId,
        address account,
        address collateralToken,
        address assetToken,
        bool isLong,
        address token,
        uint256 amount
    ) public payable {
        _consumeDelegation(account, 0);
        IMux2ProxyFactory(_mux2ProxyFactory).transferToken2(
            projectId,
            account,
            collateralToken,
            assetToken,
            isLong,
            token,
            amount
        );
    }

    function mux2WrapAndTransferNative(
        uint256 projectId,
        address account,
        address collateralToken,
        address assetToken,
        bool isLong,
        uint256 amount
    ) public payable {
        _consumeDelegation(account, 0);
        IMux2ProxyFactory(_mux2ProxyFactory).wrapAndTransferNative2{ value: amount }(
            projectId,
            account,
            collateralToken,
            assetToken,
            isLong,
            amount
        );
    }

    function mux2ProxyFunctionCall(
        address account,
        IMux2ProxyFactory.ProxyCallParams calldata params
    ) external payable {
        _consumeDelegation(account, 1);
        IMux2ProxyFactory(_mux2ProxyFactory).proxyFunctionCall2{ value: params.value }(account, params);
    }

    // ============================ Degen ============================

    function muxDegenPlacePositionOrder(
        IMuxDegenOrderBook.PositionOrderParams memory orderParams,
        bytes32 referralCode
    ) external {
        address account = _getSubAccountOwner(orderParams.subAccountId);
        _consumeDelegation(account, 1);
        IMuxDegenOrderBook(_muxDegenOrderBook).placePositionOrder(orderParams, referralCode);
    }

    function muxDegenPlaceWithdrawalOrder(IMuxDegenOrderBook.WithdrawalOrderParams memory orderParams) external {
        address account = _getSubAccountOwner(orderParams.subAccountId);
        _consumeDelegation(account, 1);
        IMuxDegenOrderBook(_muxDegenOrderBook).placeWithdrawalOrder(orderParams);
    }

    function muxDegenWithdrawAllCollateral(bytes32 subAccountId) external {
        address account = _getSubAccountOwner(subAccountId);
        _consumeDelegation(account, 1);
        IMuxDegenOrderBook(_muxDegenOrderBook).withdrawAllCollateral(subAccountId);
    }

    function muxDegenDepositCollateral(bytes32 subAccountId, uint256 collateralAmount) external {
        address account = _getSubAccountOwner(subAccountId);
        _consumeDelegation(account, 1);
        IMuxDegenOrderBook(_muxDegenOrderBook).depositCollateral(subAccountId, collateralAmount);
    }

    // note: you can only cancel PositionOrder and WithdrawalOrder (which is restricted in the OrderBook)
    function muxDegenCancelOrder(uint64 orderId) external {
        (IMuxDegenOrderBook.OrderData memory orderData, bool exists) = IMuxDegenOrderBook(_muxDegenOrderBook).getOrder(
            orderId
        );
        require(exists, "No such orderId");
        address owner = orderData.account;
        _consumeDelegation(owner, 1);
        IMuxDegenOrderBook(_muxDegenOrderBook).cancelOrder(orderId);
    }

    // ============================ MUX3 ============================

    function mux3PositionCall(
        address collateralToken,
        uint256 collateralAmount,
        bytes memory positionOrderCallData,
        uint256 initialLeverage, // 0 = ignore
        uint256 gas // 0 = ignore
    ) external payable {
        (Mux3PositionOrderParams memory orderParams, ) = abi.decode(
            positionOrderCallData,
            (Mux3PositionOrderParams, bytes32)
        );
        (address account, ) = LibMux3Codec.decodePositionId(orderParams.positionId);
        _consumeDelegation(account, 1);
        // enforce collateralToken/collateralAmount are the same as inner positionOrderCallData
        require(orderParams.collateralToken == collateralToken, "CollateralTokenMismatch");
        require(orderParams.collateralAmount == collateralAmount, "CollateralAmountMismatch");
        uint256 value = gas;
        if (
            collateralAmount > 0 &&
            (collateralToken == address(0x0) || collateralToken == address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE))
        ) {
            value += collateralAmount;
        }
        IMux2ProxyFactory(_mux2ProxyFactory).mux3PositionCall{ value: value }(
            collateralToken,
            collateralAmount,
            positionOrderCallData,
            initialLeverage,
            gas
        );
    }

    /**
     * @notice MUX3: Trader should pay for gas for their orders
     *         you should pay at least configValue(MCO_ORDER_GAS_FEE_GWEI) * 1e9 / 1e18 ETH for each order
     *
     *         note: Delegator.depositGas is slightly different from OrderBook.depositGas,
     *               there is no Delegator.wrapNative, and Delegator.depositGas consumes msg.value and deposit it as gas to OrderBook.
     */
    function mux3DepositGas(address owner, uint256 amount) external payable {
        _consumeDelegation(owner, 0);
        IMux3OrderBook(_mux3OrderBook).wrapNative{ value: amount }(amount);
        IMux3OrderBook(_mux3OrderBook).depositGas(owner, amount);
    }

    /**
     * @notice MUX3: A Trader can open/close position
     *         Market order will expire after marketOrderTimeout seconds.
     *         Limit/Trigger order will expire after deadline.
     * @param orderParams The parameters for the position order
     * @param referralCode The referral code for the position order
     * @dev depositGas required (consume gas when filled)
     */
    function mux3PlacePositionOrder(Mux3PositionOrderParams memory orderParams, bytes32 referralCode) external payable {
        (address owner, ) = LibMux3Codec.decodePositionId(orderParams.positionId);
        _consumeDelegation(owner, 1);
        if (orderParams.collateralToken != address(0) && orderParams.collateralAmount > 0) {
            IMux3OrderBook(_mux3OrderBook).transferTokenFrom(
                owner,
                orderParams.collateralToken,
                orderParams.collateralAmount
            );
        }
        IMux3OrderBook(_mux3OrderBook).placePositionOrder(orderParams, referralCode);
    }

    /**
     * @notice MUX3: A Trader/LP can cancel a PositionOrder or WithdrawalOrder by orderId (which is restricted in the OrderBook).
     * @param orderId The ID of the order to cancel
     */
    function mux3CancelOrder(uint64 orderId) external payable {
        (Mux3OrderData memory orderData, bool exists) = IMux3OrderBookGetter(_mux3OrderBook).getOrder(orderId);
        require(exists, "No such orderId");
        address owner = orderData.account;
        _consumeDelegation(owner, 1);
        IMux3OrderBook(_mux3OrderBook).cancelOrder(orderId);
    }

    /**
     * @notice MUX3: A Trader can withdraw collateral
     *         This order will expire after marketOrderTimeout seconds.
     * @param orderParams The parameters for the withdrawal order
     * @dev depositGas required (consume gas when filled)
     */
    function mux3PlaceWithdrawalOrder(Mux3WithdrawalOrderParams memory orderParams) external payable {
        (address owner, ) = LibMux3Codec.decodePositionId(orderParams.positionId);
        _consumeDelegation(owner, 1);
        IMux3OrderBook(_mux3OrderBook).placeWithdrawalOrder(orderParams);
    }

    /**
     * @notice MUX3: A Trader can withdraw all collateral only when position = 0
     * @param orderParams The parameters for the withdrawal order
     * @dev do not need depositGas
     */
    function mux3WithdrawAllCollateral(Mux3WithdrawAllOrderParams memory orderParams) external payable {
        (address owner, ) = LibMux3Codec.decodePositionId(orderParams.positionId);
        _consumeDelegation(owner, 1);
        IMux3OrderBook(_mux3OrderBook).withdrawAllCollateral(orderParams);
    }

    /**
     * @notice MUX3: A Trader can deposit collateral into a PositionAccount.
     * @param positionId The ID of the position
     * @param collateralToken The address of the collateral token
     * @param collateralAmount The amount of collateral token
     * @dev do not need depositGas
     */
    function mux3DepositCollateral(
        bytes32 positionId,
        address collateralToken,
        uint256 collateralAmount // token decimals
    ) external payable {
        (address owner, ) = LibMux3Codec.decodePositionId(positionId);
        _consumeDelegation(owner, 0);
        if (collateralAmount > 0) {
            IMux3OrderBook(_mux3OrderBook).transferTokenFrom(owner, collateralToken, collateralAmount);
        }
        IMux3OrderBook(_mux3OrderBook).depositCollateral(positionId, collateralToken, collateralAmount);
    }

    /**
     * @notice MUX3: A trader should set initial leverage at least once before open-position
     * @param positionId The ID of the position
     * @param marketId The ID of the market
     * @param initialLeverage The initial leverage to set
     * @dev do not need depositGas
     */
    function mux3SetInitialLeverage(bytes32 positionId, bytes32 marketId, uint256 initialLeverage) external payable {
        (address owner, ) = LibMux3Codec.decodePositionId(positionId);
        _consumeDelegation(owner, 0);
        IMux3OrderBook(_mux3OrderBook).setInitialLeverage(positionId, marketId, initialLeverage);
    }

    /**
     * @notice MUX3: A Trader can modify a position order
     * @param orderParams The parameters for the modify position order
     * @dev do not need depositGas
     */
    function mux3ModifyPositionOrder(Mux3ModifyPositionOrderParams memory orderParams) external payable {
        (address owner, ) = LibMux3Codec.decodePositionId(orderParams.positionId);
        _consumeDelegation(owner, 1);
        IMux3OrderBook(_mux3OrderBook).modifyPositionOrder(orderParams);
    }

    // ============================ tools ============================

    function _consumeDelegation(address owner, uint256 deductActionCount) private {
        address delegator = msg.sender;
        Delegation storage delegation = _delegations[owner];
        require(delegation.delegator == delegator, "Not authorized");
        require(delegation.actionCount > 0, "No action count"); // actionCount = 0 is the same as no delegation
        delegation.actionCount -= deductActionCount;
    }

    function _decodeFunctionSig(bytes memory muxCallData) internal pure returns (bytes4 sig) {
        require(muxCallData.length >= 0x20, "BadMuxCallData");
        bytes32 data;
        assembly {
            data := mload(add(muxCallData, 0x20))
        }
        sig = bytes4(data);
    }

    // for mux2
    function _decodeSubAccountId(bytes memory muxCallData) internal pure returns (bytes32 subAccountId) {
        require(muxCallData.length >= 0x24, "BadMuxCallData");
        assembly {
            subAccountId := mload(add(muxCallData, 0x24))
        }
    }

    // for mux1, degen
    function _getSubAccountOwner(bytes32 subAccountId) internal pure returns (address account) {
        account = address(uint160(uint256(subAccountId) >> 96));
    }

    function _decodeBytes32(bytes memory callData, uint256 index) internal pure returns (bytes32 data) {
        require(callData.length >= 32 * (index + 1), "BadCallData");
        uint256 offset = 0x20 + index * 32;
        assembly {
            data := mload(add(callData, offset))
        }
    }
}
