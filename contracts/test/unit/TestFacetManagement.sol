// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";

import "../../core/management/FacetManagement.sol";
import "../integration/MockERC20.sol";
import "../integration/SimplePriceProvider.sol";

import "../TestSuit.sol";

contract TestFacetManagement is FacetManagement, TestSuit {
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using LibConfigMap for mapping(bytes32 => bytes32);
    using LibTypeCast for address;

    ERC20 public d6;
    ERC20 public d18;
    MockStrangeERC20WithoutDecimals public oldToken;

    function setup() external {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        d6 = new MockERC20("D6", "D6", 6);
        d18 = new MockERC20("D18", "D18", 18);
        oldToken = new MockStrangeERC20WithoutDecimals();
    }

    function test_CollateralManager_retrieveDecimals() external view {
        assertEq(_retrieveDecimals(address(d6), 6), 6, "E01");
        assertEq(_retrieveDecimals(address(d18), 18), 18, "E02");
        // token without decimals
        assertEq(_retrieveDecimals(address(this), 4), 4, "E03");
    }

    function test_CollateralManager_addCollateralToken() external {
        assertEq(_isCollateralExist(address(d6)), false, "E01");
        assertEq(_isCollateralExist(address(d6)), false, "E02");
        assertEq(_isCollateralExist(address(d18)), false, "E03");
        assertEq(_isCollateralExist(address(d18)), false, "E04");

        _addCollateralToken(address(d6), 6, false);
        assertEq(_isCollateralExist(address(d6)), true, "E05");
        assertEq(_isCollateralExist(address(d6)), true, "E06");
        assertEq(_isCollateralExist(address(d18)), false, "E07");
        assertEq(_isCollateralExist(address(d18)), false, "E08");

        _addCollateralToken(address(d18), 18, false);
        assertEq(_isCollateralExist(address(d6)), true, "E08");
        assertEq(_isCollateralExist(address(d6)), true, "E10");
        assertEq(_isCollateralExist(address(d18)), true, "E11");
        assertEq(_isCollateralExist(address(d18)), true, "E12");

        _addCollateralToken(address(oldToken), 18, false);
        assertEq(_isCollateralExist(address(oldToken)), true, "E13");
    }

    function test_MarketManager_createMarket() external {
        _addCollateralToken(address(d6), 6, true);

        address fakePool0 = address(new FakeCollateralPool(address(d6)));
        address fakePool1 = address(new FakeCollateralPool(address(d6)));
        address fakePool2 = address(new FakeCollateralPool(address(d6)));
        {
            // inject fake pools
            _collateralPoolList.add(fakePool0);
            _collateralPoolList.add(fakePool1);
            _collateralPoolList.add(fakePool2);
        }

        bytes32 marketId0 = bytes32(uint256(0x1));
        bytes32 marketId1 = bytes32(uint256(0x2));
        {
            assertEq(_isMarketExist(marketId0), false, "E01");
            address[] memory pools = new address[](2);
            pools[0] = fakePool0;
            pools[1] = fakePool1;
            _createMarket(marketId0, "M0", true);
            _appendBackedPoolsToMarket(marketId0, pools);
            assertEq(_isMarketExist(marketId0), true, "E02");
        }
        {
            assertEq(_isMarketExist(marketId1), false, "E03");
            address[] memory pools = new address[](2);
            pools[0] = fakePool1;
            pools[1] = fakePool2;
            _createMarket(marketId1, "M1", false);
            _appendBackedPoolsToMarket(marketId1, pools);
            assertEq(_isMarketExist(marketId1), true, "E04");
        }
        assertEq(_markets[marketId0].pools.length, 2, "E05");
        assertEq(_markets[marketId0].pools[0].backedPool, fakePool0, "E06");
        assertEq(_markets[marketId0].pools[1].backedPool, fakePool1, "E07");
        assertEq(_markets[marketId1].pools.length, 2, "E08");
        assertEq(_markets[marketId1].pools[0].backedPool, fakePool1, "E09");
        assertEq(_markets[marketId1].pools[1].backedPool, fakePool2, "E10");

        {
            bytes32[] memory markets = ICollateralPool(fakePool0).markets();
            assertEq(markets.length, 1, "E11");
            assertEq(markets[0], keccak256(abi.encode(marketId0, true)), "E12");
        }
        {
            bytes32[] memory markets = ICollateralPool(fakePool1).markets();
            assertEq(markets.length, 2, "E13");
            assertEq(markets[0], keccak256(abi.encode(marketId0, true)), "E14");
            assertEq(markets[1], keccak256(abi.encode(marketId1, false)), "E15");
        }
        {
            bytes32[] memory markets = ICollateralPool(fakePool2).markets();
            assertEq(markets.length, 1, "E16");
            assertEq(markets[0], keccak256(abi.encode(marketId1, false)), "E17");
        }
    }

    function test_MarketManager_setMarketConfig() external {
        bytes32 marketId0 = bytes32(uint256(0x1));
        bytes32 marketId1 = bytes32(uint256(0x2));

        _createMarket(marketId0, "M0", true);
        _createMarket(marketId1, "M1", false);

        assertEq(_marketPositionFeeRate(marketId0), 0, "E01");
        // assertEq(_marketInitialMarginRate(marketId0), 0, "E02"); // not allowed
        assertEq(_marketMaintenanceMarginRate(marketId0), 0, "E03");
        // assertEq(_marketLotSize(marketId0), 0, "E04"); // not allowed

        _setMarketConfig(marketId0, MM_POSITION_FEE_RATE, bytes32(uint256(5e15)));
        _setMarketConfig(marketId0, MM_INITIAL_MARGIN_RATE, bytes32(uint256(6e16)));
        _setMarketConfig(marketId0, MM_MAINTENANCE_MARGIN_RATE, bytes32(uint256(7e17)));
        _setMarketConfig(marketId0, MM_LOT_SIZE, bytes32(uint256(8e18)));

        assertEq(_marketPositionFeeRate(marketId0), 5e15, "E05");
        assertEq(_marketInitialMarginRate(marketId0), 6e16, "E06");
        assertEq(_marketMaintenanceMarginRate(marketId0), 7e17, "E07");
        assertEq(_marketLotSize(marketId0), 8e18, "E08");
    }

    function test_PricingManager_setPrice() external {
        // set price provider
        SimplePriceProvider spp = new SimplePriceProvider();
        _setOracleProvider(address(spp), true);
        // 0.003
        _configs.setBytes32(MC_STRICT_STABLE_DEVIATION, bytes32(uint256(3e15))); // 0.003000000000000000

        // non-strict-stable token
        _addCollateralToken(address(d6), 6, false);
        bytes32 oracleId = address(d6).toBytes32();

        _setStrictStableId(oracleId, false);
        _setPrice(oracleId, address(spp), abi.encode(uint256(1004e15)));
        assertEq(_priceOf(oracleId), 1004e15, "E01");
        _setPrice(oracleId, address(spp), abi.encode(uint256(996e15)));
        assertEq(_priceOf(oracleId), 996e15, "E02");

        // strict-stable token
        _setStrictStableId(oracleId, true);
        _setPrice(oracleId, address(spp), abi.encode(uint256(1004e15)));
        assertEq(_priceOf(oracleId), 1004e15, "E01");
        _setPrice(oracleId, address(spp), abi.encode(uint256(996e15)));
        assertEq(_priceOf(oracleId), 996e15, "E02");

        _setPrice(oracleId, address(spp), abi.encode(uint256(1003e15)));
        assertEq(_priceOf(oracleId), 1e18, "E03");
        _setPrice(oracleId, address(spp), abi.encode(uint256(997e15)));
        assertEq(_priceOf(oracleId), 1e18, "E04");
    }
}

contract FakeCollateralPool {
    address public immutable collateralToken;
    bytes32[] _markets;

    constructor(address collateralToken_) {
        collateralToken = collateralToken_;
    }

    function markets() external view returns (bytes32[] memory) {
        return _markets;
    }

    function setMarket(bytes32 marketId, bool isLong) external {
        _markets.push(keccak256(abi.encode(marketId, isLong)));
    }
}

contract MockStrangeERC20WithoutDecimals {}
