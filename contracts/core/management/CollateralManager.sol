// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";

import "../../interfaces/IConstants.sol";
import "../Mux3FacetBase.sol";

contract CollateralManager is Mux3FacetBase {
    using LibConfigTable for ConfigTable;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.Bytes32Set;

    function _addCollateralToken(address token, uint8 decimals) internal {
        require(token != address(0), InvalidAddress(token));
        require(
            _collateralTokens[token].enabled == Enabled.Invalid,
            CollateralAlreadyExists(token)
        );
        _collateralTokens[token] = CollateralTokenInfo({
            enabled: Enabled.Enabled,
            decimals: _retrieveDecimals(token, decimals)
        });
        _collateralTokenList.push(token);
    }

    function _setCollateralTokenEnabled(address token, bool enabled) internal {
        require(_isCollateralExists(token), CollateralNotExists(token));
        _collateralTokens[token].enabled = enabled
            ? Enabled.Enabled
            : Enabled.Disabled;
    }

    function _retrieveDecimals(
        address token,
        uint8 defaultDecimals
    ) internal view returns (uint8) {
        try IERC20MetadataUpgradeable(token).decimals() returns (
            uint8 tokenDecimals
        ) {
            require(
                tokenDecimals == defaultDecimals,
                UnmatchedDecimals(tokenDecimals, defaultDecimals)
            );
            return tokenDecimals;
        } catch {
            return defaultDecimals;
        }
    }
}
