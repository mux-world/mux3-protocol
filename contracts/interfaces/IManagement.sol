// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

interface IManagement {
    event AddCollateralToken(address token, uint8 decimals);
    event CreateCollateralPool(string name, string symbol, address collateral, uint8 collateralDecimals, address pool);
    event AppendBackedPoolsToMarket(bytes32 marketId, address[] backedPools);
    event SetCollateralPoolImplementation(address newImplementation);
    event CreateMarket(bytes32 marketId, string symbol, bool isLong, address[] backedPools);
    event SetConfig(bytes32 key, bytes32 value);
    event SetMarketConfig(bytes32 marketId, bytes32 key, bytes32 value);
    event SetCollateralPoolConfig(address pool, bytes32 key, bytes32 value);
    event SetCollateralTokenEnabled(address token, bool enabled);
    event SetOracleProvider(address oracleProvider, bool isValid);
    event SetPrice(bytes32 priceId, address provider, bytes data, uint256 price, uint256 timestamp);

    function setPrice(bytes32 priceId, address provider, bytes memory oracleCalldata) external;

    // TODO: remove me if oracleProvider is ready
    // TODO: we MUST remove this function before launch
    function setMockPrice(bytes32 key, uint256 price) external;
}
