// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/access/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../interfaces/IMux3FeeDistributor.sol";
import "../interfaces/IReferralManager.sol";
import "../interfaces/IReferralTiers.sol";
import "../interfaces/IRoles.sol";
import "../interfaces/IMux3Core.sol";
import "../interfaces/IOrderBook.sol";
import "../libraries/LibEthUnwrapper.sol";

/**
 * @notice Mux3FeeDistributor is used to distribute protocol income to LP holders and veMUX holders.
 */
contract Mux3FeeDistributor is Initializable, AccessControlEnumerableUpgradeable, IMux3FeeDistributor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    address public mux3Facet;
    address public referralManager;
    address public referralTiers;
    mapping(address => uint256) public unclaimedVeReward; // tokenAddress => rawAmount
    uint256 public lpRewardRatio; // 1e18
    address public weth;
    address public orderBook;

    event SetFeeRatio(uint256 lpRewardRatio, uint256 placeHolder1, uint256 placeHolder2, uint256 placeHolder3);

    modifier onlyFeeDistributorUser() {
        require(isFeeDistributorUser(msg.sender), "Not a valid fee distributor user");
        _;
    }

    function initialize(
        address mux3Facet_,
        address orderBook_,
        address referralManager_,
        address referralTiers_,
        address weth_
    ) external initializer {
        __AccessControlEnumerable_init();
        mux3Facet = mux3Facet_;
        orderBook = orderBook_;
        referralManager = referralManager_;
        referralTiers = referralTiers_;
        weth = weth_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MAINTAINER_ROLE, msg.sender);
        lpRewardRatio = 1e18; // default ratio: income * 100% => LP holder
    }

    receive() external payable {
        require(msg.sender == weth, "WETH");
    }

    function setReferralManager(address referralManager_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(referralManager_ != address(0), "Invalid referral manager");
        referralManager = referralManager_;
        emit SetReferralManager(referralManager_);
    }

    /**
     * @dev MUX3 core collects liquidity fees when fillLiquidityOrder.
     *
     *      note: MUX3 Core / CollateralPool should send fees to this contract before calling this function.
     */
    function updateLiquidityFees(
        address lp,
        address poolAddress,
        address tokenAddress,
        uint256 rawAmount, // token decimals
        bool isUnwrapWeth
    ) external override onlyFeeDistributorUser {
        if (rawAmount == 0) {
            return;
        }
        IncomeInfo memory income = IncomeInfo({
            tokenAddress: tokenAddress,
            rawAmount: rawAmount,
            feeSource: FeeSource.LIQUIDITY,
            trader: lp,
            pool: poolAddress,
            isUnwrapWeth: isUnwrapWeth
        });
        _distributeFee(income);
    }

    /**
     * @dev MUX3 core collects position fees when closePosition.
     *
     *      note: MUX3 Core / CollateralPool should send fees to this contract before calling this function.
     * @param allocations only represents a proportional relationship. the sum of allocations does not
     *                    necessarily have to be consistent with the total value.
     */
    function updatePositionFees(
        address trader,
        address[] memory tokenAddresses,
        uint256[] memory rawAmounts, // [amount foreach tokenAddresses], token decimals
        address[] memory backedPools,
        uint256[] memory allocations, // [amount foreach backed pools], decimals = 18
        bool isUnwrapWeth
    ) external override onlyFeeDistributorUser {
        // foreach collateral
        //   pool_fee_i = fee * allocation_i / Σallocation_i
        require(tokenAddresses.length == rawAmounts.length, "tokenAddresses and rawAmounts mismatched");
        require(backedPools.length == allocations.length, "backedPools and allocations mismatched");
        uint256 totalAllocation = 0;
        for (uint256 i = 0; i < allocations.length; i++) {
            totalAllocation += allocations[i];
        }
        if (totalAllocation == 0) {
            return;
        }
        for (uint256 fi = 0; fi < tokenAddresses.length; fi++) {
            address tokenAddress = tokenAddresses[fi];
            uint256 rawAmount = rawAmounts[fi];
            for (uint256 pi = 0; pi < backedPools.length; pi++) {
                address pool = backedPools[pi];
                uint256 rawAmountForPool = (rawAmount * allocations[pi]) / totalAllocation;
                if (rawAmountForPool == 0) {
                    continue;
                }
                IncomeInfo memory income = IncomeInfo({
                    tokenAddress: tokenAddress,
                    rawAmount: rawAmountForPool,
                    feeSource: FeeSource.POSITION,
                    trader: trader,
                    pool: pool,
                    isUnwrapWeth: isUnwrapWeth
                });
                _distributeFee(income);
            }
        }
    }

    function isFeeDistributorUser(address addr) public view returns (bool) {
        if (addr == mux3Facet) {
            // mux3 core is valid (position fee, borrowing fee)
            return true;
        }
        if (addr == orderBook) {
            // orderBook is valid (reallocation fee)
            return true;
        }
        if (_isCollateralPool(addr)) {
            // mux3 collateral pools are valid (LP fee)
            return true;
        }
        if (hasRole(FEE_DISTRIBUTOR_USER_ROLE, addr)) {
            // for future use
            return true;
        }
        return false;
    }

    function setFeeRatio(uint256 lpRewardRatio_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(lpRewardRatio_ <= 1e18, "Sum of all ratio > 1");
        lpRewardRatio = lpRewardRatio_;
        emit SetFeeRatio(lpRewardRatio_, 0, 0, 0);
    }

    function claimVeReward(address tokenAddress) external {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || hasRole(MAINTAINER_ROLE, msg.sender), "Admin or Maintainer");
        uint256 amount = unclaimedVeReward[tokenAddress];
        SafeERC20Upgradeable.safeTransfer(IERC20Upgradeable(tokenAddress), msg.sender, amount);
        unclaimedVeReward[tokenAddress] = 0;
        emit ClaimVeReward(tokenAddress, amount);
    }

    /**
     * @dev The referral code determines the discount and rebate rates.
     */
    function getCodeOf(
        address trader
    )
        public
        view
        returns (
            bytes32 code,
            address codeRecipient,
            uint256 tier, // 1e0
            uint256 discountRate, // 1e18
            uint256 rebateRate // 1e18
        )
    {
        (code, ) = IReferralManager(referralManager).getReferralCodeOf(trader);
        if (code != bytes32(0)) {
            codeRecipient = IReferralManager(referralManager).rebateRecipients(code);
            tier = IReferralTiers(referralTiers).code2Tier(code);
            (, , uint64 rate1, uint64 rate2) = IReferralManager(referralManager).tierSettings(tier);
            // convert 1e5 to 1e18
            discountRate = uint256(rate1) * 10 ** 13;
            rebateRate = uint256(rate2) * 10 ** 13;
        } else {
            // empty referral code is not tier 0, but zero discount/rebate
        }
        uint64 extraDiscount = IReferralManager(referralManager).getExtraDiscount(trader);
        if (extraDiscount > 0) {
            discountRate += uint256(extraDiscount) * 10 ** 13;
        }
    }

    enum FeeSource {
        LIQUIDITY,
        POSITION
    }

    struct IncomeInfo {
        // protocol income
        address tokenAddress;
        uint256 rawAmount; // 1e18
        // where the fee comes from
        FeeSource feeSource;
        address trader; // trader for POSITION, lp for LIQUIDITY
        address pool; // backed pool
        bool isUnwrapWeth;
    }

    /**
     * @dev Distribute protocol income to the trader and the referrer.
     *
     *      1. handle discount, rebate
     *      2. income × 70% => LP holder     (immediately transfer)
     *      3. income × 30% => veMUX holders (saved in this contract until claimed)
     */
    function _distributeFee(IncomeInfo memory income) internal {
        uint256 remaining = _discountRebate(income);
        income.rawAmount = remaining;
        _distributeRemaining(income);
    }

    function _discountRebate(IncomeInfo memory income) internal returns (uint256 remainingRawAmount) {
        (, address codeRecipient, , uint256 discountRate, uint256 rebateRate) = getCodeOf(income.trader);

        uint256 rawAmountToTrader = (income.rawAmount * discountRate) / 1e18;
        if (income.trader == address(0)) {
            // this should never happen, but just in case
            rawAmountToTrader = 0;
        }
        if (rawAmountToTrader > 0) {
            emit FeeDistributedAsDiscount(income.tokenAddress, income.trader, rawAmountToTrader);
        }

        uint256 rawAmountToReferrer = (income.rawAmount * rebateRate) / 1e18;
        if (codeRecipient == address(0)) {
            rawAmountToReferrer = 0;
        }
        if (rawAmountToReferrer > 0) {
            emit FeeDistributedAsRebate(income.tokenAddress, income.trader, rawAmountToReferrer);
        }

        if (income.trader == codeRecipient && income.trader != address(0)) {
            // merged
            uint256 rawTotal = rawAmountToTrader + rawAmountToReferrer;
            _transferOut(income.tokenAddress, income.trader, rawTotal, income.isUnwrapWeth);
        } else {
            // separated
            if (rawAmountToTrader > 0) {
                _transferOut(income.tokenAddress, income.trader, rawAmountToTrader, income.isUnwrapWeth);
            }
            if (rawAmountToReferrer > 0) {
                _transferOut(
                    income.tokenAddress,
                    codeRecipient,
                    rawAmountToReferrer,
                    true // we assume referrer receives eth
                );
            }
        }
        remainingRawAmount = income.rawAmount - rawAmountToTrader - rawAmountToReferrer;
    }

    function _distributeRemaining(IncomeInfo memory income) internal {
        // income × 70% => DLP holder
        uint256 rawAmountToLP = (income.rawAmount * lpRewardRatio) / 1e18;
        if (rawAmountToLP > 0) {
            _transferOut(
                income.tokenAddress,
                orderBook,
                rawAmountToLP,
                false // orderBook only accepts weth
            );
            IOrderBook(orderBook).donateLiquidity(income.pool, income.tokenAddress, rawAmountToLP);
            emit FeeDistributedToLP(income.tokenAddress, income.pool, rawAmountToLP);
        }

        // remaining => veMUX holders
        uint256 rawAmountToVe = income.rawAmount - rawAmountToLP;
        if (rawAmountToVe > 0) {
            unclaimedVeReward[income.tokenAddress] += rawAmountToVe;
            emit FeeDistributedToVe(income.tokenAddress, rawAmountToVe);
        }
    }

    function _transferOut(address tokenAddress, address recipient, uint256 rawAmount, bool isUnwrapWeth) internal {
        if (tokenAddress == weth && isUnwrapWeth) {
            LibEthUnwrapper.unwrap(weth, payable(recipient), rawAmount);
        } else {
            IERC20Upgradeable(tokenAddress).safeTransfer(recipient, rawAmount);
        }
    }

    function _isCollateralPool(address pool) internal view returns (bool isExist) {
        isExist = IFacetReader(mux3Facet).getCollateralPool(pool);
    }
}
