// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";

import "../../interfaces/IFacetTrade.sol";
import "../../libraries/LibTypeCast.sol";
import "./TradeBase.sol";

contract FacetPositionAccount is Mux3TradeBase, IFacetPositionAccount {
    using LibTypeCast for address;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.Bytes32Set;
    using LibConfigMap for mapping(bytes32 => bytes32);

    struct WithdrawMemory {
        uint256 allBorrowingFeeUsd;
        uint256 collateralAmount;
        bool isSwapSuccess;
        uint256 rawSwapOut;
    }

    struct WithdrawAllMemory {
        address[] collaterals;
        uint256 collateralAmount;
        bool isSwapSuccess;
        uint256 rawSwapOut;
    }

    struct WithdrawUsdMemory {
        uint256 allBorrowingFeeUsd;
        address[] collaterals;
        uint256 remainUsd;
        bool isSwapSuccess;
        uint256 rawSwapOut;
        uint256 tokenPrice;
        uint256 payingUsd;
        uint256 payingCollateral;
    }

    /**
     * @notice Sets the initial leverage for a position
     * @param positionId The unique identifier of the position
     * @param marketId The market identifier
     * @param leverage The initial leverage value to set
     * @dev Creates position account if it doesn't exist. Only callable by ORDER_BOOK_ROLE
     */
    function setInitialLeverage(
        bytes32 positionId,
        bytes32 marketId,
        uint256 leverage
    ) external onlyRole(ORDER_BOOK_ROLE) {
        // make account if required
        if (!_isPositionAccountExist(positionId)) {
            _createPositionAccount(positionId);
        }
        PositionAccountInfo storage positionAccount = _positionAccounts[positionId];
        // set leverage
        _setInitialLeverage(positionId, marketId, leverage);
        emit SetInitialLeverage(positionAccount.owner, positionId, marketId, leverage);
    }

    /**
     * @notice Deposits collateral into a position account
     * @param positionId The unique identifier of the position
     * @param collateralToken The address of the collateral token to deposit
     * @param rawAmount The amount to deposit in token's native decimals
     * @dev Creates position account if it doesn't exist. Only callable by ORDER_BOOK_ROLE
     */
    function deposit(
        bytes32 positionId,
        address collateralToken,
        uint256 rawAmount // token.decimals
    ) external onlyRole(ORDER_BOOK_ROLE) {
        // make account if required
        if (!_isPositionAccountExist(positionId)) {
            _createPositionAccount(positionId);
        }
        PositionAccountInfo storage positionAccount = _positionAccounts[positionId];
        // deposit
        _depositToAccount(positionId, collateralToken, rawAmount);
        emit Deposit(positionAccount.owner, positionId, collateralToken, rawAmount);
        _dumpForDepositWithdrawEvent(
            positionId,
            0 // borrowingFeeUsd
        );
    }

    /**
     * @notice Withdraws collateral from a position account
     * @param args The withdrawal arguments containing:
     *        - positionId: The position identifier
     *        - collateralToken: Token to withdraw
     *        - amount: Amount to withdraw
     *        - withdrawSwapToken: Token to swap to. use address(0) to skip swap
     *        - withdrawSwapSlippage: Maximum allowed slippage for swap
     *        - lastConsumedToken: Last token consumed for borrowing fees
     *        - isUnwrapWeth: Whether to unwrap WETH to ETH
     * @dev Only callable by ORDER_BOOK_ROLE. Checks leverage safety after withdrawal
     */
    function withdraw(WithdrawArgs memory args) external onlyRole(ORDER_BOOK_ROLE) {
        WithdrawMemory memory mem;
        require(_isPositionAccountExist(args.positionId), PositionAccountNotExist(args.positionId));
        PositionAccountInfo storage positionAccount = _positionAccounts[args.positionId];
        // update borrowing fee for all markets
        mem.allBorrowingFeeUsd = _updateBorrowingForAllMarkets(
            args.positionId,
            args.lastConsumedToken,
            args.isUnwrapWeth
        );
        // withdraw
        mem.collateralAmount = _collateralToWad(args.collateralToken, args.amount);
        (mem.isSwapSuccess, mem.rawSwapOut) = _withdrawFromAccount(
            args.positionId,
            args.collateralToken,
            mem.collateralAmount,
            args.withdrawSwapToken,
            args.withdrawSwapSlippage,
            args.isUnwrapWeth
        );
        emit Withdraw(
            positionAccount.owner,
            args.positionId,
            args.collateralToken,
            mem.collateralAmount,
            mem.isSwapSuccess ? args.withdrawSwapToken : args.collateralToken,
            mem.rawSwapOut
        );
        // exceeds leverage set by setInitialLeverage
        require(_isLeverageSafe(args.positionId), UnsafePositionAccount(args.positionId, SAFE_LEVERAGE));
        // exceeds leverage set by MM_INITIAL_MARGIN_RATE
        require(_isInitialMarginSafe(args.positionId), UnsafePositionAccount(args.positionId, SAFE_INITIAL_MARGIN));
        _dumpForDepositWithdrawEvent(args.positionId, mem.allBorrowingFeeUsd);
    }

    /**
     * @notice Withdraws all collateral from a position account
     * @param args The withdrawal arguments containing:
     *        - positionId: The position identifier
     *        - withdrawSwapToken: Token to swap to. use address(0) to skip swap
     *        - withdrawSwapSlippage: Maximum allowed slippage for swap
     *        - isUnwrapWeth: Whether to unwrap WETH to ETH
     * @dev Only callable by ORDER_BOOK_ROLE. All positions must be closed first
     */
    function withdrawAll(WithdrawAllArgs memory args) external onlyRole(ORDER_BOOK_ROLE) {
        WithdrawAllMemory memory mem;
        require(_isPositionAccountExist(args.positionId), PositionAccountNotExist(args.positionId));
        PositionAccountInfo storage positionAccount = _positionAccounts[args.positionId];
        // all positions should be closed
        require(positionAccount.activeMarkets.length() == 0, PositionNotClosed(args.positionId));
        mem.collaterals = positionAccount.activeCollaterals.values();
        for (uint256 i = 0; i < mem.collaterals.length; i++) {
            mem.collateralAmount = positionAccount.collaterals[mem.collaterals[i]];
            if (mem.collateralAmount == 0) {
                // activeCollaterals should guarantee amount > 0. however, since this is usually the last step of trading,
                // we allow such withdrawals to make the execution process simpler and more fault tolerant
                continue;
            }
            (mem.isSwapSuccess, mem.rawSwapOut) = _withdrawFromAccount(
                args.positionId,
                mem.collaterals[i],
                mem.collateralAmount,
                args.withdrawSwapToken,
                args.withdrawSwapSlippage,
                args.isUnwrapWeth
            );
            emit Withdraw(
                positionAccount.owner,
                args.positionId,
                mem.collaterals[i],
                mem.collateralAmount,
                mem.isSwapSuccess ? args.withdrawSwapToken : mem.collaterals[i],
                mem.rawSwapOut
            );
        } // emit Withdraw here
        _dumpForDepositWithdrawEvent(
            args.positionId,
            0 // borrowingFeeUsd
        );
    }

    /**
     * @notice Withdraws a specific USD value of collateral from a position account
     * @param args The withdrawal arguments containing:
     *        - positionId: The position identifier
     *        - collateralUsd: USD value to withdraw
     *        - withdrawSwapToken: Token to swap to. use address(0) to skip swap
     *        - withdrawSwapSlippage: Maximum allowed slippage for swap
     *        - lastConsumedToken: Last token consumed for borrowing fees
     *        - isUnwrapWeth: Whether to unwrap WETH to ETH
     * @dev Only callable by ORDER_BOOK_ROLE. Checks leverage safety after withdrawal
     */
    function withdrawUsd(WithdrawUsdArgs memory args) external onlyRole(ORDER_BOOK_ROLE) {
        WithdrawUsdMemory memory mem;
        require(_isPositionAccountExist(args.positionId), PositionAccountNotExist(args.positionId));
        PositionAccountInfo storage positionAccount = _positionAccounts[args.positionId];
        // update borrowing fee for all markets
        mem.allBorrowingFeeUsd = _updateBorrowingForAllMarkets(
            args.positionId,
            args.lastConsumedToken,
            args.isUnwrapWeth
        );
        // withdraw
        mem.collaterals = _activeCollateralsWithLastWithdraw(args.positionId, args.lastConsumedToken);
        mem.remainUsd = args.collateralUsd;
        for (uint256 i = 0; i < mem.collaterals.length; i++) {
            mem.tokenPrice = _priceOf(mem.collaterals[i]);
            {
                uint256 balanceUsd = (positionAccount.collaterals[mem.collaterals[i]] * mem.tokenPrice) / 1e18;
                mem.payingUsd = MathUpgradeable.min(balanceUsd, mem.remainUsd);
            }
            mem.payingCollateral = (mem.payingUsd * 1e18) / mem.tokenPrice;
            if (mem.payingCollateral == 0) {
                continue;
            }
            (mem.isSwapSuccess, mem.rawSwapOut) = _withdrawFromAccount(
                args.positionId,
                mem.collaterals[i],
                mem.payingCollateral,
                args.withdrawSwapToken,
                args.withdrawSwapSlippage,
                args.isUnwrapWeth
            );
            emit Withdraw(
                positionAccount.owner,
                args.positionId,
                mem.collaterals[i],
                mem.payingCollateral,
                mem.isSwapSuccess ? args.withdrawSwapToken : mem.collaterals[i],
                mem.rawSwapOut
            );
            mem.remainUsd -= mem.payingUsd;
            if (mem.remainUsd == 0) {
                break;
            }
        }
        require(mem.remainUsd == 0, InsufficientCollateralUsd(mem.remainUsd, 0));
        // exceeds leverage set by setInitialLeverage
        require(_isLeverageSafe(args.positionId), UnsafePositionAccount(args.positionId, SAFE_LEVERAGE));
        // exceeds leverage set by MM_INITIAL_MARGIN_RATE
        require(_isInitialMarginSafe(args.positionId), UnsafePositionAccount(args.positionId, SAFE_INITIAL_MARGIN));
        _dumpForDepositWithdrawEvent(args.positionId, mem.allBorrowingFeeUsd);
    }

    /**
     * @notice Updates the borrowing fee for a specific position and market
     * @param positionId The position identifier
     * @param marketId The market identifier
     * @param lastConsumedToken The last token consumed for borrowing fees
     * @param isUnwrapWeth Whether to unwrap WETH to ETH
     * @dev Allows LPs to collect fees even if position remains open. Only callable by ORDER_BOOK_ROLE
     */
    function updateBorrowingFee(
        bytes32 positionId,
        bytes32 marketId,
        address lastConsumedToken,
        bool isUnwrapWeth
    ) external onlyRole(ORDER_BOOK_ROLE) {
        if (!_isPositionAccountExist(positionId)) {
            _createPositionAccount(positionId);
        }
        PositionAccountInfo storage positionAccount = _positionAccounts[positionId];
        // update borrowing fee
        uint256[] memory cumulatedBorrowingPerUsd = _updateMarketBorrowing(marketId);
        uint256 borrowingFeeUsd = _updateAndDispatchBorrowingFee(
            positionAccount.owner,
            positionId,
            marketId,
            cumulatedBorrowingPerUsd,
            true,
            lastConsumedToken,
            isUnwrapWeth
        );
        emit UpdatePositionBorrowingFee(positionAccount.owner, positionId, marketId, borrowingFeeUsd);
    }

    function _updateBorrowingForAllMarkets(
        bytes32 positionId,
        address lastConsumedToken,
        bool isUnwrapWeth
    ) private returns (uint256 allBorrowingFeeUsd) {
        PositionAccountInfo storage positionAccount = _positionAccounts[positionId];
        uint256 marketLength = positionAccount.activeMarkets.length();
        for (uint256 i = 0; i < marketLength; i++) {
            bytes32 marketId = positionAccount.activeMarkets.at(i);
            uint256[] memory cumulatedBorrowingPerUsd = _updateMarketBorrowing(marketId);
            uint256 borrowingFeeUsd = _updateAndDispatchBorrowingFee(
                positionAccount.owner,
                positionId,
                marketId,
                cumulatedBorrowingPerUsd,
                true, // shouldCollateralSufficient
                lastConsumedToken,
                isUnwrapWeth
            );
            allBorrowingFeeUsd += borrowingFeeUsd;
        }
    }

    function _dumpForDepositWithdrawEvent(bytes32 positionId, uint256 borrowingFeeUsd) private {
        PositionAccountInfo storage positionAccount = _positionAccounts[positionId];
        address[] memory collateralTokens = positionAccount.activeCollaterals.values();
        uint256[] memory collateralAmounts = new uint256[](collateralTokens.length);
        for (uint256 i = 0; i < collateralTokens.length; i++) {
            collateralAmounts[i] = positionAccount.collaterals[collateralTokens[i]];
        }
        emit DepositWithdrawFinish(
            positionAccount.owner,
            positionId,
            borrowingFeeUsd,
            collateralTokens,
            collateralAmounts
        );
    }
}
