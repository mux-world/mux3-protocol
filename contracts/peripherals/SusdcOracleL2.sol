// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

// https://arbiscan.io/address/0x940098b108fb7d0a7e374f6eded7760787464609
interface ISusdc {
    function decimals() external view returns (uint8);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/**
 * @notice An oracle for sUSDC (Spark USDC Vault) on Arbitrum.
 *
 *         Price = NAV(sUSDC/USDC) * Chainlink(USDC/USD).
 *         We assume sUSDC.decimals = 18. USDC.decimals = 6. Output decimals = 8.
 */
contract SusdcOracleL2 is Initializable, OwnableUpgradeable {
    uint8 internal constant OUT_DECIMALS = 8;
    uint8 internal constant SUSDC_DECIMALS = 18;
    uint8 internal constant USDC_DECIMALS = 6;
    uint8 internal constant USDC_FEED_DECIMALS = 8;
    
    ISusdc public susdc;
    IAggregatorV3 public chainlinkUSDC;
    
    function initialize(ISusdc susdc_, IAggregatorV3 chainlinkUSDC_) external initializer {
        __Ownable_init();
        susdc = susdc_;
        chainlinkUSDC = chainlinkUSDC_;

        require(susdc.decimals() == SUSDC_DECIMALS, "Unsupported vault decimals");
        require(chainlinkUSDC.decimals() == USDC_FEED_DECIMALS, "Unsupported feed decimals");
    }

    function decimals() external pure returns (uint8) {
        return OUT_DECIMALS;
    }

    /**
     * @notice Price
     * @dev Pretend to be a ChainlinkAggregator
     * @return roundId The round ID
     * @return answer The answer for this round (sUSDC NAV in USDC terms)
     * @return startedAt Timestamp of when the round started
     * @return updatedAt Timestamp of when the round was updated
     * @return answeredInRound Deprecated - Previously used when answers could take multiple rounds to be computed
     */
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        // read Chainlink USDC/USD
        (
            uint80 usdcRoundId,
            int256 usdcUsdAnswer,
            uint256 usdcStartAt,
            uint256 usdcUpdateAt,
            uint80 usdcAnsweredInRound
        ) = chainlinkUSDC.latestRoundData();
        require(usdcUsdAnswer > 0, "USDC/USD invalid");

        // read NAV (USDC per 1 sUSDC share)
        uint256 navInUsdc = susdc.convertToAssets(1e18); // e.g., 1.063e6 for $1.063 when usdcDec=6

        // convert (navInUsdc * usdcUsdAnswer) scaled to OUT_DECIMALS
        //          6         + 8              =>        8
        uint256 scaled = uint256(navInUsdc) * uint256(usdcUsdAnswer) / 1e6;
        
        // return Chainlink-shaped tuple
        roundId = usdcRoundId;
        answer = int256(scaled);
        startedAt = usdcStartAt < block.timestamp ? usdcStartAt : block.timestamp;
        updatedAt = usdcUpdateAt < block.timestamp ? usdcUpdateAt : block.timestamp;
        answeredInRound = usdcAnsweredInRound;
    }
}
