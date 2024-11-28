// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

// core
bytes32 constant MC_BORROWING_BASE_APY = keccak256("MC_BORROWING_BASE_APY");
bytes32 constant MC_BORROWING_INTERVAL = keccak256("MC_BORROWING_INTERVAL");
bytes32 constant MC_FEE_DISTRIBUTOR = keccak256("MC_FEE_DISTRIBUTOR");
bytes32 constant MC_SWAPPER = keccak256("MC_SWAPPER");
bytes32 constant MC_STRICT_STABLE_DEVIATION = keccak256("MC_STRICT_STABLE_DEVIATION");

// market
bytes32 constant MM_POSITION_FEE_RATE = keccak256("MM_POSITION_FEE_RATE");
bytes32 constant MM_LIQUIDATION_FEE_RATE = keccak256("MM_LIQUIDATION_FEE_RATE");
bytes32 constant MM_INITIAL_MARGIN_RATE = keccak256("MM_INITIAL_MARGIN_RATE");
bytes32 constant MM_MAINTENANCE_MARGIN_RATE = keccak256("MM_MAINTENANCE_MARGIN_RATE");
bytes32 constant MM_LOT_SIZE = keccak256("MM_LOT_SIZE");
bytes32 constant MM_ORACLE_ID = keccak256("MM_ORACLE_ID");
bytes32 constant MM_DISABLE_TRADE = keccak256("MM_DISABLE_TRADE");
bytes32 constant MM_DISABLE_OPEN = keccak256("MM_DISABLE_OPEN");

// pool
bytes32 constant MCP_SYMBOL = keccak256("MCP_SYMBOL"); // the contract does not use it but can be used in UI
bytes32 constant MCP_LIQUIDITY_FEE_RATE = keccak256("MCP_LIQUIDITY_FEE_RATE");
bytes32 constant MCP_LIQUIDITY_CAP_USD = keccak256("MCP_LIQUIDITY_CAP_USD");
bytes32 constant MCP_BORROWING_K = keccak256("MCP_BORROWING_K");
bytes32 constant MCP_BORROWING_B = keccak256("MCP_BORROWING_B");

// pool + market
bytes32 constant MCP_ADL_RESERVE_RATE = keccak256("MCP_ADL_RESERVE_RATE");
bytes32 constant MCP_ADL_MAX_PNL_RATE = keccak256("MCP_ADL_MAX_PNL_RATE");
bytes32 constant MCP_ADL_TRIGGER_RATE = keccak256("MCP_ADL_TRIGGER_RATE");

// order book
bytes32 constant MCO_LIQUIDITY_LOCK_PERIOD = keccak256("MCO_LIQUIDITY_LOCK_PERIOD");
bytes32 constant MCO_POSITION_ORDER_PAUSED = keccak256("MCO_POSITION_ORDER_PAUSED");
bytes32 constant MCO_LIQUIDITY_ORDER_PAUSED = keccak256("MCO_LIQUIDITY_ORDER_PAUSED");
bytes32 constant MCO_WITHDRAWAL_ORDER_PAUSED = keccak256("MCO_WITHDRAWAL_ORDER_PAUSED");
bytes32 constant MCO_MARKET_ORDER_TIMEOUT = keccak256("MCO_MARKET_ORDER_TIMEOUT");
bytes32 constant MCO_LIMIT_ORDER_TIMEOUT = keccak256("MCO_LIMIT_ORDER_TIMEOUT");
bytes32 constant MCO_REFERRAL_MANAGER = keccak256("MCO_REFERRAL_MANAGER");
bytes32 constant MCO_CANCEL_COOL_DOWN = keccak256("MCO_CANCEL_COOL_DOWN");
bytes32 constant MCO_ORDER_GAS_FEE_GWEI = keccak256("MCO_ORDER_GAS_FEE_GWEI");
