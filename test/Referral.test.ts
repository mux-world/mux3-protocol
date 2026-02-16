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
  Mux3FeeDistributor,
  CollateralPoolEventEmitter,
  MockUniswap3,
  Swapper,
  TestReferralManager,
  TestReferralTiers,
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

describe("Referral", () => {
  const refCode = toBytes32("")
  const refCode2 = toBytes32("testCode")
  const long1 = toBytes32("LongBTC")

  let usdc: MockERC20
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
  let orderBook: OrderBook
  let feeDistributor: Mux3FeeDistributor
  let uniswap: MockUniswap3
  let swapper: Swapper
  let referralTiers: TestReferralTiers
  let referralManager: TestReferralManager

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
    btc = (await createContract("MockERC20", ["BTC", "BTC", 8])) as MockERC20
    await usdc.mint(lp1.address, toUnit("1000000", 6))
    await usdc.mint(trader1.address, toUnit("100000", 6))
    await usdc.mint(trader2.address, toUnit("100000", 6))
    await btc.mint(lp1.address, toUnit("1000000", 8))
    await btc.mint(trader1.address, toUnit("100000", 8))

    // core
    core = (await createContract("TestMux3", [])) as TestMux3
    await core.initialize(weth.address)
    await core.addCollateralToken(usdc.address, 6, true)
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
    await orderBook.setConfig(ethers.utils.id("MCO_LIQUIDITY_LOCK_PERIOD"), u2b(ethers.BigNumber.from(0)))
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

    // pool 2
    await core.createCollateralPool("TN1", "TS1", btc.address, 1)
    const pool2Addr = (await core.listCollateralPool())[1]
    pool2 = (await ethers.getContractAt("CollateralPool", pool2Addr)) as CollateralPool
    await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_BORROWING_K"), u2b(toWei("10")))
    await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_BORROWING_B"), u2b(toWei("-7")))
    await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_LIQUIDITY_CAP_USD"), u2b(toWei("1000000")))
    await core.setPoolConfig(pool2.address, ethers.utils.id("MCP_LIQUIDITY_FEE_RATE"), u2b(toWei("0.0001")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_RESERVE_RATE", long1), u2b(toWei("0.80")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_TRIGGER_RATE", long1), u2b(toWei("0.75")))
    await core.setPoolConfig(pool2.address, encodePoolMarketKey("MCP_ADL_MAX_PNL_RATE", long1), u2b(toWei("0.70")))

    // market 1 - uses 2 pools
    await core.createMarket(
      long1,
      "Long1",
      true, // isLong
      [pool1.address, pool2.address]
    )
    await core.setMarketConfig(long1, ethers.utils.id("MM_POSITION_FEE_RATE"), u2b(toWei("0.001")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_LIQUIDATION_FEE_RATE"), u2b(toWei("0.002")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_INITIAL_MARGIN_RATE"), u2b(toWei("0.006")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_MAINTENANCE_MARGIN_RATE"), u2b(toWei("0.005")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.0001")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_ORACLE_ID"), a2b(btc.address))
    await core.setMarketConfig(long1, ethers.utils.id("MM_OPEN_INTEREST_CAP_USD"), u2b(toWei("100000000")))

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

    // price
    await core.setMockPrice(a2b(usdc.address), toWei("1"))
    await core.setMockPrice(a2b(btc.address), toWei("50000"))

    // referral
    referralManager = (await createContract("TestReferralManager")) as TestReferralManager
    referralTiers = (await createContract("TestReferralTiers")) as TestReferralTiers
    await referralManager.setTierSetting(1, 25000, toUnit("0.04", 5), toUnit("0.06", 5))
    await orderBook.setConfig(ethers.utils.id("MCO_REFERRAL_MANAGER"), a2b(referralManager.address))

    // feeDistributor
    feeDistributor = (await createContract("Mux3FeeDistributor")) as Mux3FeeDistributor
    await feeDistributor.initialize(
      core.address,
      orderBook.address,
      referralManager.address,
      referralTiers.address,
      weth.address
    )
    await feeDistributor.setFeeRatio(toWei("0.75"))
    await core.setConfig(ethers.utils.id("MC_FEE_DISTRIBUTOR"), a2b(feeDistributor.address))
  })

  it("no tier. all return to pool", async () => {
    // add liquidity 1
    {
      await usdc.mint(orderBook.address, toUnit("1000000", 6))
      {
        const args = {
          poolAddress: pool1.address,
          token: usdc.address,
          rawAmount: toUnit("1000000", 6),
          isAdding: true,
          isUnwrapWeth: false,
        }
        await orderBook.connect(lp1).placeLiquidityOrder(args)
        const tx1 = await orderBook.connect(broker).fillLiquidityOrder(0, [])
        // fee = 1000000 * 0.01% = 100
        await expect(tx1).to.emit(emitter, "CollectFee").withArgs(pool1.address, usdc.address, toWei("1"), toWei("100"))
        await expect(tx1)
          .to.emit(feeDistributor, "FeeDistributedToLP")
          .withArgs(usdc.address, pool1.address, toUnit("75", 6)) // 100 * 75%
        await expect(tx1).to.emit(feeDistributor, "FeeDistributedToVe").withArgs(usdc.address, toUnit("25", 6)) // 100 * 25%
      }
      {
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("25", 6)) // 0 + 25
        expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999975", 6)) // 1000000 - 100 + 75
      }
      {
        const [poolTokens, poolBalances] = await pool1.liquidityBalances()
        expect(poolTokens[0]).to.equal(usdc.address)
        expect(poolBalances[0]).to.equal(toWei("999975"))
      }
      {
        expect(await feeDistributor.unclaimedVeReward(usdc.address)).to.equal(toUnit("25", 6))
      }
    }
    // add liquidity 2
    {
      await btc.mint(orderBook.address, toUnit("20", 8))
      {
        const args = {
          poolAddress: pool2.address,
          token: btc.address,
          rawAmount: toUnit("20", 8),
          isAdding: true,
          isUnwrapWeth: false,
        }
        await orderBook.connect(lp1).placeLiquidityOrder(args)
        const tx1 = await orderBook.connect(broker).fillLiquidityOrder(1, [])
        // fee = 20 * 0.01% = 0.002
        await expect(tx1)
          .to.emit(emitter, "CollectFee")
          .withArgs(pool2.address, btc.address, toWei("50000"), toWei("0.002"))
        await expect(tx1)
          .to.emit(feeDistributor, "FeeDistributedToLP")
          .withArgs(btc.address, pool2.address, toUnit("0.0015", 8)) // 0.002 * 75%
        await expect(tx1).to.emit(feeDistributor, "FeeDistributedToVe").withArgs(btc.address, toUnit("0.0005", 8)) // 0.002 * 25%
      }
      {
        expect(await btc.balanceOf(feeDistributor.address)).to.equal(toUnit("0.0005", 8)) // 0 + 0.0005
        expect(await btc.balanceOf(pool2.address)).to.equal(toUnit("19.9995", 8)) // 20 - 0.002 + 0.0015
      }
      {
        const [poolTokens, poolBalances] = await pool2.liquidityBalances()
        expect(poolTokens[1]).to.equal(btc.address)
        expect(poolBalances[1]).to.equal(toWei("19.9995"))
      }
      {
        expect(await feeDistributor.unclaimedVeReward(btc.address)).to.equal(toUnit("0.0005", 8))
      }
    }
    // open long
    {
      const positionId = encodePositionId(trader1.address, 0)
      await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("100"))
      await usdc.mint(orderBook.address, toUnit("10000", 6))
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
        const tx2 = await orderBook.connect(broker).fillPositionOrder(2)
        // allocate 0.5, 0.5
        // fee = 50000 * 0.5 * 0.1% = 25
        await expect(tx2)
          .to.emit(feeDistributor, "FeeDistributedToLP")
          .withArgs(usdc.address, pool1.address, toUnit("18.75", 6)) // 25 * 75%
        await expect(tx2).to.emit(feeDistributor, "FeeDistributedToVe").withArgs(usdc.address, toUnit("6.25", 6)) // 25 * 25%
        await expect(tx2)
          .to.emit(feeDistributor, "FeeDistributedToLP")
          .withArgs(usdc.address, pool2.address, toUnit("18.75", 6)) // 25 * 75%
        await expect(tx2).to.emit(feeDistributor, "FeeDistributedToVe").withArgs(usdc.address, toUnit("6.25", 6)) // 25 * 25%
      }
      {
        const [poolTokens, poolBalances] = await pool1.liquidityBalances()
        expect(poolTokens[0]).to.equal(usdc.address)
        expect(poolBalances[0]).to.equal(toWei("999993.75")) // 999975 + 18.75
        expect(poolTokens[1]).to.equal(btc.address)
        expect(poolBalances[1]).to.equal(toWei("0"))
      }
      {
        const [poolTokens, poolBalances] = await pool2.liquidityBalances()
        expect(poolTokens[0]).to.equal(usdc.address)
        expect(poolBalances[0]).to.equal(toWei("18.75")) // 0 + 18.75
        expect(poolTokens[1]).to.equal(btc.address)
        expect(poolBalances[1]).to.equal(toWei("19.9995")) // 19.9995
      }
    }
  })

  it("tier 1. to trader, referer, pool", async () => {
    // referral
    await referralManager.setReferrerCodeFor(lp1.address, refCode2)
    await referralManager.setReferrerCodeFor(trader1.address, refCode2)
    await referralManager.setRebateRecipient(refCode2, admin.address /* recipient */)
    await referralTiers.setTier([refCode2], [1])
    // add liquidity 1
    {
      await usdc.mint(orderBook.address, toUnit("1000000", 6))
      {
        const args = {
          poolAddress: pool1.address,
          token: usdc.address,
          rawAmount: toUnit("1000000", 6),
          isAdding: true,
          isUnwrapWeth: false,
        }
        await orderBook.connect(lp1).placeLiquidityOrder(args)
        const tx1 = await orderBook.connect(broker).fillLiquidityOrder(0, [])
        // fee = 1000000 * 0.01% = 100
        await expect(tx1).to.emit(emitter, "CollectFee").withArgs(pool1.address, usdc.address, toWei("1"), toWei("100"))
        await expect(tx1)
          .to.emit(feeDistributor, "FeeDistributedAsDiscount")
          .withArgs(usdc.address, lp1.address, toUnit("4", 6)) // 100 * 4%
        await expect(tx1)
          .to.emit(feeDistributor, "FeeDistributedAsRebate")
          .withArgs(usdc.address, lp1.address, toUnit("6", 6)) // 100 * 4%
        await expect(tx1)
          .to.emit(feeDistributor, "FeeDistributedToLP")
          .withArgs(usdc.address, pool1.address, toUnit("67.5", 6)) // 100 * 90% * 75%
        await expect(tx1).to.emit(feeDistributor, "FeeDistributedToVe").withArgs(usdc.address, toUnit("22.5", 6)) // 100 * 90% * 25%
      }
      {
        expect(await usdc.balanceOf(feeDistributor.address)).to.equal(toUnit("22.5", 6)) // 0 + 22.5
        expect(await usdc.balanceOf(pool1.address)).to.equal(toUnit("999967.5", 6)) // 1000000 - 100 + 67.5
        expect(await usdc.balanceOf(admin.address)).to.equal(toUnit("6", 6)) // 0 + 6
        expect(await usdc.balanceOf(lp1.address)).to.equal(toUnit("1000004", 6)) // 1000000 + 4
      }
      {
        const [poolTokens, poolBalances] = await pool1.liquidityBalances()
        expect(poolTokens[0]).to.equal(usdc.address)
        expect(poolBalances[0]).to.equal(toWei("999967.5"))
      }
      {
        expect(await feeDistributor.unclaimedVeReward(usdc.address)).to.equal(toUnit("22.5", 6))
      }
    }
    // add liquidity 2
    {
      await btc.mint(orderBook.address, toUnit("20", 8))
      {
        const args = {
          poolAddress: pool2.address,
          token: btc.address,
          rawAmount: toUnit("20", 8),
          isAdding: true,
          isUnwrapWeth: false,
        }
        await orderBook.connect(lp1).placeLiquidityOrder(args)
        const tx1 = await orderBook.connect(broker).fillLiquidityOrder(1, [])
        // fee = 20 * 0.01% = 0.002
        await expect(tx1)
          .to.emit(emitter, "CollectFee")
          .withArgs(pool2.address, btc.address, toWei("50000"), toWei("0.002"))
        await expect(tx1)
          .to.emit(feeDistributor, "FeeDistributedAsDiscount")
          .withArgs(btc.address, lp1.address, toUnit("0.00008", 8)) // 0.002 * 4%
        await expect(tx1)
          .to.emit(feeDistributor, "FeeDistributedAsRebate")
          .withArgs(btc.address, lp1.address, toUnit("0.00012", 8)) // 0.002 * 6%
        await expect(tx1)
          .to.emit(feeDistributor, "FeeDistributedToLP")
          .withArgs(btc.address, pool2.address, toUnit("0.00135", 8)) // 0.002 * 90% * 75%
        await expect(tx1).to.emit(feeDistributor, "FeeDistributedToVe").withArgs(btc.address, toUnit("0.00045", 8)) // 0.002 * 90% * 25%
      }
      {
        expect(await btc.balanceOf(feeDistributor.address)).to.equal(toUnit("0.00045", 8)) // 0 + 0.00045
        expect(await btc.balanceOf(pool2.address)).to.equal(toUnit("19.99935", 8)) // 20 - 0.002 + 0.00135
        expect(await btc.balanceOf(admin.address)).to.equal(toUnit("0.00012", 8)) // 0 + 0.00012
        expect(await btc.balanceOf(lp1.address)).to.equal(toUnit("1000000.00008", 8)) // 1000000 + 0.00008
      }
      {
        const [poolTokens, poolBalances] = await pool2.liquidityBalances()
        expect(poolTokens[1]).to.equal(btc.address)
        expect(poolBalances[1]).to.equal(toWei("19.99935"))
      }
      {
        expect(await feeDistributor.unclaimedVeReward(btc.address)).to.equal(toUnit("0.00045", 8))
      }
    }
    // open long
    {
      const positionId = encodePositionId(trader1.address, 0)
      await orderBook.connect(trader1).setInitialLeverage(positionId, long1, toWei("100"))
      await usdc.mint(orderBook.address, toUnit("10000", 6))
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
        const tx2 = await orderBook.connect(broker).fillPositionOrder(2)
        // allocate 0.5, 0.5
        // fee = 50000 * 0.5 * 0.1% = 25
        await expect(tx2)
          .to.emit(feeDistributor, "FeeDistributedAsDiscount")
          .withArgs(usdc.address, trader1.address, toUnit("1", 6)) // 25 * 4%
        await expect(tx2)
          .to.emit(feeDistributor, "FeeDistributedAsRebate")
          .withArgs(usdc.address, trader1.address, toUnit("1.5", 6)) // 25 * 6%
        await expect(tx2)
          .to.emit(feeDistributor, "FeeDistributedToLP")
          .withArgs(usdc.address, pool1.address, toUnit("16.875", 6)) // 25 * 90% * 75%
        await expect(tx2).to.emit(feeDistributor, "FeeDistributedToVe").withArgs(usdc.address, toUnit("5.625", 6)) // 25 * 90% * 25%
        // fee = 50000 * 0.5 * 0.1% = 25
        await expect(tx2)
          .to.emit(feeDistributor, "FeeDistributedAsDiscount")
          .withArgs(usdc.address, trader1.address, toUnit("1", 6)) // 25 * 4%
        await expect(tx2)
          .to.emit(feeDistributor, "FeeDistributedAsRebate")
          .withArgs(usdc.address, trader1.address, toUnit("1.5", 6)) // 25 * 6%
        await expect(tx2)
          .to.emit(feeDistributor, "FeeDistributedToLP")
          .withArgs(usdc.address, pool2.address, toUnit("16.875", 6)) // 25 * 90% * 75%
        await expect(tx2).to.emit(feeDistributor, "FeeDistributedToVe").withArgs(usdc.address, toUnit("5.625", 6)) // 25 * 90% * 25%
      }
      {
        const [poolTokens, poolBalances] = await pool1.liquidityBalances()
        expect(poolTokens[0]).to.equal(usdc.address)
        expect(poolBalances[0]).to.equal(toWei("999984.375")) // 999967.5 + 16.875
        expect(poolTokens[1]).to.equal(btc.address)
        expect(poolBalances[1]).to.equal(toWei("0"))
      }
      {
        const [poolTokens, poolBalances] = await pool2.liquidityBalances()
        expect(poolTokens[0]).to.equal(usdc.address)
        expect(poolBalances[0]).to.equal(toWei("16.875")) // 0 + 16.875
        expect(poolTokens[1]).to.equal(btc.address)
        expect(poolBalances[1]).to.equal(toWei("19.99935")) // 19.99935
      }
      expect(await usdc.balanceOf(admin.address)).to.equal(toUnit("9", 6)) // 6 + 1.5 + 1.5
      expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("100002", 6)) // 100000 + 1 + 1
      expect(await btc.balanceOf(admin.address)).to.equal(toUnit("0.00012", 8)) // 0.00012
      expect(await btc.balanceOf(trader1.address)).to.equal(toUnit("100000", 8)) // 100000
    }
  })
})
