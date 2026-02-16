import { ethers } from "hardhat"
import "@nomiclabs/hardhat-waffle"
import { expect } from "chai"
import {
  toWei,
  createContract,
  PositionOrderFlags,
  toBytes32,
  encodePositionId,
  toUnit,
  zeroAddress,
  encodePoolMarketKey,
  parsePositionOrder,
} from "../scripts/deployUtils"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import {
  CollateralPool,
  OrderBook,
  TestMux3,
  MockERC20,
  WETH9,
  MockMux3FeeDistributor,
  CollateralPoolEventEmitter,
  MockUniswap3,
  Swapper,
  CollateralPoolAumReader,
  MockChainlinkFeeder,
} from "../typechain"
import { time } from "@nomicfoundation/hardhat-network-helpers"

const a2b = (a) => {
  return a + "000000000000000000000000"
}
const u2b = (u) => {
  return ethers.utils.hexZeroPad(u.toTwos(256).toHexString(), 32)
}
const SWAPPER_UNI3 = "00"
const SWAPPER_BAL2 = "01"

describe("Trade", () => {
  const refCode = toBytes32("")
  const long1 = toBytes32("LongBTC")
  const short1 = toBytes32("ShortBTC")

  let usdc: MockERC20
  let arb: MockERC20
  let btc: MockERC20
  let weth: WETH9

  let admin: SignerWithAddress
  let broker: SignerWithAddress
  let lp1: SignerWithAddress
  let trader1: SignerWithAddress
  let trader2: SignerWithAddress

  let core: TestMux3
  let emitter: CollateralPoolEventEmitter
  let imp: CollateralPool
  let pool1: CollateralPool
  let pool2: CollateralPool
  let pool3: CollateralPool
  let orderBook: OrderBook
  let feeDistributor: MockMux3FeeDistributor
  let uniswap: MockUniswap3
  let swapper: Swapper

  let aumReader: CollateralPoolAumReader
  let wethFeeder: MockChainlinkFeeder
  let usdcFeeder: MockChainlinkFeeder
  let arbFeeder: MockChainlinkFeeder
  let btcFeeder: MockChainlinkFeeder

  let timestampOfTest: number

  before(async () => {
    const accounts = await ethers.getSigners()
    admin = accounts[0]
    broker = accounts[1]
    lp1 = accounts[2]
    trader1 = accounts[3]
    trader2 = accounts[4]
    weth = (await createContract("WETH9", [])) as WETH9
  })

  beforeEach(async () => {
    timestampOfTest = await time.latest()
    timestampOfTest = Math.ceil(timestampOfTest / 3600) * 3600 // move to the next hour

    // token
    usdc = (await createContract("MockERC20", ["USDC", "USDC", 6])) as MockERC20
    arb = (await createContract("MockERC20", ["ARB", "ARB", 18])) as MockERC20
    btc = (await createContract("MockERC20", ["BTC", "BTC", 8])) as MockERC20
    await usdc.mint(lp1.address, toUnit("1000000", 6))
    await usdc.mint(trader1.address, toUnit("100000", 6))
    await usdc.mint(trader2.address, toUnit("100000", 6))
    await arb.mint(lp1.address, toUnit("1000000", 18))
    await arb.mint(trader1.address, toUnit("100000", 18))
    await btc.mint(lp1.address, toUnit("1000000", 8))
    await btc.mint(trader1.address, toUnit("100000", 8))

    // core
    core = (await createContract("TestMux3", [])) as TestMux3
    await core.initialize(weth.address)
    await core.addCollateralToken(usdc.address, 6, true)
    await core.addCollateralToken(arb.address, 18, false)
    await core.addCollateralToken(btc.address, 8, false)
    await core.setConfig(ethers.utils.id("MC_BORROWING_BASE_APY"), u2b(toWei("0.10")))
    await core.setConfig(ethers.utils.id("MC_BORROWING_INTERVAL"), u2b(ethers.BigNumber.from(3600)))

    // orderBook
    const libOrderBook = await createContract("LibOrderBook")
    const libOrderBook2 = await createContract("LibOrderBook2")
    orderBook = (await createContract("OrderBook", [], {
      "contracts/libraries/LibOrderBook.sol:LibOrderBook": libOrderBook,
      "contracts/libraries/LibOrderBook2.sol:LibOrderBook2": libOrderBook2,
    })) as OrderBook
    const callbackRegister = await createContract("CallbackRegister")
    await orderBook.initialize(core.address, weth.address)
    await orderBook.setConfig(ethers.utils.id("MCO_LIQUIDITY_LOCK_PERIOD"), u2b(ethers.BigNumber.from(60 * 15)))
    await orderBook.setConfig(ethers.utils.id("MCO_MARKET_ORDER_TIMEOUT"), u2b(ethers.BigNumber.from(60 * 2)))
    await orderBook.setConfig(ethers.utils.id("MCO_LIMIT_ORDER_TIMEOUT"), u2b(ethers.BigNumber.from(86400 * 30)))
    await orderBook.setConfig(ethers.utils.id("MCO_CANCEL_COOL_DOWN"), u2b(ethers.BigNumber.from(5)))
    await orderBook.setConfig(ethers.utils.id("MCO_MIN_LIQUIDITY_ORDER_USD"), u2b(toWei("0.1")))
    await orderBook.setConfig(ethers.utils.id("MCO_CALLBACK_REGISTER"), a2b(callbackRegister.address))

    // collateral pool
    emitter = (await createContract("CollateralPoolEventEmitter")) as CollateralPoolEventEmitter
    await emitter.initialize(core.address)
    imp = (await createContract("CollateralPool", [
      core.address,
      orderBook.address,
      weth.address,
      emitter.address,
    ])) as CollateralPool
    await core.setCollateralPoolImplementation(imp.address)

    // pool 1
    await core.createCollateralPool("TN0", "TS0", usdc.address, 0)
    const poolAddr = (await core.listCollateralPool())[0]
    pool1 = (await ethers.getContractAt("CollateralPool", poolAddr)) as CollateralPool
    await core.setPoolConfig(pool1.address, ethers.utils.id("MCP_BORROWING_K"), u2b(toWei("10")))
    await core.setPoolConfig(pool1.address, ethers.utils.id("MCP_BORROWING_B"), u2b(toWei("-7")))
    await core.setPoolConfig(pool1.address, ethers.utils.id("MCP_LIQUIDITY_CAP_USD"), u2b(toWei("1000000")))
    await core.setPoolConfig(pool1.address, ethers.utils.id("MCP_LIQUIDITY_FEE_RATE"), u2b(toWei("0.0001")))
    await core.setPoolConfig(pool1.address, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", long1), u2b(toWei("0.80")))
    await core.setPoolConfig(pool1.address, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", long1), u2b(toWei("0.75")))
    await core.setPoolConfig(pool1.address, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", long1), u2b(toWei("0.70")))
    await core.setPoolConfig(pool1.address, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", short1), u2b(toWei("0.80")))
    await core.setPoolConfig(pool1.address, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", short1), u2b(toWei("0.75")))
    await core.setPoolConfig(pool1.address, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", short1), u2b(toWei("0.70")))

    // pool 2
    await core.createCollateralPool("TN1", "TS1", usdc.address, 1)
    const pool2Addr = (await core.listCollateralPool())[1]
    pool2 = (await ethers.getContractAt("CollateralPool", pool2Addr)) as CollateralPool
    await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_BORROWING_K"), u2b(toWei("6")))
    await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_BORROWING_B"), u2b(toWei("-6")))
    await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_LIQUIDITY_CAP_USD"), u2b(toWei("1000000")))
    await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_LIQUIDITY_FEE_RATE"), u2b(toWei("0.0001")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", long1), u2b(toWei("0.80")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", long1), u2b(toWei("0.75")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", long1), u2b(toWei("0.70")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", short1), u2b(toWei("0.80")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", short1), u2b(toWei("0.75")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", short1), u2b(toWei("0.70")))

    // pool 3
    await core.createCollateralPool("TN2", "TS2", btc.address, 2)
    const pool3Addr = (await core.listCollateralPool())[2]
    pool3 = (await ethers.getContractAt("CollateralPool", pool3Addr)) as CollateralPool
    await core.setPoolConfig(pool3.address, ethers.utils.id("MCP_BORROWING_BASE_APY"), u2b(toWei("0.10")))
    await core.setPoolConfig(pool3.address, ethers.utils.id("MCP_BORROWING_K"), u2b(toWei("2.2")))
    await core.setPoolConfig(pool3.address, ethers.utils.id("MCP_BORROWING_B"), u2b(toWei("-3")))
    await core.setPoolConfig(pool3.address, ethers.utils.id("MCP_LIQUIDITY_CAP_USD"), u2b(toWei("1000000")))
    await core.setPoolConfig(pool3.address, ethers.utils.id("MCP_LIQUIDITY_FEE_RATE"), u2b(toWei("0.0001")))
    await core.setPoolConfig(pool3.address, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", long1), u2b(toWei("0.80")))
    await core.setPoolConfig(pool3.address, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", long1), u2b(toWei("0.75")))
    await core.setPoolConfig(pool3.address, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", long1), u2b(toWei("0.70")))
    await core.setPoolConfig(pool3.address, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", short1), u2b(toWei("0.80")))
    await core.setPoolConfig(pool3.address, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", short1), u2b(toWei("0.75")))
    await core.setPoolConfig(pool3.address, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", short1), u2b(toWei("0.70")))

    // market 1 - uses 3 pools
    await core.createMarket(
      long1,
      "Long1",
      true, // isLong
      [pool1.address, pool2.address, pool3.address]
    )
    await core.setMarketConfig(long1, ethers.utils.id("MM_POSITION_FEE_RATE"), u2b(toWei("0.001")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_LIQUIDATION_FEE_RATE"), u2b(toWei("0.002")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_INITIAL_MARGIN_RATE"), u2b(toWei("0.006")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_MAINTENANCE_MARGIN_RATE"), u2b(toWei("0.005")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.0001")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_ORACLE_ID"), a2b(btc.address))
    await core.setMarketConfig(long1, ethers.utils.id("MM_OPEN_INTEREST_CAP_USD"), u2b(toWei("100000000")))

    await core.createMarket(
      short1,
      "Short1",
      false, // isLong
      [pool2.address]
    )
    await core.setMarketConfig(short1, ethers.utils.id("MM_POSITION_FEE_RATE"), u2b(toWei("0.001")))
    await core.setMarketConfig(short1, ethers.utils.id("MM_LIQUIDATION_FEE_RATE"), u2b(toWei("0.002")))
    await core.setMarketConfig(short1, ethers.utils.id("MM_INITIAL_MARGIN_RATE"), u2b(toWei("0.006")))
    await core.setMarketConfig(short1, ethers.utils.id("MM_MAINTENANCE_MARGIN_RATE"), u2b(toWei("0.005")))
    await core.setMarketConfig(short1, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.0001")))
    await core.setMarketConfig(short1, ethers.utils.id("MM_ORACLE_ID"), a2b(btc.address))
    await core.setMarketConfig(short1, ethers.utils.id("MM_OPEN_INTEREST_CAP_USD"), u2b(toWei("100000000")))

    // feeDistributor
    feeDistributor = (await createContract("MockMux3FeeDistributor", [core.address])) as MockMux3FeeDistributor
    await core.setConfig(ethers.utils.id("MC_FEE_DISTRIBUTOR"), a2b(feeDistributor.address))

    // role
    await orderBook.grantRole(ethers.utils.id("BROKER_ROLE"), broker.address)
    await core.grantRole(ethers.utils.id("ORDER_BOOK_ROLE"), orderBook.address)

    // swapper
    uniswap = (await createContract("MockUniswap3", [
      usdc.address,
      weth.address,
      btc.address,
      zeroAddress,
    ])) as MockUniswap3
    swapper = (await createContract("Swapper", [])) as Swapper
    await swapper.initialize(weth.address)
    await swapper.grantRole(await swapper.SET_ROUTE_ROLE(), admin.address)
    await swapper.setUniswap3(uniswap.address, uniswap.address)
    await swapper.setSwapPath(usdc.address, btc.address, [
      "0x" + SWAPPER_UNI3 + usdc.address.slice(2) + "0001f4" + btc.address.slice(2),
    ])
    await btc.mint(uniswap.address, toUnit("100000", 8))
    await core.setConfig(ethers.utils.id("MC_SWAPPER"), a2b(swapper.address))

    // aum reader
    aumReader = (await createContract("CollateralPoolAumReader", [core.address])) as CollateralPoolAumReader
    await aumReader.initialize()

    wethFeeder = (await createContract("MockChainlinkFeeder", [])) as MockChainlinkFeeder
    usdcFeeder = (await createContract("MockChainlinkFeeder", [])) as MockChainlinkFeeder
    arbFeeder = (await createContract("MockChainlinkFeeder", [])) as MockChainlinkFeeder
    btcFeeder = (await createContract("MockChainlinkFeeder", [])) as MockChainlinkFeeder
    await wethFeeder.setDecimals(8)
    await usdcFeeder.setDecimals(8)
    await arbFeeder.setDecimals(8)
    await btcFeeder.setDecimals(8)
    await aumReader.setMarketPriceProvider(long1, btcFeeder.address)
    await aumReader.setMarketPriceProvider(short1, btcFeeder.address)
    await aumReader.setTokenPriceProvider(weth.address, wethFeeder.address)
    await aumReader.setTokenPriceProvider(usdc.address, usdcFeeder.address)
    await aumReader.setTokenPriceProvider(arb.address, arbFeeder.address)
    await aumReader.setTokenPriceProvider(btc.address, btcFeeder.address)

    // price
    await core.setMockPrice(a2b(usdc.address), toWei("1"))
    await core.setMockPrice(a2b(arb.address), toWei("2"))
    await core.setMockPrice(a2b(btc.address), toWei("50000"))
    await usdcFeeder.setMockData(toUnit("1", 8), timestampOfTest + 86400 * 2)
    await arbFeeder.setMockData(toUnit("2", 8), timestampOfTest + 86400 * 2)
    await btcFeeder.setMockData(toUnit("50000", 8), timestampOfTest + 86400 * 2)
  })

  it("deposit 2 tokens, withdraw all when position = 0", async () => {
    const positionId = encodePositionId(trader1.address, 0)
    // clear price
    await core.setMockPrice(a2b(usdc.address), toWei("0"))
    await core.setMockPrice(a2b(arb.address), toWei("0"))
    await core.setMockPrice(a2b(btc.address), toWei("0"))
    // deposit
    await usdc.connect(trader1).transfer(orderBook.address, toUnit("1000", 6))
    await arb.connect(trader1).transfer(orderBook.address, toUnit("500", 18))
    {
      await expect(
        orderBook.connect(trader1).depositCollateral(positionId, usdc.address, toUnit("0", 6))
      ).to.revertedWith("Zero collateral")
      await orderBook.connect(trader1).depositCollateral(positionId, usdc.address, toUnit("1000", 6))
      expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("99000", 6))
      expect(await usdc.balanceOf(orderBook.address)).to.equal(toUnit("0", 6))
      expect(await usdc.balanceOf(core.address)).to.equal(toUnit("1000", 6))
      const collaterals = await core.listAccountCollaterals(positionId)
      expect(collaterals[0].collateralAddress).to.equal(usdc.address)
      expect(collaterals[0].collateralAmount).to.equal(toWei("1000"))
      const positions = await core.listAccountPositions(positionId)
      expect(positions.length).to.equal(0)
      const activated = await core.listActivePositionIds(0, 10)
      expect(activated.totalLength).to.equal(0)
    }
    {
      await orderBook.connect(trader1).depositCollateral(positionId, arb.address, toUnit("500", 18))
      expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("99500", 18))
      expect(await arb.balanceOf(orderBook.address)).to.equal(toUnit("0", 18))
      expect(await arb.balanceOf(core.address)).to.equal(toUnit("500", 18))
      const collaterals = await core.listAccountCollaterals(positionId)
      expect(collaterals[0].collateralAddress).to.equal(usdc.address)
      expect(collaterals[0].collateralAmount).to.equal(toWei("1000"))
      expect(collaterals[1].collateralAddress).to.equal(arb.address)
      expect(collaterals[1].collateralAmount).to.equal(toWei("500"))
      const positions = await core.listAccountPositions(positionId)
      expect(positions.length).to.equal(0)
      const activated = await core.listActivePositionIds(0, 10)
      expect(activated.totalLength).to.equal(0)
    }
    // withdraw all
    {
      const args = {
        positionId,
        isUnwrapWeth: false,
      }
      await expect(orderBook.connect(lp1).withdrawAllCollateral(args)).to.revertedWith("Not authorized")
      await orderBook.connect(trader1).withdrawAllCollateral(args)
      expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("100000", 6))
      expect(await usdc.balanceOf(orderBook.address)).to.equal(toUnit("0", 6))
      expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0", 6))
      expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("100000", 18))
      expect(await arb.balanceOf(orderBook.address)).to.equal(toUnit("0", 18))
      expect(await arb.balanceOf(core.address)).to.equal(toUnit("0", 18))
      const collaterals = await core.listAccountCollaterals(positionId)
      expect(collaterals.length).to.equal(0)
      const positions = await core.listAccountPositions(positionId)
      expect(positions.length).to.equal(0)
      const activated = await core.listActivePositionIds(0, 10)
      expect(activated.totalLength).to.equal(0)
    }
    // withdraw again should fail
    {
      await orderBook.connect(trader1).placeWithdrawalOrder({
        positionId,
        tokenAddress: usdc.address,
        rawAmount: toWei("1"),
        isUnwrapWeth: false,
        lastConsumedToken: usdc.address,
        withdrawSwapToken: zeroAddress,
        withdrawSwapSlippage: toWei("0"),
      })
      await expect(orderBook.connect(broker).fillWithdrawalOrder(0)).to.revertedWith("InsufficientCollateralBalance")
    }
  })

  it("deposit 1 token, withdraw 1 collateral when position = 0", async () => {
    const positionId = encodePositionId(trader1.address, 0)
    // deposit
    await usdc.connect(trader1).transfer(orderBook.address, toUnit("1000", 6))
    {
      await expect(
        orderBook.connect(trader1).depositCollateral(positionId, usdc.address, toUnit("0", 6))
      ).to.revertedWith("Zero collateral")
      await orderBook.connect(trader1).depositCollateral(positionId, usdc.address, toUnit("1000", 6))
      expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("99000", 6))
      expect(await usdc.balanceOf(orderBook.address)).to.equal(toUnit("0", 6))
      expect(await usdc.balanceOf(core.address)).to.equal(toUnit("1000", 6))
      const collaterals = await core.listAccountCollaterals(positionId)
      expect(collaterals[0].collateralAddress).to.equal(usdc.address)
      expect(collaterals[0].collateralAmount).to.equal(toWei("1000"))
      const positions = await core.listAccountPositions(positionId)
      expect(positions.length).to.equal(0)
      const activated = await core.listActivePositionIds(0, 10)
      expect(activated.totalLength).to.equal(0)
    }
    // withdraw order
    {
      await orderBook.connect(trader1).placeWithdrawalOrder({
        positionId,
        tokenAddress: usdc.address,
        rawAmount: toUnit("1000", 6),
        isUnwrapWeth: false,
        lastConsumedToken: usdc.address,
        withdrawSwapToken: zeroAddress,
        withdrawSwapSlippage: toWei("0"),
      })
      expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("99000", 6))
      expect(await usdc.balanceOf(orderBook.address)).to.equal(toUnit("0", 6))
      expect(await usdc.balanceOf(core.address)).to.equal(toUnit("1000", 6))
      await orderBook.connect(broker).fillWithdrawalOrder(0)
      expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("100000", 6))
      expect(await usdc.balanceOf(orderBook.address)).to.equal(toUnit("0", 6))
      expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0", 6))
      const collaterals = await core.listAccountCollaterals(positionId)
      expect(collaterals.length).to.equal(0)
      const positions = await core.listAccountPositions(positionId)
      expect(positions.length).to.equal(0)
      const activated = await core.listActivePositionIds(0, 10)
      expect(activated.totalLength).to.equal(0)
    }
    // withdraw again should fail
    {
      await orderBook.connect(trader1).placeWithdrawalOrder({
        positionId,
        tokenAddress: usdc.address,
        rawAmount: toUnit("1000", 6),
        isUnwrapWeth: false,
        lastConsumedToken: usdc.address,
        withdrawSwapToken: zeroAddress,
        withdrawSwapSlippage: toWei("0"),
      })
      await expect(orderBook.connect(broker).fillWithdrawalOrder(1)).to.revertedWith("InsufficientCollateralBalance")
    }
  })

  describe("add liquidity to 3 pools and test more", () => {
    beforeEach(async () => {
      await time.increaseTo(timestampOfTest + 86400 * 2)
      await usdc.connect(lp1).transfer(orderBook.address, toUnit("1000000", 6))
      {
        const args = {
          poolAddress: pool1.address,
          token: usdc.address,
          rawAmount: toUnit("1000000", 6),
          isAdding: true,
          isUnwrapWeth: false,
        }
        await orderBook.connect(lp1).placeLiquidityOrder(args)
        expect(await usdc.balanceOf(lp1.address)).to.equal(toUnit("0", 6))
      }
      await usdc.mint(lp1.address, toUnit("1000000", 6))
      await usdc.connect(lp1).transfer(orderBook.address, toUnit("1000000", 6))
      {
        const args = {
          poolAddress: pool2.address,
          token: usdc.address,
          rawAmount: toUnit("1000000", 6),
          isAdding: true,
          isUnwrapWeth: false,
        }
        await orderBook.connect(lp1).placeLiquidityOrder(args)
        expect(await usdc.balanceOf(lp1.address)).to.equal(toUnit("0", 6))
      }
      await btc.connect(lp1).transfer(orderBook.address, toUnit("20", 8))
      {
        const args = {
          poolAddress: pool3.address,
          token: btc.address,
          rawAmount: toUnit("20", 8),
          isAdding: true,
          isUnwrapWeth: false,
        }
        await orderBook.connect(lp1).placeLiquidityOrder(args)
        expect(await btc.balanceOf(lp1.address)).to.equal(toUnit("999980", 8))
      }
      await time.increaseTo(timestampOfTest + 86400 * 2 + 930)
      {
        await orderBook.connect(broker).fillLiquidityOrder(0, [])
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("100", 6)) // fee = 1000000 * 0.01% = 100
        expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6))
      }
      {
        const [poolTokens, poolBalances] = await pool1.liquidityBalances()
        expect(poolTokens[0]).to.equal(usdc.address)
        expect(poolBalances[0]).to.equal(toWei("999900")) // 1000000 - fee
        await assertPoolBalances(pool1)
      }
      expect(await pool1.balanceOf(lp1.address)).to.equal(toWei("999900"))
      expect(await pool1.totalSupply()).to.equal(toWei("999900"))
      expect(await pool1.getAumUsd()).to.equal(toWei("999900"))
      expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("999900"))
      {
        await orderBook.connect(broker).fillLiquidityOrder(1, [])
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("200", 6)) // fee = 1000000 * 0.01% = 100
        expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6))
      }
      {
        const [poolTokens, poolBalances] = await pool2.liquidityBalances()
        expect(poolTokens[0]).to.equal(usdc.address)
        expect(poolBalances[0]).to.equal(toWei("999900")) // 1000000 - fee
        await assertPoolBalances(pool2)
      }
      expect(await pool2.balanceOf(lp1.address)).to.equal(toWei("999900"))
      expect(await pool2.totalSupply()).to.equal(toWei("999900"))
      expect(await pool2.getAumUsd()).to.equal(toWei("999900"))
      expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("999900"))
      {
        await orderBook.connect(broker).fillLiquidityOrder(2, [])
        expect(await btc.balanceOf(feeDistributor.address)).to.equal(toUnit("0.002", 8)) // fee = 20 * 0.01% = 0.002
        expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8))
      }
      {
        const [poolTokens, poolBalances] = await pool3.liquidityBalances()
        expect(poolTokens[2]).to.equal(btc.address)
        expect(poolBalances[2]).to.equal(toWei("19.998")) // 20 - fee
        await assertPoolBalances(pool3)
      }
      expect(await pool3.balanceOf(lp1.address)).to.equal(toWei("999900"))
      expect(await pool3.totalSupply()).to.equal(toWei("999900"))
      expect(await pool3.getAumUsd()).to.equal(toWei("999900"))
      expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("999900"))
      {
        const state = await pool1.marketState(long1)
        expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
      }
      {
        const state = await pool1.marketState(short1)
        expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
      }
    })

    it("remove liquidity + remove liquidity", async () => {
      // remove pool3
      {
        const args = {
          poolAddress: pool3.address,
          token: btc.address,
          rawAmount: toWei("100"),
          isAdding: false,
          isUnwrapWeth: false,
        }
        await expect(orderBook.connect(lp1).placeLiquidityOrder({ ...args, rawAmount: toWei("0") })).to.revertedWith(
          "Zero amount"
        )
        await expect(orderBook.connect(lp1).placeLiquidityOrder(args)).to.revertedWith("Token balance not enough")
        await pool3.connect(lp1).transfer(orderBook.address, toWei("100"))
        const tx1 = await orderBook.connect(lp1).placeLiquidityOrder(args)
        await expect(tx1)
          .to.emit(orderBook, "NewLiquidityOrder")
          .withArgs(lp1.address, 3, [args.poolAddress, btc.address, args.rawAmount, args.isAdding, args.isUnwrapWeth])
        expect(await pool3.balanceOf(lp1.address)).to.equal(toWei("999800")) // 999900 - 100
        expect(await pool3.balanceOf(orderBook.address)).to.equal(toWei("100"))
      }
      {
        expect(await btc.balanceOf(lp1.address)).to.equal(toUnit("999980", 8)) // unchanged
        expect(await pool3.totalSupply()).to.equal(toWei("999900")) // unchanged
        expect(await pool3.getAumUsd()).to.equal(toWei("999900")) // unchanged
        expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("999900"))

        await core.setMockPrice(a2b(btc.address), toWei("40000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("40000", 8), await time.latest())
        expect(await pool3.getAumUsd()).to.equal(toWei("799920")) // aum = 19.998 * 40000 = 799920, nav = 799920 / 999900 = 0.8
        expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("799920"))
      }
      {
        await expect(orderBook.connect(broker).fillLiquidityOrder(3, [])).to.revertedWith("lock period")
        await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 930)
        await orderBook.connect(broker).fillLiquidityOrder(3, []) // return 100 * nav / 40000 = 0.002, fee = * 0.01% = 0.0000002
        expect(await btc.balanceOf(lp1.address)).to.equal(toUnit("999980.0019998", 8)) // 999980 + 0.002 - fee
        expect(await btc.balanceOf(feeDistributor.address)).to.equal(toUnit("0.0020002", 8)) // +fee
        expect(await btc.balanceOf(orderBook.address)).to.equal(toUnit("0", 8))
        expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.996", 8)) // 19.998 - 100 * nav / 40000
        expect(await pool3.balanceOf(lp1.address)).to.equal(toWei("999800")) // unchanged
        expect(await pool3.balanceOf(orderBook.address)).to.equal(toWei("0"))
      }
      {
        const [poolTokens, poolBalances] = await pool3.liquidityBalances()
        expect(poolTokens[2]).to.equal(btc.address)
        expect(poolBalances[2]).to.equal(toWei("19.996")) // 19.998 - 100 * nav / 40000
        await assertPoolBalances(pool3)
      }
      expect(await pool3.totalSupply()).to.equal(toWei("999800")) // 999900 - 100
      expect(await pool3.getAumUsd()).to.equal(toWei("799840")) // 19.996 * 40000
      expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("799840"))

      // remove pool3
      {
        const args = {
          poolAddress: pool3.address,
          token: btc.address,
          rawAmount: toWei("100"),
          isAdding: false,
          isUnwrapWeth: false,
        }
        await pool3.connect(lp1).transfer(orderBook.address, toWei("100"))
        const tx1 = await orderBook.connect(lp1).placeLiquidityOrder(args)
        await expect(tx1)
          .to.emit(orderBook, "NewLiquidityOrder")
          .withArgs(lp1.address, 4, [args.poolAddress, args.token, args.rawAmount, args.isAdding, args.isUnwrapWeth])
        expect(await pool3.balanceOf(lp1.address)).to.equal(toWei("999700")) // 999800 - 100
        expect(await pool3.balanceOf(orderBook.address)).to.equal(toWei("100"))
      }
      {
        await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 930 + 930)
        await orderBook.connect(broker).fillLiquidityOrder(4, []) // return 100 * nav / 40000 = 0.002, fee = * 0.01% = 0.0000002
        expect(await btc.balanceOf(lp1.address)).to.equal(toUnit("999980.0039996", 8)) // 999980.0019998 + 0.002 - fee
        expect(await btc.balanceOf(feeDistributor.address)).to.equal(toUnit("0.0020004", 8)) // +fee
        expect(await btc.balanceOf(orderBook.address)).to.equal(toUnit("0", 8))
        expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.994", 8)) // 19.996 - 100 * nav / 40000
        expect(await pool3.balanceOf(lp1.address)).to.equal(toWei("999700")) // unchanged
        expect(await pool3.balanceOf(orderBook.address)).to.equal(toWei("0"))
      }
      {
        const [poolTokens, poolBalances] = await pool3.liquidityBalances()
        expect(poolTokens[2]).to.equal(btc.address)
        expect(poolBalances[2]).to.equal(toWei("19.994")) // 19.996 - 100 * nav / 40000
        await assertPoolBalances(pool3)
      }
      expect(await pool3.totalSupply()).to.equal(toWei("999700")) // 999800 - 100
      expect(await pool3.getAumUsd()).to.equal(toWei("799760")) // 19.994 * 40000
      expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("799760"))
    })

    it("addLiquidity with tiny amount", async () => {
      // pool 1
      await usdc.mint(orderBook.address, toUnit("0.001", 6))
      const args = {
        poolAddress: pool1.address,
        token: usdc.address,
        rawAmount: toUnit("0.001", 6),
        isAdding: true,
        isUnwrapWeth: false,
      }
      await orderBook.connect(lp1).placeLiquidityOrder(args)
      await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 930)
      await expect(orderBook.connect(broker).fillLiquidityOrder(3, [])).to.revertedWith("Min liquidity order value")
    })

    it("removeLiquidity with tiny amount", async () => {
      // pool 1
      const args = {
        poolAddress: pool1.address,
        token: usdc.address,
        rawAmount: toWei("0.001"),
        isAdding: false,
        isUnwrapWeth: false,
      }
      await pool1.connect(lp1).transfer(orderBook.address, toWei("0.001"))
      await orderBook.connect(lp1).placeLiquidityOrder(args)
      await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 930)
      await expect(orderBook.connect(broker).fillLiquidityOrder(3, [])).to.revertedWith("Min liquidity order value")
    })

    it("removeLiquidity another token", async () => {
      // donate some arb into the pool
      await arb.mint(orderBook.address, toWei("10"))
      await orderBook.grantRole(ethers.utils.id("FEE_DONATOR_ROLE"), admin.address) // so that we can call donateLiquidity
      await orderBook.donateLiquidity(pool1.address, arb.address, toWei("10"))
      {
        const balances = await pool1.liquidityBalances()
        expect(balances.tokens[0]).to.equal(usdc.address)
        expect(balances.balances[0]).to.equal(toWei("999900"))
        expect(balances.tokens[1]).to.equal(arb.address)
        expect(balances.balances[1]).to.equal(toWei("10"))
        await assertPoolBalances(pool1)
      }
      {
        expect(await pool1.getAumUsd()).to.equal(toWei("999920")) // 999900 + 10 * 2
      }
      // now nav = 999920 / 999900 = 1.00002
      await pool1.connect(lp1).transfer(orderBook.address, toWei("15"))
      {
        const args = {
          poolAddress: pool1.address,
          token: arb.address,
          rawAmount: toWei("15"),
          isAdding: false,
          isUnwrapWeth: false,
        }
        await orderBook.connect(lp1).placeLiquidityOrder(args)
        await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 930)
        await orderBook.connect(broker).fillLiquidityOrder(3, [])
        // previous nav = 999920 / 999900 = 1.000020002000200020
        // 15 * 1.000020002000200020 / 2 = 7.500150015001500150
        expect(await arb.balanceOf(lp1.address)).to.equal(toWei("1000007.4994")) // 1000000 + 7.500150015001500150 * 0.9999
        expect(await arb.balanceOf(feeDistributor.address)).to.equal(toWei("0.000750015001500150")) // 7.500150015001500150 * 0.0001
      }
      {
        const balances = await pool1.liquidityBalances()
        expect(balances.tokens[0]).to.equal(usdc.address)
        expect(balances.balances[0]).to.equal(toWei("999900"))
        expect(balances.tokens[1]).to.equal(arb.address)
        expect(balances.balances[1]).to.equal(toWei("2.499849984998499850")) // 10 - 7.500150015001500150
        await assertPoolBalances(pool1)
      }
      expect(await pool1.getAumUsd()).to.equal(toWei("999904.999699969996999700")) // 999900 + 2.499849984998499850 * 2
    })

    it("open long: should set trader im before fill a position order", async () => {
      const positionId = encodePositionId(trader1.address, 0)
      await usdc.connect(trader1).transfer(orderBook.address, toUnit("10000", 6))
      {
        const args = {
          positionId,
          marketId: long1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("10000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await expect(orderBook.connect(broker).fillPositionOrder(3)).to.revertedWith("EssentialConfigNotSet")
      }
    })

    it("open long: exceeds initial leverage", async () => {
      const positionId = encodePositionId(trader1.address, 0)
      await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("10"))
      await usdc.connect(trader1).transfer(orderBook.address, toUnit("1000", 6))
      {
        const args = {
          positionId,
          marketId: long1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("1000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await expect(orderBook.connect(broker).fillPositionOrder(3)).to.revertedWith("UnsafePositionAccount")
      }
    })

    it("open long: limit price unmatched", async () => {
      const positionId = encodePositionId(trader1.address, 0)
      await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("100"))
      await usdc.connect(trader1).transfer(orderBook.address, toUnit("1000", 6))
      {
        const args = {
          positionId,
          marketId: long1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("1000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await core.setMockPrice(a2b(btc.address), toWei("50001"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("50001", 8), await time.latest())
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await expect(orderBook.connect(broker).fillPositionOrder(3)).to.revertedWith("limitPrice")
      }
    })

    it("open short: limit price unmatched", async () => {
      const positionId = encodePositionId(trader1.address, 0)
      await orderBook.connect(trader1).setInitialLeverage(positionId, short1, toWei("100"))
      await usdc.connect(trader1).transfer(orderBook.address, toUnit("1000", 6))
      {
        const args = {
          positionId,
          marketId: short1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("1000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await core.setMockPrice(a2b(btc.address), toWei("49999"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("49999", 8), await time.latest())
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await expect(orderBook.connect(broker).fillPositionOrder(3)).to.revertedWith("limitPrice")
      }
    })

    it("open long without collateral", async () => {
      const positionId = encodePositionId(trader1.address, 1)
      await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("100"))
      const args = {
        positionId,
        marketId: long1,
        size: toWei("1"),
        flags: PositionOrderFlags.OpenPosition,
        limitPrice: toWei("50000"),
        expiration: timestampOfTest + 86400 * 2 + 930 + 300,
        lastConsumedToken: usdc.address,
        collateralToken: usdc.address,
        collateralAmount: toUnit("0", 6),
        withdrawUsd: toWei("0"),
        withdrawSwapToken: zeroAddress,
        withdrawSwapSlippage: toWei("0"),
        tpPriceDiff: toWei("0"),
        slPriceDiff: toWei("0"),
        tpslExpiration: 0,
        tpslFlags: 0,
        tpslWithdrawSwapToken: zeroAddress,
        tpslWithdrawSwapSlippage: toWei("0"),
      }
      {
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("100000", 6)) // unchanged
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("200", 6)) // unchanged
        expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0", 6)) // unchanged
      }
      await expect(orderBook.connect(broker).fillPositionOrder(3)).to.revertedWith("InsufficientCollateralUsd")
    })

    describe("long a little and test more", () => {
      let positionId = ""
      beforeEach(async () => {
        // open long btc, using usdc
        positionId = encodePositionId(trader1.address, 0)
        await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("100"))
        await usdc.connect(trader1).transfer(orderBook.address, toUnit("10000", 6))
        const args = {
          positionId,
          marketId: long1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("10000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        {
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // - 10000
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("200", 6)) // unchanged
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0", 6)) // unchanged
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
        }
        {
          const [poolTokens, poolBalances] = await pool1.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
          await assertPoolBalances(pool1)
        }
        {
          const [poolTokens, poolBalances] = await pool2.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
          await assertPoolBalances(pool2)
        }
        {
          const [poolTokens, poolBalances] = await pool3.liquidityBalances()
          expect(poolTokens[2]).to.equal(btc.address)
          expect(poolBalances[2]).to.equal(toWei("19.998")) // unchanged
          await assertPoolBalances(pool3)
        }
        {
          // fee = 50000 * 1 * 0.1% = 50
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30)
          const tx1 = await orderBook.connect(broker).fillPositionOrder(3)
          await expect(tx1)
            .to.emit(core, "OpenPosition")
            .withArgs(
              trader1.address,
              positionId,
              long1,
              true, // isLong
              args.size,
              toWei("50000"), // trading price
              [pool1.address, pool2.address, pool3.address],
              [toWei("1"), toWei("0"), toWei("0")], // allocations
              [toWei("1"), toWei("0"), toWei("0")], // new size
              [toWei("50000"), toWei("0"), toWei("0")], // new entry
              toWei("50"), // positionFee
              toWei("0"), // borrowingFee
              [usdc.address],
              [toWei("9950")] // collateral - fee = 10000 - 50
            )
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("250", 6)) // + 50
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("9950", 6)) // at least collateral
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
          {
            const state = await pool1.marketState(long1)
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const state = await pool1.marketState(short1)
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const collaterals = await core.listAccountCollaterals(positionId)
            expect(collaterals[0].collateralAddress).to.equal(usdc.address)
            expect(collaterals[0].collateralAmount).to.equal(toWei("9950")) // collateral - fee = 10000 - 50
            const positions = await core.listAccountPositions(positionId)
            expect(positions[0].marketId).to.equal(long1)
            expect(positions[0].pools[0].poolAddress).to.equal(pool1.address)
            expect(positions[0].pools[0].size).to.equal(toWei("1"))
            expect(positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
            expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0"))
            const activated = await core.listActivePositionIds(0, 10)
            expect(activated.totalLength).to.equal(1)
            expect(activated.positionIds[0]).to.equal(positionId)
          }
          {
            const collateralsAndPositions = await core.listCollateralsAndPositionsOf(trader1.address)
            expect(collateralsAndPositions.length).to.equal(1)
            expect(collateralsAndPositions[0].positionId).to.equal(positionId)
            expect(collateralsAndPositions[0].collaterals[0].collateralAddress).to.equal(usdc.address)
            expect(collateralsAndPositions[0].collaterals[0].collateralAmount).to.equal(toWei("9950"))
            expect(collateralsAndPositions[0].positions[0].pools[0].poolAddress).to.equal(pool1.address)
            expect(collateralsAndPositions[0].positions[0].pools[0].size).to.equal(toWei("1"))
            expect(collateralsAndPositions[0].positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
            expect(collateralsAndPositions[0].positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
          }
          {
            const state = await pool1.marketState(long1)
            expect(state.isLong).to.equal(true)
            expect(state.totalSize).to.equal(toWei("1"))
            expect(state.averageEntryPrice).to.equal(toWei("50000"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const state = await pool2.marketState(long1)
            expect(state.isLong).to.equal(true)
            expect(state.totalSize).to.equal(toWei("0"))
            expect(state.averageEntryPrice).to.equal(toWei("0"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const state = await pool3.marketState(long1)
            expect(state.isLong).to.equal(true)
            expect(state.totalSize).to.equal(toWei("0"))
            expect(state.averageEntryPrice).to.equal(toWei("0"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            expect(await pool1.getAumUsd()).to.equal(toWei("999900")) // unchanged
            expect(await pool2.getAumUsd()).to.equal(toWei("999900")) // unchanged
            expect(await pool3.getAumUsd()).to.equal(toWei("999900")) // unchanged

            expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("999900"))
            expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("999900"))
            expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("999900"))
          }
        }
      })

      it("open position cause reserved > aum", async () => {
        await usdc.mint(orderBook.address, toUnit("1000000", 6))
        const args = {
          positionId,
          marketId: long1,
          size: toWei("75"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("1000000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        {
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
        }
        {
          await expect(orderBook.connect(broker).fillPositionOrder(4)).to.revertedWith("MarketFull")
        }
      })

      it("open position cause openInterest > cap", async () => {
        await core.setMarketConfig(long1, ethers.utils.id("MM_OPEN_INTEREST_CAP_USD"), u2b(toWei("10000")))
        await usdc.mint(orderBook.address, toUnit("1000000", 6))
        const args = {
          positionId,
          marketId: long1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("1000000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        {
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
        }
        {
          await expect(orderBook.connect(broker).fillPositionOrder(4)).to.revertedWith("MarketFull")
        }
      })

      it("close long: exceeds position size", async () => {
        const args = {
          positionId,
          marketId: long1,
          size: toWei("2"),
          flags: PositionOrderFlags.WithdrawAllIfEmpty,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
          lastConsumedToken: zeroAddress,
          collateralToken: zeroAddress,
          collateralAmount: toUnit("0", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await expect(orderBook.connect(broker).fillPositionOrder(4)).to.revertedWith("InvalidCloseSize")
      })

      describe("the same trader longs again, allocate into 2 pools", () => {
        beforeEach(async () => {
          await usdc.mint(orderBook.address, toUnit("100000", 6))
          const args = {
            positionId,
            marketId: long1,
            size: toWei("20"),
            flags: PositionOrderFlags.OpenPosition,
            limitPrice: toWei("51000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: zeroAddress,
            collateralToken: usdc.address,
            collateralAmount: toUnit("100000", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          {
            await orderBook.connect(trader1).placePositionOrder(args, refCode)
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("250", 6)) // unchanged
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("9950", 6)) // unchanged
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
            expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
          }
          {
            const [poolTokens, poolBalances] = await pool1.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
            await assertPoolBalances(pool1)
          }
          {
            const [poolTokens, poolBalances] = await pool2.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
            await assertPoolBalances(pool2)
          }
          {
            const [poolTokens, poolBalances] = await pool3.liquidityBalances()
            expect(poolTokens[2]).to.equal(btc.address)
            expect(poolBalances[2]).to.equal(toWei("19.998")) // unchanged
            await assertPoolBalances(pool3)
          }
          await core.setMockPrice(a2b(btc.address), toWei("50500"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("50500", 8), await time.latest())
          {
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30 + 30)
            const tx1 = await orderBook.connect(broker).fillPositionOrder(4)
            await expect(tx1)
              .to.emit(core, "OpenPosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                args.size,
                toWei("50500"), // trading price
                [pool1.address, pool2.address, pool3.address],
                [toWei("8.4281"), toWei("11.5719"), toWei("0")], // allocations
                [toWei("9.4281"), toWei("11.5719"), toWei("0")], // new size
                [toWei("50446.967045321963067850"), toWei("50500"), toWei("0")], // new entry (50000 * 1 + 50500 * 8.4281) / 9.4281
                toWei("1010"), // positionFee = 50500 * 20 * 0.1%
                toWei("0"), // borrowingFee
                [usdc.address],
                [toWei("108940")] // collateral - fee = 9950 + 100000 - 1010
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // 250 + 1010
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // at least collateral
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
              await assertPoolBalances(pool1)
            }
            {
              const marketInfo1 = await pool1.marketState(long1)
              expect(marketInfo1.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
            }
            {
              const marketInfo2 = await pool2.marketState(long1)
              expect(marketInfo2.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
            }
            // 10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7 = -3.1946670
            // 6 * 11.5719 * 50500                    * 0.80 / 999900 - 6 = -3.1946909
            // 2.2 * 0 - 3
            {
              const collaterals = await core.listAccountCollaterals(positionId)
              expect(collaterals[0].collateralAddress).to.equal(usdc.address)
              expect(collaterals[0].collateralAmount).to.equal(toWei("108940"))
              const positions = await core.listAccountPositions(positionId)
              expect(positions[0].marketId).to.equal(long1)
              expect(positions[0].pools[0].size).to.equal(toWei("9.4281"))
              expect(positions[0].pools[0].entryPrice).to.equal(toWei("50446.967045321963067850"))
              expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
              expect(positions[0].pools[1].size).to.equal(toWei("11.5719"))
              expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500"))
              expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0"))
              expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0"))
              const activated = await core.listActivePositionIds(0, 10)
              expect(activated.totalLength).to.equal(1)
              expect(activated.positionIds[0]).to.equal(positionId)
            }
            {
              const state = await pool1.marketState(long1)
              expect(state.isLong).to.equal(true)
              expect(state.totalSize).to.equal(toWei("9.4281"))
              expect(state.averageEntryPrice).to.equal(toWei("50446.967045321963067850"))
            }
            {
              const state = await pool2.marketState(long1)
              expect(state.isLong).to.equal(true)
              expect(state.totalSize).to.equal(toWei("11.5719"))
              expect(state.averageEntryPrice).to.equal(toWei("50500"))
            }
            {
              const state = await pool3.marketState(long1)
              expect(state.isLong).to.equal(true)
              expect(state.totalSize).to.equal(toWei("0"))
              expect(state.averageEntryPrice).to.equal(toWei("0"))
            }
            {
              expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("999399.999999999999999997")) // 999900 - (50500 - 50446.967045321963067850) * 9.4281
              expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("999900")) // 999900 - (50500 - 50500) * 11.5719
              expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1009899")) // 19.998 * 50500

              expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                toWei("999399.999999999999999997")
              )
              expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("999900"))
              expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1009899"))
            }
          }
        })

        it("close half (profit), close all (profit)", async () => {
          // close half
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("10"),
              flags: PositionOrderFlags.WithdrawAllIfEmpty,
              limitPrice: toWei("55000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            {
              await orderBook.connect(trader1).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // unchanged
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
            }
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
              await assertPoolBalances(pool1)
            }
            {
              const [poolTokens, poolBalances] = await pool2.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
              await assertPoolBalances(pool2)
            }
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
            await expect(orderBook.connect(broker).fillPositionOrder(5)).to.revertedWith("limit")
            await core.setMockPrice(a2b(btc.address), toWei("60000"))
            await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
            await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
            await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
            {
              expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.049999999999999997")) // 999900 - (60000 - 50446.967045321963067850) * 9.4281
              expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // 999900 - (60000 - 50500) * 11.5719
              expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880")) // 19.998 * 60000
              expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                toWei("909833.049999999999999997")
              )
              expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("889966.95"))
              expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1199880"))
            }
            {
              // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
              // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
              // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
              // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
              // borrowing 60000 * 9.4281 * 0.002703729225668555 + 60000 * 11.5719 * 0.002703710487661317 = 3406.685814281621855268
              // position fee = 60000 * 10 * 0.1% = 600
              // Δsize1 =  9.4281 / (9.4281 + 11.5719) * 10 = 4.4896
              // Δsize2 = 11.5719 / (9.4281 + 11.5719) * 10 = 5.5104
              // pnl1 = (60000 - 50446.967045321963067850) * 4.4896 = 42889.296753
              // pnl2 = (60000 - 50500) * 5.5104 = 52348.8
              const tx = await orderBook.connect(broker).fillPositionOrder(5)
              // {
              //   for (const i of (await (await tx).wait()).events!) {
              //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
              //       console.log(emitter.interface.parseLog(i))
              //     }
              //   }
              // }
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool1.address,
                long1,
                toWei("0.140980166767003251"), // apy
                toWei("0.002703729225668555") // acc
              )
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool2.address,
                long1,
                toWei("0.140979189713768724"), // apy
                toWei("0.002703710487661317") // acc
              )
              await expect(tx)
                .to.emit(core, "ClosePosition")
                .withArgs(
                  trader1.address,
                  positionId,
                  long1,
                  true, // isLong
                  toWei("10"), // size
                  toWei("60000"), // tradingPrice
                  [pool1.address, pool2.address], // backedPools
                  [toWei("4.4896"), toWei("5.5104")], // allocations
                  [toWei("4.9385"), toWei("6.0615")], // newSizes
                  [toWei("50446.967045321963067850"), toWei("50500")], // newEntryPrices
                  [toWei("42889.296753"), toWei("52348.8")], // poolPnlUsds
                  toWei("600"), // positionFeeUsd
                  toWei("3406.685814281621855268"), // borrowingFeeUsd
                  [usdc.address],
                  [toWei("200171.410938718378144732")] // collateral + pnl - fee = 108940 + 42889.296753 + 52348.8 - 600 - 3406.685814281621855268
                )
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("5266.685814", 6)) // 1260 + 600 + 3406.685814281621855268
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("200171.410939", 6)) // at least collateral
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("957010.703247", 6)) // 999900 - 42889.296753
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("947551.200000", 6)) // 999900 - 52348.8
              expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
              {
                const [poolTokens, poolBalances] = await pool1.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("957010.703247")) // the same as balanceOf
                await assertPoolBalances(pool1)
              }
              {
                const [poolTokens, poolBalances] = await pool2.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("947551.200000")) // the same as balanceOf
                await assertPoolBalances(pool2)
              }
              {
                const collaterals = await core.listAccountCollaterals(positionId)
                expect(collaterals[0].collateralAddress).to.equal(usdc.address)
                expect(collaterals[0].collateralAmount).to.equal(toWei("200171.410938718378144732"))
                const positions = await core.listAccountPositions(positionId)
                expect(positions[0].marketId).to.equal(long1)
                expect(positions[0].pools[0].size).to.equal(toWei("4.9385"))
                expect(positions[0].pools[0].entryPrice).to.equal(toWei("50446.967045321963067850"))
                expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0.002703729225668555"))
                expect(positions[0].pools[1].size).to.equal(toWei("6.0615"))
                expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500"))
                expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0.002703710487661317"))
                expect(positions[0].realizedBorrowingUsd).to.equal(toWei("3406.685814281621855268")) // accumulate until fully closed
                const activated = await core.listActivePositionIds(0, 10)
                expect(activated.totalLength).to.equal(1)
                expect(activated.positionIds[0]).to.equal(positionId)
              }
              {
                const state = await pool1.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("4.9385"))
                expect(state.averageEntryPrice).to.equal(toWei("50446.967045321963067850"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703729225668555"))
              }
              {
                const state = await pool2.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("6.0615"))
                expect(state.averageEntryPrice).to.equal(toWei("50500"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703710487661317"))
              }
              {
                const state = await pool3.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002872628708424787"))
              }
              {
                expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.050000322514610578")) // 957010.703247 - (60000 - 50446.967045321963067850) * 4.9385
                expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // 947551.200000 - (60000 - 50500) * 6.0615
                expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880")) // 19.998 * 60000
                expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                  toWei("909833.050000322514610578")
                )
                expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("889966.95"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1199880"))
              }
            }
          }
          // close all
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("11"),
              flags: PositionOrderFlags.WithdrawAllIfEmpty,
              limitPrice: toWei("55000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: 0,
              tpPriceDiff: 0,
              slPriceDiff: 0,
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: 0,
            }
            {
              await orderBook.connect(trader1).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("5266.685814", 6)) // unchanged
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("200171.410939", 6)) // unchanged
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("957010.703247", 6)) // unchanged
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("947551.200000", 6)) // unchanged
            }
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("957010.703247")) // unchanged
              await assertPoolBalances(pool1)
            }
            {
              const [poolTokens, poolBalances] = await pool2.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("947551.200000")) // unchanged
              await assertPoolBalances(pool2)
            }
            {
              // borrowing = 0
              // position fee = 60000 * 11 * 0.1% = 660
              // fees = 660
              // pnl1 = (60000 - 50446.967045321963067850) * 4.9385 = 47177.65324667748538942
              // pnl2 = (60000 - 50500) * 6.0615 = 57584.25
              // should auto withdraw oldCollateral + pnl - fee = 200171.410938718378144732 + 47177.65324667748538942 + 57584.25 - 660 = 304273.314185395863534152
              await orderBook.connect(broker).fillPositionOrder(6)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("394273.314184", 6)) // 90000 + 304273.314185395863534152
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("5926.685814", 6)) // 5266.685814 + 660
              expect(await usdc.balanceOf(core.address)).to.be.closeTo(toWei("0"), toWei("0.0000001")) // at least collateral
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("909833.050001", 6)) // 957010.703247 - 47177.65324667748538942
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("889966.95", 6)) // 947551.200000 - 57584.25
              expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
              {
                const [poolTokens, poolBalances] = await pool1.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("909833.050001")) // the same as balanceOf
                await assertPoolBalances(pool1)
              }
              {
                const [poolTokens, poolBalances] = await pool2.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("889966.95")) // the same as balanceOf
                await assertPoolBalances(pool2)
              }
              {
                const collaterals = await core.listAccountCollaterals(positionId)
                expect(collaterals.length).to.equal(0)
                const positions = await core.listAccountPositions(positionId)
                expect(positions.length).to.equal(0)
                const activated = await core.listActivePositionIds(0, 10)
                expect(activated.totalLength).to.equal(0)
              }
              {
                const state = await pool1.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703729225668555"))
              }
              {
                const state = await pool2.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703710487661317"))
              }
              {
                expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.050001")) // the same as liquidityBalance
                expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // the same as liquidityBalance
                expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("909833.050001"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("889966.95"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1199880"))
              }
            }
          }
        })

        it("close half (profit), use stop loss order. the same as previous case", async () => {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("10"),
            flags: PositionOrderFlags.TriggerOrder + PositionOrderFlags.WithdrawAllIfEmpty, // here
            limitPrice: toWei("60000"), // trigger when price <= 60000
            expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
            lastConsumedToken: zeroAddress,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          {
            await orderBook.connect(trader1).placePositionOrder(args, refCode)
          }
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
          await core.setMockPrice(a2b(btc.address), toWei("60001"))
          await expect(orderBook.connect(broker).fillPositionOrder(5)).to.revertedWith("limit")
          await core.setMockPrice(a2b(btc.address), toWei("60000"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
          // should be the same as the previous test
          {
            const tx = await orderBook.connect(broker).fillPositionOrder(5)
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool1.address,
              long1,
              toWei("0.140980166767003251"), // apy
              toWei("0.002703729225668555") // acc
            )
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool2.address,
              long1,
              toWei("0.140979189713768724"), // apy
              toWei("0.002703710487661317") // acc
            )
            await expect(tx)
              .to.emit(core, "ClosePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                toWei("10"), // size
                toWei("60000"), // tradingPrice
                [pool1.address, pool2.address], // backedPools
                [toWei("4.4896"), toWei("5.5104")], // allocations
                [toWei("4.9385"), toWei("6.0615")], // newSizes
                [toWei("50446.967045321963067850"), toWei("50500")], // newEntryPrices
                [toWei("42889.296753"), toWei("52348.8")], // poolPnlUsds
                toWei("600"), // positionFeeUsd
                toWei("3406.685814281621855268"), // borrowingFeeUsd
                [usdc.address],
                [toWei("200171.410938718378144732")] // collateral + pnl - fee = 108940 + 42889.296753 + 52348.8 - 600 - 3406.685814281621855268
              )
          }
        })

        it("close half (loss), close all (profit+loss)", async () => {
          // close half
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("10"),
              flags: PositionOrderFlags.WithdrawAllIfEmpty,
              limitPrice: toWei("50000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: 0,
              tpPriceDiff: 0,
              slPriceDiff: 0,
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: 0,
            }
            {
              await orderBook.connect(trader1).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // unchanged
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
            }
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // the same as balanceOf
              await assertPoolBalances(pool1)
            }
            {
              const [poolTokens, poolBalances] = await pool2.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // the same as balanceOf
              await assertPoolBalances(pool2)
            }
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
            await core.setMockPrice(a2b(btc.address), toWei("49000"))
            await expect(orderBook.connect(broker).fillPositionOrder(5)).to.revertedWith("limit")
            await core.setMockPrice(a2b(btc.address), toWei("50000"))
            await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
            await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
            await btcFeeder.setMockData(toUnit("50000", 8), await time.latest())
            {
              expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("1004114.049999999999999996")) // 999900 - (50000 - 50446.967045321963067850) * 9.4281
              expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("1005685.95")) // 999900 - (50000 - 50500) * 11.5719
              expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("999900")) // 19.998 * 50000
              expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                toWei("1004114.049999999999999996")
              )
              expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("1005685.95"))
              expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("999900"))
            }
            {
              // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
              // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
              // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
              // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
              // borrowing 50000 * 9.4281 * 0.002703729225668555 + 50000 * 11.5719 * 0.002703710487661317 = 2838.904845234684879390
              // position fee = 50000 * 10 * 0.1% = 500
              // Δsize1 =  9.4281 / (9.4281 + 11.5719) * 10 = 4.4896
              // Δsize2 = 11.5719 / (9.4281 + 11.5719) * 10 = 5.5104
              // pnl1 = (50000 - 50446.967045321963067850) * 4.4896 = -2006.703246677485389419
              // pnl2 = (50000 - 50500) * 5.5104 = -2755.2
              const tx = await orderBook.connect(broker).fillPositionOrder(5)
              // {
              //   for (const i of (await (await tx).wait()).events!) {
              //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
              //       console.log(emitter.interface.parseLog(i))
              //     }
              //   }
              // }
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool1.address,
                long1,
                toWei("0.140980166767003251"), // apy
                toWei("0.002703729225668555") // acc
              )
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool2.address,
                long1,
                toWei("0.140979189713768724"), // apy
                toWei("0.002703710487661317") // acc
              )
              await expect(tx)
                .to.emit(core, "ClosePosition")
                .withArgs(
                  trader1.address,
                  positionId,
                  long1,
                  true, // isLong
                  toWei("10"), // size
                  toWei("50000"), // tradingPrice
                  [pool1.address, pool2.address], // backedPools
                  [toWei("4.4896"), toWei("5.5104")], // allocations
                  [toWei("4.9385"), toWei("6.0615")], // newSizes
                  [toWei("50446.967045321963067850"), toWei("50500")], // newEntryPrices
                  [toWei("-2006.703246677485389419"), toWei("-2755.2")], // poolPnlUsds
                  toWei("500"), // positionFeeUsd
                  toWei("2838.904845234684879390"), // borrowingFeeUsd
                  [usdc.address],
                  [toWei("100839.191908087829731191")] // collateral + pnl - fee = 108940 - 2006.703246677485389419 - 2755.2 - 500 - 2838.904845234684879390
                )
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("4598.904845", 6)) // 1260 + 500 + 2838.904845234684879390
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("100839.191909", 6)) // at least collateral
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("1001906.703246", 6)) // 999900 + 2006.703246677485389419
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("1002655.2", 6)) // 999900 + 2755.2
              expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
              {
                const [poolTokens, poolBalances] = await pool1.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("1001906.703246")) // the same as balanceOf
                await assertPoolBalances(pool1)
              }
              {
                const [poolTokens, poolBalances] = await pool2.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("1002655.2")) // the same as balanceOf
                await assertPoolBalances(pool2)
              }
              {
                const collaterals = await core.listAccountCollaterals(positionId)
                expect(collaterals[0].collateralAddress).to.equal(usdc.address)
                expect(collaterals[0].collateralAmount).to.equal(toWei("100839.191908087829731191"))
                const positions = await core.listAccountPositions(positionId)
                expect(positions[0].marketId).to.equal(long1)
                expect(positions[0].pools[0].size).to.equal(toWei("4.9385"))
                expect(positions[0].pools[0].entryPrice).to.equal(toWei("50446.967045321963067850"))
                expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0.002703729225668555"))
                expect(positions[0].pools[1].size).to.equal(toWei("6.0615"))
                expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500"))
                expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0.002703710487661317"))
                expect(positions[0].realizedBorrowingUsd).to.equal(toWei("2838.904845234684879390")) // accumulate until fully closed
                const activated = await core.listActivePositionIds(0, 10)
                expect(activated.totalLength).to.equal(1)
                expect(activated.positionIds[0]).to.equal(positionId)
              }
              {
                const state = await pool1.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("4.9385"))
                expect(state.averageEntryPrice).to.equal(toWei("50446.967045321963067850"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703729225668555"))
              }
              {
                const state = await pool2.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("6.0615"))
                expect(state.averageEntryPrice).to.equal(toWei("50500"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703710487661317"))
              }
              {
                const state = await pool3.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002872628708424787"))
              }
              {
                expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("1004114.049999322514610577")) // 1001906.703246 - (50000 - 50446.967045321963067850) * 4.9385
                expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("1005685.950000000000000000")) // 1002655.2 - (50000 - 50500) * 6.0615
                expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("999900")) // 19.998 * 50000
                expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                  toWei("1004114.049999322514610577")
                )
                expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(
                  toWei("1005685.950000000000000000")
                )
                expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("999900"))
              }
            }
          }
          // close all
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("11"),
              flags: PositionOrderFlags.WithdrawAllIfEmpty,
              limitPrice: toWei("50473"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            {
              await orderBook.connect(trader1).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("4598.904845", 6)) // unchanged
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("100839.191909", 6)) // unchanged
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("1001906.703246", 6)) // unchanged
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("1002655.2", 6)) // unchanged
            }
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("1001906.703246")) // the same as balanceOf
              await assertPoolBalances(pool1)
            }
            {
              const [poolTokens, poolBalances] = await pool2.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("1002655.2")) // the same as balanceOf
              await assertPoolBalances(pool2)
            }
            await core.setMockPrice(a2b(btc.address), toWei("50473"))
            await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
            await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
            await btcFeeder.setMockData(toUnit("50473", 8), await time.latest())
            {
              // borrowing = 0
              // position fee = 50473 * 11 * 0.1% = 660
              // fees = 555.203
              // pnl1 = (50473 - 50446.967045321963067850) * 4.9385 = 128.563746677485389422
              // pnl2 = (50473 - 50500) * 6.0615 = -163.6605
              // should auto withdraw oldCollateral + pnl - fee = 100839.191908087829731191 + 128.563746677485389422 -163.6605 - 555.203 = 100248.892154087829731191
              await orderBook.connect(broker).fillPositionOrder(6)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("190248.892154", 6)) // 90000 + 100248.892154087829731191
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("5154.107845", 6)) // 4598.904845 + 555.203
              expect(await usdc.balanceOf(core.address)).to.be.closeTo(toWei("0"), toWei("0.0000001")) // at least collateral
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("1001778.139500", 6)) // 1001906.703246 - 128.563746677485389422
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("1002818.860500", 6)) // 1002655.2 + 163.7469
              expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
              {
                const [poolTokens, poolBalances] = await pool1.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("1001778.139500")) // the same as balanceOf
                await assertPoolBalances(pool1)
              }
              {
                const [poolTokens, poolBalances] = await pool2.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("1002818.860500")) // the same as balanceOf
                await assertPoolBalances(pool2)
              }
              {
                const collaterals = await core.listAccountCollaterals(positionId)
                expect(collaterals.length).to.equal(0)
                const positions = await core.listAccountPositions(positionId)
                expect(positions.length).to.equal(0)
                const activated = await core.listActivePositionIds(0, 10)
                expect(activated.totalLength).to.equal(0)
              }
              {
                const state = await pool1.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703729225668555"))
              }
              {
                const state = await pool2.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703710487661317"))
              }
              {
                expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("1001778.139500")) // the same as liquidityBalance
                expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("1002818.860500")) // the same as liquidityBalance
                expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1009359.054")) // 19.998 * 50473
                expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("1001778.139500"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("1002818.860500"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1009359.054"))
              }
            }
          }
        })

        it("close all (profit), open again", async () => {
          // close all
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("21"),
              flags: 0,
              limitPrice: toWei("50000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            await orderBook.connect(trader1).placePositionOrder(args, refCode)
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
            await core.setMockPrice(a2b(btc.address), toWei("60000"))
            await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
            await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
            await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
            {
              // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
              // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
              // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
              // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
              // borrowing 60000 * 9.4281 * 0.002703729225668555 + 60000 * 11.5719 * 0.002703710487661317 = 3406.685814281621855268
              // position fee = 60000 * 21 * 0.1% = 1260
              // Δsize1 =  9.4281
              // Δsize2 = 11.5719
              // pnl1 = (60000 - 50446.967045321963067850) * 9.4281 = 90066.95
              // pnl2 = (60000 - 50500) * 11.5719 = 109933.05
              const tx = await orderBook.connect(broker).fillPositionOrder(5)
              // {
              //   for (const i of (await (await tx).wait()).events!) {
              //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
              //       console.log(emitter.interface.parseLog(i))
              //     }
              //   }
              // }
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool1.address,
                long1,
                toWei("0.140980166767003251"), // apy
                toWei("0.002703729225668555") // acc
              )
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool2.address,
                long1,
                toWei("0.140979189713768724"), // apy
                toWei("0.002703710487661317") // acc
              )
              await expect(tx)
                .to.emit(core, "ClosePosition")
                .withArgs(
                  trader1.address,
                  positionId,
                  long1,
                  true, // isLong
                  toWei("21"), // size
                  toWei("60000"), // tradingPrice
                  [pool1.address, pool2.address], // backedPools
                  [toWei("9.4281"), toWei("11.5719")], // allocations
                  [toWei("0"), toWei("0")], // newSizes
                  [toWei("0"), toWei("0")], // newEntryPrices
                  [toWei("90066.95"), toWei("109933.05")], // poolPnlUsds
                  toWei("1260"), // positionFeeUsd
                  toWei("3406.685814281621855268"), // borrowingFeeUsd
                  [usdc.address],
                  [toWei("304273.314185718378144732")] // collateral + pnl - fee = 108940 + 90066.95 + 109933.05 - 1260 - 3406.685814281621855268
                )
              {
                const positions = await core.listAccountPositions(positionId)
                expect(positions.length).to.equal(0)
                const activated = await core.listActivePositionIds(0, 10)
                expect(activated.totalLength).to.equal(0)
              }
            }
          }
          // open again
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("1"),
              flags: PositionOrderFlags.OpenPosition,
              limitPrice: toWei("60000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            await orderBook.connect(trader1).placePositionOrder(args, refCode)
            await orderBook.connect(broker).fillPositionOrder(6)
            {
              const positions = await core.listAccountPositions(positionId)
              expect(positions[0].marketId).to.equal(long1)
              expect(positions[0].pools[0].size).to.equal(toWei("1"))
              expect(positions[0].pools[0].entryPrice).to.equal(toWei("60000"))
              expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0.002703729225668555"))
              expect(positions[0].pools[1].size).to.equal(toWei("0"))
              expect(positions[0].pools[1].entryPrice).to.equal(toWei("0"))
              expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0"))
              expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0")) // because removed in previous close
              const activated = await core.listActivePositionIds(0, 10)
              expect(activated.totalLength).to.equal(1)
              expect(activated.positionIds[0]).to.equal(positionId)
            }
          }
        })

        it("close half (profit), withdraw profit + withdraw usdc", async () => {
          // close half
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("10"),
              flags: PositionOrderFlags.WithdrawProfit, // here
              limitPrice: toWei("55000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("500"), // here
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            {
              await orderBook.connect(trader1).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // unchanged
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
            }
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
              await assertPoolBalances(pool1)
            }
            {
              const [poolTokens, poolBalances] = await pool2.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
              await assertPoolBalances(pool2)
            }
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
            await expect(orderBook.connect(broker).fillPositionOrder(5)).to.revertedWith("limit")
            await core.setMockPrice(a2b(btc.address), toWei("60000"))
            await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
            await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
            await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
            {
              expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.049999999999999997")) // 999900 - (60000 - 50446.967045321963067850) * 9.4281
              expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // 999900 - (60000 - 50500) * 11.5719
              expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880")) // 19.998 * 60000
              expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                toWei("909833.049999999999999997")
              )
              expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("889966.95"))
              expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1199880"))
            }
            {
              // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
              // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
              // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
              // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
              // borrowing 60000 * 9.4281 * 0.002703729225668555 + 60000 * 11.5719 * 0.002703710487661317 = 3406.685814281621855268
              // position fee = 60000 * 10 * 0.1% = 600
              // Δsize1 =  9.4281 / (9.4281 + 11.5719) * 10 = 4.4896
              // Δsize2 = 11.5719 / (9.4281 + 11.5719) * 10 = 5.5104
              // pnl1 = (60000 - 50446.967045321963067850) * 4.4896 = 42889.296753
              // pnl2 = (60000 - 50500) * 5.5104 = 52348.8
              const tx = await orderBook.connect(broker).fillPositionOrder(5)
              // {
              //   for (const i of (await (await tx).wait()).events!) {
              //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
              //       console.log(emitter.interface.parseLog(i))
              //     }
              //   }
              // }
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool1.address,
                long1,
                toWei("0.140980166767003251"), // apy
                toWei("0.002703729225668555") // acc
              )
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool2.address,
                long1,
                toWei("0.140979189713768724"), // apy
                toWei("0.002703710487661317") // acc
              )
              await expect(tx)
                .to.emit(core, "ClosePosition")
                .withArgs(
                  trader1.address,
                  positionId,
                  long1,
                  true, // isLong
                  toWei("10"), // size
                  toWei("60000"), // tradingPrice
                  [pool1.address, pool2.address], // backedPools
                  [toWei("4.4896"), toWei("5.5104")], // allocations
                  [toWei("4.9385"), toWei("6.0615")], // newSizes
                  [toWei("50446.967045321963067850"), toWei("50500")], // newEntryPrices
                  [toWei("42889.296753"), toWei("52348.8")], // poolPnlUsds
                  toWei("600"), // positionFeeUsd
                  toWei("3406.685814281621855268"), // borrowingFeeUsd
                  [usdc.address],
                  [toWei("200171.410938718378144732")] // collateral + pnl - fee = 108940 + 42889.296753 + 52348.8 - 600 - 3406.685814281621855268
                )
              await expect(tx).to.emit(core, "Withdraw").withArgs(
                trader1.address,
                positionId,
                usdc.address,
                toWei("91731.410938718378144732"), // profit - fee + withdraw = 42889.296753 + 52348.8 - 600 - 3406.685814281621855268 + 500
                usdc.address,
                toUnit("91731.410938", 6)
              )
              await expect(tx)
                .to.emit(core, "DepositWithdrawFinish")
                .withArgs(
                  trader1.address,
                  positionId,
                  toWei("0"),
                  [usdc.address],
                  [toWei("108440")] // 200171.410938718378144732 - 91731.410938718378144732
                )
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("181731.410938", 6)) // 90000 + 91731.410938
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("5266.685814", 6)) // 1260 + 600 + 3406.685814281621855268
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108440.000001", 6)) // at least collateral
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("957010.703247", 6)) // 999900 - 42889.296753
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("947551.200000", 6)) // 999900 - 52348.8
              expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
              {
                const collaterals = await core.listAccountCollaterals(positionId)
                expect(collaterals[0].collateralAddress).to.equal(usdc.address)
                expect(collaterals[0].collateralAmount).to.equal(toWei("108440"))
                const positions = await core.listAccountPositions(positionId)
                expect(positions[0].marketId).to.equal(long1)
                expect(positions[0].pools[0].size).to.equal(toWei("4.9385"))
                expect(positions[0].pools[0].entryPrice).to.equal(toWei("50446.967045321963067850"))
                expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0.002703729225668555"))
                expect(positions[0].pools[1].size).to.equal(toWei("6.0615"))
                expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500"))
                expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0.002703710487661317"))
                expect(positions[0].realizedBorrowingUsd).to.equal(toWei("3406.685814281621855268")) // accumulate until fully closed
                const activated = await core.listActivePositionIds(0, 10)
                expect(activated.totalLength).to.equal(1)
                expect(activated.positionIds[0]).to.equal(positionId)
              }
            }
          }
        })

        it("close half (profit), withdraw profit + withdraw btc (swap)", async () => {
          // close half
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("10"),
              flags: PositionOrderFlags.WithdrawProfit, // here
              limitPrice: toWei("55000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("500"), // here
              withdrawSwapToken: btc.address,
              withdrawSwapSlippage: toWei("0.1"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            {
              await orderBook.connect(trader1).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            }
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
            await expect(orderBook.connect(broker).fillPositionOrder(5)).to.revertedWith("limit")
            await core.setMockPrice(a2b(btc.address), toWei("60000"))
            await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
            await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
            await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
            {
              const tx = await orderBook.connect(broker).fillPositionOrder(5)
              await expect(tx).to.emit(core, "Withdraw").withArgs(
                trader1.address,
                positionId,
                usdc.address,
                toWei("91731.410938718378144732"), // profit - fee + withdraw = 42889.296753 + 52348.8 - 600 - 3406.685814281621855268 + 500
                btc.address,
                toUnit("1.83462821", 8) // swapOut 91731.410938 / 50000 (mockUniswap always return 50000)
              )
              await expect(tx).to.emit(swapper, "TransferOut").withArgs(
                btc.address,
                toUnit("1.83462821", 8), // 91731.410938 / 50000 (mockUniswap always return 50000)
                false
              )
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // 90000
              expect(await btc.balanceOf(trader1.address)).to.equal(toUnit("100001.83462821", 8)) // 100000 + 91731.410938 / 50000
            }
          }
        })

        it("close half (profit), withdraw profit + withdraw usdc (swap)", async () => {
          // close half
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("10"),
              flags: PositionOrderFlags.WithdrawProfit, // here
              limitPrice: toWei("55000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("500"), // here
              withdrawSwapToken: usdc.address,
              withdrawSwapSlippage: toWei("0.1"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            {
              await orderBook.connect(trader1).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            }
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
            await expect(orderBook.connect(broker).fillPositionOrder(5)).to.revertedWith("limit")
            await core.setMockPrice(a2b(btc.address), toWei("60000"))
            await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
            await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
            await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
            {
              const tx = await orderBook.connect(broker).fillPositionOrder(5)
              await expect(tx).to.emit(core, "Withdraw").withArgs(
                trader1.address,
                positionId,
                usdc.address,
                toWei("91731.410938718378144732"), // profit - fee + withdraw = 42889.296753 + 52348.8 - 600 - 3406.685814281621855268 + 500
                usdc.address,
                toUnit("91731.410938", 6) // swapOut
              )
              await expect(tx).to.emit(swapper, "TransferOut").withArgs(usdc.address, toUnit("91731.410938", 6), false)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6).add(toUnit("91731.410938", 6))) // 90000 + 91731.410938
              expect(await btc.balanceOf(trader1.address)).to.equal(toUnit("100000", 8)) // 100000 + 91731.410938 / 50000
            }
          }
        })

        it("close half (loss), withdraw profit (but no profit) + withdraw usd", async () => {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("10"),
            flags: PositionOrderFlags.WithdrawProfit, // here
            limitPrice: toWei("50000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
            lastConsumedToken: zeroAddress,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("500"), // here
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: 0,
            tpPriceDiff: 0,
            slPriceDiff: 0,
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: 0,
          }
          {
            await orderBook.connect(trader1).placePositionOrder(args, refCode)
          }
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
          await core.setMockPrice(a2b(btc.address), toWei("50000"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("50000", 8), await time.latest())
          {
            // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
            // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
            // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
            // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
            // borrowing 50000 * 9.4281 * 0.002703729225668555 + 50000 * 11.5719 * 0.002703710487661317 = 2838.904845234684879390
            // position fee = 50000 * 10 * 0.1% = 500
            // Δsize1 =  9.4281 / (9.4281 + 11.5719) * 10 = 4.4896
            // Δsize2 = 11.5719 / (9.4281 + 11.5719) * 10 = 5.5104
            // pnl1 = (50000 - 50446.967045321963067850) * 4.4896 = -2006.703246677485389419
            // pnl2 = (50000 - 50500) * 5.5104 = -2755.2
            const tx = await orderBook.connect(broker).fillPositionOrder(5)
            // {
            //   for (const i of (await (await tx).wait()).events!) {
            //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
            //       console.log(emitter.interface.parseLog(i))
            //     }
            //   }
            // }
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool1.address,
              long1,
              toWei("0.140980166767003251"), // apy
              toWei("0.002703729225668555") // acc
            )
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool2.address,
              long1,
              toWei("0.140979189713768724"), // apy
              toWei("0.002703710487661317") // acc
            )
            await expect(tx)
              .to.emit(core, "ClosePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                toWei("10"), // size
                toWei("50000"), // tradingPrice
                [pool1.address, pool2.address], // backedPools
                [toWei("4.4896"), toWei("5.5104")], // allocations
                [toWei("4.9385"), toWei("6.0615")], // newSizes
                [toWei("50446.967045321963067850"), toWei("50500")], // newEntryPrices
                [toWei("-2006.703246677485389419"), toWei("-2755.2")], // poolPnlUsds
                toWei("500"), // positionFeeUsd
                toWei("2838.904845234684879390"), // borrowingFeeUsd
                [usdc.address],
                [toWei("100839.191908087829731191")] // collateral + pnl - fee = 108940 - 2006.703246677485389419 - 2755.2 - 500 - 2838.904845234684879390
              )
            await expect(tx).to.emit(core, "Withdraw").withArgs(
              trader1.address,
              positionId,
              usdc.address,
              toWei("500"), // withdrawUsd
              usdc.address,
              toUnit("500", 6)
            )
            await expect(tx)
              .to.emit(core, "DepositWithdrawFinish")
              .withArgs(
                trader1.address,
                positionId,
                toWei("0"),
                [usdc.address],
                [toWei("100339.191908087829731191")] // 100839.191908087829731191 - 500
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90500", 6)) // 90000 + 500
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("4598.904845", 6)) // 1260 + 500 + 2838.904845234684879390
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("100339.191909", 6)) // at least collateral
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("1001906.703246", 6)) // 999900 + 2006.703246677485389419
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("1002655.2", 6)) // 999900 + 2755.2
            expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
            {
              const collaterals = await core.listAccountCollaterals(positionId)
              expect(collaterals[0].collateralAddress).to.equal(usdc.address)
              expect(collaterals[0].collateralAmount).to.equal(toWei("100339.191908087829731191"))
              const positions = await core.listAccountPositions(positionId)
              expect(positions[0].marketId).to.equal(long1)
              expect(positions[0].pools[0].size).to.equal(toWei("4.9385"))
              expect(positions[0].pools[0].entryPrice).to.equal(toWei("50446.967045321963067850"))
              expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0.002703729225668555"))
              expect(positions[0].pools[1].size).to.equal(toWei("6.0615"))
              expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500"))
              expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0.002703710487661317"))
              expect(positions[0].realizedBorrowingUsd).to.equal(toWei("2838.904845234684879390")) // accumulate until fully closed
              const activated = await core.listActivePositionIds(0, 10)
              expect(activated.totalLength).to.equal(1)
              expect(activated.positionIds[0]).to.equal(positionId)
            }
          }
        })

        it("withdraw collateral, should deduct borrowing fee", async () => {
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
          await core.setMockPrice(a2b(btc.address), toWei("60000"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
          {
            await expect(
              orderBook.connect(trader1).placeWithdrawalOrder({
                positionId: positionId,
                tokenAddress: usdc.address,
                rawAmount: toUnit("0", 6),
                isUnwrapWeth: false,
                lastConsumedToken: zeroAddress,
                withdrawSwapToken: zeroAddress,
                withdrawSwapSlippage: toWei("0"),
              })
            ).to.revertedWith("Zero amount")
            await orderBook.connect(trader1).placeWithdrawalOrder({
              positionId: positionId,
              tokenAddress: usdc.address,
              rawAmount: toUnit("1", 6),
              isUnwrapWeth: false,
              lastConsumedToken: zeroAddress,
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
            })
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // unchanged
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
          }
          {
            // fr1 0.10 + exp(10 * 9.4281 * 60000 * 0.80 / 999900 - 7) = 0.140980166767003251
            // fr2 0.10 + exp(6 * 11.5719 * 60000 * 0.80 / 999900 - 6) = 0.140979189713768724
            // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
            // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
            // borrowing 60000 * 9.4281 * 0.002703729225668555 + 60000 * 11.5719 * 0.002703710487661317 = 3406.685814281621855268
            await expect(orderBook.connect(trader1).fillWithdrawalOrder(5)).to.revertedWith("AccessControl")
            const tx = await orderBook.connect(broker).fillWithdrawalOrder(5)
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool1.address,
              long1,
              toWei("0.140980166767003251"), // apy
              toWei("0.002703729225668555") // acc
            )
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool2.address,
              long1,
              toWei("0.140979189713768724"), // apy
              toWei("0.002703710487661317") // acc
            )
            await expect(tx).to.emit(core, "Withdraw").withArgs(
              trader1.address,
              positionId,
              usdc.address,
              toWei("1"), // withdraw = +1
              usdc.address,
              toUnit("1", 6)
            )
            await expect(tx)
              .to.emit(core, "DepositWithdrawFinish")
              .withArgs(
                trader1.address,
                positionId,
                toWei("3406.685814281621855268"), // fee
                [usdc.address],
                [toWei("105532.314185718378144732")] // new = collateral - withdraw - fee = 108940 - 1 - 3406.685814281621855268
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90001", 6)) // +withdraw = +1
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("4666.685814", 6)) // + fee = 1260 + 3406.685814281621855268
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("105532.314186", 6)) // at least collateral
            const collaterals = await core.listAccountCollaterals(positionId)
            expect(collaterals[0].collateralAddress).to.equal(usdc.address)
            expect(collaterals[0].collateralAmount).to.equal(toWei("105532.314185718378144732")) // collateral - withdraw - fee = 108940 - 1 - 3406.685814281621855268
            const positions = await core.listAccountPositions(positionId)
            expect(positions[0].marketId).to.equal(long1)
            expect(positions[0].pools[0].size).to.equal(toWei("9.4281")) // unchanged
            expect(positions[0].pools[0].entryPrice).to.equal(toWei("50446.967045321963067850")) // unchanged
            expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0.002703729225668555")) // update
            expect(positions[0].pools[1].size).to.equal(toWei("11.5719")) // unchanged
            expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500")) // unchanged
            expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0.002703710487661317")) // update
            expect(positions[0].realizedBorrowingUsd).to.equal(toWei("3406.685814281621855268")) // accumulate until fully closed
            const activated = await core.listActivePositionIds(0, 10)
            expect(activated.totalLength).to.equal(1)
            expect(activated.positionIds[0]).to.equal(positionId)
          }
        })

        it("withdraw collateral, max possible value", async () => {
          // borrowing = 0
          // pnl = 0
          // collateral = 108940
          // margin balance = 108940
          // im = 50000 * 21 * 0.006 = 6300
          // entryLev = (9.4281 * 50446.967045321963067850 + 11.5719 * 50500) / 100 = 10599.99999999999999999999
          // max withdraw (according to marginBalance >= im) = 108940 - 6300 = 102640
          // max withdraw (according to collateral >= entryLev) = 108940 - 10599.99999999999999999999 = 98340
          {
            await orderBook.connect(trader1).placeWithdrawalOrder({
              positionId: positionId,
              tokenAddress: usdc.address,
              rawAmount: toUnit("98341", 6),
              isUnwrapWeth: false,
              lastConsumedToken: zeroAddress,
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
            })
            await expect(orderBook.connect(broker).fillWithdrawalOrder(5)).to.revertedWith("UnsafePositionAccount")
          }
          {
            await orderBook.connect(trader1).placeWithdrawalOrder({
              positionId: positionId,
              tokenAddress: usdc.address,
              rawAmount: toUnit("98340", 6),
              isUnwrapWeth: false,
              lastConsumedToken: zeroAddress,
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
            })
            await orderBook.connect(broker).fillWithdrawalOrder(6)
          }
        })

        it("withdraw collateral, swap btc", async () => {
          {
            await orderBook.connect(trader1).placeWithdrawalOrder({
              positionId: positionId,
              tokenAddress: usdc.address,
              rawAmount: toUnit("10000", 6),
              isUnwrapWeth: false,
              lastConsumedToken: zeroAddress,
              withdrawSwapToken: btc.address,
              withdrawSwapSlippage: toWei("0.01"),
            })
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await btc.balanceOf(trader1.address)).to.equal(toUnit("100000", 8)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // unchanged
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
          }
          {
            const tx = await orderBook.connect(broker).fillWithdrawalOrder(5)
            await expect(tx).to.emit(core, "Withdraw").withArgs(
              trader1.address,
              positionId,
              usdc.address,
              toWei("10000"), // withdraw = +1
              btc.address,
              toUnit("0.2", 8) // 10000 / 50000
            )
            await expect(tx)
              .to.emit(core, "DepositWithdrawFinish")
              .withArgs(
                trader1.address,
                positionId,
                toWei("0"), // fee
                [usdc.address],
                [toWei("98940")] // new = collateral - withdraw - fee = 108940 - 10000
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await btc.balanceOf(trader1.address)).to.equal(toUnit("100000.2", 8)) // 100000  + 0.00002
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("98940", 6)) // at least collateral
          }
        })

        it("withdraw collateral, swap btc failed", async () => {
          // minOut = 10000 / 49999, but MockUniswap gives 10000 / 50000
          await core.setMockPrice(a2b(btc.address), toWei("49999"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("49999", 8), await time.latest())
          {
            await orderBook.connect(trader1).placeWithdrawalOrder({
              positionId: positionId,
              tokenAddress: usdc.address,
              rawAmount: toUnit("10000", 6),
              isUnwrapWeth: false,
              lastConsumedToken: zeroAddress,
              withdrawSwapToken: btc.address,
              withdrawSwapSlippage: toWei("0.00"),
            })
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await btc.balanceOf(trader1.address)).to.equal(toUnit("100000", 8)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // unchanged
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
          }
          {
            const tx = await orderBook.connect(broker).fillWithdrawalOrder(5)
            await expect(tx).to.emit(core, "Withdraw").withArgs(
              trader1.address,
              positionId,
              usdc.address,
              toWei("10000"), // withdraw = 10000
              usdc.address,
              toUnit("10000", 6)
            )
            await expect(tx)
              .to.emit(core, "DepositWithdrawFinish")
              .withArgs(
                trader1.address,
                positionId,
                toWei("0"), // fee
                [usdc.address],
                [toWei("98940")] // new = collateral - withdraw - fee = 108940 - 10000
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("100000", 6)) // 90000 + 10000
            expect(await btc.balanceOf(trader1.address)).to.equal(toUnit("100000", 8)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("98940", 6)) // at least collateral
          }
        })

        it("liquidate long because of funding", async () => {
          await core.setMockPrice(a2b(btc.address), toWei("50500"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("50500", 8), await time.latest())
          // collateral = 108940
          // pnl1 = (50500 - 50446.967045321963067850) * 9.4281 = 500
          // pnl2 = (50500 - 50500) * 11.5719 = 0
          // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
          // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
          // mm = 50500 * 21 * 0.005 = 5302.5
          // borrowing = (50500 * 9.4281 * 0.140980166767003251 + 50500 * 11.5719 * 0.140979189713768724) * hours / (24*365) = 17.0672255576609080164885102740 hours
          // Solve[108940 + 500 - 17.0672255576609080164885102740 hours == 5302.5], => 6101.6 hours
          // acc1 0.140980166767003251 * 6102 / (24*365) = 0.098203307946604319
          // acc2 0.140979189713768724 * 6102 / (24*365) = 0.098202627355412871
          // borrowing 50500 * 9.4281 * 0.098203307946604319 + 50500 * 11.5719 * 0.098202627355412871 = 104144.210352846860285383
          // position fee = 50500 * 21 * 0.002 = 2121
          // update to 1 hour before liquidate
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 3600 * 6101)
          await expect(orderBook.liquidate(positionId, zeroAddress, false, false)).to.revertedWith("AccessControl")
          await expect(orderBook.connect(broker).liquidate(positionId, zeroAddress, false, false)).to.revertedWith(
            "SafePositionAccount"
          )
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 3600 * 6102)
          {
            const tx = await orderBook.connect(broker).liquidate(positionId, zeroAddress, false, false)
            // {
            //   for (const i of (await (await tx).wait()).events!) {
            //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
            //       console.log(emitter.interface.parseLog(i))
            //     }
            //   }
            // }
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool1.address,
              long1,
              toWei("0.140980166767003251"), // apy
              toWei("0.098203307946604319") // acc
            )
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool2.address,
              long1,
              toWei("0.140979189713768724"), // apy
              toWei("0.098202627355412871") // acc
            )
            await expect(tx)
              .to.emit(core, "LiquidatePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                toWei("21"), // oldSize
                toWei("50500"), // tradingPrice
                [pool1.address, pool2.address], // backedPools
                [toWei("9.4281"), toWei("11.5719")], // allocations
                [toWei("500"), toWei("0")], // poolPnlUsds
                toWei("2121"), // positionFeeUsd
                toWei("104144.210352846860285383"), // borrowingFeeUsd
                [usdc.address],
                [toWei("3174.789647153139714617")] // collateral + pnl - fee = 108940 + 500 - 104144.210352846860285383 - 2121
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("107525.210352", 6)) // 1260 + 2121 + 104144.210352846860285383
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("3174.789648", 6)) // at least collateral
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999400", 6)) // 999900 - 500
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // 999900 + 0
            expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
          }
        })

        it("liquidate long. 0 < fee < margin < MM", async () => {
          // borrowing = 0
          // Solve[108940
          //   + (x - 50446.967045321963067850) * 9.4281
          //   + (x - 50500) * 11.5719
          // == x * 21 * 0.005]
          // x = 45516.15
          // position fee = x * 21 * 0.002
          await core.setMockPrice(a2b(btc.address), toWei("45516"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("45516", 8), await time.latest())
          {
            const tx = await orderBook.connect(broker).liquidate(positionId, zeroAddress, false, false)
            await expect(tx)
              .to.emit(core, "LiquidatePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                toWei("21"), // oldSize
                toWei("45516"), // tradingPrice
                [pool1.address, pool2.address], // backedPools
                [toWei("9.4281"), toWei("11.5719")], // allocations
                [toWei("-46489.650399999999999996"), toWei("-57674.3496")], // poolPnlUsds
                toWei("1911.672"), // positionFeeUsd
                toWei("0"), // borrowingFeeUsd
                [usdc.address],
                [toWei("2864.328000000000000004")] // collateral + pnl - fee = 108940 - 46489.650399999999999996 - 57674.3496 - 1911.672
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("3171.672", 6)) // 1260 + 1911.672
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("2864.328001", 6)) // at least collateral
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("1046389.650399", 6)) // 999900 + 46489.650399999999999996
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("1057574.349600", 6)) // 999900 + 57674.3496
            expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
          }
        })

        it("liquidate long. 0 < margin < fee < MM", async () => {
          // borrowing = 0
          // Solve[108940
          //   + (x - 50446.967045321963067850) * 9.4281
          //   + (x - 50500) * 11.5719
          // == 0]
          // x = 45288.57
          // position fee = x * 21 * 0.002
          await core.setMockPrice(a2b(btc.address), toWei("45300"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("45300", 8), await time.latest())
          {
            const tx = await orderBook.connect(broker).liquidate(positionId, zeroAddress, false, false)
            await expect(tx)
              .to.emit(core, "LiquidatePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                toWei("21"), // oldSize
                toWei("45300"), // tradingPrice
                [pool1.address, pool2.address], // backedPools
                [toWei("9.4281"), toWei("11.5719")], // allocations
                [toWei("-48526.119999999999999996"), toWei("-60173.88")], // poolPnlUsds
                toWei("240.000000000000000004"), // positionFeeUsd (not fully charged)
                toWei("0"), // borrowingFeeUsd
                [],
                []
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1500", 6)) // 1260 + 240
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0.000001", 6)) // at least collateral
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("1048426.119999", 6)) // 999900 + 48526.119999999999999996
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("1060073.88", 6)) // 999900 + 60173.88
            expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
          }
        })

        it("liquidate long. margin < 0", async () => {
          // borrowing = 0
          // Solve[108940
          //   + (x - 50446.967045321963067850) * 9.4281
          //   + (x - 50500) * 11.5719
          // == 0]
          // x = 45288.57
          // position fee = x * 21 * 0.002
          await core.setMockPrice(a2b(btc.address), toWei("45200"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("45200", 8), await time.latest())
          {
            const tx = await orderBook.connect(broker).liquidate(positionId, zeroAddress, false, false)
            await expect(tx)
              .to.emit(core, "LiquidatePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                toWei("21"), // oldSize
                toWei("45200"), // tradingPrice
                [pool1.address, pool2.address], // backedPools
                [toWei("9.4281"), toWei("11.5719")], // allocations
                [toWei("-49468.929999999999999996"), toWei("-59471.070000000000000004")], // poolPnlUsds (not fully charged)
                toWei("0"), // positionFeeUsd (not fully charged)
                toWei("0"), // borrowingFeeUsd
                [],
                []
              )
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // 1260 + 0
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0.000001", 6)) // at least collateral
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("1049368.929999", 6)) // 999900 + 49468.929999999999999996
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("1059371.070000", 6)) // 999900 + 59471.070000000000000004
            expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
          }
        })
      }) // the same trader longs again, allocate into 2 pools

      describe("another trader longs again, allocate into 2 pools", () => {
        let positionId2: string
        beforeEach(async () => {
          positionId2 = encodePositionId(trader2.address, 0)
          await orderBook.connect(trader2).setInitialLeverage(positionId2, long1, toWei("100"))
          await usdc.mint(orderBook.address, toUnit("100000", 6))
          const args = {
            positionId: positionId2,
            marketId: long1,
            size: toWei("20"),
            flags: PositionOrderFlags.OpenPosition,
            limitPrice: toWei("51000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: zeroAddress,
            collateralToken: usdc.address,
            collateralAmount: toUnit("100000", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          {
            await orderBook.connect(trader2).placePositionOrder(args, refCode)
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(trader2.address)).to.equal(toUnit("100000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("250", 6)) // unchanged
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("9950", 6)) // unchanged
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
            expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
          }
          {
            const [poolTokens, poolBalances] = await pool1.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
            await assertPoolBalances(pool1)
          }
          {
            const [poolTokens, poolBalances] = await pool2.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
            await assertPoolBalances(pool2)
          }
          await core.setMockPrice(a2b(btc.address), toWei("50500"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("50500", 8), await time.latest())
          {
            // fee = 50500 * 20 * 0.1% = 1010
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30 + 30)
            await orderBook.connect(broker).fillPositionOrder(4)
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
            expect(await usdc.balanceOf(trader2.address)).to.equal(toUnit("100000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // + 1010
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // + collateral - fee = 9950 + 100000 - 1010
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // the same as balanceOf
              await assertPoolBalances(pool1)
            }
            {
              const marketInfo1 = await pool1.marketState(long1)
              expect(marketInfo1.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
            }
            {
              const marketInfo2 = await pool2.marketState(long1)
              expect(marketInfo2.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
            }
            // 10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7 = -3.1946670
            // 6 * 11.5719 * 50500                    * 0.80 / 999900 - 6 = -3.1946909
            // 2.2 * 0 - 3
            {
              const collaterals = await core.listAccountCollaterals(positionId2)
              expect(collaterals[0].collateralAddress).to.equal(usdc.address)
              expect(collaterals[0].collateralAmount).to.equal(toWei("98990")) // collateral - fee = 0 + 100000 - 1010
              const positions = await core.listAccountPositions(positionId2)
              expect(positions[0].marketId).to.equal(long1)
              expect(positions[0].pools[0].size).to.equal(toWei("8.4281"))
              expect(positions[0].pools[0].entryPrice).to.equal(toWei("50500"))
              expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
              expect(positions[0].pools[1].size).to.equal(toWei("11.5719"))
              expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500"))
              expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0"))
              expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0"))
              const activated = await core.listActivePositionIds(0, 10)
              expect(activated.totalLength).to.equal(2)
              expect(activated.positionIds[0]).to.equal(positionId)
              expect(activated.positionIds[1]).to.equal(positionId2)
            }
            {
              const state = await pool1.marketState(long1)
              expect(state.isLong).to.equal(true)
              expect(state.totalSize).to.equal(toWei("9.4281"))
              expect(state.averageEntryPrice).to.equal(toWei("50446.967045321963067850"))
            }
            {
              const state = await pool2.marketState(long1)
              expect(state.isLong).to.equal(true)
              expect(state.totalSize).to.equal(toWei("11.5719"))
              expect(state.averageEntryPrice).to.equal(toWei("50500"))
            }
            {
              const state = await pool3.marketState(long1)
              expect(state.isLong).to.equal(true)
              expect(state.totalSize).to.equal(toWei("0"))
              expect(state.averageEntryPrice).to.equal(toWei("0"))
            }
            {
              expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("999399.999999999999999997")) // 999900 - (50500 - 50446.967045321963067850) * 9.4281
              expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("999900")) // 999900 - (50500 - 50500) * 11.5719
              expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1009899")) // 19.998 * 50500
              expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                toWei("999399.999999999999999997")
              )
              expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("999900"))
              expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1009899"))
            }
          }
        })

        it("close, profit", async () => {
          // trader1 close
          {
            const args = {
              positionId,
              marketId: long1,
              size: toWei("1"),
              flags: PositionOrderFlags.WithdrawAllIfEmpty,
              limitPrice: toWei("55000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            {
              await orderBook.connect(trader1).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
              expect(await usdc.balanceOf(trader2.address)).to.equal(toUnit("100000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1260", 6)) // unchanged
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("108940", 6)) // unchanged
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
            }
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // the same as balanceOf
              await assertPoolBalances(pool1)
            }
            {
              const [poolTokens, poolBalances] = await pool2.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // the same as balanceOf
              await assertPoolBalances(pool2)
            }
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
            await expect(orderBook.connect(broker).fillPositionOrder(5)).to.revertedWith("limit")
            await core.setMockPrice(a2b(btc.address), toWei("60000"))
            await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
            await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
            await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
            {
              expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.049999999999999997")) // 999900 - (60000 - 50446.967045321963067850) * 9.4281
              expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // 999900 - (60000 - 50500) * 11.5719
              expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880")) // 19.998 * 60000
              expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                toWei("909833.049999999999999997")
              )
              expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("889966.95"))
              expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1199880"))
            }
            {
              // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
              // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
              // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
              // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
              // borrowing 60000 * 1 * 0.002703729225668555 + 60000 * 0 * 0.002703710487661317 = 162.2237535401133
              // position fee = 60000 * 1 * 0.1% = 60
              // Δsize1 = 1
              // Δsize2 = 0
              // pnl1 = (60000 - 50000) * 1 = 10000
              const tx = await orderBook.connect(broker).fillPositionOrder(5)
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool1.address,
                long1,
                toWei("0.140980166767003251"), // apy
                toWei("0.002703729225668555") // acc
              )
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool2.address,
                long1,
                toWei("0.140979189713768724"), // apy
                toWei("0.002703710487661317") // acc
              )
              await expect(tx)
                .to.emit(core, "ClosePosition")
                .withArgs(
                  trader1.address,
                  positionId,
                  long1,
                  true, // isLong
                  toWei("1"), // size
                  toWei("60000"), // tradingPrice
                  [pool1.address, pool2.address], // backedPools
                  [toWei("1"), toWei("0")], // allocations
                  [toWei("0"), toWei("0")], // newSizes
                  [toWei("0"), toWei("0")], // newEntryPrices
                  [toWei("10000"), toWei("0")], // poolPnlUsds
                  toWei("60"), // positionFeeUsd
                  toWei("162.2237535401133"), // borrowingFeeUsd
                  [usdc.address],
                  [toWei("19727.7762464598867")] // collateral + pnl - fee = 9950 + 10000 - 60 - 162.2237535401133
                )
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("109727.776246", 6)) // 90000 + collateral
              expect(await usdc.balanceOf(trader2.address)).to.equal(toUnit("100000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1482.223753", 6)) // 1260 + 60 + 162.2237535401133
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("98990.000001", 6)) // trader1 = 0, trader2 = 98990
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("989900", 6)) // 999900 - 10000
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // 999900 - 0
              expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
              {
                const [poolTokens, poolBalances] = await pool1.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("989900")) // the same as balanceOf
                await assertPoolBalances(pool1)
              }
              {
                const [poolTokens, poolBalances] = await pool2.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("999900")) // the same as balanceOf
                await assertPoolBalances(pool2)
              }
              {
                const collaterals = await core.listAccountCollaterals(positionId)
                expect(collaterals.length).to.equal(0)
                const positions = await core.listAccountPositions(positionId)
                expect(positions.length).to.equal(0)
                const activated = await core.listActivePositionIds(0, 10)
                expect(activated.totalLength).to.equal(1)
                expect(activated.positionIds[0]).to.equal(positionId2) // trader1 closed, so trader2 remains
              }
              {
                const state = await pool1.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("8.4281"))
                expect(state.averageEntryPrice).to.equal(toWei("50499.999999999999999999"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703729225668555"))
              }
              {
                const state = await pool2.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("11.5719"))
                expect(state.averageEntryPrice).to.equal(toWei("50500"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703710487661317"))
              }
              {
                const state = await pool3.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002872628708424787"))
              }
              {
                expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.049999999999999992")) // 989900 - (60000 - 50499.999999999999999999) * 8.4281
                expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // 999900 - (60000 - 50500) * 11.5719
                expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880")) // 19.998 * 60000
                expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(
                  toWei("909833.049999999999999992")
                )
                expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("889966.95"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1199880"))
              }
            }
          }
          // trader2 close
          {
            const args = {
              positionId: positionId2,
              marketId: long1,
              size: toWei("20"),
              flags: PositionOrderFlags.WithdrawAllIfEmpty,
              limitPrice: toWei("55000"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: 0,
              tpPriceDiff: 0,
              slPriceDiff: 0,
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: 0,
            }
            {
              await orderBook.connect(trader2).placePositionOrder(args, refCode)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("109727.776246", 6)) // unchanged
              expect(await usdc.balanceOf(trader2.address)).to.equal(toUnit("100000", 6)) // unchanged
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("1482.223753", 6)) // unchanged
              expect(await usdc.balanceOf(core.address)).to.equal(toUnit("98990.000001", 6)) // unchanged
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("989900", 6)) // unchanged
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
            }
            {
              const [poolTokens, poolBalances] = await pool1.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("989900")) // the same as balanceOf
              await assertPoolBalances(pool1)
            }
            {
              const [poolTokens, poolBalances] = await pool2.liquidityBalances()
              expect(poolTokens[0]).to.equal(usdc.address)
              expect(poolBalances[0]).to.equal(toWei("999900")) // the same as balanceOf
              await assertPoolBalances(pool2)
            }
            {
              // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
              // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
              // borrowing 60000 * 8.4281 * 0.002703729225668555 + 60000 * 11.5719 * 0.002703710487661317 = 3244.462060741508555268
              // position fee = 60000 * 20 * 0.1% = 1200
              // pnl1 = (60000 - 50499.999999999999999999) * 8.4281 = 80066.95
              // pnl2 = (60000 - 50500) * 11.5719 = 109933.05
              // should auto withdraw oldCollateral + pnl - fee = 98990 + 80066.95 + 109933.05 - 1200 - 3244.462060741508555268 = 284545.537939258491444732
              await orderBook.connect(broker).fillPositionOrder(6)
              expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("109727.776246", 6)) // unchanged
              expect(await usdc.balanceOf(trader2.address)).to.equal(toUnit("384545.537939", 6)) // 100000 + 284545.537939258491444732
              expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("5926.685813", 6)) // 1482.223753 + 1200 + 3244.462060741508555268
              expect(await usdc.balanceOf(core.address)).to.be.closeTo(toWei("0"), toWei("0.0000001")) // near 0 is ok
              expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("909833.05", 6)) // 989900 - 80066.95
              expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("889966.95", 6)) // 999900 - 109933.05
              expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
              {
                const [poolTokens, poolBalances] = await pool1.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("909833.05")) // the same as balanceOf
                await assertPoolBalances(pool1)
              }
              {
                const [poolTokens, poolBalances] = await pool2.liquidityBalances()
                expect(poolTokens[0]).to.equal(usdc.address)
                expect(poolBalances[0]).to.equal(toWei("889966.95")) // the same as balanceOf
                await assertPoolBalances(pool2)
              }
              {
                const collaterals = await core.listAccountCollaterals(positionId2)
                expect(collaterals.length).to.equal(0)
                const positions = await core.listAccountPositions(positionId2)
                expect(positions.length).to.equal(0)
                const activated = await core.listActivePositionIds(0, 10)
                expect(activated.totalLength).to.equal(0)
              }
              {
                const state = await pool1.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703729225668555"))
              }
              {
                const state = await pool2.marketState(long1)
                expect(state.isLong).to.equal(true)
                expect(state.totalSize).to.equal(toWei("0"))
                expect(state.averageEntryPrice).to.equal(toWei("0"))
                expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703710487661317"))
              }
              {
                expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.05")) // the same as liquidityBalance
                expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // the same as liquidityBalance
                expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("909833.05"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("889966.95"))
                expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1199880"))
              }
            }
          }
        })

        it("partially reallocate1, trader2, profit, poo1 -> pool2, nobody pays position fees", async () => {
          await core.setMockPrice(a2b(btc.address), toWei("60000"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
          {
            expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.049999999999999997")) // 999900 - (60000 - 50446.967045321963067850) * 9.4281
            expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // 999900 - (60000 - 50500) * 11.5719
            expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880")) // 19.998 * 60000
          }
          {
            await expect(
              orderBook
                .connect(trader2)
                .reallocate(positionId2, long1, pool1.address, pool2.address, toWei("1"), usdc.address, false)
            ).to.revertedWith("AccessControl")
            const tx = orderBook
              .connect(broker)
              .reallocate(positionId2, long1, pool1.address, pool2.address, toWei("1"), usdc.address, false)
            // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
            // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
            // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
            // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
            // borrowing 60000 * 8.4281 * 0.002703729225668555 + 60000 * 11.5719 * 0.002703710487661317 = 3244.462060741508555268
            // newSize = 8.4281 - 1, 11.5719 + 1, 0
            // pnl1 = (60000 - 50500) * 1
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool1.address,
              long1,
              toWei("0.140980166767003251"), // apy
              toWei("0.002703729225668555") // acc
            )
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool2.address,
              long1,
              toWei("0.140979189713768724"), // apy
              toWei("0.002703710487661317") // acc
            )
            await expect(tx)
              .to.emit(core, "ReallocatePosition")
              .withArgs(
                trader2.address,
                positionId2,
                long1,
                true, // isLong
                pool1.address, // fromPool
                pool2.address, // toPool
                toWei("1"), // size
                toWei("60000"), // tradingPrice
                toWei("50500"), // oldEntry
                [pool1.address, pool2.address, pool3.address], // backedPools
                [toWei("7.4281"), toWei("12.5719"), toWei("0")], // newSizes
                [toWei("50500"), toWei("50500"), toWei("0")], // newEntryPrices
                [toWei("9500"), toWei("0"), toWei("0")], // poolPnlUsds
                toWei("3244.462060741508555268"), // borrowingFeeUsd
                [usdc.address],
                [toWei("95745.537939258491444732")] // collateral - fee = 98990 - 3244.462060741508555268
              )
          }
          {
            const positions = await core.listAccountPositions(positionId2)
            expect(positions[0].marketId).to.equal(long1)
            expect(positions[0].pools[0].size).to.equal(toWei("7.4281"))
            expect(positions[0].pools[0].entryPrice).to.equal(toWei("50500"))
            expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0.002703729225668555"))
            expect(positions[0].pools[1].size).to.equal(toWei("12.5719"))
            expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500"))
            expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0.002703710487661317"))
            expect(positions[0].realizedBorrowingUsd).to.equal(toWei("3244.462060741508555268")) // accumulate until fully closed
          }
          {
            const positions = await core.listAccountPositions(positionId)
            expect(positions[0].marketId).to.equal(long1)
            expect(positions[0].pools[0].size).to.equal(toWei("1"))
            expect(positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
            expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].pools[1].size).to.equal(toWei("0"))
            expect(positions[0].pools[1].entryPrice).to.equal(toWei("0"))
            expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0")) // accumulate until fully closed
          }
          {
            const state = await pool1.marketState(long1)
            expect(state.isLong).to.equal(true)
            expect(state.totalSize).to.equal(toWei("8.4281"))
            expect(state.averageEntryPrice).to.equal(toWei("50440.674647904035310449")) // (50000 * 1 + 50500 * 7.4281) / 8.4281
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703729225668555"))
          }
          {
            const state = await pool2.marketState(long1)
            expect(state.totalSize).to.equal(toWei("12.5719"))
            expect(state.averageEntryPrice).to.equal(toWei("50500"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703710487661317"))
          }
          {
            const [poolTokens, poolBalances] = await pool1.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("990400")) // 999900 - 9500
            await assertPoolBalances(pool1)
          }
          {
            const [poolTokens, poolBalances] = await pool2.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("1009400")) // 999900 + 9500
            await assertPoolBalances(pool2)
          }
          {
            expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("909833.049999999999999996")) // 990400 - (60000 - 50440.674647904035310449) * 8.4281
            expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("889966.95")) // 1009400 - (60000 - 50500) * 12.5719
            expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1199880")) // 19.998 * 60000
          }
        })

        it("completely reallocate1, trader1, loss, poo1 -> pool3, nobody pays position fees", async () => {
          await core.setMockPrice(a2b(btc.address), toWei("49900"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("49900", 8), await time.latest())
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
          {
            expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("1005056.859999999999999996")) // 999900 - (49900 - 50446.967045321963067850) * 9.4281
            expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("1006843.14")) // 999900 - (49900 - 50500) * 11.5719
            expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("997900.2")) // 19.998 * 49900
          }
          {
            await expect(
              orderBook
                .connect(trader2)
                .reallocate(positionId, long1, pool1.address, pool2.address, toWei("1"), usdc.address, false)
            ).to.revertedWith("AccessControl")
            const tx = orderBook
              .connect(broker)
              .reallocate(positionId, long1, pool1.address, pool3.address, toWei("1"), usdc.address, false)
            // fr1 0.10 + exp(10 * 9.4281 * 50446.967045321963067850 * 0.80 / 999900 - 7) = 0.140980166767003251
            // fr2 0.10 + exp(6 * 11.5719 * 50500                    * 0.80 / 999900 - 6) = 0.140979189713768724
            // acc1 0.140980166767003251 * 7 / 365 = 0.002703729225668555
            // acc2 0.140979189713768724 * 7 / 365 = 0.002703710487661317
            // borrowing 49900 * 1 * 0.002703729225668555 + 49900 * 0 * 0.002703710487661317 = 134.9160883608608945
            // newSize = 8.4281 - 1, 11.5719 + 1, 0
            // pnl1 = (49900 - 50000) * 1 = -100, since it is loss, pool1 should get rpnl, thus pool3 should pay to pool1.
            //      = -100 / 49900 = -0.00200400 btc = -99.9996
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool1.address,
              long1,
              toWei("0.140980166767003251"), // apy
              toWei("0.002703729225668555") // acc
            )
            await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
              pool2.address,
              long1,
              toWei("0.140979189713768724"), // apy
              toWei("0.002703710487661317") // acc
            )
            await expect(tx)
              .to.emit(core, "ReallocatePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                pool1.address, // fromPool
                pool3.address, // toPool
                toWei("1"), // size
                toWei("49900"), // tradingPrice
                toWei("50000"), // oldEntry
                [pool1.address, pool2.address, pool3.address], // backedPools
                [toWei("0"), toWei("0"), toWei("1")], // newSizes
                [toWei("0"), toWei("0"), toWei("50000")], // newEntryPrices
                [toWei("-99.9996"), toWei("0"), toWei("0")], // poolPnlUsds
                toWei("134.9160883608608945"), // borrowingFeeUsd
                [usdc.address],
                [toWei("9815.0839116391391055")] // collateral - fee = 9950 - 134.9160883608608945
              )
          }
          {
            const positions = await core.listAccountPositions(positionId2)
            expect(positions[0].marketId).to.equal(long1)
            expect(positions[0].pools[0].size).to.equal(toWei("8.4281"))
            expect(positions[0].pools[0].entryPrice).to.equal(toWei("50500"))
            expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].pools[1].size).to.equal(toWei("11.5719"))
            expect(positions[0].pools[1].entryPrice).to.equal(toWei("50500"))
            expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0")) // accumulate until fully closed
          }
          {
            const positions = await core.listAccountPositions(positionId)
            expect(positions[0].marketId).to.equal(long1)
            expect(positions[0].pools[0].size).to.equal(toWei("0"))
            expect(positions[0].pools[0].entryPrice).to.equal(toWei("0"))
            expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].pools[1].size).to.equal(toWei("0"))
            expect(positions[0].pools[1].entryPrice).to.equal(toWei("0"))
            expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].pools[2].size).to.equal(toWei("1"))
            expect(positions[0].pools[2].entryPrice).to.equal(toWei("50000"))
            expect(positions[0].pools[2].entryBorrowing).to.equal(toWei("0.002872628708424787"))
            expect(positions[0].realizedBorrowingUsd).to.equal(toWei("134.9160883608608945")) // accumulate until fully closed
          }
          {
            const state = await pool1.marketState(long1)
            expect(state.isLong).to.equal(true)
            expect(state.totalSize).to.equal(toWei("8.4281"))
            expect(state.averageEntryPrice).to.equal(toWei("50499.999999999999999999"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703729225668555"))
          }
          {
            const state = await pool2.marketState(long1)
            expect(state.totalSize).to.equal(toWei("11.5719"))
            expect(state.averageEntryPrice).to.equal(toWei("50500"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002703710487661317"))
          }
          {
            const state = await pool3.marketState(long1)
            expect(state.totalSize).to.equal(toWei("1"))
            expect(state.averageEntryPrice).to.equal(toWei("50000"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0.002872628708424787"))
          }
          {
            const [poolTokens, poolBalances] = await pool1.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
            expect(poolTokens[2]).to.equal(btc.address)
            expect(poolBalances[2]).to.equal(toWei("0.00200400")) // 100 / 49900
            await assertPoolBalances(pool1)
          }
          {
            const [poolTokens, poolBalances] = await pool2.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
            await assertPoolBalances(pool2)
          }
          {
            const [poolTokens, poolBalances] = await pool3.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("0"))
            expect(poolTokens[2]).to.equal(btc.address)
            expect(poolBalances[2]).to.equal(toWei("19.99599600")) // 19.998 - 100 / 49900
            await assertPoolBalances(pool3)
          }
          {
            // note: pool1 aum is missed by 0.0004 in this case. this is caused by btc decimals precision,
            //       so it is a fixed value rather than scaling with position value
            expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("1005056.859599999999999991")) // 999900 + 0.00200400 * 49900 - (49900 - 50499.999999999999999999) * 8.4281
            expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("1006843.14")) // 999900 - (49900 - 50500) * 11.5719
            expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("997900.2004")) // 19.99599600 * 49900 - (49900 - 50000) * 1
          }
        })
      })

      it("mlp price should consider capped pnl", async () => {
        // entry = 50000 * 1
        // maxProfit = 70% = 35000
        // if markPrice = 90000, capped pnl = 35000, aum = 999900 - 35000
        await core.setMockPrice(a2b(btc.address), toWei("90000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("90000", 8), await time.latest())
        {
          const collaterals = await core.listAccountCollaterals(positionId)
          expect(collaterals[0].collateralAddress).to.equal(usdc.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("9950")) // unchanged
          const positions = await core.listAccountPositions(positionId)
          expect(positions[0].marketId).to.equal(long1)
          expect(positions[0].pools[0].size).to.equal(toWei("1"))
          expect(positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
          expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
          expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0"))
          const activated = await core.listActivePositionIds(0, 10)
          expect(activated.totalLength).to.equal(1)
          expect(activated.positionIds[0]).to.equal(positionId)
        }
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("964900")) // 999900 - 35000
          expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("999900")) // unchanged
          expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1799820")) // 19.998 * 90000
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("964900"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("999900"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1799820"))
        }
      })

      it("long capped pnl", async () => {
        // closing 50000 * 0.5
        // maxProfit = 70% = 17500
        // fee = 90000 * 0.5 * 0.1% = 45
        await core.setMockPrice(a2b(btc.address), toWei("90000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("90000", 8), await time.latest())
        // close half
        {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("0.5"),
            flags: PositionOrderFlags.WithdrawProfit,
            limitPrice: toWei("50000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
            lastConsumedToken: zeroAddress,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
          {
            const tx = await orderBook.connect(broker).fillPositionOrder(4)
            await expect(tx)
              .to.emit(core, "ClosePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true, // isLong
                toWei("0.5"), // size
                toWei("90000"), // tradingPrice
                [pool1.address, pool2.address], // backedPools
                [toWei("0.5"), toWei("0")], // allocations
                [toWei("0.5"), toWei("0")], // newSizes
                [toWei("50000"), toWei("0")], // newEntryPrices
                [toWei("17500"), toWei("0")], // poolPnlUsds
                toWei("45"), // positionFeeUsd
                toWei("0"), // borrowingFeeUsd
                [usdc.address],
                [toWei("27405")] // collateral + pnl - fee = 9950 + 17500 - 45
              )
          }
          {
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("107455", 6)) // 90000 + 17500 - 45
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("295", 6)) // 250 + 45
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("9950", 6)) // unchanged
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("982400", 6)) // 999900 - 17500
          }
          {
            const [poolTokens, poolBalances] = await pool1.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("982400")) // 999900 - 17500
            await assertPoolBalances(pool1)
          }
          {
            expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("964900")) // 982400 - (50000 * 0.5 * 0.70)
            expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("964900"))
          }
        }
      })

      it("ADL a long position", async () => {
        // en try 50000 * 1
        // trigger profit = 75% = 37500, trigger price = 87500
        // max profit = 70% = 35000
        // fee = 87501 * 1 * 0.1% = 87.501
        await core.setMockPrice(a2b(btc.address), toWei("87500"))
        expect(await core.isDeleverageAllowed(positionId, long1)).to.equal(false)
        {
          await expect(
            orderBook.connect(broker).fillAdlOrder(positionId, long1, zeroAddress, false, false)
          ).to.revertedWith("ADL safe")
        }
        await core.setMockPrice(a2b(btc.address), toWei("87501"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("87501", 8), await time.latest())
        expect(await core.isDeleverageAllowed(positionId, long1)).to.equal(true)
        {
          await expect(
            orderBook.connect(trader1).fillAdlOrder(positionId, long1, zeroAddress, false, false)
          ).to.revertedWith("AccessControl")
        }
        {
          const tx = await orderBook.connect(broker).fillAdlOrder(positionId, long1, zeroAddress, false, false)
          await expect(tx)
            .to.emit(core, "ClosePosition")
            .withArgs(
              trader1.address,
              positionId,
              long1,
              true, // isLong
              toWei("1"), // size
              toWei("87501"), // tradingPrice
              [pool1.address, pool2.address], // backedPools
              [toWei("1"), toWei("0")], // allocations
              [toWei("0"), toWei("0")], // newSizes
              [toWei("0"), toWei("0")], // newEntryPrices
              [toWei("35000"), toWei("0")], // poolPnlUsds
              toWei("87.501"), // positionFeeUsd
              toWei("0"), // borrowingFeeUsd
              [usdc.address],
              [toWei("44862.499")] // collateral + pnl - fee = 9950 + 35000 - 87.501
            )
        }
        {
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("337.501", 6)) // 250 + 87.501
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("44862.499", 6)) // near collateral
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("964900", 6)) // 999900 - 35000
        }
        {
          const [poolTokens, poolBalances] = await pool1.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("964900")) // 999900 - 35000
          await assertPoolBalances(pool1)
        }
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("964900")) // poolBalance
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("964900"))
        }
      })

      it("remove liquidity (usdc) cause reserved > spotLiquidity, if price unchanged", async () => {
        // reserve = 50000 * 1 * 80% = 40000
        // max possible withdraw = 999900 - 40000 = 959900
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("999900")) // unchanged
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("999900"))
        }
        {
          expect(await pool1.balanceOf(lp1.address)).to.equal(toWei("999900"))
          await pool1.connect(lp1).transfer(orderBook.address, toWei("959901"))
          const args = {
            poolAddress: pool1.address,
            token: usdc.address,
            rawAmount: toWei("959901"),
            isAdding: false,
            isUnwrapWeth: false,
          }
          await orderBook.connect(lp1).placeLiquidityOrder(args)
          expect(await pool1.balanceOf(lp1.address)).to.equal(toWei("39999")) // 999900 - 959901
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30 + 930)
          await expect(orderBook.connect(broker).fillLiquidityOrder(4, [])).to.revertedWith("InsufficientLiquidity")
        }
        {
          await orderBook.connect(lp1).cancelOrder(4)
          expect(await pool1.balanceOf(lp1.address)).to.equal(toWei("999900"))
        }
        {
          await pool1.connect(lp1).transfer(orderBook.address, toWei("959900"))
          const args = {
            poolAddress: pool1.address,
            token: usdc.address,
            rawAmount: toWei("959900"),
            isAdding: false,
            isUnwrapWeth: false,
          }
          await orderBook.connect(lp1).placeLiquidityOrder(args)
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30 + 930 + 930)
          await orderBook.connect(broker).fillLiquidityOrder(5, [])
        }
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("345.99", 6)) // 250 + 959900 * 0.0001
        expect(await usdc.balanceOf(core.address)).to.equal(toUnit("9950", 6)) // unchanged
        expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("40000", 6)) // 999900 - 959900
        {
          expect(await pool1.getAumUsd()).to.equal(toWei("40000"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("40000"))
        }
      })

      it("remove liquidity (usdc) cause reserved > spotLiquidity, if price changed", async () => {
        await core.setMockPrice(a2b(btc.address), toWei("45000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("45000", 8), await time.latest())
        // aum = 999900 - (45000 - 50000) * 1 = 1004900
        // nav = 1004900 / 999900
        // reserve = 50000 * 1 * 80% = 40000
        // max possible withdraw = 999900 - 40000 = 959900
        // max possible share = 959900 / nav = 955123.9
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("1004900"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("1004900"))
        }
        {
          expect(await pool1.balanceOf(lp1.address)).to.equal(toWei("999900"))
          await pool1.connect(lp1).transfer(orderBook.address, toWei("955124"))
          const args = {
            poolAddress: pool1.address,
            token: usdc.address,
            rawAmount: toWei("955124"),
            isAdding: false,
            isUnwrapWeth: false,
          }
          await orderBook.connect(lp1).placeLiquidityOrder(args)
          expect(await pool1.balanceOf(lp1.address)).to.equal(toWei("44776")) // 999900 - 955124
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30 + 930)
          await expect(orderBook.connect(broker).fillLiquidityOrder(4, [])).to.revertedWith("InsufficientLiquidity")
        }
        {
          await orderBook.connect(lp1).cancelOrder(4)
          expect(await pool1.balanceOf(lp1.address)).to.equal(toWei("999900"))
        }
        {
          await pool1.connect(lp1).transfer(orderBook.address, toWei("955123"))
          const args = {
            poolAddress: pool1.address,
            token: usdc.address,
            rawAmount: toWei("955123"),
            isAdding: false,
            isUnwrapWeth: false,
          }
          await orderBook.connect(lp1).placeLiquidityOrder(args)
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30 + 930 + 930)
          await orderBook.connect(broker).fillLiquidityOrder(5, [])
        }
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("345.989909", 6)) // 250 + 955123 * nav * 0.0001
        expect(await usdc.balanceOf(core.address)).to.equal(toUnit("9950", 6)) // unchanged
        expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("40000.907392", 6)) // at least 999900 - 955123 * nav
        {
          expect(await pool1.getAumUsd()).to.equal(toWei("45000.907390739074385000")) // at least 999900 - (45000 - 50000) * 1 - 955123 * nav
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("45000.907390739074385000"))
        }
      })
    }) // long a little and test more

    describe("short a little and test more", () => {
      let positionId = ""
      beforeEach(async () => {
        // open long btc, using usdc
        positionId = encodePositionId(trader1.address, 0)
        await orderBook.connect(trader1).setInitialLeverage(positionId, short1, toWei("100"))
        await usdc.connect(trader1).transfer(orderBook.address, toUnit("10000", 6))
        const args = {
          positionId,
          marketId: short1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("10000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        {
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // - 10000
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("200", 6)) // unchanged
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0", 6)) // unchanged
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
        }
        {
          const [poolTokens, poolBalances] = await pool1.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
          await assertPoolBalances(pool1)
        }
        {
          const [poolTokens, poolBalances] = await pool2.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
          await assertPoolBalances(pool2)
        }
        {
          const [poolTokens, poolBalances] = await pool3.liquidityBalances()
          expect(poolTokens[2]).to.equal(btc.address)
          expect(poolBalances[2]).to.equal(toWei("19.998")) // unchanged
          await assertPoolBalances(pool3)
        }
        {
          // fee = 50000 * 1 * 0.1% = 50
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30)
          await orderBook.connect(broker).fillPositionOrder(3)
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("250", 6)) // + 50
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("9950", 6)) // at least collateral
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
          {
            const state = await pool1.marketState(long1)
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const state = await pool1.marketState(short1)
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const collaterals = await core.listAccountCollaterals(positionId)
            expect(collaterals[0].collateralAddress).to.equal(usdc.address)
            expect(collaterals[0].collateralAmount).to.equal(toWei("9950")) // collateral - fee = 10000 - 50
            const positions = await core.listAccountPositions(positionId)
            expect(positions[0].marketId).to.equal(short1)
            expect(positions[0].pools[0].poolAddress).to.equal(pool2.address)
            expect(positions[0].pools[0].size).to.equal(toWei("1"))
            expect(positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
            expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0"))
            const activated = await core.listActivePositionIds(0, 10)
            expect(activated.totalLength).to.equal(1)
            expect(activated.positionIds[0]).to.equal(positionId)
          }
          {
            const collateralsAndPositions = await core.listCollateralsAndPositionsOf(trader1.address)
            expect(collateralsAndPositions.length).to.equal(1)
            expect(collateralsAndPositions[0].positionId).to.equal(positionId)
            expect(collateralsAndPositions[0].collaterals[0].collateralAddress).to.equal(usdc.address)
            expect(collateralsAndPositions[0].collaterals[0].collateralAmount).to.equal(toWei("9950"))
            expect(collateralsAndPositions[0].positions[0].pools[0].size).to.equal(toWei("1"))
            expect(collateralsAndPositions[0].positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
            expect(collateralsAndPositions[0].positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
          }
          {
            const state = await pool2.marketState(short1)
            expect(state.isLong).to.equal(false)
            expect(state.totalSize).to.equal(toWei("1"))
            expect(state.averageEntryPrice).to.equal(toWei("50000"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const state = await pool3.marketState(short1)
            expect(state.isLong).to.equal(false)
            expect(state.totalSize).to.equal(toWei("0"))
            expect(state.averageEntryPrice).to.equal(toWei("0"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            expect(await pool2.getAumUsd()).to.equal(toWei("999900")) // unchanged
            expect(await pool3.getAumUsd()).to.equal(toWei("999900")) // unchanged
            expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("999900"))
            expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("999900"))
            expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("999900"))
          }
        }
      })

      it("mlp price should consider capped pnl", async () => {
        // entry = 50000 * 1
        // maxProfit = 70% = 35000
        // if markPrice = 10000, capped pnl = 35000, aum = 999900 - 35000
        await core.setMockPrice(a2b(btc.address), toWei("10000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("10000", 8), await time.latest())
        {
          const collaterals = await core.listAccountCollaterals(positionId)
          expect(collaterals[0].collateralAddress).to.equal(usdc.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("9950")) // unchanged
          const positions = await core.listAccountPositions(positionId)
          expect(positions[0].marketId).to.equal(short1)
          expect(positions[0].pools[0].size).to.equal(toWei("1"))
          expect(positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
          expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
          expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0"))
          const activated = await core.listActivePositionIds(0, 10)
          expect(activated.totalLength).to.equal(1)
          expect(activated.positionIds[0]).to.equal(positionId)
        }
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("999900")) // unchanged
          expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("964900")) // 999900 - 35000
          expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("199980")) // 19.998 * 10000
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("999900"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("964900"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("199980"))
        }
      })

      it("short capped pnl", async () => {
        // closing 50000 * 0.5
        // maxProfit = 70% = 17500
        // fee = 10000 * 0.5 * 0.1% = 5
        await core.setMockPrice(a2b(btc.address), toWei("10000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("10000", 8), await time.latest())
        // close half
        {
          const args = {
            positionId,
            marketId: short1,
            size: toWei("0.5"),
            flags: PositionOrderFlags.WithdrawProfit,
            limitPrice: toWei("50000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 86400 * 7 + 30,
            lastConsumedToken: zeroAddress,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
          {
            const tx = await orderBook.connect(broker).fillPositionOrder(4)
            await expect(tx)
              .to.emit(core, "ClosePosition")
              .withArgs(
                trader1.address,
                positionId,
                short1,
                false, // isLong
                toWei("0.5"), // size
                toWei("10000"), // tradingPrice
                [pool2.address], // backedPools
                [toWei("0.5")], // allocations
                [toWei("0.5")], // newSizes
                [toWei("50000")], // newEntryPrices
                [toWei("17500")], // poolPnlUsds
                toWei("5"), // positionFeeUsd
                toWei("0"), // borrowingFeeUsd
                [usdc.address],
                [toWei("27445")] // collateral + pnl - fee = 9950 + 17500 - 5
              )
          }
          {
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("107495", 6)) // 90000 + 17500 - 5
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("255", 6)) // 250 + 5
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("9950", 6)) // unchanged
            expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("982400", 6)) // 999900 - 17500
          }
          {
            const [poolTokens, poolBalances] = await pool2.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("982400")) // 999900 - 17500
            await assertPoolBalances(pool2)
          }
          {
            expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("964900")) // 982400 - (50000 * 0.5 * 0.70)
            expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("964900"))
          }
        }
      })

      it("liquidate short. margin < 0", async () => {
        // borrowing = 0
        // Solve[9950 + (50000 - x) * 1 == 0]
        // x = 59950
        // position fee = x * 1 * 0.002 = 119.9
        await core.setMockPrice(a2b(btc.address), toWei("59950"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("59950", 8), await time.latest())
        {
          const tx = await orderBook.connect(broker).liquidate(positionId, zeroAddress, true, false)
          await expect(tx)
            .to.emit(core, "LiquidatePosition")
            .withArgs(
              trader1.address,
              positionId,
              short1,
              false, // isLong
              toWei("1"), // oldSize
              toWei("59950"), // tradingPrice
              [pool2.address], // backedPools
              [toWei("1")], // allocations
              [toWei("-9950")], // poolPnlUsds
              toWei("0"), // positionFeeUsd (not fully charged)
              toWei("0"), // borrowingFeeUsd
              [],
              []
            )
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // unchanged
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("250", 6)) // 250 + 0
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0", 6)) // at least collateral
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("1009850", 6)) // 999900 + 9950
          expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
        }
      })
    }) // short a little and test more

    describe("deposit 2 collaterals, open long, allocated to 3 pools", () => {
      let positionId = ""
      beforeEach(async () => {
        // deposit 2 collaterals
        positionId = encodePositionId(trader1.address, 0)
        await usdc.connect(trader1).transfer(orderBook.address, toUnit("30000", 6))
        await arb.connect(trader1).transfer(orderBook.address, toUnit("30000", 18))
        await orderBook.connect(trader1).depositCollateral(positionId, usdc.address, toUnit("30000", 6))
        await orderBook.connect(trader1).depositCollateral(positionId, arb.address, toUnit("30000", 18))
        {
          const collaterals = await core.listAccountCollaterals(positionId)
          expect(collaterals.length).to.equal(2)
          expect(collaterals[0].collateralAddress).to.equal(usdc.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("30000"))
          expect(collaterals[1].collateralAddress).to.equal(arb.address)
          expect(collaterals[1].collateralAmount).to.equal(toWei("30000"))
        }
        // open long
        await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("100"))
        {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("60"),
            flags: PositionOrderFlags.OpenPosition,
            limitPrice: toWei("50000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: zeroAddress,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
        }
        {
          const [poolTokens, poolBalances] = await pool1.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
          await assertPoolBalances(pool1)
        }
        {
          const [poolTokens, poolBalances] = await pool2.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
          await assertPoolBalances(pool2)
        }
        {
          const [poolTokens, poolBalances] = await pool3.liquidityBalances()
          expect(poolTokens[2]).to.equal(btc.address)
          expect(poolBalances[2]).to.equal(toWei("19.998")) // unchanged
          await assertPoolBalances(pool3)
        }
        {
          // fee = 50000 * 60 * 0.1% = 3000
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30)
          await orderBook.connect(broker).fillPositionOrder(3)
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("70000", 6)) // 100000 - 30000
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("3200", 6)) // + 3000
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("27000", 6)) // + collateral - fee = 0 + 30000 - 3000
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("70000", 18)) // 100000 - 30000
          expect(await arb.balanceOf(core.address)).to.equal(toUnit("30000", 18)) // + collateral - fee = 0 + 30000 - 0
          {
            const state = await pool1.marketState(long1)
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const state = await pool1.marketState(short1)
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const collaterals = await core.listAccountCollaterals(positionId)
            expect(collaterals[0].collateralAddress).to.equal(usdc.address)
            expect(collaterals[0].collateralAmount).to.equal(toWei("27000")) // collateral - fee = 30000 - 3000
            expect(collaterals[1].collateralAddress).to.equal(arb.address)
            expect(collaterals[1].collateralAmount).to.equal(toWei("30000")) // collateral = 30000
            const positions = await core.listAccountPositions(positionId)
            expect(positions[0].marketId).to.equal(long1)
            expect(positions[0].pools[0].size).to.equal(toWei("15.1989"))
            expect(positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
            expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].pools[1].size).to.equal(toWei("21.1652"))
            expect(positions[0].pools[1].entryPrice).to.equal(toWei("50000"))
            expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].pools[2].size).to.equal(toWei("23.6359"))
            expect(positions[0].pools[2].entryPrice).to.equal(toWei("50000"))
            expect(positions[0].pools[2].entryBorrowing).to.equal(toWei("0"))
            expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0"))
            const activated = await core.listActivePositionIds(0, 10)
            expect(activated.totalLength).to.equal(1)
            expect(activated.positionIds[0]).to.equal(positionId)
          }
          {
            const state = await pool1.marketState(long1)
            expect(state.isLong).to.equal(true)
            expect(state.totalSize).to.equal(toWei("15.1989"))
            expect(state.averageEntryPrice).to.equal(toWei("50000"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const state = await pool2.marketState(long1)
            expect(state.isLong).to.equal(true)
            expect(state.totalSize).to.equal(toWei("21.1652"))
            expect(state.averageEntryPrice).to.equal(toWei("50000"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            const state = await pool3.marketState(long1)
            expect(state.isLong).to.equal(true)
            expect(state.totalSize).to.equal(toWei("23.6359"))
            expect(state.averageEntryPrice).to.equal(toWei("50000"))
            expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
          }
          {
            expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("999900")) // unchanged
            expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("999900")) // unchanged
            expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("999900")) // unchanged
            expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("999900"))
            expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("999900"))
            expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("999900"))
          }
        }
      })

      it("close all, take profit => the trader gets 2 types of tokens", async () => {
        await core.setMockPrice(a2b(usdc.address), toWei("1"))
        await core.setMockPrice(a2b(arb.address), toWei("3"))
        await core.setMockPrice(a2b(btc.address), toWei("60000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("3", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
        {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("60"),
            flags: 0,
            limitPrice: toWei("50000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: zeroAddress,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
        }
        await orderBook.connect(broker).fillPositionOrder(4)
        // positionFees = 60000 * 60 * 0.001 = 3600
        // borrowingFee = 0
        // pnl1 = (60000 - 50000) * 15.1989 = 151989 usdc
        // pnl2 = (60000 - 50000) * 21.1652 = 211652 usdc
        // pnl3 = (60000 - 50000) * 23.6359 = 236359 = 3.93931666 wbtc
        expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("70000", 6)) // unchanged
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("6800", 6)) // 3200 + 3600
        expect(await usdc.balanceOf(core.address)).to.equal(toUnit("387041", 6)) // + collateral + pnl1 + pnl2 - fee = 27000 + 151989 + 211652 - 3600
        expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("847911", 6)) // - pnl1 = 999900 - 151989
        expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("788248", 6)) // - pnl2 = 999900 - 211652
        expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("16.05868334", 8)) // - pnl3 = 19.998 - 3.93931666
        expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("70000", 18)) // unchanged
        expect(await arb.balanceOf(core.address)).to.equal(toUnit("30000", 18)) // unchanged
        {
          const state = await pool1.marketState(long1)
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool1.marketState(short1)
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const collaterals = await core.listAccountCollaterals(positionId)
          expect(collaterals[0].collateralAddress).to.equal(usdc.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("387041")) // collateral - fee + pnl1 + pnl2 = 27000 - 3000 + 151989 + 211652
          expect(collaterals[1].collateralAddress).to.equal(arb.address)
          expect(collaterals[1].collateralAmount).to.equal(toWei("30000")) // unchanged
          expect(collaterals[2].collateralAddress).to.equal(btc.address)
          expect(collaterals[2].collateralAmount).to.equal(toWei("3.93931666")) // pnl3 = 3.93931666
          const positions = await core.listAccountPositions(positionId)
          expect(positions.length).to.equal(0)
          const activated = await core.listActivePositionIds(0, 10)
          expect(activated.totalLength).to.equal(0)
        }
        {
          const state = await pool1.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool2.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool3.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("847911"))
          expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("788248"))
          expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("963521.0004"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("847911"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("788248"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("963521.0004"))
        }
      })

      it("close all, take profit => try to keep usdc and pay fees by profits", async () => {
        await core.setMockPrice(a2b(usdc.address), toWei("1"))
        await core.setMockPrice(a2b(arb.address), toWei("3"))
        await core.setMockPrice(a2b(btc.address), toWei("60000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("3", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
        {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("60"),
            flags: 0,
            limitPrice: toWei("50000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: usdc.address,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
        }
        await orderBook.connect(broker).fillPositionOrder(4)
        // positionFees = 60000 * 60 * 0.001 = 3600
        // borrowingFee = 0
        // pnl1 = (60000 - 50000) * 15.1989 = 151989 usdc
        // pnl2 = (60000 - 50000) * 21.1652 = 211652 usdc
        // pnl3 = (60000 - 50000) * 23.6359 = 236359 = 3.93931666 wbtc
        // fee is paid by wbtc
        expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("70000", 6)) // unchanged
        expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("70000", 18)) // unchanged
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("3200", 6)) // unchanged
        expect(await arb.balanceOf(feeDistributor.address)).to.equal(toUnit("0", 6)) // unchanged
        expect(await btc.balanceOf(feeDistributor.address)).to.equal(toUnit("0.062", 8)) // 0.002 + 3600 / 60000
        expect(await usdc.balanceOf(core.address)).to.equal(toUnit("390641", 6)) // + collateral + pnl1 + pnl2 = 27000 + 151989 + 211652
        expect(await arb.balanceOf(core.address)).to.equal(toUnit("30000", 18)) // unchanged
        expect(await btc.balanceOf(core.address)).to.equal(toUnit("3.87931666", 8)) // + pnl3 - fee = 3.93931666 - 0.06
        expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("847911", 6)) // - pnl1 = 999900 - 151989
        expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("788248", 6)) // - pnl2 = 999900 - 211652
        expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("16.05868334", 8)) // - pnl3 = 19.998 - 3.93931666
        {
          const state = await pool1.marketState(long1)
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool1.marketState(short1)
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const collaterals = await core.listAccountCollaterals(positionId)
          expect(collaterals[0].collateralAddress).to.equal(usdc.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("390641")) // collateral + pnl1 + pnl2 = 27000 + 151989 + 211652
          expect(collaterals[1].collateralAddress).to.equal(arb.address)
          expect(collaterals[1].collateralAmount).to.equal(toWei("30000")) // unchanged
          expect(collaterals[2].collateralAddress).to.equal(btc.address)
          expect(collaterals[2].collateralAmount).to.equal(toWei("3.87931666")) // pnl3 - fee = 3.93931666 - 3600 / 60000
          const positions = await core.listAccountPositions(positionId)
          expect(positions.length).to.equal(0)
          const activated = await core.listActivePositionIds(0, 10)
          expect(activated.totalLength).to.equal(0)
        }
        {
          const state = await pool1.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool2.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool3.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("847911"))
          expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("788248"))
          expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("963521.0004"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("847911"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("788248"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("963521.0004"))
        }
      })

      it("close all, realize loss => the pools get 2 types of tokens", async () => {
        await core.setMockPrice(a2b(usdc.address), toWei("1"))
        await core.setMockPrice(a2b(arb.address), toWei("1.5"))
        await core.setMockPrice(a2b(btc.address), toWei("49500"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("1.5", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("49500", 8), await time.latest())
        {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("60"),
            flags: 0,
            limitPrice: toWei("40000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: zeroAddress,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
        }
        await orderBook.connect(broker).fillPositionOrder(4)
        // positionFees = 49500 * 60 * 0.001 = 2970
        // borrowingFee = 0
        // pnl1 = (49500 - 50000) * 15.1989 = -7599.45
        // pnl2 = (49500 - 50000) * 21.1652 = -10582.6
        // pnl3 = (49500 - 50000) * 23.6359 = -11817.95
        // pnl1+2+3 = (49500 - 50000) * 60 = -30000
        {
          const state = await pool1.marketState(long1)
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool1.marketState(short1)
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const collaterals = await core.listAccountCollaterals(positionId)
          // usdc should be removed because max(0, collateral + pnl) = max(0, 27000 - 30000) = 0
          expect(collaterals.length).to.equal(1)
          expect(collaterals[0].collateralAddress).to.equal(arb.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("26020")) // collateral + (-fee + remain) / price = 30000 - (2970 + 3000) / 1.5
          const positions = await core.listAccountPositions(positionId)
          expect(positions.length).to.equal(0)
          const activated = await core.listActivePositionIds(0, 10)
          expect(activated.totalLength).to.equal(0)
        }
        {
          const state = await pool1.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool2.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool3.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("1007499.45")) // 999900 + 7599.45
          expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("1010482.6")) // 999900 + 10582.6
          expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1001718.95")) // 19.998 * 49500 + 11817.95
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("1007499.45"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("1010482.6"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(toWei("1001718.95"))
        }
      })

      it("close all, realize loss => try to keep usdc and pay fees and loss by arb", async () => {
        await core.setMockPrice(a2b(usdc.address), toWei("1"))
        await core.setMockPrice(a2b(arb.address), toWei("1.5"))
        await core.setMockPrice(a2b(btc.address), toWei("49500"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("1.5", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("49500", 8), await time.latest())
        {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("60"),
            flags: 0,
            limitPrice: toWei("40000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: usdc.address,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
        }
        await orderBook.connect(broker).fillPositionOrder(4)
        // positionFees = 49500 * 60 * 0.001 = 2970
        // borrowingFee = 0
        // pnl1 = (49500 - 50000) * 15.1989 = -7599.45
        // pnl2 = (49500 - 50000) * 21.1652 = -10582.6
        // pnl3 = (49500 - 50000) * 23.6359 = -11817.95
        // pnl1+2+3 = (49500 - 50000) * 60 = -30000
        {
          const state = await pool1.marketState(long1)
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool1.marketState(short1)
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const collaterals = await core.listAccountCollaterals(positionId)
          expect(collaterals[1].collateralAddress).to.equal(arb.address)
          expect(collaterals[1].collateralAmount).to.equal(toWei("8019.999999999999999999")) // collateral + pnl - fee = 30000 + (-30000 - 2970) / 1.5
          expect(collaterals[0].collateralAddress).to.equal(usdc.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("27000")) // unchanged
          const positions = await core.listAccountPositions(positionId)
          expect(positions.length).to.equal(0)
          const activated = await core.listActivePositionIds(0, 10)
          expect(activated.totalLength).to.equal(0)
        }
        {
          const state = await pool1.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool2.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          const state = await pool3.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("0"))
          expect(state.averageEntryPrice).to.equal(toWei("0"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("1007499.45")) // 999900 + 7599.45
          expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("1010482.6")) // 999900 + 10582.6
          expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("1001718.950000000000000001")) // 19.998 * 49500 + 11817.95
          expect(await aumReader.callStatic.estimatedAumUsd(pool1.address)).to.equal(toWei("1007499.45"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool2.address)).to.equal(toWei("1010482.6"))
          expect(await aumReader.callStatic.estimatedAumUsd(pool3.address)).to.equal(
            toWei("1001718.950000000000000001")
          )
        }
      })

      it("pool2 is draining, open position allocates to pool1 + pool3", async () => {
        await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_IS_DRAINING"), u2b(ethers.BigNumber.from("1")))
        // open long
        {
          const args = {
            positionId,
            marketId: long1,
            size: toWei("1"),
            flags: PositionOrderFlags.OpenPosition,
            limitPrice: toWei("50000"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: zeroAddress,
            collateralToken: zeroAddress,
            collateralAmount: toUnit("0", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0"),
            slPriceDiff: toWei("0"),
            tpslExpiration: 0,
            tpslFlags: 0,
            tpslWithdrawSwapToken: zeroAddress,
            tpslWithdrawSwapSlippage: toWei("0"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
        }
        const tx2 = await orderBook.connect(broker).fillPositionOrder(4)
        await expect(tx2)
          .to.emit(core, "OpenPosition")
          .withArgs(
            trader1.address,
            positionId,
            long1,
            true,
            toWei("1"), // size
            toWei("50000"), // tradingPrice
            [pool1.address, pool2.address, pool3.address], // backedPools
            [toWei("0.1803"), toWei("0"), toWei("0.8197")], // allocations
            [toWei("15.3792"), toWei("21.1652"), toWei("24.4556")], // newSizes
            [toWei("50000"), toWei("50000"), toWei("50000")], // newEntryPrices
            toWei("50"), // positionFeeUsd = 50000 * 1 * 0.1%
            toWei("0"), // borrowingFeeUsd
            [usdc.address, arb.address], // newCollateralTokens
            [toWei("26950"), toWei("30000")] // newCollateralAmounts 27000 - 50, 30000
          )
      })

      it("borrowing fees are different, pool3 uses marketPrice, pool1+2 uses entryPrice", async () => {
        await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
        await core.setMockPrice(a2b(btc.address), toWei("60000"))
        await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
        await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
        await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
        // fr1 0.10 + exp( 10 * 15.1989 * 50000 * 0.80 / 999900 - 7)           = 0.498586004604546543
        // fr2 0.10 + exp(  6 * 21.1652 * 50000 * 0.80 / 999900 - 6)           = 0.498581221122844065
        // fr2 0.10 + exp(2.2 * 23.6359 * 60000 * 0.80 / (19.998 * 60000) - 3) = 0.498585685703980363
        // acc1 0.498586004604546543 * 7 / 365 = 0.009561923375977604
        // acc2 0.498581221122844065 * 7 / 365 = 0.009561831637972351
        // acc2 0.498585685703980363 * 7 / 365 = 0.009561917260076335
        // borrowing 60000 * 15.1989 * 0.009561923375977604 + 60000 * 21.1652 * 0.009561831637972351 + 60000 * 23.6359 * 0.009561917260076335 = 34422.798981035799314838
        await expect(
          orderBook.connect(trader1).updateBorrowingFee(positionId, long1, usdc.address, false)
        ).to.be.revertedWith("AccessControl")
        const tx = await orderBook.connect(broker).updateBorrowingFee(positionId, long1, usdc.address, false)
        // {
        //   for (const i of (await (await tx).wait()).events!) {
        //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
        //       console.log(emitter.interface.parseLog(i))
        //     }
        //   }
        // }
        await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
          pool1.address,
          long1,
          toWei("0.498586004604546543"), // apy
          toWei("0.009561923375977604") // acc
        )
        await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
          pool2.address,
          long1,
          toWei("0.498581221122844065"), // apy
          toWei("0.009561831637972351") // acc
        )
        await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
          pool3.address,
          long1,
          toWei("0.498585685703980363"), // apy
          toWei("0.009561917260076335") // acc
        )
        await expect(tx)
          .to.emit(core, "UpdatePositionBorrowingFee")
          .withArgs(trader1.address, positionId, long1, toWei("34422.798981035799314838"))
        await expect(tx).to.emit(core, "CollectFee").withArgs(arb.address, toWei("17211.399490517899657419"))
        {
          const collaterals = await core.listAccountCollaterals(positionId)
          expect(collaterals[0].collateralAddress).to.equal(usdc.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("27000")) // unchanged
          expect(collaterals[1].collateralAddress).to.equal(arb.address)
          expect(collaterals[1].collateralAmount).to.equal(toWei("12788.600509482100342581")) // 30000 - 17211.399490517899657419
          const positions = await core.listAccountPositions(positionId)
          expect(positions[0].marketId).to.equal(long1)
          expect(positions[0].pools[0].size).to.equal(toWei("15.1989"))
          expect(positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
          expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0.009561923375977604"))
          expect(positions[0].pools[1].size).to.equal(toWei("21.1652"))
          expect(positions[0].pools[1].entryPrice).to.equal(toWei("50000"))
          expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0.009561831637972351"))
          expect(positions[0].pools[2].size).to.equal(toWei("23.6359"))
          expect(positions[0].pools[2].entryPrice).to.equal(toWei("50000"))
          expect(positions[0].pools[2].entryBorrowing).to.equal(toWei("0.009561917260076335"))
          expect(positions[0].realizedBorrowingUsd).to.equal(toWei("34422.798981035799314838")) // accumulate until fully closed
          const activated = await core.listActivePositionIds(0, 10)
          expect(activated.totalLength).to.equal(1)
          expect(activated.positionIds[0]).to.equal(positionId)
        }
      })

      it("remove liquidity (btc) + reallocate2, lp pays position fees", async () => {
        expect(await btc.balanceOf(feeDistributor.address)).to.equal(toUnit("0.002", 8))
        expect(await pool3.balanceOf(lp1.address)).to.equal(toWei("999900"))
        {
          const state = await pool3.marketState(long1)
          expect(state.isLong).to.equal(true)
          expect(state.totalSize).to.equal(toWei("23.6359"))
          expect(state.averageEntryPrice).to.equal(toWei("50000"))
          expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
        }
        {
          await core.setMockPrice(a2b(btc.address), toWei("60000"))
          await usdcFeeder.setMockData(toUnit("1", 8), await time.latest())
          await arbFeeder.setMockData(toUnit("2", 8), await time.latest())
          await btcFeeder.setMockData(toUnit("60000", 8), await time.latest())
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("847911")) // 999900 - (60000 - 50000) * 15.1989
          expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("788248")) // 999900 - (60000 - 50000) * 21.1652
          expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("963521")) // 19.998 * 60000 - (60000 - 50000) 23.6359
        }
        await pool3.connect(lp1).transfer(orderBook.address, toWei("400000"))
        {
          const args = {
            poolAddress: pool3.address,
            token: btc.address,
            rawAmount: toWei("400000"),
            isAdding: false,
            isUnwrapWeth: false,
          }
          await orderBook.connect(lp1).placeLiquidityOrder(args)
          expect(await pool3.balanceOf(lp1.address)).to.equal(toWei("599900")) // 999900 - 400000
        }
        {
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
          // fr1 0.10 + exp( 10 * 15.1989 * 50000 * 0.80 / 999900 - 7)           = 0.498586004604546543
          // fr2 0.10 + exp(  6 * 21.1652 * 50000 * 0.80 / 999900 - 6)           = 0.498581221122844065
          // fr2 0.10 + exp(2.2 * 23.6359 * 60000 * 0.80 / (19.998 * 60000) - 3) = 0.498585685703980363
          // acc1 0.498586004604546543 * 7 / 365 = 0.009561923375977604
          // acc2 0.498581221122844065 * 7 / 365 = 0.009561831637972351
          // acc2 0.498585685703980363 * 7 / 365 = 0.009561917260076335
          // borrowing 60000 * 15.1989 * 0.009561923375977604 + 60000 * 21.1652 * 0.009561831637972351 + 60000 * 23.6359 * 0.009561917260076335 = 34422.798981035799314838
          // position fees = 60000 * (9 + 2) * 0.001 = 660 paid by lp
          // when reallocate, transfer upnl
          //   pool3 -> pool1, (60000 - 50000) * 9 = 90000
          //   pool3 -> pool2, (60000 - 50000) * 2 = 20000 = 19999.9998 (because of rounding)
          // after reallocate
          //   pool3
          //     aum = 19.998 * 60000 - 90000 - 19999.9998 - (60000 - 50000) (23.6359 - 9 - 2) = 963521.0002
          //     nav = 963521.0002 / 999900 = 0.963617361936193619
          const tx = await orderBook.connect(broker).fillLiquidityOrder(4, [
            {
              positionId,
              marketId: long1,
              fromPool: pool3.address,
              toPool: pool1.address,
              size: toWei("9"),
              lastConsumedToken: zeroAddress,
              isUnwrapWeth: false,
            },
            {
              positionId,
              marketId: long1,
              fromPool: pool3.address,
              toPool: pool2.address,
              size: toWei("2"),
              lastConsumedToken: zeroAddress,
              isUnwrapWeth: false,
            },
          ])
          // {
          //   for (const i of (await (await tx).wait()).events!) {
          //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
          //       console.log(emitter.interface.parseLog(i))
          //     }
          //   }
          // }
          await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
            pool1.address,
            long1,
            toWei("0.498586004604546543"), // apy
            toWei("0.009561923375977604") // acc
          )
          await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
            pool2.address,
            long1,
            toWei("0.498581221122844065"), // apy
            toWei("0.009561831637972351") // acc
          )
          await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
            pool3.address,
            long1,
            toWei("0.498585685703980363"), // apy
            toWei("0.009561917260076335") // acc
          )
          // {
          //   for (const i of (await (await tx).wait()).events!) {
          //     if (i.topics[0] === "0xb48bd90f58452fe73356197cb2b955341ef4f2dd57d8bda856d9805977bc5594") {
          //       console.log(core.interface.parseLog(i))
          //     }
          //   }
          // }
          await expect(tx)
            .to.emit(core, "ReallocatePosition")
            .withArgs(
              trader1.address,
              positionId,
              long1,
              true, // isLong
              pool3.address,
              pool1.address,
              toWei("9"), // size
              toWei("60000"), // tradingPrice
              toWei("50000"), // fromPoolOldEntryPrice
              [pool1.address, pool2.address, pool3.address], // backedPools
              // 15.1989 + 9, 21.1652, 23.6359 - 9
              [toWei("24.1989"), toWei("21.1652"), toWei("14.6359")], // newSizes
              [toWei("50000"), toWei("50000"), toWei("50000")], // newEntryPrices
              [toWei("0"), toWei("0"), toWei("90000")], // mem.poolPnlUsds
              toWei("34422.798981035799314838"), // borrowingFeeUsd
              // 27000 usdc => 0 - 34422.798981035799314838
              // 30000 arb - (34422.798981035799314838 - 27000) / 2
              [arb.address], // newCollateralTokens
              [toWei("26288.600509482100342581")] // newCollateralAmounts
            )
          await expect(tx)
            .to.emit(core, "ReallocatePosition")
            .withArgs(
              trader1.address,
              positionId,
              long1,
              true, // isLong
              pool3.address,
              pool2.address,
              toWei("2"), // size
              toWei("60000"), // tradingPrice
              toWei("50000"), // fromPoolOldEntryPrice
              [pool1.address, pool2.address, pool3.address], // backedPools
              // 24.1989, 21.1652 + 2, 14.6359 - 2
              [toWei("24.1989"), toWei("23.1652"), toWei("12.6359")], // newSizes
              [toWei("50000"), toWei("50000"), toWei("50000")], // newEntryPrices
              [toWei("0"), toWei("0"), toWei("19999.9998")], // mem.poolPnlUsds
              toWei("0"), // borrowingFeeUsd
              [arb.address], // newCollateralTokens
              [toWei("26288.600509482100342581")] // unchanged
            )
          await expect(tx).to.emit(emitter, "RemoveLiquidity").withArgs(
            pool3.address,
            lp1.address,
            btc.address,
            toWei("60000"), // collateralPrice
            toWei("0.011642411574624129"), // liquidityFeeCollateral + extraFeeCollateral = (400000 * 0.963617361936193619 * 0.0001 + 660) / 60000
            toWei("0.963617361936193619"), // lpPrice
            toWei("400000") // shares
          )
        }
        // when removeLiquidity
        //   pool3 liquidity decreases = 400000 * 0.963617361936193619 / 60000 = 6.424115746241290793, including output collateral + liquidityFee + extraFee
        //   liquidityFee = 6.424115746241290793 * 0.0001 = 0.000642411574624129
        //   extraFee = positionFee = 60000 * (9 + 2) * 0.001 / 60000 = 0.011
        //   pool1 + pool2 got (90000 + 19999.9998) / 60000
        //   lp got 6.424115746241290793 - liquidityFee - extraFee = 6.424115746241290793 - 0.000642411574624129 - 0.011 = 6.412473334666666664
        {
          const [poolTokens, poolBalances] = await pool1.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
          expect(poolTokens[2]).to.equal(btc.address)
          expect(poolBalances[2]).to.equal(toWei("1.5")) // got pnl = (60000 - 50000) * 9 / 60000
          await assertPoolBalances(pool1)
        }
        {
          const [poolTokens, poolBalances] = await pool2.liquidityBalances()
          expect(poolTokens[0]).to.equal(usdc.address)
          expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
          expect(poolTokens[2]).to.equal(btc.address)
          expect(poolBalances[2]).to.equal(toWei("0.33333333")) // got pnl = (60000 - 50000) * 2 / 60000
          await assertPoolBalances(pool2)
        }
        {
          const [poolTokens, poolBalances] = await pool3.liquidityBalances()
          expect(poolTokens[2]).to.equal(btc.address)
          expect(poolBalances[2]).to.equal(toWei("11.740550923758709207")) // collateral - pnl - liquidityFee = 19.998 - (1.5 + 0.33333333) - 6.424115746241290793
          await assertPoolBalances(pool3)
        }
        {
          expect(await btc.balanceOf(lp1.address)).to.equal(toUnit("999986.41247333", 8)) // 999980 + 6.412473334666666664
          expect(await btc.balanceOf(pool1.address)).to.equal(toUnit("1.5", 8)) // at least liquidityBalances
          expect(await btc.balanceOf(pool2.address)).to.equal(toUnit("0.33333333", 8)) // at least liquidityBalances
          expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("11.74055093", 8)) // at least liquidityBalances
          expect(await btc.balanceOf(feeDistributor.address)).to.equal(toUnit("0.01364241", 8)) // 0.002 + 0.011 + 0.000642411574624129
        }
        {
          expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("847911")) // 999900 + 1.5 * 60000 - (60000 - 50000) * 24.1989
          expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("788247.9998")) // 999900 + 0.33333333 * 60000 - (60000 - 50000) * 23.1652
          expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("578074.05542552255242")) // 11.740550923758709207 * 60000 - (60000 - 50000) * 12.6359
        }
      })

      describe("cross margin, open at market2", () => {
        let short2 = toBytes32("ShortArb")

        beforeEach(async () => {
          // market
          await core.createMarket(
            short2,
            "Short2",
            false, // isLong
            [pool1.address, pool2.address]
          )
          await core.setMarketConfig(short2, ethers.utils.id("MM_POSITION_FEE_RATE"), u2b(toWei("0.001")))
          await core.setMarketConfig(short2, ethers.utils.id("MM_LIQUIDATION_FEE_RATE"), u2b(toWei("0.002")))
          await core.setMarketConfig(short2, ethers.utils.id("MM_INITIAL_MARGIN_RATE"), u2b(toWei("0.006")))
          await core.setMarketConfig(short2, ethers.utils.id("MM_MAINTENANCE_MARGIN_RATE"), u2b(toWei("0.005")))
          await core.setMarketConfig(short2, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.1")))
          await core.setMarketConfig(short2, ethers.utils.id("MM_ORACLE_ID"), a2b(arb.address))
          await core.setMarketConfig(short2, ethers.utils.id("MM_OPEN_INTEREST_CAP_USD"), u2b(toWei("100000000")))
          await core.setPoolConfig(
            pool1.address,
            encodePoolMarketKey("MCP_ADL_RESERVE_RATE", short2),
            u2b(toWei("0.80"))
          )
          await core.setPoolConfig(
            pool1.address,
            encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", short2),
            u2b(toWei("0.75"))
          )
          await core.setPoolConfig(
            pool1.address,
            encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", short2),
            u2b(toWei("0.70"))
          )
          await core.setPoolConfig(
            pool2.address,
            encodePoolMarketKey("MCP_ADL_RESERVE_RATE", short2),
            u2b(toWei("0.80"))
          )
          await core.setPoolConfig(
            pool2.address,
            encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", short2),
            u2b(toWei("0.75"))
          )
          await core.setPoolConfig(
            pool2.address,
            encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", short2),
            u2b(toWei("0.70"))
          )
          await core.setPoolConfig(
            pool3.address,
            encodePoolMarketKey("MCP_ADL_RESERVE_RATE", short2),
            u2b(toWei("0.80"))
          )
          await core.setPoolConfig(
            pool3.address,
            encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", short2),
            u2b(toWei("0.75"))
          )
          await core.setPoolConfig(
            pool3.address,
            encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", short2),
            u2b(toWei("0.70"))
          )
          await core.setMockPrice(a2b(usdc.address), toWei("1"))
          await core.setMockPrice(a2b(arb.address), toWei("2"))
          await core.setMockPrice(a2b(btc.address), toWei("60000"))
          await usdcFeeder.setMockData(toUnit("1", 8), timestampOfTest + 86400 * 2)
          await arbFeeder.setMockData(toUnit("2", 8), timestampOfTest + 86400 * 2)
          await btcFeeder.setMockData(toUnit("60000", 8), timestampOfTest + 86400 * 2)
          // open
          await orderBook.connect(trader1).setInitialLeverage(positionId, short2, toWei("100"))
          {
            const args = {
              positionId,
              marketId: short2,
              size: toWei("70000"),
              flags: PositionOrderFlags.OpenPosition,
              limitPrice: toWei("2"),
              expiration: timestampOfTest + 86400 * 2 + 930 + 300,
              lastConsumedToken: zeroAddress,
              collateralToken: zeroAddress,
              collateralAmount: toUnit("0", 6),
              withdrawUsd: toWei("0"),
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
              tpPriceDiff: toWei("0"),
              slPriceDiff: toWei("0"),
              tpslExpiration: 0,
              tpslFlags: 0,
              tpslWithdrawSwapToken: zeroAddress,
              tpslWithdrawSwapSlippage: toWei("0"),
            }
            await orderBook.connect(trader1).placePositionOrder(args, refCode)
          }
          {
            const [poolTokens, poolBalances] = await pool1.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
            await assertPoolBalances(pool1)
          }
          {
            const [poolTokens, poolBalances] = await pool2.liquidityBalances()
            expect(poolTokens[0]).to.equal(usdc.address)
            expect(poolBalances[0]).to.equal(toWei("999900")) // unchanged
            await assertPoolBalances(pool2)
          }
          {
            const [poolTokens, poolBalances] = await pool3.liquidityBalances()
            expect(poolTokens[2]).to.equal(btc.address)
            expect(poolBalances[2]).to.equal(toWei("19.998")) // unchanged
            await assertPoolBalances(pool3)
          }
          {
            // fee = 2 * 70000 * 0.1% = 140
            await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30 + 30)
            await orderBook.connect(broker).fillPositionOrder(4)
            expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("70000", 6)) // unchanged
            expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("3340", 6)) // 3200 + 140
            expect(await usdc.balanceOf(core.address)).to.equal(toUnit("26860", 6)) // 27000 - 140
            expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
            expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("70000", 18)) // unchanged
            expect(await arb.balanceOf(core.address)).to.equal(toUnit("30000", 18)) // unchanged
            {
              const state = await pool1.marketState(short2)
              expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
            }
            {
              const state = await pool1.marketState(short2)
              expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
            }
            {
              const collaterals = await core.listAccountCollaterals(positionId)
              expect(collaterals[0].collateralAddress).to.equal(usdc.address)
              expect(collaterals[0].collateralAmount).to.equal(toWei("26860")) // 27000 - 140
              expect(collaterals[1].collateralAddress).to.equal(arb.address)
              expect(collaterals[1].collateralAmount).to.equal(toWei("30000")) // unchanged
              const positions = await core.listAccountPositions(positionId)
              expect(positions[0].marketId).to.equal(long1)
              expect(positions[0].pools[0].size).to.equal(toWei("15.1989")) // unchanged
              expect(positions[0].pools[0].entryPrice).to.equal(toWei("50000"))
              expect(positions[0].pools[0].entryBorrowing).to.equal(toWei("0"))
              expect(positions[0].pools[1].size).to.equal(toWei("21.1652")) // unchanged
              expect(positions[0].pools[1].entryPrice).to.equal(toWei("50000"))
              expect(positions[0].pools[1].entryBorrowing).to.equal(toWei("0"))
              expect(positions[0].pools[2].size).to.equal(toWei("23.6359")) // unchanged
              expect(positions[0].pools[2].entryPrice).to.equal(toWei("50000"))
              expect(positions[0].pools[2].entryBorrowing).to.equal(toWei("0"))
              expect(positions[0].realizedBorrowingUsd).to.equal(toWei("0"))
              expect(positions[1].pools[0].size).to.equal(toWei("26249.5"))
              expect(positions[1].pools[0].entryPrice).to.equal(toWei("2"))
              expect(positions[1].pools[0].entryBorrowing).to.equal(toWei("0"))
              expect(positions[1].pools[1].size).to.equal(toWei("43750.5"))
              expect(positions[1].pools[1].entryPrice).to.equal(toWei("2"))
              expect(positions[1].pools[1].entryBorrowing).to.equal(toWei("0"))
              expect(positions[1].realizedBorrowingUsd).to.equal(toWei("0"))
              const activated = await core.listActivePositionIds(0, 10)
              expect(activated.totalLength).to.equal(1)
              expect(activated.positionIds[0]).to.equal(positionId)
            }
            {
              const state = await pool1.marketState(short2)
              expect(state.isLong).to.equal(false)
              expect(state.totalSize).to.equal(toWei("26249.5"))
              expect(state.averageEntryPrice).to.equal(toWei("2"))
              expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
            }
            {
              const state = await pool2.marketState(short2)
              expect(state.isLong).to.equal(false)
              expect(state.totalSize).to.equal(toWei("43750.5"))
              expect(state.averageEntryPrice).to.equal(toWei("2"))
              expect(state.cumulatedBorrowingPerUsd).to.equal(toWei("0"))
            }
            {
              expect(await pool1.callStatic.getAumUsd()).to.equal(toWei("847911")) // 999900 - (60000 - 50000) * 15.1989
              expect(await pool2.callStatic.getAumUsd()).to.equal(toWei("788248")) // 999900 - (60000 - 50000) * 21.1652
              expect(await pool3.callStatic.getAumUsd()).to.equal(toWei("963521")) // 19.998 * 60000 - (60000 - 50000) * 23.6359
            }
          }
        }) // beforeEach

        it("liquidate cross margin. 0 < fee < margin < MM. arb loss, btc profit", async () => {
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 86400 * 7)
          // fr1 0.10 + exp( 10 * (15.1989 * 50000 + 26249.5 * 2) * 0.80 / 999900 - 7) = 0.706653203536787298
          // fr2 0.10 + exp(  6 * (21.1652 * 50000 + 43750.5 * 2) * 0.80 / 999900 - 6) = 0.706653688908081406
          // fr2 0.10 + exp(2.2 * (23.6359 * 60000) * 0.80 / (19.998 * 60000) - 3)     = 0.498585685703980362
          // acc1 0.706653203536787298 * 7 / 365 = 0.013552253218513729
          // acc2 0.706653688908081406 * 7 / 365 = 0.013552262527004300
          // acc2 0.498585685703980362 * 7 / 365 = 0.009561917260076335
          // Solve[26860 + 30000 * x
          //   - (60000 * 15.1989 + x * 26249.5) * 0.013552253218513729
          //   - (60000 * 21.1652 + x * 43750.5) * 0.013552262527004300
          //   - (60000 * 23.6359) * 0.009561917260076335
          //   + (60000 - 50000) * 60
          //   + (2 - x) * 70000
          // == (60000 * 60 + x * 70000) * 0.005]
          // x = 17.0885
          await core.setMockPrice(a2b(btc.address), toWei("60000"))
          await core.setMockPrice(a2b(arb.address), toWei("17.1"))
          // borrowing (60000 * 15.1989) * 0.013552253218513729
          //         + (60000 * 21.1652) * 0.013552262527004300
          //         + (60000 * 23.6359) * 0.009561917260076335
          //         = 43129.212506811478349076
          // borrowing (17.1 * 26249.5) * 0.013552253218513729
          //         + (17.1 * 43750.5) * 0.013552262527004300
          //         = 16222.05406655502963675705
          // position fee = 60000 * 60 * 0.002 = 7200
          // position fee = 17.1 * 70000 * 0.002 = 2394
          const tx = await orderBook.connect(broker).liquidate(positionId, usdc.address, false, false)
          {
            // {
            //   for (const i of (await (await tx).wait()).events!) {
            //     if (i.topics[0] === "0xd96b06dba5730e68d159471f627b117be995386df87ebe38f94d51fe476d5985") {
            //       console.log(emitter.interface.parseLog(i))
            //     }
            //   }
            // }
            for (const market of [long1, short2]) {
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool1.address,
                market,
                toWei("0.706653203536787300"), // apy
                toWei("0.013552253218513729") // acc
              )
              await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                pool2.address,
                market,
                toWei("0.706653688908081407"), // apy
                toWei("0.013552262527004300") // acc
              )
              if (market !== short2) {
                await expect(tx).to.emit(emitter, "UpdateMarketBorrowing").withArgs(
                  pool3.address,
                  market,
                  toWei("0.498585685703980363"), // apy
                  toWei("0.009561917260076335") // acc
                )
              }
            }
          }
          // 1. realize profit
          //    * 26860 + (60000 - 50000) * 15.1989 + (60000 - 50000) * 21.1652 = 390501
          //    * 30000 unchanged
          //    * 0 + (60000 - 50000) * 23.6359 / 60000 = 3.93931666
          // 2. realize loss
          //    loss = (2 - 17.1) * 70000 = -1057000
          //    * 390501 - (1057000 - 513000 - 236358.9996) = 82859.9996
          //    * 30000 - 30000 = 0 (realize 30000 * 17.1 = 513000)
          //    * 3.93931666 - 3.93931666 = 0 (realize 3.93931666 * 60000 = 236358.9996)
          // 3. fees
          {
            // {
            //   for (const i of (await (await tx).wait()).events!) {
            //     if (i.topics[0] === "0xdd2546302785fbbbf22bc752c8fe0466231a7b7995c6ca744d6c07a8b5299b7d") {
            //       console.log(core.interface.parseLog(i))
            //     }
            //   }
            // }
            await expect(tx)
              .to.emit(core, "LiquidatePosition")
              .withArgs(
                trader1.address,
                positionId,
                long1,
                true,
                toWei("60"), // size
                toWei("60000"), // tradingPrice
                [pool1.address, pool2.address, pool3.address],
                [toWei("15.1989"), toWei("21.1652"), toWei("23.6359")], // allocations
                [toWei("151989"), toWei("211652"), toWei("236358.9996")], // poolPnlUsds
                toWei("7200"), // positionFeeUsd = 60000 * 60 * 0.002
                toWei("43129.212506811478349076"), // borrowingFeeUsd
                [usdc.address],
                [toWei("32530.787093188521650920")] // 82859.9996 - 7200 - 43129.212506811478349076
              )
            await expect(tx)
              .to.emit(core, "LiquidatePosition")
              .withArgs(
                trader1.address,
                positionId,
                short2,
                false,
                toWei("70000"), // size
                toWei("17.1"), // tradingPrice
                [pool1.address, pool2.address],
                [toWei("26249.5"), toWei("43750.5")], // allocations
                [toWei("-396367.45"), toWei("-660632.55")], // poolPnlUsds
                toWei("2394"), // positionFeeUsd = 17.1 * 70000 * 0.002
                toWei("16222.054066555029636757"), // borrowingFeeUsd
                [usdc.address],
                [toWei("13914.733026633492014163")] // 32530.787093188521650920 - 16222.054066555029636757 - 2394
              )
          }
        })

        it("pool collateral ETH, short ETH is forbidden", async () => {
          await expect(core.appendBackedPoolsToMarket(short2, [pool3.address])).to.be.revertedWith(
            "MarketTradeDisabled"
          )

          let short3 = toBytes32("ShortArb2")
          await expect(
            core.createMarket(
              short3,
              "Short3",
              false, // isLong
              [pool1.address, pool2.address, pool3.address]
            )
          ).to.be.revertedWith("MarketTradeDisabled")
        })
      }) // cross margin

      it("withdraw edge case 1: close position with loss, remaining collateral1 < 1e-6, withdraw all", async () => {
        // Solve[27000 + (x - 50000) * 60 - x * 60 * 0.001 == 0.00000099], x = 49599.599599616116116116
        // pnl = (49599.599599616116116116 - 50000) * 15.1989 = -6085.645645394612762764
        // pnl = (49599.599599616116116116 - 50000) * 21.1652 = -8474.554554204979179181
        // pnl = (49599.599599616116116116 - 50000) * 23.6359 = -9463.823823433441091093
        // fee = 49599.599599616116116116 * 60 * 0.001 = 2975.975975976966966966
        const args = {
          positionId,
          marketId: long1,
          size: toWei("60"),
          flags: PositionOrderFlags.WithdrawAllIfEmpty,
          limitPrice: toWei("40000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 30 + 30,
          lastConsumedToken: zeroAddress,
          collateralToken: zeroAddress,
          collateralAmount: toUnit("0", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await core.setMockPrice(a2b(btc.address), toWei("49599.599599616116116116"))
        {
          const tx = await orderBook.connect(broker).fillPositionOrder(4)
          await expect(tx)
            .to.emit(core, "ClosePosition")
            .withArgs(
              trader1.address,
              positionId,
              long1,
              true, // isLong
              toWei("60"), // size
              toWei("49599.599599616116116116"), // tradingPrice
              [pool1.address, pool2.address, pool3.address], // backedPools
              [toWei("15.1989"), toWei("21.1652"), toWei("23.6359")], // allocations
              [toWei("0"), toWei("0"), toWei("0")], // newSizes
              [toWei("0"), toWei("0"), toWei("0")], // newEntryPrices
              [toWei("-6085.645645394612762764"), toWei("-8474.554554204979179181"), toWei("-9463.823823433441091093")], // poolPnlUsds
              toWei("2975.975975976966966966"), // positionFeeUsd
              toWei("0"), // borrowingFeeUsd
              [usdc.address, arb.address],
              [
                toWei("0.000000989999999996"), // collateral + pnl - fee = 27000 - 6085.645645394612762764 - 8474.554554204979179181 - 9463.823823433441091093 - 2975.975975976966966966
                toWei("30000"), // unchanged
              ]
            )
        }
        expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("70000", 6)) // 70000 + 0
        expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("100000", 18)) // 70000 + 30000
      })

      it("withdraw edge case 2: close position with loss, remaining collateral1 < 1e-6, withdraw usd", async () => {
        // Solve[27000 + (x - 50000) * 60 - x * 60 * 0.001 == 0.00000099], x = 49599.599599616116116116
        // pnl = (49599.599599616116116116 - 50000) * 15.1989 = -6085.645645394612762764
        // pnl = (49599.599599616116116116 - 50000) * 21.1652 = -8474.554554204979179181
        // pnl = (49599.599599616116116116 - 50000) * 23.6359 = -9463.823823433441091093
        // fee = 49599.599599616116116116 * 60 * 0.001 = 2975.975975976966966966
        const args = {
          positionId,
          marketId: long1,
          size: toWei("60"),
          flags: 0, // different here
          limitPrice: toWei("40000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 30 + 30,
          lastConsumedToken: zeroAddress,
          collateralToken: zeroAddress,
          collateralAmount: toUnit("0", 6),
          withdrawUsd: toWei("1"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await core.setMockPrice(a2b(btc.address), toWei("49599.599599616116116116"))
        {
          const tx = await orderBook.connect(broker).fillPositionOrder(4)
          await expect(tx)
            .to.emit(core, "ClosePosition")
            .withArgs(
              trader1.address,
              positionId,
              long1,
              true, // isLong
              toWei("60"), // size
              toWei("49599.599599616116116116"), // tradingPrice
              [pool1.address, pool2.address, pool3.address], // backedPools
              [toWei("15.1989"), toWei("21.1652"), toWei("23.6359")], // allocations
              [toWei("0"), toWei("0"), toWei("0")], // newSizes
              [toWei("0"), toWei("0"), toWei("0")], // newEntryPrices
              [toWei("-6085.645645394612762764"), toWei("-8474.554554204979179181"), toWei("-9463.823823433441091093")], // poolPnlUsds
              toWei("2975.975975976966966966"), // positionFeeUsd
              toWei("0"), // borrowingFeeUsd
              [usdc.address, arb.address],
              [
                toWei("0.000000989999999996"), // collateral + pnl - fee = 27000 - 6085.645645394612762764 - 8474.554554204979179181 - 9463.823823433441091093 - 2975.975975976966966966
                toWei("30000"), // unchanged
              ]
            )
        }
        expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("70000", 6)) // 70000 + 0
        expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("70000.499999505000000002", 18)) // 70000 + (1 - 0.000000989999999996) / 2
      })

      it("withdraw edge case 3: close position with loss, remaining collateral2 < 1e-17, withdraw usd", async () => {
        await core.setMarketConfig(long1, ethers.utils.id("MM_POSITION_FEE_RATE"), u2b(toWei("0")))
        // deposit 1e-18 arb
        {
          await arb.mint(orderBook.address, toWei("0.000000000000000001"))
          await orderBook.connect(trader1).depositCollateral(positionId, arb.address, toWei("0.000000000000000001"))
          const collaterals = await core.listAccountCollaterals(positionId)
          expect(collaterals[0].collateralAddress).to.equal(usdc.address)
          expect(collaterals[0].collateralAmount).to.equal(toWei("27000"))
          expect(collaterals[1].collateralAddress).to.equal(arb.address)
          expect(collaterals[1].collateralAmount).to.equal(toWei("30000.000000000000000001"))
        }
        await core.setMockPrice(a2b(arb.address), toWei("0.01"))
        // Solve[30000.000000000000000001 + ((x - 50000) * 60) / 0.01 == 0.000000000000000001], x = 49995
        // pnl = (49995 - 50000) * 15.1989 = -75.9945
        // pnl = (49995 - 50000) * 21.1652 = -105.826
        // pnl = (49995 - 50000) * 23.6359 = -118.1795
        // fee = 0
        await core.setMockPrice(a2b(btc.address), toWei("49995"))
        const args = {
          positionId,
          marketId: long1,
          size: toWei("60"),
          flags: 0, // different here
          limitPrice: toWei("40000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 30 + 30,
          lastConsumedToken: usdc.address, // different here
          collateralToken: zeroAddress,
          collateralAmount: toUnit("0", 6),
          withdrawUsd: toWei("1"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        {
          const tx = await orderBook.connect(broker).fillPositionOrder(4)
          await expect(tx)
            .to.emit(core, "ClosePosition")
            .withArgs(
              trader1.address,
              positionId,
              long1,
              true, // isLong
              toWei("60"), // size
              toWei("49995"), // tradingPrice
              [pool1.address, pool2.address, pool3.address], // backedPools
              [toWei("15.1989"), toWei("21.1652"), toWei("23.6359")], // allocations
              [toWei("0"), toWei("0"), toWei("0")], // newSizes
              [toWei("0"), toWei("0"), toWei("0")], // newEntryPrices
              [toWei("-75.9945"), toWei("-105.826"), toWei("-118.1795")], // poolPnlUsds
              toWei("0"), // positionFeeUsd
              toWei("0"), // borrowingFeeUsd
              [usdc.address, arb.address],
              [
                toWei("27000"), // unchanged
                toWei("0.000000000000000001"),
              ]
            )
        }
        expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("70001", 6))
        expect(await arb.balanceOf(trader1.address)).to.equal(toUnit("70000", 18)) // unchanged
      })
    }) // 2 collaterals, open long, allocated to 3 pools

    it("isolated mode, you can only open single market position", async () => {
      const positionId = encodePositionId(trader1.address, 1)
      await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("100"))
      await usdc.connect(trader1).transfer(orderBook.address, toUnit("1000", 6))
      {
        const args = {
          positionId,
          marketId: long1,
          size: toWei("0.01"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("1000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await orderBook.connect(broker).fillPositionOrder(3)
      }
      {
        const args = {
          positionId,
          marketId: short1,
          size: toWei("0.01"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: zeroAddress,
          collateralToken: usdc.address,
          collateralAmount: toUnit("0", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0"),
          slPriceDiff: toWei("0"),
          tpslExpiration: 0,
          tpslFlags: 0,
          tpslWithdrawSwapToken: zeroAddress,
          tpslWithdrawSwapSlippage: toWei("0"),
        }
        await orderBook.connect(trader1).placePositionOrder(args, refCode)
        await expect(orderBook.connect(broker).fillPositionOrder(4)).to.be.revertedWith(
          "OnlySingleMarketPositionAllowed"
        )
      }
    })

    describe("tp/sl strategy - open long", () => {
      let positionId: string

      beforeEach(async () => {
        // open long btc, using usdc
        positionId = encodePositionId(trader1.address, 0)
        await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("100"))
        await usdc.connect(trader1).transfer(orderBook.address, toUnit("10000", 6))
        const args = {
          positionId,
          marketId: long1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: usdc.address,
          collateralToken: usdc.address,
          collateralAmount: toUnit("10000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0.01"),
          slPriceDiff: toWei("0.01"),
          tpslExpiration: timestampOfTest + 86400 * 2 + 930 + 300 + 300,
          tpslFlags: PositionOrderFlags.WithdrawProfit + PositionOrderFlags.WithdrawAllIfEmpty,
          tpslWithdrawSwapToken: btc.address,
          tpslWithdrawSwapSlippage: toWei("0.01"),
        }
        {
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // - 10000
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("200", 6)) // unchanged
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0", 6)) // unchanged
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
        }
        {
          // fee = 50000 * 1 * 0.1% = 50
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30)
          await orderBook.connect(broker).fillPositionOrder(3)
        }
        {
          const orderIds = await orderBook.getTpslOrders(positionId, long1)
          expect(orderIds.length).to.equal(2)
          expect(orderIds[0]).to.equal(4)
          expect(orderIds[1]).to.equal(5)
        }
        {
          const [orders, totalCount] = await orderBook.getOrders(0, 100)
          expect(totalCount).to.equal(2)
          expect(orders[0].id).to.equal(4)
          expect(orders[1].id).to.equal(5)
          const order1 = parsePositionOrder(orders[0].payload)
          expect(order1.positionId).to.equal(positionId)
          expect(order1.marketId).to.equal(long1)
          expect(order1.size).to.equal(toWei("1"))
          expect(order1.flags).to.equal(PositionOrderFlags.WithdrawProfit + PositionOrderFlags.WithdrawAllIfEmpty)
          expect(order1.limitPrice).to.equal(toWei("50500")) // 50000 * 1.01
          expect(order1.expiration).to.equal(timestampOfTest + 86400 * 2 + 930 + 300 + 300)
          expect(order1.lastConsumedToken).to.equal(usdc.address)
          expect(order1.collateralToken).to.equal(zeroAddress)
          expect(order1.collateralAmount).to.equal(toUnit("0", 6))
          expect(order1.withdrawUsd).to.equal(toWei("0"))
          expect(order1.withdrawSwapToken).to.equal(btc.address)
          expect(order1.withdrawSwapSlippage).to.equal(toWei("0.01"))
          expect(order1.tpPriceDiff).to.equal(toWei("0"))
          expect(order1.slPriceDiff).to.equal(toWei("0"))
          expect(order1.tpslExpiration).to.equal(0)
          expect(order1.tpslFlags).to.equal(0)
          expect(order1.tpslWithdrawSwapToken).to.equal(zeroAddress)
          expect(order1.tpslWithdrawSwapSlippage).to.equal(toWei("0"))
          const order2 = parsePositionOrder(orders[1].payload)
          expect(order2.positionId).to.equal(positionId)
          expect(order2.marketId).to.equal(long1)
          expect(order2.size).to.equal(toWei("1"))
          expect(order2.flags).to.equal(
            PositionOrderFlags.WithdrawProfit + PositionOrderFlags.WithdrawAllIfEmpty + PositionOrderFlags.TriggerOrder
          )
          expect(order2.limitPrice).to.equal(toWei("49500")) // 50000 * 0.99
          expect(order2.expiration).to.equal(timestampOfTest + 86400 * 2 + 930 + 300 + 300)
          expect(order2.lastConsumedToken).to.equal(usdc.address)
          expect(order2.collateralToken).to.equal(zeroAddress)
          expect(order2.collateralAmount).to.equal(toUnit("0", 6))
          expect(order2.withdrawUsd).to.equal(toWei("0"))
          expect(order2.withdrawSwapToken).to.equal(btc.address)
          expect(order2.withdrawSwapSlippage).to.equal(toWei("0.01"))
          expect(order2.tpPriceDiff).to.equal(toWei("0"))
          expect(order2.slPriceDiff).to.equal(toWei("0"))
          expect(order2.tpslExpiration).to.equal(0)
          expect(order2.tpslFlags).to.equal(0)
          expect(order2.tpslWithdrawSwapToken).to.equal(zeroAddress)
          expect(order2.tpslWithdrawSwapSlippage).to.equal(toWei("0"))
        }
      })

      describe("trigger close (loss). auto cancel another order", () => {
        beforeEach(async () => {
          await expect(orderBook.connect(broker).fillPositionOrder(5)).to.be.revertedWith("limitPrice")
          await core.setMockPrice(a2b(btc.address), toWei("49500"))
          await orderBook.connect(broker).fillPositionOrder(5)
          // auto cancel
          {
            const orderIds = await orderBook.getTpslOrders(positionId, long1)
            expect(orderIds.length).to.equal(0)
          }
          {
            const [_, totalCount] = await orderBook.getOrders(0, 100)
            expect(totalCount).to.equal(0)
          }
        })

        it("open again, close again", async () => {
          // open long btc, using usdc
          await core.setMockPrice(a2b(btc.address), toWei("49500"))
          await usdc.connect(trader1).transfer(orderBook.address, toUnit("10000", 6))
          const args = {
            positionId,
            marketId: long1,
            size: toWei("1"),
            flags: PositionOrderFlags.OpenPosition,
            limitPrice: toWei("49500"),
            expiration: timestampOfTest + 86400 * 2 + 930 + 300,
            lastConsumedToken: usdc.address,
            collateralToken: usdc.address,
            collateralAmount: toUnit("10000", 6),
            withdrawUsd: toWei("0"),
            withdrawSwapToken: zeroAddress,
            withdrawSwapSlippage: toWei("0"),
            tpPriceDiff: toWei("0.01"),
            slPriceDiff: toWei("0.01"),
            tpslExpiration: timestampOfTest + 86400 * 2 + 930 + 300 + 300,
            tpslFlags: PositionOrderFlags.WithdrawProfit + PositionOrderFlags.WithdrawAllIfEmpty,
            tpslWithdrawSwapToken: btc.address,
            tpslWithdrawSwapSlippage: toWei("0.01"),
          }
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
          await orderBook.connect(broker).fillPositionOrder(6)
          {
            const orderIds = await orderBook.getTpslOrders(positionId, long1)
            expect(orderIds.length).to.equal(2)
            expect(orderIds[0]).to.equal(7)
            expect(orderIds[1]).to.equal(8)
          }
          {
            const [orders, totalCount] = await orderBook.getOrders(0, 100)
            expect(totalCount).to.equal(2)
            expect(orders[0].id).to.equal(7)
            expect(orders[1].id).to.equal(8)
          }
          // fill, auto cancel
          await core.setMockPrice(a2b(btc.address), toWei("50000"))
          await orderBook.connect(broker).fillPositionOrder(7)
          {
            const orderIds = await orderBook.getTpslOrders(positionId, long1)
            expect(orderIds.length).to.equal(0)
          }
          {
            const [_, totalCount] = await orderBook.getOrders(0, 100)
            expect(totalCount).to.equal(0)
          }
        })
      })
    })

    describe("tp/sl strategy - open short", () => {
      let positionId: string
      beforeEach(async () => {
        // open short btc, using usdc
        positionId = encodePositionId(trader1.address, 0)
        await orderBook.connect(trader1).setInitialLeverage(positionId, short1, toWei("100"))
        await usdc.connect(trader1).transfer(orderBook.address, toUnit("10000", 6))
        const args = {
          positionId,
          marketId: short1,
          size: toWei("1"),
          flags: PositionOrderFlags.OpenPosition,
          limitPrice: toWei("50000"),
          expiration: timestampOfTest + 86400 * 2 + 930 + 300,
          lastConsumedToken: usdc.address,
          collateralToken: usdc.address,
          collateralAmount: toUnit("10000", 6),
          withdrawUsd: toWei("0"),
          withdrawSwapToken: zeroAddress,
          withdrawSwapSlippage: toWei("0"),
          tpPriceDiff: toWei("0.01"),
          slPriceDiff: toWei("0.01"),
          tpslExpiration: timestampOfTest + 86400 * 2 + 930 + 300 + 300,
          tpslFlags: PositionOrderFlags.WithdrawProfit + PositionOrderFlags.WithdrawAllIfEmpty,
          tpslWithdrawSwapToken: btc.address,
          tpslWithdrawSwapSlippage: toWei("0.01"),
        }
        {
          await orderBook.connect(trader1).placePositionOrder(args, refCode)
          expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("90000", 6)) // - 10000
          expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("200", 6)) // unchanged
          expect(await usdc.balanceOf(core.address)).to.equal(toUnit("0", 6)) // unchanged
          expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await usdc.balanceOf(pool2.address)).to.equal(toUnit("999900", 6)) // unchanged
          expect(await btc.balanceOf(pool3.address)).to.equal(toUnit("19.998", 8)) // unchanged
        }
        {
          // fee = 50000 * 1 * 0.1% = 50
          await time.increaseTo(timestampOfTest + 86400 * 2 + 930 + 30)
          await orderBook.connect(broker).fillPositionOrder(3)
        }
        {
          const orderIds = await orderBook.getTpslOrders(positionId, short1)
          expect(orderIds.length).to.equal(2)
          expect(orderIds[0]).to.equal(4)
          expect(orderIds[1]).to.equal(5)
        }
        {
          const [orders, totalCount] = await orderBook.getOrders(0, 100)
          expect(totalCount).to.equal(2)
          expect(orders[0].id).to.equal(4)
          expect(orders[1].id).to.equal(5)
          const order1 = parsePositionOrder(orders[0].payload)
          expect(order1.positionId).to.equal(positionId)
          expect(order1.marketId).to.equal(short1)
          expect(order1.size).to.equal(toWei("1"))
          expect(order1.flags).to.equal(PositionOrderFlags.WithdrawProfit + PositionOrderFlags.WithdrawAllIfEmpty)
          expect(order1.limitPrice).to.equal(toWei("49500")) // 50000 * 0.99
          expect(order1.expiration).to.equal(timestampOfTest + 86400 * 2 + 930 + 300 + 300)
          expect(order1.lastConsumedToken).to.equal(usdc.address)
          expect(order1.collateralToken).to.equal(zeroAddress)
          expect(order1.collateralAmount).to.equal(toUnit("0", 6))
          expect(order1.withdrawUsd).to.equal(toWei("0"))
          expect(order1.withdrawSwapToken).to.equal(btc.address)
          expect(order1.withdrawSwapSlippage).to.equal(toWei("0.01"))
          expect(order1.tpPriceDiff).to.equal(toWei("0"))
          expect(order1.slPriceDiff).to.equal(toWei("0"))
          expect(order1.tpslExpiration).to.equal(0)
          expect(order1.tpslFlags).to.equal(0)
          expect(order1.tpslWithdrawSwapToken).to.equal(zeroAddress)
          expect(order1.tpslWithdrawSwapSlippage).to.equal(toWei("0"))
          const order2 = parsePositionOrder(orders[1].payload)
          expect(order2.positionId).to.equal(positionId)
          expect(order2.marketId).to.equal(short1)
          expect(order2.size).to.equal(toWei("1"))
          expect(order2.flags).to.equal(
            PositionOrderFlags.WithdrawProfit + PositionOrderFlags.WithdrawAllIfEmpty + PositionOrderFlags.TriggerOrder
          )
          expect(order2.limitPrice).to.equal(toWei("50500")) // 50000 * 1.01
          expect(order2.expiration).to.equal(timestampOfTest + 86400 * 2 + 930 + 300 + 300)
          expect(order2.lastConsumedToken).to.equal(usdc.address)
          expect(order2.collateralToken).to.equal(zeroAddress)
          expect(order2.collateralAmount).to.equal(toUnit("0", 6))
          expect(order2.withdrawUsd).to.equal(toWei("0"))
          expect(order2.withdrawSwapToken).to.equal(btc.address)
          expect(order2.withdrawSwapSlippage).to.equal(toWei("0.01"))
          expect(order2.tpPriceDiff).to.equal(toWei("0"))
          expect(order2.slPriceDiff).to.equal(toWei("0"))
          expect(order2.tpslExpiration).to.equal(0)
          expect(order2.tpslFlags).to.equal(0)
          expect(order2.tpslWithdrawSwapToken).to.equal(zeroAddress)
          expect(order2.tpslWithdrawSwapSlippage).to.equal(toWei("0"))
        }
      })

      it("trigger close (loss). auto cancel another order", async () => {
        await expect(orderBook.connect(broker).fillPositionOrder(5)).to.be.revertedWith("limitPrice")
        await core.setMockPrice(a2b(btc.address), toWei("50500"))
        await orderBook.connect(broker).fillPositionOrder(5)
        // auto cancel
        {
          const orderIds = await orderBook.getTpslOrders(positionId, short1)
          expect(orderIds.length).to.equal(0)
        }
        {
          const [_, totalCount] = await orderBook.getOrders(0, 100)
          expect(totalCount).to.equal(0)
        }
      })
    })
  }) // add some liquidity and test more

  it("only 1 pool has liquidity, open long", async () => {
    // add liquidity
    await time.increaseTo(timestampOfTest + 86400 * 2)
    await usdc.connect(lp1).transfer(orderBook.address, toUnit("1000000", 6))
    {
      const args = {
        poolAddress: pool1.address,
        token: usdc.address,
        rawAmount: toUnit("1000000", 6),
        isAdding: true,
        isUnwrapWeth: false,
      }
      await orderBook.connect(lp1).placeLiquidityOrder(args)
    }
    await time.increaseTo(timestampOfTest + 86400 * 2 + 930)
    {
      await orderBook.connect(broker).fillLiquidityOrder(0, [])
      expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("100", 6)) // fee = 1000000 * 0.01% = 100
      expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999900", 6))
    }
    // open long
    const positionId = encodePositionId(trader1.address, 0)
    await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("10"))
    await usdc.connect(trader1).transfer(orderBook.address, toUnit("10000", 6))
    {
      const args = {
        positionId,
        marketId: long1,
        size: toWei("1"),
        flags: PositionOrderFlags.OpenPosition,
        limitPrice: toWei("50000"),
        expiration: timestampOfTest + 86400 * 2 + 930 + 300,
        lastConsumedToken: zeroAddress,
        collateralToken: usdc.address,
        collateralAmount: toUnit("10000", 6),
        withdrawUsd: toWei("0"),
        withdrawSwapToken: zeroAddress,
        withdrawSwapSlippage: toWei("0"),
        tpPriceDiff: toWei("0"),
        slPriceDiff: toWei("0"),
        tpslExpiration: 0,
        tpslFlags: 0,
        tpslWithdrawSwapToken: zeroAddress,
        tpslWithdrawSwapSlippage: toWei("0"),
      }
      await orderBook.connect(trader1).placePositionOrder(args, refCode)
      const tx2 = await orderBook.connect(broker).fillPositionOrder(1)
      await expect(tx2)
        .to.emit(core, "OpenPosition")
        .withArgs(
          trader1.address,
          positionId,
          long1,
          true,
          toWei("1"), // size
          toWei("50000"), // tradingPrice
          [pool1.address, pool2.address, pool3.address], // backedPools
          [toWei("1"), toWei("0"), toWei("0")], // allocations
          [toWei("1"), toWei("0"), toWei("0")], // newSizes
          [toWei("50000"), toWei("0"), toWei("0")], // newEntryPrices
          toWei("50"), // positionFeeUsd = 50000 * 1 * 0.1%
          toWei("0"), // borrowingFeeUsd
          [usdc.address], // newCollateralTokens
          [toWei("9950")] // newCollateralAmounts 10000 - 50
        )
    }
  })

  it("multicall can throw error(string)", async () => {
    await expect(
      orderBook.multicall([orderBook.interface.encodeFunctionData("wrapNative", [toWei("0")])])
    ).to.be.revertedWith("Invalid wrap amount")
  })

  it("multicall can throw custom error", async () => {
    // clear price
    await core.setMockPrice(a2b(usdc.address), toWei("0"))
    await core.setMockPrice(a2b(arb.address), toWei("0"))
    await core.setMockPrice(a2b(btc.address), toWei("0"))
    await expect(
      orderBook.connect(trader1).multicall([
        orderBook.interface.encodeFunctionData("withdrawAllCollateral", [
          {
            positionId: encodePositionId(trader1.address, 0),
            isUnwrapWeth: false,
          },
        ]),
      ])
    ).to.be.revertedWith("PositionAccountNotExist")
  })

  // assert balanceOf(pool) >= _liquidityBalances for each token
  async function assertPoolBalances(pool: CollateralPool) {
    const balances = await pool.liquidityBalances()
    const tokenDecimals: { [key: string]: number } = {
      [usdc.address]: 6,
      [arb.address]: 18,
      [btc.address]: 8,
    }
    for (let i = 0; i < balances.tokens.length; i++) {
      const token = balances.tokens[i]
      const decimals = tokenDecimals[token]
      if (decimals === undefined) {
        throw new Error(`Unknown token ${token}`)
      }
      const actualBalance = await (await ethers.getContractAt("MockERC20", token)).balanceOf(pool.address)
      const recordedBalance = balances.balances[i]
      const converted = recordedBalance.div(ethers.BigNumber.from(10).pow(18 - decimals))
      expect(actualBalance).to.be.gte(converted, `Pool balance violated for token ${token}`)
    }
  }
})
