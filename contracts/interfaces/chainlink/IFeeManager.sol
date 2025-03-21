// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "./ICommon.sol";

interface IFeeManager {
    /**
     * @notice Calculate the applied fee and the reward from a report. If the sender is a subscriber, they will receive a discount.
     * @param subscriber address trying to verify
     * @param report report to calculate the fee for
     * @param quoteAddress address of the quote payment token
     * @return (fee, reward, totalDiscount) fee and the reward data with the discount applied
     */
    function getFeeAndReward(
        address subscriber,
        bytes memory report,
        address quoteAddress
    ) external returns (Asset memory, Asset memory, uint256);

    function i_rewardManager() external view returns (address);

    function i_linkAddress() external view returns (address);
}
