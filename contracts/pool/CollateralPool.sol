// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

import "../interfaces/IBorrowingRate.sol";
import "../interfaces/ICollateralPool.sol";
import "../interfaces/ICollateralPoolEventEmitter.sol";
import "../interfaces/IErrors.sol";
import "../interfaces/IMux3FeeDistributor.sol";
import "../interfaces/IMux3RebalancerCallback.sol";
import "../libraries/LibConfigMap.sol";
import "../libraries/LibEthUnwrapper.sol";
import "../libraries/LibExpBorrowingRate.sol";
import "../libraries/LibTypeCast.sol";
import "./CollateralPoolToken.sol";
import "./CollateralPoolStore.sol";
import "./CollateralPoolComputed.sol";

contract CollateralPool is CollateralPoolToken, CollateralPoolStore, CollateralPoolComputed, ICollateralPool, IErrors {
    using LibConfigMap for mapping(bytes32 => bytes32);
    using LibTypeCast for int256;
    using LibTypeCast for uint256;
    using LibTypeCast for bytes32;
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.Bytes32Set;

    /**
     * @notice Restricts function access to only the core contract
     */
    modifier onlyCore() {
        require(msg.sender == address(_core), UnauthorizedCaller(msg.sender));
        _;
    }

    /**
     * @notice Restricts function access to only the order book contract
     */
    modifier onlyOrderBook() {
        require(msg.sender == address(_orderBook), UnauthorizedCaller(msg.sender));
        _;
    }

    /**
     * @notice Contract constructor
     * @param core_ Address of the core contract
     * @param orderBook_ Address of the order book contract
     * @param weth_ Address of the WETH contract
     * @param eventEmitter_ Address of the event emitter contract
     */
    constructor(address core_, address orderBook_, address weth_, address eventEmitter_) {
        _core = core_;
        _orderBook = orderBook_;
        _weth = weth_;
        _eventEmitter = eventEmitter_;
    }

    /**
     * @notice Initializes the collateral pool with name, symbol and collateral token
     * @param name_ The name of the pool token
     * @param symbol_ The symbol of the pool token
     * @param collateralToken_ The address of the collateral token
     * @dev Can only be called once due to initializer modifier
     */
    function initialize(string memory name_, string memory symbol_, address collateralToken_) external initializer {
        require(collateralToken_ != address(0), InvalidAddress(collateralToken_));
        __CollateralPoolToken_init(name_, symbol_);
        __CollateralPoolStore_init(collateralToken_);
    }

    /**
     * @notice Allows the contract to receive ETH from WETH contract only
     * @dev Required for removeLiquidity when unwrapping WETH
     */
    receive() external payable {
        require(msg.sender == _weth, UnauthorizedCaller(msg.sender));
    }

    /**
     * @notice Returns the token name, with optional override from config
     * @return The name of the token
     * @dev Modifying ERC20 name is not a common practice. If we really need it, this is the only way.
     */
    function name() public view override returns (string memory) {
        string memory overrideName = _configTable.getString(MCP_TOKEN_NAME);
        return bytes(overrideName).length > 0 ? overrideName : super.name();
    }

    /**
     * @notice Returns the token symbol, with optional override from config
     * @return The symbol of the token
     * @dev Modifying ERC20 symbols is not a common practice. If we really need it, this is the only way.
     */
    function symbol() public view override returns (string memory) {
        string memory overrideSymbol = _configTable.getString(MCP_TOKEN_SYMBOL);
        return bytes(overrideSymbol).length > 0 ? overrideSymbol : super.symbol();
    }

    /**
     * @notice Gets the value for a specific configuration key
     * @param key The configuration key to query
     * @return The value associated with the key
     */
    function configValue(bytes32 key) external view returns (bytes32) {
        return _configTable.getBytes32(key);
    }

    /**
     * @notice Calculates the value of pool.collateralToken. This is used to reserve for potential PnL.
     * @return The value of pool.collateralToken in USD (18 decimals)
     */
    function getCollateralTokenUsd() external view returns (uint256) {
        return _collateralTokenUsd();
    }

    /**
     * @notice Calculates the total Assets Under Management (AUM) in USD including unrealized PnL.
     *         This is used to evaluate NAV.
     *
     *         note: This function is for MUX3 contract internal use only. External contracts may
     *               revert or get incorrect information when calling this function.
     * @return The total AUM value in USD (18 decimals)
     */
    function getAumUsd() external view returns (uint256) {
        return _aumUsd();
    }

    /**
    /**
     * @notice Calculates the reserved USD which is used to ensure the pool can pay PnL
     *
     *         note: This function is for MUX3 contract internal use only. External contracts may
     *               revert or get incorrect information when calling this function.
     * @return Reserved value in USD (18 decimals)
     */
    function getReservedUsd() external view returns (uint256) {
        return _reservedUsd();
    }

    /**
     * @notice Returns the address of the collateral token for this pool
     * @return The collateral token address
     */
    function collateralToken() external view returns (address) {
        return _collateralToken;
    }

    /**
     * @notice Returns the balances of all collateral tokens in the pool
     * @return tokens Array of token addresses
     * @return balances Array of corresponding token balances (18 decimals)
     */
    function liquidityBalances() external view returns (address[] memory tokens, uint256[] memory balances) {
        tokens = IFacetReader(_core).listCollateralTokens();
        balances = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i] = _liquidityBalances[tokens[i]];
        }
    }

    /**
     * @notice Returns all market IDs associated with this pool
     * @return Array of market IDs
     */
    function markets() external view returns (bytes32[] memory) {
        return _marketIds.values();
    }

    /**
     * @notice Returns the state of a specific market
     * @param marketId The ID of the market to query
     * @return The market state struct
     */
    function marketState(bytes32 marketId) external view returns (MarketState memory) {
        return _marketStates[marketId];
    }

    /**
     * @notice Returns the states of all markets
     * @return marketIds Array of market IDs
     * @return states Array of corresponding market states
     */
    function marketStates() external view returns (bytes32[] memory marketIds, MarketState[] memory states) {
        marketIds = _marketIds.values();
        states = new MarketState[](marketIds.length);
        for (uint256 i = 0; i < marketIds.length; i++) {
            bytes32 marketId = marketIds[i];
            states[i] = _marketStates[marketId];
        }
    }

    /**
     * @notice Returns configuration values for all markets given key prefixes
     * @param keyPrefixes Array of configuration key prefixes to query
     * @return marketIds Array of market IDs
     * @return values 2D array of configuration values for each market and key prefix
     */
    function marketConfigs(
        bytes32[] memory keyPrefixes
    ) external view returns (bytes32[] memory marketIds, bytes32[][] memory values) {
        marketIds = _marketIds.values();
        values = new bytes32[][](marketIds.length);
        for (uint256 i = 0; i < marketIds.length; i++) {
            bytes32 marketId = marketIds[i];
            values[i] = new bytes32[](keyPrefixes.length);
            for (uint256 j = 0; j < keyPrefixes.length; j++) {
                bytes32 key = keccak256(abi.encodePacked(keyPrefixes[j], marketId));
                values[i][j] = _configTable.getBytes32(key);
            }
        }
    }

    function borrowingFeeRateApy(bytes32 marketId) public view returns (uint256 feeRateApy) {
        IBorrowingRate.Global memory globalFr;
        globalFr.baseApy = _borrowingBaseApy();
        IBorrowingRate.AllocatePool memory poolFr = makeBorrowingContext(marketId);
        int256 fr = LibExpBorrowingRate.getBorrowingRate2(globalFr, poolFr);
        return fr.toUint256();
    }

    /**
     * @dev This is a helper for borrowing rate calculation or pool allocation.
     *
     *      note: do NOT rely on this function outside MUX3 contracts. we probably modify the return value when necessary.
     */
    function makeBorrowingContext(bytes32 marketId) public view returns (IBorrowingRate.AllocatePool memory poolFr) {
        poolFr.poolId = uint256(uint160(address(this)));
        poolFr.k = _borrowingK();
        poolFr.b = _borrowingB();
        poolFr.poolSizeUsd = _collateralTokenUsd().toInt256();
        poolFr.reservedUsd = _reservedUsd().toInt256();
        poolFr.reserveRate = _adlReserveRate(marketId).toInt256();
        poolFr.isDraining = _isDraining();
    }

    /**
     * @notice Calculates the position PnL for given parameters
     * @param marketId The ID of the market
     * @param size Position size
     * @param entryPrice Entry price of the position
     * @param marketPrice Current market price
     * @return pnlUsd Uncapped PnL in USD
     * @return cappedPnlUsd PnL in USD after applying caps
     */
    function positionPnl(
        bytes32 marketId,
        uint256 size,
        uint256 entryPrice,
        uint256 marketPrice
    ) external view returns (int256 pnlUsd, int256 cappedPnlUsd) {
        if (size == 0) {
            return (0, 0);
        }
        require(marketPrice > 0, MissingPrice(_marketOracleId(marketId)));
        MarketState storage market = _marketStates[marketId];
        int256 priceDelta = marketPrice.toInt256() - entryPrice.toInt256();
        if (!market.isLong) {
            priceDelta = -priceDelta;
        }
        pnlUsd = (priceDelta * size.toInt256()) / 1e18;
        cappedPnlUsd = pnlUsd;
        if (pnlUsd > 0) {
            // cap the trader upnl
            // note that this is not strictly identical to deleverage all positions. this is just an estimated
            //      value when the price increases dramatically.
            uint256 maxPnlRate = _adlMaxPnlRate(marketId);
            uint256 maxPnlUsd = _assetValueForAdl(marketId, maxPnlRate, entryPrice, size);
            cappedPnlUsd = MathUpgradeable.min(uint256(pnlUsd), maxPnlUsd).toInt256();
        }
    }

    /**
     * @notice Sets up a new market in the pool
     * @param marketId The ID of the new market
     * @param isLong Whether this is a long market
     * @dev Can only be called by core contract
     */
    function setMarket(bytes32 marketId, bool isLong) external onlyCore {
        require(!_marketIds.contains(marketId), MarketAlreadyExist(marketId));
        require(_marketIds.add(marketId), ArrayAppendFailed());
        _marketStates[marketId].isLong = isLong;
    }

    /**
     * @notice Sets a configuration value
     * @param key The configuration key
     * @param value The configuration value
     * @dev Can only be called by core contract
     */
    function setConfig(bytes32 key, bytes32 value) external onlyCore {
        _configTable.setBytes32(key, value);
        ICollateralPoolEventEmitter(_eventEmitter).emitSetConfig(key, value);
    }

    /**
     * @notice Open a position in the market.
     * @param marketId The ID of the market
     * @param size The size of the position
     */
    function openPosition(bytes32 marketId, uint256 size, uint256 entryPrice) external override onlyCore {
        MarketState storage data = _marketStates[marketId];
        uint256 newSize = data.totalSize + size;
        data.averageEntryPrice = (data.averageEntryPrice * data.totalSize + entryPrice * size) / newSize;
        data.totalSize = newSize;
        ICollateralPoolEventEmitter(_eventEmitter).emitOpenPosition(
            marketId,
            size,
            data.averageEntryPrice,
            data.totalSize
        );
    }

    /**
     * @notice Close a position in the market.
     * @param marketId The ID of the market
     * @param size The size of the position
     * @param entryPrice The entry price of the position
     */
    function closePosition(bytes32 marketId, uint256 size, uint256 entryPrice) external override onlyCore {
        MarketState storage data = _marketStates[marketId];
        require(size <= data.totalSize, InvalidCloseSize(size, data.totalSize));
        uint256 newSize = data.totalSize - size;
        if (newSize > 0) {
            // in order to keep nav
            data.averageEntryPrice = (data.averageEntryPrice * data.totalSize - entryPrice * size) / newSize;
        } else {
            data.averageEntryPrice = 0;
        }
        data.totalSize = newSize;
        ICollateralPoolEventEmitter(_eventEmitter).emitClosePosition(
            marketId,
            size,
            data.averageEntryPrice,
            data.totalSize
        );
    }

    /**
     * @notice A trader takes profit. the pool pays the profit to the market.
     * @param pnlUsd The PnL in USD
     * @return token The token address
     * @return wad The amount of tokens to be paid
     */
    function realizeProfit(
        uint256 pnlUsd
    )
        external
        onlyCore
        returns (
            address token,
            uint256 wad // 1e18
        )
    {
        token = _collateralToken;
        uint256 collateralPrice = IFacetReader(_core).priceOf(token);
        wad = (pnlUsd * 1e18) / collateralPrice;
        uint256 raw = _toRaw(token, wad);
        wad = _toWad(token, raw); // re-calculate wad to avoid precision loss
        require(wad <= _liquidityBalances[token], InsufficientLiquidity(wad, _liquidityBalances[token]));
        _liquidityBalances[token] -= wad;
        ICollateralPoolEventEmitter(_eventEmitter).emitLiquidityBalanceOut(token, collateralPrice, wad);
        IERC20Upgradeable(token).safeTransfer(address(_core), raw);
    }

    /**
     * @notice A trader realize loss
     *
     *         note: the received token might not the collateral token.
     *         note: core should send tokens to this contract.
     * @param token The token address
     * @param rawAmount The amount of tokens to be received
     */
    function realizeLoss(
        address token,
        uint256 rawAmount // token decimals
    ) external onlyCore {
        uint256 wad = _toWad(token, rawAmount);
        _liquidityBalances[token] += wad;
        uint256 collateralPrice = IFacetReader(_core).priceOf(token);
        ICollateralPoolEventEmitter(_eventEmitter).emitLiquidityBalanceIn(token, collateralPrice, wad);
    }

    /**
     * @notice Get fees from FeeDistributor => OrderBook => CollateralPool
     *
     *         note: the received token might not the collateral token.
     *         note: orderBook should send fee to this contract.
     * @param token The token address
     * @param rawAmount The amount of tokens to be received
     */
    function receiveFee(address token, uint256 rawAmount) external onlyOrderBook {
        uint256 wad = _toWad(token, rawAmount);
        _liquidityBalances[token] += wad;
        uint256 collateralPrice = IFacetReader(_core).priceOf(token);
        ICollateralPoolEventEmitter(_eventEmitter).emitLiquidityBalanceIn(token, collateralPrice, wad);
        ICollateralPoolEventEmitter(_eventEmitter).emitReceiveFee(token, collateralPrice, wad);
    }

    /**
     * @notice Add liquidity to the pool and returns shares to the lp.
     *
     *         note: orderBook should transfer rawCollateralAmount to this contract
     * @param args The arguments for adding liquidity
     * @return result The result of adding liquidity
     */
    function addLiquidity(
        AddLiquidityArgs memory args
    ) external override onlyOrderBook returns (AddLiquidityResult memory result) {
        _updateAllMarketBorrowing();
        require(args.rawCollateralAmount != 0, InvalidAmount("rawCollateralAmount"));
        address token = _collateralToken;
        require(_isCollateralExist(token), CollateralNotExist(token));
        // nav
        uint256 collateralPrice = IFacetReader(_core).priceOf(token);
        uint256 aumUsd = _aumUsd();
        uint256 poolCollateralUsd = _collateralTokenUsd(); // used to reserve for potential PnL. important: read this before add liquidity
        uint256 lpPrice = _nav(aumUsd);
        require(lpPrice > 0, PoolBankrupt());
        // token amount
        uint256 collateralAmount = _toWad(token, args.rawCollateralAmount);
        uint256 liquidityFeeCollateral = (collateralAmount * _liquidityFeeRate()) / 1e18;
        require(
            collateralAmount >= liquidityFeeCollateral,
            InsufficientCollateral(collateralAmount, liquidityFeeCollateral)
        );
        collateralAmount -= liquidityFeeCollateral;
        // to pool
        _liquidityBalances[token] += collateralAmount;
        ICollateralPoolEventEmitter(_eventEmitter).emitLiquidityBalanceIn(token, collateralPrice, collateralAmount);
        // verify
        {
            uint256 liquidityCap = _liquidityCapUsd();
            uint256 collateralUsd = (collateralAmount * collateralPrice) / 1e18;
            require(
                poolCollateralUsd + collateralUsd <= liquidityCap,
                CapacityExceeded(liquidityCap, poolCollateralUsd, collateralUsd)
            );
        }
        // share
        result.shares = (collateralAmount * collateralPrice) / lpPrice;
        result.lpPrice = lpPrice;
        result.collateralPrice = collateralPrice;
        _mint(args.account, result.shares);
        // fees
        _distributeFee(args.account, _collateralToken, collateralPrice, liquidityFeeCollateral, args.isUnwrapWeth);
        // done
        ICollateralPoolEventEmitter(_eventEmitter).emitAddLiquidity(
            args.account,
            token,
            collateralPrice,
            liquidityFeeCollateral,
            lpPrice,
            result.shares
        );
    }

    /**
     * @notice Remove liquidity from the pool and returns collateral tokens to the lp
     *         orderBook should transfer `shares` share token to this contract before removing
     * @param args The arguments for removing liquidity
     * @return result The result of removing liquidity
     */
    function removeLiquidity(
        RemoveLiquidityArgs memory args
    ) external override onlyOrderBook returns (RemoveLiquidityResult memory result) {
        _updateAllMarketBorrowing();
        require(args.shares != 0, InvalidAmount("shares"));
        address token = args.token;
        require(_isCollateralExist(token), CollateralNotExist(token));
        // nav
        uint256 aumUsd = _aumUsd();
        uint256 poolCollateralUsd = _collateralTokenUsd(); // used to reserve for potential PnL. important: read this before remove liquidity
        uint256 lpPrice = _nav(aumUsd);
        require(lpPrice > 0, PoolBankrupt());
        // from pool
        uint256 collateralPrice = IFacetReader(_core).priceOf(token);
        uint256 collateralAmount = (args.shares * lpPrice) / collateralPrice;
        require(
            collateralAmount <= _liquidityBalances[token],
            InsufficientLiquidity(collateralAmount, _liquidityBalances[token])
        );
        _liquidityBalances[token] -= collateralAmount;
        ICollateralPoolEventEmitter(_eventEmitter).emitLiquidityBalanceOut(token, collateralPrice, collateralAmount);
        {
            uint256 removedValue = (collateralPrice * collateralAmount) / 1e18;
            if (removedValue < poolCollateralUsd) {
                poolCollateralUsd -= removedValue;
            } else {
                poolCollateralUsd = 0;
            }
        }
        // fees
        uint256 liquidityFeeCollateral = (collateralAmount * _liquidityFeeRate()) / 1e18;
        require(
            collateralAmount >= liquidityFeeCollateral + args.extraFeeCollateral,
            InsufficientCollateral(collateralAmount, liquidityFeeCollateral + args.extraFeeCollateral)
        );
        collateralAmount -= liquidityFeeCollateral;
        _distributeFee(args.account, token, collateralPrice, liquidityFeeCollateral, args.isUnwrapWeth);
        if (args.extraFeeCollateral > 0) {
            // extraFeeCollateral is always amount of pool.collateralToken
            require(token == _collateralToken, InvalidAddress(token));
            // send extra fee to OrderBook. we can not call _distributeFee here because it sends fee to FeeDistributor
            collateralAmount -= args.extraFeeCollateral;
            ICollateralPoolEventEmitter(_eventEmitter).emitCollectFee(
                _collateralToken,
                collateralPrice,
                args.extraFeeCollateral
            );
            IERC20Upgradeable(_collateralToken).safeTransfer(
                _orderBook,
                _toRaw(_collateralToken, args.extraFeeCollateral)
            );
        }
        // send tokens to lp
        _burn(address(this), args.shares);
        result.rawCollateralAmount = _toRaw(token, collateralAmount);
        result.lpPrice = lpPrice;
        result.collateralPrice = collateralPrice;
        if (token == _weth && args.isUnwrapWeth) {
            LibEthUnwrapper.unwrap(_weth, payable(args.account), result.rawCollateralAmount);
        } else {
            IERC20Upgradeable(token).safeTransfer(args.account, result.rawCollateralAmount);
        }
        // since util = reserved / poolCollateralUsd, do not let new poolCollateralUsd < reserved
        {
            uint256 reservedUsd = _reservedUsd();
            require(reservedUsd <= poolCollateralUsd, InsufficientLiquidity(reservedUsd, poolCollateralUsd));
        }
        ICollateralPoolEventEmitter(_eventEmitter).emitRemoveLiquidity(
            args.account,
            token,
            collateralPrice,
            liquidityFeeCollateral + args.extraFeeCollateral,
            lpPrice,
            args.shares
        );
    }

    /**
     * @notice Rebalance pool liquidity. Swap token0 in this pool into pool.collateralToken
     *         rebalancer must implement IMux3RebalancerCallback
     *
     * @param rebalancer The address of the rebalancer contract
     * @param token0 The address of the token0 to be swapped
     * @param rawAmount0 The amount of token0 to be swapped
     * @param maxRawAmount1 The maximum amount of collateralToken to be swapped
     * @param userData The user data for the rebalancer callback
     * @return rawAmount1 The amount of collateralToken to be swapped
     */
    function rebalance(
        address rebalancer,
        address token0,
        uint256 rawAmount0, // token0 decimals
        uint256 maxRawAmount1, // collateralToken decimals
        bytes memory userData
    ) external override onlyOrderBook returns (uint256 rawAmount1) {
        _updateAllMarketBorrowing();
        require(rebalancer != address(0), InvalidAddress(rebalancer));
        require(token0 != _collateralToken, InvalidAddress(token0));
        require(_isCollateralExist(token0), CollateralNotExist(token0));
        require(_isCollateralExist(_collateralToken), CollateralNotExist(_collateralToken));
        uint256 price0 = IFacetReader(_core).priceOf(token0);
        uint256 price1 = IFacetReader(_core).priceOf(_collateralToken);
        // send token 0
        require(rawAmount0 != 0, InvalidAmount("rawAmount0"));
        uint256 amount0 = _toWad(token0, rawAmount0);
        require(amount0 <= _liquidityBalances[token0], InsufficientLiquidity(amount0, _liquidityBalances[token0]));
        _liquidityBalances[token0] -= amount0;
        IERC20Upgradeable(token0).safeTransfer(rebalancer, rawAmount0);
        ICollateralPoolEventEmitter(_eventEmitter).emitLiquidityBalanceOut(token0, price0, amount0);
        // expected
        uint256 expectedAmount1 = (amount0 * price0) / price1;
        uint256 slippage = _rebalanceSlippage(token0, _collateralToken);
        expectedAmount1 = (expectedAmount1 * (1e18 - slippage)) / 1e18;
        uint256 expectedRawAmount1 = _toRaw(_collateralToken, expectedAmount1);
        require(expectedRawAmount1 <= maxRawAmount1, LimitPriceNotMet(expectedRawAmount1, maxRawAmount1));
        // swap. check amount 1
        {
            uint256 rawAmount1Old = IERC20Upgradeable(_collateralToken).balanceOf(address(this));
            IMux3RebalancerCallback(rebalancer).mux3RebalanceCallback(
                address(this),
                token0,
                _collateralToken,
                rawAmount0,
                expectedRawAmount1,
                userData
            );
            uint256 rawAmount1New = IERC20Upgradeable(_collateralToken).balanceOf(address(this));
            require(
                rawAmount1Old <= rawAmount1New,
                InsufficientCollateralBalance(_collateralToken, rawAmount1New, rawAmount1Old)
            ); // this is a dummy protection that never happens
            rawAmount1 = rawAmount1New - rawAmount1Old;
        }
        require(rawAmount1 >= expectedRawAmount1, LimitPriceNotMet(expectedRawAmount1, rawAmount1));
        uint256 amount1 = _toWad(_collateralToken, rawAmount1);
        _liquidityBalances[_collateralToken] += amount1;
        ICollateralPoolEventEmitter(_eventEmitter).emitLiquidityBalanceIn(_collateralToken, price1, amount1);
        ICollateralPoolEventEmitter(_eventEmitter).emitRebalance(
            rebalancer,
            token0,
            _collateralToken,
            price0,
            price1,
            amount0,
            amount1
        );
    }

    /**
     * @notice Update the borrowing state.
     * @param marketId The ID of the market to update
     * @return newCumulatedBorrowingPerUsd The new cumulative borrowing per USD
     */
    function updateMarketBorrowing(bytes32 marketId) external onlyCore returns (uint256 newCumulatedBorrowingPerUsd) {
        return _updateMarketBorrowing(marketId);
    }

    /**
     * @dev Distribute fee to FeeDistributor
     *
     *      note: we assume the fee is not added to _liquidityBalances
     */
    function _distributeFee(
        address lp,
        address token,
        uint256 collateralPrice,
        uint256 feeCollateral, // decimals = 18
        bool isUnwrapWeth
    ) internal {
        ICollateralPoolEventEmitter(_eventEmitter).emitCollectFee(token, collateralPrice, feeCollateral);
        address feeDistributor = _feeDistributor();
        uint256 rawFee = _toRaw(token, feeCollateral);
        IERC20Upgradeable(token).safeTransfer(feeDistributor, rawFee);
        IMux3FeeDistributor(feeDistributor).updateLiquidityFees(
            lp,
            address(this), // poolAddress
            token,
            rawFee,
            isUnwrapWeth
        );
    }

    function _updateMarketBorrowing(bytes32 marketId) internal returns (uint256 newCumulatedBorrowingPerUsd) {
        MarketState storage market = _marketStates[marketId];
        // interval check
        uint256 interval = IFacetReader(_core).configValue(MC_BORROWING_INTERVAL).toUint256();
        require(interval > 0, EssentialConfigNotSet("MC_BORROWING_INTERVAL"));
        uint256 blockTime = block.timestamp;
        uint256 nextFundingTime = (blockTime / interval) * interval;
        if (market.lastBorrowingUpdateTime == 0) {
            // init state. just update lastFundingTime
            market.lastBorrowingUpdateTime = nextFundingTime;
            return market.cumulatedBorrowingPerUsd;
        } else if (market.lastBorrowingUpdateTime + interval >= blockTime) {
            // do nothing
            return market.cumulatedBorrowingPerUsd;
        }
        uint256 timeSpan = nextFundingTime - market.lastBorrowingUpdateTime;
        uint256 feeRateApy = borrowingFeeRateApy(marketId);
        newCumulatedBorrowingPerUsd = market.cumulatedBorrowingPerUsd + (feeRateApy * timeSpan) / (365 * 86400);
        market.cumulatedBorrowingPerUsd = newCumulatedBorrowingPerUsd;
        market.lastBorrowingUpdateTime = nextFundingTime;
        ICollateralPoolEventEmitter(_eventEmitter).emitUpdateMarketBorrowing(
            marketId,
            feeRateApy,
            newCumulatedBorrowingPerUsd
        );
    }

    function _updateAllMarketBorrowing() internal {
        uint256 marketCount = _marketIds.length();
        for (uint256 i = 0; i < marketCount; i++) {
            bytes32 marketId = _marketIds.at(i);
            _updateMarketBorrowing(marketId);
        }
    }
}
