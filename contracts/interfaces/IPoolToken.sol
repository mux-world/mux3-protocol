// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";

interface IPoolToken is IERC20Upgradeable, IERC20MetadataUpgradeable {
    function mint(address receiver, uint256 amount) external;

    function burn(address receiver, uint256 amount) external;
}
