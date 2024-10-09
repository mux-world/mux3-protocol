// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import "../../interfaces/IBorrowingRate.sol";
import { LibExpBorrowingRate } from "../../libraries/LibExpBorrowingRate.sol";

contract TestLibExpBorrowingRate {
    function getBorrowingRates(
        IBorrowingRate.Global memory conf,
        IBorrowingRate.Pool[] memory pools
    ) public pure returns (int256[] memory fr) {
        fr = new int256[](pools.length);
        for (uint256 i = 0; i < pools.length; i++) {
            fr[i] = LibExpBorrowingRate.getBorrowingRate2(conf, pools[i]);
        }
    }

    function testDistributeEquation(
        IBorrowingRate.Pool[] memory pools,
        int256 xTotal
    ) public pure returns (int256[] memory xi) {
        LibExpBorrowingRate.AllocateMem memory mem;
        mem.poolsN = int256(pools.length);
        mem.pools = new LibExpBorrowingRate.PoolState[](uint256(mem.poolsN));
        for (int256 i = 0; i < mem.poolsN; i++) {
            mem.pools[uint256(i)] = LibExpBorrowingRate.initPoolState(
                pools[uint256(i)]
            );
        }
        xi = new int256[](uint256(mem.poolsN));

        int256 c;
        for (int256 i = 1; i <= mem.poolsN; i++) {
            c = LibExpBorrowingRate.calculateC(mem, i, xTotal);
        }
        for (int256 i = 0; i < mem.poolsN; i++) {
            xi[uint256(i)] = LibExpBorrowingRate.calculateXi(mem, i, c);
        }
    }

    function sort(
        LibExpBorrowingRate.PoolState[] memory pools,
        int256 n
    ) external pure returns (LibExpBorrowingRate.PoolState[] memory) {
        LibExpBorrowingRate.sort(pools, n);
        return pools;
    }

    function allocate(
        IBorrowingRate.Pool[] memory pools,
        int256 xTotal
    )
        external
        pure
        returns (LibExpBorrowingRate.AllocateResult[] memory result)
    {
        return LibExpBorrowingRate.allocate2(pools, xTotal);
    }
}
