import hre, { ethers } from "hardhat"
import { Deployer, DeploymentOptions } from "./deployer/deployer"
import { restorableEnviron } from "./deployer/environ"
import { encodePoolMarketKey, toBytes32, toWei, ensureFinished } from "./deployUtils"
import {
  ChainlinkStreamProvider,
  CollateralPoolEventEmitter,
  Delegator,
  Mux3,
  Mux3FeeDistributor,
  OrderBook,
  Swapper,
} from "../typechain"
import { deployDiamondOrSkip } from "./diamondTools"

const ENV: DeploymentOptions = {
  network: hre.network.name,
  artifactDirectory: "./artifacts/contracts",
  addressOverride: {},
}

const a2b = (a) => {
  return a + "000000000000000000000000"
}
const u2b = (u) => {
  return ethers.utils.hexZeroPad(u.toTwos(256).toHexString(), 32)
}

const brokers = [
  "0x4A14ea8A87794157981303FA8aA317A8d6bc2612", // test net broker

  "0x49Db8818022EF28dbf57E0211628c454a50144ed", // mux broker
  "0xBc5bb8fe68eFBB9d5Bf6dEfAB3D8c01b5F36A80f", // mux broker
]

const mux3OracleSigner = "0x4A14ea8A87794157981303FA8aA317A8d6bc2612"

const muxReferralTiers = "0xef6868929C8FCf11996e621cfd1b89d3B3aa6Bda"

const muxReferralManager = "0xa68d96F26112377abdF3d6b9fcde9D54f2604C2a"

