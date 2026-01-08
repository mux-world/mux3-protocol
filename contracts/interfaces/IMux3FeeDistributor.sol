// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

interface IMux3FeeDistributor {
    event FeeDistributedToLP(address indexed tokenAddress, address indexed poolAddress, uint256 rawAmount);
    event FeeDistributedAsDiscount(address indexed tokenAddress, address indexed trader, uint256 rawAmount);
    event FeeDistributedAsRebate(address indexed tokenAddress, address indexed trader, uint256 rawAmount);
    event FeeDistributedToVe(address indexed tokenAddress, uint256 rawAmount);
    event ClaimVeReward(address indexed tokenAddress, uint256 rawAmount);
    event SetReferralManager(address indexed referralManager);

    function updateLiquidityFees(
        address lp,
        address poolAddress,
        address tokenAddress,
        uint256 rawAmount, // token decimals
        bool isUnwrapWeth
    ) external;

    // note: allocation only represents a proportional relationship.
    //       the sum of allocations does not necessarily have to be consistent with the total value.
    function updatePositionFees(
        address trader,
        address[] memory tokenAddresses,
        uint256[] memory rawAmounts, // [amount foreach tokenAddresses], token decimals
        address[] memory backedPools,
        uint256[] memory allocations, // [amount foreach backed pools], decimals = 18
        bool isUnwrapWeth
    ) external;
}
