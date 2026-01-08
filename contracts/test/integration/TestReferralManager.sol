// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import { IReferralManager } from "../../interfaces/IReferralManager.sol";

contract TestReferralManager {
    mapping(bytes32 => address) public rebateRecipients;
    mapping(address => bytes32) public referralCodeOf;
    mapping(address => uint256) public lastUpdatedTime;
    IReferralManager.TierSetting[] public tierSettings;

    function getReferralCodeOf(address trader) external view returns (bytes32, uint256) {
        return (referralCodeOf[trader], lastUpdatedTime[trader]);
    }

    function setReferrerCodeFor(address trader, bytes32 referralCode) external {
        referralCodeOf[trader] = referralCode;
    }

    function setRebateRecipient(bytes32 referralCode, address recipient) external {
        rebateRecipients[referralCode] = recipient;
    }

    function setTierSetting(uint8 tier, uint64 stakeThreshold, uint64 discountRate, uint64 rebateRate) external {
        while (tierSettings.length <= tier) {
            tierSettings.push();
        }
        tierSettings[tier] = IReferralManager.TierSetting(tier, stakeThreshold, discountRate, rebateRate);
    }

    function getExtraDiscount(address trader) external view returns (uint64 discount) {}
}