async function main(deployer: Deployer) {
  // deploy
  let proxyAdmin = deployer.addressOf("ProxyAdmin")
  let usdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
  let weth = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"

  const diamondInit = await deployer.deployOrSkip("DiamondInit", "DiamondInit")
  const facets = {
    // check https://louper.dev/diamond/ for the current cuts
    diamondCutFacet: await deployer.deployOrSkip("DiamondCutFacet", "DiamondCutFacet"),
    diamondLoupeFacet: await deployer.deployOrSkip("DiamondLoupeFacet", "DiamondLoupeFacet"),
    ownershipFacet: await deployer.deployOrSkip("OwnershipFacet", "OwnershipFacet"),
    facetManagement: await deployer.deployOrSkip("FacetManagement", "FacetManagement"),
    facetReader: await deployer.deployOrSkip("FacetReader", "FacetReader"),
    facetOpen: await deployer.deployOrSkip("FacetOpen", "FacetOpen"),
    facetClose: await deployer.deployOrSkip("FacetClose", "FacetClose"),
    facetPositionAccount: await deployer.deployOrSkip("FacetPositionAccount", "FacetPositionAccount"),
  }
  await deployDiamondOrSkip(deployer, "Mux3", facets, diamondInit)
  const core = (await deployer.getDeployedInterface("Mux3", "Mux3")) as Mux3
  const orderBook = (await deployer.deployUpgradeableOrSkip("OrderBook", "OrderBook", proxyAdmin)) as OrderBook
  const delegator = (await deployer.deployUpgradeableOrSkip("Delegator", "Delegator", proxyAdmin)) as Delegator
  const feeDistributor = (await deployer.deployUpgradeableOrSkip(
    "Mux3FeeDistributor",
    "Mux3FeeDistributor",
    proxyAdmin
  )) as Mux3FeeDistributor
  const chainlinkStreamProvider = (await deployer.deployUpgradeableOrSkip(
    "ChainlinkStreamProvider",
    "ChainlinkStreamProvider",
    proxyAdmin
  )) as ChainlinkStreamProvider
  const collateralPoolEventEmitter = (await deployer.deployUpgradeableOrSkip(
    "CollateralPoolEventEmitter",
    "CollateralPoolEventEmitter",
    proxyAdmin
  )) as CollateralPoolEventEmitter
  const poolImp = await deployer.deployOrSkip(
    "CollateralPool",
    "CollateralPool__implementation",
    core.address,
    orderBook.address,
    weth,
    collateralPoolEventEmitter.address
  )
  const mux3PriceProvider = await deployer.deployUpgradeableOrSkip("MuxPriceProvider", "MuxPriceProvider", proxyAdmin)
  const testReferralManager = await deployer.deployUpgradeableOrSkip(
    "TestReferralManager",
    "TestReferralManager",
    proxyAdmin
  )
  const swapper = (await deployer.deployUpgradeableOrSkip("Swapper", "Swapper", proxyAdmin)) as Swapper
  const lEthMarketId = toBytes32("LongETH")
  const sEthMarketId = toBytes32("ShortETH")

  // core
  await ensureFinished(core.initialize(weth))
  await ensureFinished(core.setCollateralPoolImplementation(poolImp.address))
  await ensureFinished(core.grantRole(ethers.utils.id("ORDER_BOOK_ROLE"), orderBook.address))
  await ensureFinished(core.setConfig(ethers.utils.id("MC_BORROWING_BASE_APY"), u2b(toWei("0.10"))))
  await ensureFinished(core.setConfig(ethers.utils.id("MC_BORROWING_INTERVAL"), u2b(ethers.BigNumber.from(3600))))
  await ensureFinished(core.setConfig(ethers.utils.id("MC_FEE_DISTRIBUTOR"), a2b(feeDistributor.address)))
  await ensureFinished(core.setConfig(ethers.utils.id("MC_SWAPPER"), a2b(swapper.address)))
  await ensureFinished(core.setConfig(ethers.utils.id("MC_STRICT_STABLE_DEVIATION"), u2b(toWei("0.003"))))

  // event emitter
  await ensureFinished(collateralPoolEventEmitter.initialize(core.address))

  // orderbook
  await ensureFinished(orderBook.initialize(core.address, weth))
  for (const broker of brokers) {
    await ensureFinished(orderBook.grantRole(ethers.utils.id("BROKER_ROLE"), broker))
  }
  await ensureFinished(
    orderBook.setConfig(ethers.utils.id("MCO_LIQUIDITY_LOCK_PERIOD"), u2b(ethers.BigNumber.from(60 * 2)))
  ) // 60 * 15
  await ensureFinished(
    orderBook.setConfig(ethers.utils.id("MCO_MARKET_ORDER_TIMEOUT"), u2b(ethers.BigNumber.from(60 * 2)))
  )
  await ensureFinished(
    orderBook.setConfig(ethers.utils.id("MCO_LIMIT_ORDER_TIMEOUT"), u2b(ethers.BigNumber.from(86400 * 30)))
  )
  await ensureFinished(orderBook.setConfig(ethers.utils.id("MCO_CANCEL_COOL_DOWN"), u2b(ethers.BigNumber.from(5))))
  await ensureFinished(orderBook.setConfig(ethers.utils.id("MCO_REFERRAL_MANAGER"), a2b(testReferralManager.address))) // change me to muxReferralManager when release
  await ensureFinished(orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), delegator.address))

  // collateral
  await ensureFinished(core.addCollateralToken(usdc, 6))
  await ensureFinished(core.setCollateralTokenStatus(usdc, true))
  await ensureFinished(core.addCollateralToken(weth, 18))
  await ensureFinished(core.setCollateralTokenStatus(weth, true))

  // pool 1: usdc, normal, support all
  await ensureFinished(core.createCollateralPool("MUX3 USDC Pool 1", "LP1", usdc, 0))
  const pool1 = (await core.listCollateralPool())[0]
  console.log("pool1Addr", pool1)
  await ensureFinished(
    core.setPoolConfig(pool1, ethers.utils.id("MCP_SYMBOL"), ethers.utils.formatBytes32String("USDC for all markets"))
  )
  await ensureFinished(core.setPoolConfig(pool1, ethers.utils.id("MCP_BORROWING_K"), u2b(toWei("6.36306"))))
  await ensureFinished(core.setPoolConfig(pool1, ethers.utils.id("MCP_BORROWING_B"), u2b(toWei("-6.58938"))))
  await ensureFinished(core.setPoolConfig(pool1, ethers.utils.id("MCP_LIQUIDITY_CAP_USD"), u2b(toWei("1000000"))))
  await ensureFinished(core.setPoolConfig(pool1, ethers.utils.id("MCP_LIQUIDITY_FEE_RATE"), u2b(toWei("0.0001"))))

  // pool 2: usdc, normal, support eth
  await ensureFinished(core.createCollateralPool("MUX3 USDC Pool 2", "LP2", usdc, 1))
  const pool2 = (await core.listCollateralPool())[1]
  console.log("pool2Addr", pool2)
  await ensureFinished(
    core.setPoolConfig(pool2, ethers.utils.id("MCP_SYMBOL"), ethers.utils.formatBytes32String("USDC for ETH"))
  )
  await ensureFinished(core.setPoolConfig(pool2, ethers.utils.id("MCP_BORROWING_K"), u2b(toWei("6.36306"))))
  await ensureFinished(core.setPoolConfig(pool2, ethers.utils.id("MCP_BORROWING_B"), u2b(toWei("-6.58938"))))
  await ensureFinished(core.setPoolConfig(pool2, ethers.utils.id("MCP_LIQUIDITY_CAP_USD"), u2b(toWei("1000000"))))
  await ensureFinished(core.setPoolConfig(pool2, ethers.utils.id("MCP_LIQUIDITY_FEE_RATE"), u2b(toWei("0.0001"))))

  // pool 3: weth, support eth
  await ensureFinished(core.createCollateralPool("MUX3 ETH Pool", "LP3", weth, 2))
  const pool3 = (await core.listCollateralPool())[2]
  console.log("pool3Addr", pool3)
  await ensureFinished(
    core.setPoolConfig(pool3, ethers.utils.id("MCP_SYMBOL"), ethers.utils.formatBytes32String("ETH only"))
  )
  await ensureFinished(core.setPoolConfig(pool3, ethers.utils.id("MCP_BORROWING_K"), u2b(toWei("6.36306"))))
  await ensureFinished(core.setPoolConfig(pool3, ethers.utils.id("MCP_BORROWING_B"), u2b(toWei("-6.58938"))))
  await ensureFinished(core.setPoolConfig(pool3, ethers.utils.id("MCP_LIQUIDITY_CAP_USD"), u2b(toWei("1000000"))))
  await ensureFinished(core.setPoolConfig(pool3, ethers.utils.id("MCP_LIQUIDITY_FEE_RATE"), u2b(toWei("0.0001"))))

  // markets
  await ensureFinished(core.createMarket(lEthMarketId, "ETH_LONG", true, [pool1, pool2, pool3]))
  await ensureFinished(
    core.setMarketConfig(lEthMarketId, ethers.utils.id("MM_POSITION_FEE_RATE"), u2b(toWei("0.0006")))
  )
  await ensureFinished(
    core.setMarketConfig(lEthMarketId, ethers.utils.id("MM_LIQUIDATION_FEE_RATE"), u2b(toWei("0.0006")))
  )
  await ensureFinished(
    core.setMarketConfig(lEthMarketId, ethers.utils.id("MM_INITIAL_MARGIN_RATE"), u2b(toWei("0.006")))
  )
  await ensureFinished(
    core.setMarketConfig(lEthMarketId, ethers.utils.id("MM_MAINTENANCE_MARGIN_RATE"), u2b(toWei("0.005")))
  )
  await ensureFinished(core.setMarketConfig(lEthMarketId, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.001"))))
  await ensureFinished(core.setMarketConfig(lEthMarketId, ethers.utils.id("MM_ORACLE_ID"), a2b(weth)))
  await ensureFinished(
    core.setPoolConfig(pool1, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", lEthMarketId), u2b(toWei("0.80")))
  )
  await ensureFinished(
    core.setPoolConfig(pool1, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", lEthMarketId), u2b(toWei("0.75")))
  )
  await ensureFinished(
    core.setPoolConfig(pool1, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", lEthMarketId), u2b(toWei("0.70")))
  )
  await ensureFinished(
    core.setPoolConfig(pool2, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", lEthMarketId), u2b(toWei("0.80")))
  )
  await ensureFinished(
    core.setPoolConfig(pool2, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", lEthMarketId), u2b(toWei("0.75")))
  )
  await ensureFinished(
    core.setPoolConfig(pool2, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", lEthMarketId), u2b(toWei("0.70")))
  )
  await ensureFinished(
    core.setPoolConfig(pool3, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", lEthMarketId), u2b(toWei("0.80")))
  )
  await ensureFinished(
    core.setPoolConfig(pool3, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", lEthMarketId), u2b(toWei("0.75")))
  )
  await ensureFinished(
    core.setPoolConfig(pool3, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", lEthMarketId), u2b(toWei("0.70")))
  )

  await ensureFinished(core.createMarket(sEthMarketId, "ETH_SHORT", false, [pool1, pool2, pool3]))
  await ensureFinished(
    core.setMarketConfig(sEthMarketId, ethers.utils.id("MM_POSITION_FEE_RATE"), u2b(toWei("0.0006")))
  )
  await ensureFinished(
    core.setMarketConfig(sEthMarketId, ethers.utils.id("MM_LIQUIDATION_FEE_RATE"), u2b(toWei("0.0006")))
  )
  await ensureFinished(
    core.setMarketConfig(sEthMarketId, ethers.utils.id("MM_INITIAL_MARGIN_RATE"), u2b(toWei("0.006")))
  )
  await ensureFinished(
    core.setMarketConfig(sEthMarketId, ethers.utils.id("MM_MAINTENANCE_MARGIN_RATE"), u2b(toWei("0.005")))
  )
  await ensureFinished(core.setMarketConfig(sEthMarketId, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.001"))))
  await ensureFinished(core.setMarketConfig(sEthMarketId, ethers.utils.id("MM_ORACLE_ID"), a2b(weth)))
  await ensureFinished(
    core.setPoolConfig(pool1, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", sEthMarketId), u2b(toWei("0.80")))
  )
  await ensureFinished(
    core.setPoolConfig(pool1, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", sEthMarketId), u2b(toWei("0.75")))
  )
  await ensureFinished(
    core.setPoolConfig(pool1, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", sEthMarketId), u2b(toWei("0.70")))
  )
  await ensureFinished(
    core.setPoolConfig(pool2, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", sEthMarketId), u2b(toWei("0.80")))
  )
  await ensureFinished(
    core.setPoolConfig(pool2, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", sEthMarketId), u2b(toWei("0.75")))
  )
  await ensureFinished(
    core.setPoolConfig(pool2, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", sEthMarketId), u2b(toWei("0.70")))
  )
  await ensureFinished(
    core.setPoolConfig(pool3, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", sEthMarketId), u2b(toWei("0.80")))
  )
  await ensureFinished(
    core.setPoolConfig(pool3, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", sEthMarketId), u2b(toWei("0.75")))
  )
  await ensureFinished(
    core.setPoolConfig(pool3, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", sEthMarketId), u2b(toWei("0.70")))
  )

  // periphery
  await ensureFinished(delegator.initialize(orderBook.address))
  await ensureFinished(
    feeDistributor.initialize(core.address, orderBook.address, muxReferralManager, muxReferralTiers, weth)
  )
  await ensureFinished(feeDistributor.setFeeRatio(toWei("0.85")))

  // oracle
  await ensureFinished(chainlinkStreamProvider.initialize("0x478Aa2aC9F6D65F84e09D9185d126c3a17c2a93C"))
  await ensureFinished(chainlinkStreamProvider.setPriceExpirationSeconds(86400))
  await ensureFinished(core.setOracleProvider(chainlinkStreamProvider.address, true))
  await ensureFinished(mux3PriceProvider.initialize(mux3OracleSigner))
  await ensureFinished(mux3PriceProvider.setPriceExpirationSeconds(86400))
  await ensureFinished(core.setOracleProvider(mux3PriceProvider.address, true))

  // swapper
  const uniRouter = "0xE592427A0AEce92De3Edee1F18E0157C05861564"
  const uniQuoter = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"
  await ensureFinished(swapper.initialize(weth, uniRouter, uniQuoter))
  const UNI_FEE_030 = "000bb8"
  const UNI_FEE_005 = "0001f4"
  await ensureFinished(
    swapper.setSwapPath(usdc, weth, [usdc + UNI_FEE_030 + weth.slice(2), usdc + UNI_FEE_005 + weth.slice(2)])
  )
  await ensureFinished(
    swapper.setSwapPath(weth, usdc, [weth + UNI_FEE_030 + usdc.slice(2), weth + UNI_FEE_005 + usdc.slice(2)])
  )
}

restorableEnviron(ENV, main)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
