// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

contract MockSUSDC is ERC20 {
    using SafeERC20 for IERC20Metadata;

    // NAV = 1.06 = NAV_NUM / NAV_DEN
    uint256 private constant NAV_NUM = 106;
    uint256 private constant NAV_DEN = 100;
    uint8 private constant SHARES_DECIMALS = 18;
    uint256 private constant SHARES_ONE = 10 ** SHARES_DECIMALS;

    IERC20Metadata private immutable _asset;
    uint8 private immutable _assetDecimals;
    uint256 private immutable _assetOne; // 10**assetDecimals

    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed caller,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    constructor(address asset_) ERC20("Mock Spark USDC Vault", "mSUSDC") {
        require(asset_ != address(0), "MockSUSDC/invalid-asset");
        _asset = IERC20Metadata(asset_);
        _assetDecimals = _asset.decimals();
        _assetOne = 10 ** _assetDecimals;
    }

    function decimals() public pure override returns (uint8) {
        return SHARES_DECIMALS;
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    function totalAssets() public view returns (uint256) {
        return _sharesToAssetsDown(totalSupply());
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _assetsToSharesDown(assets);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _sharesToAssetsDown(shares);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return _assetsToSharesDown(assets);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return _sharesToAssetsUp(shares);
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return _assetsToSharesUp(assets);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return _sharesToAssetsDown(shares);
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        uint256 byShares = _sharesToAssetsDown(balanceOf(owner));
        uint256 cash = _asset.balanceOf(address(this));
        return byShares < cash ? byShares : cash;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        uint256 holder = balanceOf(owner);
        uint256 cash = _asset.balanceOf(address(this));
        uint256 sharesByCash = _assetsToSharesDown(cash);
        return holder < sharesByCash ? holder : sharesByCash;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(receiver != address(0), "MockSUSDC/invalid-receiver");
        require(assets > 0, "MockSUSDC/zero-assets");
        shares = _assetsToSharesDown(assets);
        require(shares > 0, "MockSUSDC/zero-shares");
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        require(receiver != address(0), "MockSUSDC/invalid-receiver");
        require(shares > 0, "MockSUSDC/zero-shares");
        assets = _sharesToAssetsUp(shares);
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(receiver != address(0), "MockSUSDC/invalid-receiver");
        shares = _assetsToSharesUp(assets);
        if (owner != msg.sender) {
            uint256 allowed = allowance(owner, msg.sender);
            if (allowed != type(uint256).max) {
                require(allowed >= shares, "MockSUSDC/insufficient-allowance");
                _approve(owner, msg.sender, allowed - shares);
            }
        }
        _burn(owner, shares);
        _asset.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(receiver != address(0), "MockSUSDC/invalid-receiver");
        require(shares > 0, "MockSUSDC/zero-shares");
        if (owner != msg.sender) {
            uint256 allowed = allowance(owner, msg.sender);
            if (allowed != type(uint256).max) {
                require(allowed >= shares, "MockSUSDC/insufficient-allowance");
                _approve(owner, msg.sender, allowed - shares);
            }
        }
        assets = _sharesToAssetsDown(shares);
        _burn(owner, shares);
        _asset.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function _sharesToAssetsDown(uint256 shares) internal view returns (uint256) {
        if (shares == 0) return 0;
        return (shares * NAV_NUM * _assetOne) / (NAV_DEN * SHARES_ONE);
    }

    function _sharesToAssetsUp(uint256 shares) internal view returns (uint256) {
        if (shares == 0) return 0;
        return Math.ceilDiv(shares * NAV_NUM * _assetOne, NAV_DEN * SHARES_ONE);
    }

    function _assetsToSharesDown(uint256 assets) internal view returns (uint256) {
        if (assets == 0) return 0;
        return (assets * NAV_DEN * SHARES_ONE) / (NAV_NUM * _assetOne);
    }

    function _assetsToSharesUp(uint256 assets) internal view returns (uint256) {
        if (assets == 0) return 0;
        return Math.ceilDiv(assets * NAV_DEN * SHARES_ONE, NAV_NUM * _assetOne);
    }
}
