// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";

enum OrderType {
    None, // 0
    PositionOrder, // 1
    LiquidityOrder, // 2
    WithdrawalOrder, // 3
    RebalanceOrder, // 4
    AdlOrder, // 5
    LiquidateOrder // 6
}

// position order flags
uint256 constant POSITION_OPEN = 0x80; // this flag means open-position; otherwise close-position
uint256 constant POSITION_MARKET_ORDER = 0x40; // this flag only affects order expire time and shows a better effect on UI
uint256 constant POSITION_WITHDRAW_ALL_IF_EMPTY = 0x20; // this flag means auto withdraw all collateral if position.size == 0
// this flag means this is a trigger order (ex: stop-loss order). otherwise this is a limit order (ex: take-profit order)
// |                         | Limit Order             | Trigger Order           |
// +-------------------------+-------------------------+-------------------------+
// | Open long / Close short | fillPrice <= limitPrice | fillPrice >= limitPrice |
// | Close long / Open short | fillPrice >= limitPrice | fillPrice <= limitPrice |
uint256 constant POSITION_TRIGGER_ORDER = 0x10;
// 0x08 was POSITION_TPSL_STRATEGY. not suitable for mux3
// 0x04 was POSITION_SHOULD_REACH_MIN_PROFIT. not suitable for mux3
uint256 constant POSITION_AUTO_DELEVERAGE = 0x02; // denotes that this order is an auto-deleverage order
uint256 constant POSITION_UNWRAP_ETH = 0x100; // unwrap WETH into ETH. only valid when fill close-position, or cancel open-position, or fill liquidity, or cancel liquidity
uint256 constant POSITION_WITHDRAW_PROFIT = 0x200; // withdraw profit - fee. only valid when fill close-position

struct OrderData {
    uint64 id;
    address account;
    OrderType orderType;
    uint8 version;
    uint64 placeOrderTime;
    uint64 gasFeeGwei;
    bytes payload;
}

struct OrderBookStorage {
    address mux3Facet;
    uint64 nextOrderId;
    mapping(uint64 => OrderData) orderData;
    EnumerableSetUpgradeable.UintSet orders;
    mapping(address => EnumerableSetUpgradeable.UintSet) userOrders;
    mapping(bytes32 => mapping(bytes32 => EnumerableSetUpgradeable.UintSet)) tpslOrders; // positionId => marketId => [orderId]
    uint32 sequence; // will be 0 after 0xffffffff
    mapping(address => bool) priceProviders;
    address weth;
    mapping(address => uint256) _reserved1; // was previousTokenBalance
    mapping(address => uint256) gasBalances;
    mapping(bytes32 => bytes32) configTable;
    mapping(address => uint256) previousTokenBalance;
    mapping(address => bool) _reserved2; // was callbackWhitelist
    bytes32[46] __gap;
}

struct PositionOrderParams {
    bytes32 positionId;
    bytes32 marketId;
    uint256 size;
    uint256 flags; // see "constant POSITION_*"
    uint256 limitPrice; // decimals = 18
    uint64 expiration; // timestamp. decimals = 0
    address lastConsumedToken; // when paying fees or losses (for both open and close positions), this token will be consumed last. can be 0 if no preference
    // when openPosition
    // * collateralToken == 0 means do not deposit collateral
    // * collateralToken != 0 means to deposit collateralToken as collateral
    // * deduct fees
    // * open positions
    address collateralToken; // only valid when flags.POSITION_OPEN
    uint256 collateralAmount; // only valid when flags.POSITION_OPEN. erc20.decimals
    // when closePosition, pnl and fees
    // * realize pnl
    // * deduct fees
    // * flags.POSITION_WITHDRAW_PROFIT means also withdraw (profit - fee)
    // * withdrawUsd means to withdraw collateral. this is independent of flags.POSITION_WITHDRAW_PROFIT
    // * flags.POSITION_UNWRAP_ETH means to unwrap WETH into ETH
    uint256 withdrawUsd; // only valid when close a position
    address withdrawSwapToken; // only valid when close a position and withdraw. try to swap to this token. use address(0) to skip swap
    uint256 withdrawSwapSlippage; // only valid when close a position and withdraw. slippage tolerance for withdrawSwapToken. if swap cannot achieve this slippage, swap will be skipped
    // tpsl strategy, only valid when openPosition
    uint256 tpPriceDiff; // take-profit price will be marketPrice * diff. decimals = 18. leave 0 if no tp
    uint256 slPriceDiff; // stop-loss price will be marketPrice * diff. decimals = 18. leave 0 if no sl
    uint64 tpslExpiration; // timestamp. decimals = 0. only valid when tpPriceDiff > 0 or slPriceDiff > 0
    uint256 tpslFlags; // POSITION_WITHDRAW_ALL_IF_EMPTY, POSITION_WITHDRAW_PROFIT, POSITION_UNWRAP_ETH. only valid when tpPriceDiff > 0 or slPriceDiff > 0
    address tpslWithdrawSwapToken; // only valid when tpPriceDiff > 0 or slPriceDiff > 0. use address(0) to skip swap
    uint256 tpslWithdrawSwapSlippage; // only valid when tpPriceDiff > 0 or slPriceDiff > 0
}

