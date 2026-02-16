import hre, { ethers } from "hardhat"
import { Deployer, DeploymentOptions } from "./deployer/deployer"
import { restorableEnviron } from "./deployer/environ"
import { encodePoolMarketKey, toBytes32, toWei, ensureFinished, encodeRebalanceSlippageKey } from "./deployUtils"
import {
  CallbackRegister,
  ChainlinkStreamProvider,
  CollateralPoolAumReader,
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

const muxReferralTiers = "0xef6868929C8FCf11996e621cfd1b89d3B3aa6Bda"

const muxReferralManager = "0xa68d96F26112377abdF3d6b9fcde9D54f2604C2a"

const mux3Tranche = "0xE84fE6066191D9c0D72aB10F8e56Bc686fc12537"

async function main(deployer: Deployer) {
  // deploy
  const [admin1] = await ethers.getSigners()
  const proxyAdmin = deployer.addressOf("ProxyAdmin")
  const usdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
  const usdce = "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"
  const usdt = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"
  const weth = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"
  const wbtc = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f"
  const arb = "0x912ce59144191c1204e64559fe8253a0e49e6548"
  const susde = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"

  const diamondInit = await deployer.deployOrSkip("DiamondInit", "DiamondInit")
  const facets = {
    // check https://louper.dev/diamond/ for the current cuts
    diamondCutFacet: await deployer.deployOrSkip("DiamondCutFacet", "DiamondCutFacet"),
    diamondLoupeFacet: await deployer.deployOrSkip("DiamondLoupeFacet", "DiamondLoupeFacet"),
    facetMux3Owner: await deployer.deployOrSkip("FacetMux3Owner", "FacetMux3Owner"),
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
  if (!deployer.deployedContracts["CollateralPool__implementation"]) {
    console.log(
      "deploying CollateralPool__implementation",
      core.address,
      orderBook.address,
      weth,
      collateralPoolEventEmitter.address
    )
  }
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
  const collateralPoolAumReader = (await deployer.deployUpgradeableOrSkip(
    "CollateralPoolAumReader",
    "CollateralPoolAumReader",
    proxyAdmin,
    core.address
  )) as CollateralPoolAumReader
  const lEthMarket = toBytes32("LongETH")
  const sEthMarket = toBytes32("ShortETH")
  const lBtcMarket = toBytes32("LongBTC")
  const sBtcMarket = toBytes32("ShortBTC")
  const lArbMarket = toBytes32("LongARB")
  const sArbMarket = toBytes32("ShortARB")
  const callbackRegister = (await deployer.deployUpgradeableOrSkip(
    "CallbackRegister",
    "CallbackRegister",
    proxyAdmin
  )) as CallbackRegister

  const initDefault = async () => {
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

    // callback register
    await ensureFinished(callbackRegister.initialize())
    await ensureFinished(callbackRegister.setMux3Tranche(mux3Tranche))

    // orderbook
    await ensureFinished(orderBook.initialize(core.address, weth))
    for (const broker of brokers) {
      await ensureFinished(orderBook.grantRole(ethers.utils.id("BROKER_ROLE"), broker))
    }
    await ensureFinished(
      orderBook.setConfig(ethers.utils.id("MCO_LIQUIDITY_LOCK_PERIOD"), u2b(ethers.BigNumber.from(5)))
    )
    await ensureFinished(orderBook.setConfig(ethers.utils.id("MCO_MIN_LIQUIDITY_ORDER_USD"), u2b(toWei("0.1"))))
    await ensureFinished(
      orderBook.setConfig(ethers.utils.id("MCO_MARKET_ORDER_TIMEOUT"), u2b(ethers.BigNumber.from(60 * 2)))
    )
    await ensureFinished(
      orderBook.setConfig(ethers.utils.id("MCO_LIMIT_ORDER_TIMEOUT"), u2b(ethers.BigNumber.from(86400 * 30)))
    )
    await ensureFinished(orderBook.setConfig(ethers.utils.id("MCO_CANCEL_COOL_DOWN"), u2b(ethers.BigNumber.from(5))))
    await ensureFinished(orderBook.setConfig(ethers.utils.id("MCO_REFERRAL_MANAGER"), a2b(testReferralManager.address))) // change me to muxReferralManager when release
    await ensureFinished(orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), delegator.address))
    await ensureFinished(
      orderBook.setConfig(ethers.utils.id("MCO_ORDER_GAS_FEE_GWEI"), u2b(ethers.BigNumber.from("5882")))
    ) // 0.02 / 3400 * 1e18 / 1e9
    await ensureFinished(orderBook.setConfig(ethers.utils.id("MCO_CALLBACK_REGISTER"), a2b(callbackRegister.address)))

    // collateral
    await ensureFinished(core.addCollateralToken(usdc, 6, true))
    await ensureFinished(core.addCollateralToken(usdce, 6, true))
    await ensureFinished(core.addCollateralToken(usdt, 6, true))
    await ensureFinished(core.addCollateralToken(weth, 18, false))
    await ensureFinished(core.addCollateralToken(wbtc, 8, false))
    await ensureFinished(core.addCollateralToken(arb, 18, false))
    await ensureFinished(core.addCollateralToken(susde, 18, true))
    await ensureFinished(core.setStrictStableId(a2b(usdc), true))
    await ensureFinished(core.setStrictStableId(a2b(usdce), true))
    await ensureFinished(core.setStrictStableId(a2b(usdt), true))

    // periphery
    await ensureFinished(delegator.initialize(orderBook.address))
    await ensureFinished(
      feeDistributor.initialize(core.address, orderBook.address, muxReferralManager, muxReferralTiers, weth)
    )
    await ensureFinished(feeDistributor.setFeeRatio(toWei("0.85")))

    // oracle: chainlink stream provider
    // https://docs.chain.link/data-streams/crypto-streams?network=arbitrum&page=1&search=Ethena
    await ensureFinished(core.setOracleProvider(chainlinkStreamProvider.address, true))
    await ensureFinished(chainlinkStreamProvider.initialize("0x478Aa2aC9F6D65F84e09D9185d126c3a17c2a93C"))
    await ensureFinished(chainlinkStreamProvider.setPriceExpirationSeconds(86400))
    await ensureFinished(chainlinkStreamProvider.setCallerWhitelist(core.address, true))
    await ensureFinished(
      chainlinkStreamProvider.setFeedId(a2b(usdc), "0x00038f83323b6b08116d1614cf33a9bd71ab5e0abf0c9f1b783a74a43e7bd992")
    )
    await ensureFinished(
      chainlinkStreamProvider.setFeedId(
        a2b(usdce),
        "0x00038f83323b6b08116d1614cf33a9bd71ab5e0abf0c9f1b783a74a43e7bd992"
      )
    )
    await ensureFinished(
      chainlinkStreamProvider.setFeedId(a2b(usdt), "0x0003a910a43485e0685ff5d6d366541f5c21150f0634c5b14254392d1a1c06db")
    )
    await ensureFinished(
      chainlinkStreamProvider.setFeedId(a2b(weth), "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9")
    )
    await ensureFinished(
      chainlinkStreamProvider.setFeedId(a2b(wbtc), "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8")
    )
    await ensureFinished(
      chainlinkStreamProvider.setFeedId(a2b(arb), "0x00030ab7d02fbba9c6304f98824524407b1f494741174320cfd17a2c22eec1de")
    )

    // oracle: mux3 provider
    await ensureFinished(core.setOracleProvider(mux3PriceProvider.address, true))
    await ensureFinished(mux3PriceProvider.initialize())
    await ensureFinished(mux3PriceProvider.setPriceExpirationSeconds(86400))
    for (const broker of brokers) {
      await ensureFinished(mux3PriceProvider.grantRole(ethers.utils.id("ORACLE_SIGNER"), broker))
    }

    // swapper
    const uni3Router = "0xE592427A0AEce92De3Edee1F18E0157C05861564"
    const uni3Quoter = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"
    const balancer2Vault = "0xba12222222228d8ba445958a75a0704d566bf2c8"
    await ensureFinished(swapper.initialize(weth))
    await ensureFinished(swapper.setUniswap3(uni3Router, uni3Quoter))
    await ensureFinished(swapper.setBalancer2(balancer2Vault))
    await ensureFinished(swapper.grantRole(ethers.utils.id("SET_ROUTE_ROLE"), admin1.address))

    // aum reader
    // https://docs.chain.link/data-feeds/price-feeds/addresses/?network=arbitrum&amp%3Bpage=1&page=1
    await ensureFinished(collateralPoolAumReader.initialize())
    await ensureFinished(collateralPoolAumReader.setPriceExpiration(86400))
    await ensureFinished(
      collateralPoolAumReader.setTokenPriceProvider(usdc, "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3")
    )
    await ensureFinished(
      collateralPoolAumReader.setTokenPriceProvider(usdce, "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3")
    )
    await ensureFinished(
      collateralPoolAumReader.setTokenPriceProvider(usdt, "0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7")
    )
    await ensureFinished(
      collateralPoolAumReader.setTokenPriceProvider(weth, "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612")
    )
    await ensureFinished(
      collateralPoolAumReader.setTokenPriceProvider(wbtc, "0x6ce185860a4963106506C203335A2910413708e9")
    )
    await ensureFinished(
      collateralPoolAumReader.setTokenPriceProvider(arb, "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6")
    )
    await ensureFinished(
      collateralPoolAumReader.setTokenPriceProvider(susde, "0xf2215b9c35b1697B5f47e407c917a40D055E68d7")
    ) // https://data.chain.link/feeds/arbitrum/mainnet/susde-usd
    await ensureFinished(
      collateralPoolAumReader.setMarketPriceProvider(lEthMarket, "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612")
    )
    await ensureFinished(
      collateralPoolAumReader.setMarketPriceProvider(sEthMarket, "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612")
    )
    await ensureFinished(
      collateralPoolAumReader.setMarketPriceProvider(lBtcMarket, "0x6ce185860a4963106506C203335A2910413708e9")
    )
    await ensureFinished(
      collateralPoolAumReader.setMarketPriceProvider(sBtcMarket, "0x6ce185860a4963106506C203335A2910413708e9")
    )
    await ensureFinished(
      collateralPoolAumReader.setMarketPriceProvider(lArbMarket, "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6")
    )
    await ensureFinished(
      collateralPoolAumReader.setMarketPriceProvider(sArbMarket, "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6")
    )

    // rebalance slippage
    await ensureFinished(core.setConfig(encodeRebalanceSlippageKey(weth, susde), u2b(toWei("0.0005"))))
    await ensureFinished(core.setConfig(encodeRebalanceSlippageKey(wbtc, susde), u2b(toWei("0.0005"))))
    await ensureFinished(core.setConfig(encodeRebalanceSlippageKey(arb, susde), u2b(toWei("0.0005"))))
    await ensureFinished(core.setConfig(encodeRebalanceSlippageKey(weth, arb), u2b(toWei("0.0005"))))
    await ensureFinished(core.setConfig(encodeRebalanceSlippageKey(wbtc, arb), u2b(toWei("0.0005"))))
  }

  const initDefaultPools = async () => {
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 1", "MEP-1", wbtc, 0))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 2", "MEP-2", wbtc, 1))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 3", "MEP-3", weth, 2))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 4", "MEP-4", weth, 3))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 5", "MEP-5", susde, 4))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 6", "MEP-6", susde, 5))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 7", "MEP-7", susde, 6))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 8", "MEP-8", arb, 7))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 9", "MEP-9", susde, 8))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 10", "MEP-10", weth, 9))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 11", "MEP-11", susde, 10))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 12", "MEP-12", susde, 11))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 13", "MEP-13", susde, 12))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 14", "MEP-14", susde, 13))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 15", "MEP-15", susde, 14))
    await ensureFinished(core.createCollateralPool("MUX Elemental Pool 16", "MEP-16", susde, 15))

    const pools = await core.listCollateralPool()
    for (const pool of pools) {
      await ensureFinished(core.setPoolConfig(pool, ethers.utils.id("MCP_BORROWING_K"), u2b(toWei("6.36306"))))
      await ensureFinished(core.setPoolConfig(pool, ethers.utils.id("MCP_BORROWING_B"), u2b(toWei("-6.58938"))))
      await ensureFinished(core.setPoolConfig(pool, ethers.utils.id("MCP_LIQUIDITY_CAP_USD"), u2b(toWei("1000000"))))
      await ensureFinished(core.setPoolConfig(pool, ethers.utils.id("MCP_LIQUIDITY_FEE_RATE"), u2b(toWei("0.0005"))))
      await ensureFinished(
        core.setPoolConfig(pool, ethers.utils.id("MCP_IS_DRAINING"), u2b(ethers.BigNumber.from("0")))
      )
    }
  }

  const initDefaultMarkets = async () => {
    const pools = await core.listCollateralPool()

    // create markets
    await ensureFinished(
      core.createMarket(lBtcMarket, "BTC", true, [pools[0], pools[1], pools[3], pools[4], pools[5], pools[10]])
    )
    await ensureFinished(core.createMarket(sBtcMarket, "BTC", false, [pools[4], pools[5], pools[11]]))
    await ensureFinished(
      core.createMarket(lEthMarket, "ETH", true, [
        pools[1],
        pools[2],
        pools[3],
        pools[4],
        pools[6],
        pools[9],
        pools[12],
      ])
    )
    await ensureFinished(core.createMarket(sEthMarket, "ETH", false, [pools[4], pools[6], pools[13]]))
    await ensureFinished(core.createMarket(lArbMarket, "ARB", true, [pools[7], pools[8], pools[9], pools[14]]))
    await ensureFinished(core.createMarket(sArbMarket, "ARB", false, [pools[8], pools[15]]))

    // fees
    for (const m of [lBtcMarket, sBtcMarket, lEthMarket, sEthMarket, lArbMarket, sArbMarket]) {
      await ensureFinished(core.setMarketConfig(m, ethers.utils.id("MM_POSITION_FEE_RATE"), u2b(toWei("0.0006"))))
      await ensureFinished(core.setMarketConfig(m, ethers.utils.id("MM_LIQUIDATION_FEE_RATE"), u2b(toWei("0.0006"))))
    }

    // im, mm, cap
    for (const m of [lBtcMarket, sBtcMarket, lEthMarket, sEthMarket, lArbMarket, sArbMarket]) {
      await ensureFinished(core.setMarketConfig(m, ethers.utils.id("MM_INITIAL_MARGIN_RATE"), u2b(toWei("0.006"))))
      await ensureFinished(core.setMarketConfig(m, ethers.utils.id("MM_MAINTENANCE_MARGIN_RATE"), u2b(toWei("0.005"))))
      await ensureFinished(core.setMarketConfig(m, ethers.utils.id("MM_OPEN_INTEREST_CAP_USD"), u2b(toWei("10000"))))
    }

    // lot size
    await ensureFinished(core.setMarketConfig(lBtcMarket, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.00001"))))
    await ensureFinished(core.setMarketConfig(sBtcMarket, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.00001"))))
    await ensureFinished(core.setMarketConfig(lEthMarket, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.0001"))))
    await ensureFinished(core.setMarketConfig(sEthMarket, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.0001"))))
    await ensureFinished(core.setMarketConfig(lArbMarket, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("1"))))
    await ensureFinished(core.setMarketConfig(sArbMarket, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("1"))))

    // oracle
    await ensureFinished(core.setMarketConfig(lBtcMarket, ethers.utils.id("MM_ORACLE_ID"), a2b(wbtc)))
    await ensureFinished(core.setMarketConfig(sBtcMarket, ethers.utils.id("MM_ORACLE_ID"), a2b(wbtc)))
    await ensureFinished(core.setMarketConfig(lEthMarket, ethers.utils.id("MM_ORACLE_ID"), a2b(weth)))
    await ensureFinished(core.setMarketConfig(sEthMarket, ethers.utils.id("MM_ORACLE_ID"), a2b(weth)))
    await ensureFinished(core.setMarketConfig(lArbMarket, ethers.utils.id("MM_ORACLE_ID"), a2b(arb)))
    await ensureFinished(core.setMarketConfig(sArbMarket, ethers.utils.id("MM_ORACLE_ID"), a2b(arb)))

    // adl group 1: eth based long eth
    for (const [m, p] of [
      [lBtcMarket, pools[0]],
      [lBtcMarket, pools[1]],
      [lEthMarket, pools[2]],
      [lEthMarket, pools[3]],
      [lEthMarket, pools[9]],
      [lArbMarket, pools[7]],
    ]) {
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", m), u2b(toWei("0.80"))))
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", m), u2b(toWei("0.79"))))
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", m), u2b(toWei("0.75"))))
    }

    // adl group 2: eth based long btc
    for (const [m, p] of [
      [lBtcMarket, pools[3]],
      [lEthMarket, pools[1]],
      [lArbMarket, pools[9]],
    ]) {
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", m), u2b(toWei("1.00"))))
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", m), u2b(toWei("0.99"))))
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", m), u2b(toWei("0.95"))))
    }

    // adl group 3: usd based long/short eth
    for (const [m, p] of [
      [lBtcMarket, pools[4]],
      [lBtcMarket, pools[5]],
      [lBtcMarket, pools[10]],
      [sBtcMarket, pools[4]],
      [sBtcMarket, pools[5]],
      [sBtcMarket, pools[11]],
      [lEthMarket, pools[4]],
      [lEthMarket, pools[6]],
      [lEthMarket, pools[12]],
      [sEthMarket, pools[4]],
      [sEthMarket, pools[6]],
      [sEthMarket, pools[13]],
      [lArbMarket, pools[8]],
      [lArbMarket, pools[14]],
      [sArbMarket, pools[8]],
      [sArbMarket, pools[15]],
    ]) {
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", m), u2b(toWei("1.00"))))
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", m), u2b(toWei("0.99"))))
      await ensureFinished(core.setPoolConfig(p, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", m), u2b(toWei("0.95"))))
    }
  }

  // await initDefault()
  // await initDefaultPools()
  // await initDefaultMarkets()
}

restorableEnviron(ENV, main)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