struct LiquidityOrderParams {
    address poolAddress;
    address token; // which address to add/remove. this must be pool.collateralToken when addLiquidity
    uint256 rawAmount; // erc20.decimals
    bool isAdding;
    bool isUnwrapWeth;
}

struct WithdrawalOrderParams {
    bytes32 positionId;
    address tokenAddress;
    uint256 rawAmount; // erc20.decimals
    bool isUnwrapWeth;
    address lastConsumedToken; // this token will be consumed last. can be address(0) if no preference
    address withdrawSwapToken; // try to swap to this token. use address(0) to skip swap
    uint256 withdrawSwapSlippage; // slippage tolerance for withdrawSwapToken. if swap cannot achieve this slippage, swap will be skipped
}

struct WithdrawAllOrderParams {
    bytes32 positionId;
    bool isUnwrapWeth;
}

struct ModifyPositionOrderParams {
    uint64 orderId;
    bytes32 positionId; // this is to double check if orderId has the same positionId
    uint256 limitPrice; // decimals = 18. leave 0 if not changed
    // tpsl strategy, only valid when openPosition
    uint256 tpPriceDiff; // take-profit price will be marketPrice * diff. decimals = 18. leave 0 if not changed
    uint256 slPriceDiff; // stop-loss price will be marketPrice * diff. decimals = 18. leave 0 if not changed
}

struct RebalanceOrderParams {
    address poolAddress;
    address token0;
    uint256 rawAmount0; // erc20.decimals
    uint256 maxRawAmount1; // erc20.decimals
    bytes userData;
}

struct AdlOrderParams {
    bytes32 positionId;
    bytes32 marketId;
    uint256 size; // 1e18
    uint256 price; // 1e18
    bool isUnwrapWeth;
}

interface IOrderBook {
    event UpdateSequence(uint32 sequence);
    event CancelOrder(address indexed account, uint64 indexed orderId, OrderData orderData);
    event NewLiquidityOrder(address indexed account, uint64 indexed orderId, LiquidityOrderParams params);
    event NewPositionOrder(address indexed account, uint64 indexed orderId, PositionOrderParams params);
    event NewWithdrawalOrder(address indexed account, uint64 indexed orderId, WithdrawalOrderParams params);
    event NewRebalanceOrder(address indexed rebalancer, uint64 indexed orderId, RebalanceOrderParams params);
    event FillOrder(address indexed account, uint64 indexed orderId, OrderData orderData);
    event FillAdlOrder(address indexed account, AdlOrderParams params);
    event CallbackFailed(address indexed account, uint64 indexed orderId, bytes reason);
    event ModifyPositionOrder(address indexed account, uint64 indexed orderId, ModifyPositionOrderParams params);

    /**
     * @dev Trader/LP can wrap ETH to OrderBook, transfer ERC20 to OrderBook, placeOrders
     *
     *      example for collateral = USDC:
     *        multicall([
     *          wrapNative(gas),
     *          depositGas(gas),
     *          transferToken(collateral),
     *          placePositionOrder(positionOrderParams),
     *        ])
     *      example for collateral = ETH:
     *        multicall([
     *          wrapNative(gas),
     *          depositGas(gas),
     *          wrapNative(collateral),
     *          placePositionOrder(positionOrderParams),
     *        ])
     */
    function multicall(bytes[] calldata proxyCalls) external payable returns (bytes[] memory results);

    /**
     * @dev Trader/LP can wrap ETH to OrderBook
     *
     *      note: wrapNative is intended to be used as part of a multicall. If it is called directly
     *            the caller would end up losing the funds.
     *      note: wrapNative is intended to be consumed in depositGas or placePositionOrder/placeLiquidityOrder.
     *            Any excess ETH sent beyond the amount parameter will be lost in the contract.
     */
    function wrapNative(uint256 amount) external payable;

    /**
     * @dev Trader/LP can transfer ERC20 to OrderBook
     *
     *      note: transferToken is intended to be used as part of a multicall. If it is called directly
     *            the caller would end up losing the funds.
     *      note: transferToken is intended to be consumed in placePositionOrder/placeLiquidityOrder.
     *            Any excess tokens sent beyond the amount parameter will be lost in the contract.
     */
    function transferToken(address token, uint256 amount) external payable;

    /**
     * @dev Delegator can transfer ERC20 from Trader/LP to OrderBook
     */
    function transferTokenFrom(address from, address token, uint256 amount) external payable;

    /**
     * @dev Trader/LP should pay for gas for their orders
     *
     *      you should pay configValue(MCO_ORDER_GAS_FEE_GWEI) * 1e9 / 1e18 ETH for each order
     */
    function depositGas(address account, uint256 amount) external payable;

    /**
     * @dev Trader/LP can withdraw gas
     *
     *      usually your deposited gas should be consumed by your orders immediately,
     *      but if you want to withdraw it, you can call this function
     */
    function withdrawGas(address account, uint256 amount) external payable;

    /**
     * @notice A trader should set initial leverage at least once before open-position
     */
    function setInitialLeverage(bytes32 positionId, bytes32 marketId, uint256 initialLeverage) external payable;

    /**
     * @notice A Trader can open/close position
     *
     *         Market order will expire after marketOrderTimeout seconds.
     *         Limit/Trigger order will expire after deadline.
     */
    function placePositionOrder(PositionOrderParams memory orderParams, bytes32 referralCode) external payable;

    /**
     * @notice A LP can add/remove liquidity to a CollateralPool
     *
     *         Can be filled after liquidityLockPeriod seconds.
     */
    function placeLiquidityOrder(LiquidityOrderParams memory orderParams) external payable;

    /**
     * @notice A Trader can withdraw collateral
     *
     *         This order will expire after marketOrderTimeout seconds.
     */
    function placeWithdrawalOrder(WithdrawalOrderParams memory orderParams) external payable;

    /**
     * @notice A Trader can deposit collateral into a PositionAccount
     */
    function depositCollateral(
        bytes32 positionId,
        address collateralToken,
        uint256 collateralAmount // token decimals
    ) external payable;

    /**
     * @notice A Trader can withdraw all collateral only when position = 0
     */
    function withdrawAllCollateral(WithdrawAllOrderParams memory orderParams) external payable;

    /**
     * @notice A Trader can modify a position order
     */
    function modifyPositionOrder(ModifyPositionOrderParams memory orderParams) external payable;

    /**
     * @notice A Trader/LP can cancel an Order by orderId after a cool down period.
     *         A Broker can also cancel an Order after expiration.
     */
    function cancelOrder(uint64 orderId) external payable;

    /**
     * @notice A Rebalancer can rebalance pool liquidity by swap token 0 for token 1
     *
     *         msg.sender must implement IMux3RebalancerCallback.
     */
    function placeRebalanceOrder(RebalanceOrderParams memory orderParams) external;

    /**
     * @notice Add liquidity to a CollateralPool without mint shares
     */
    function donateLiquidity(
        address poolAddress,
        address collateralAddress,
        uint256 rawAmount // token.decimals
    ) external;
}

interface IOrderBookGetter {
    function nextOrderId() external view returns (uint64);

    function sequence() external view returns (uint32);

    function configValue(bytes32 key) external view returns (bytes32);

    function getOrder(uint64 orderId) external view returns (OrderData memory, bool);

    function getOrders(
        uint256 begin,
        uint256 end
    ) external view returns (OrderData[] memory orderDataArray, uint256 totalCount);

    function getOrdersOf(
        address user,
        uint256 begin,
        uint256 end
    ) external view returns (OrderData[] memory orderDataArray, uint256 totalCount);
}
