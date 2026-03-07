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
} from "../scripts/deployUtils"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { CollateralPool, OrderBook, TestMux3, MockERC20, Delegator, WETH9, Swapper } from "../typechain"
import { time } from "@nomicfoundation/hardhat-network-helpers"
import { BigNumber } from "ethers"

const a2b = (a) => {
  return a + "000000000000000000000000"
}
const u2b = (u) => {
  return ethers.utils.hexZeroPad(u.toTwos(256).toHexString(), 32)
}

describe("Delegator", () => {
  const refCode = toBytes32("")
  const long1 = toBytes32("LongBTC")

  let usdc: MockERC20
  let weth: WETH9

  let admin: SignerWithAddress
  let trader1: SignerWithAddress
  let trader2: SignerWithAddress
  let trader3: SignerWithAddress

  let core: TestMux3
  let imp: CollateralPool
  let pool1: CollateralPool
  let orderBook: OrderBook
  let delegator: Delegator
  let swapper: Swapper

  let timestampOfTest: number

  before(async () => {
    const accounts = await ethers.getSigners()
    admin = accounts[0]
    trader1 = accounts[1]
    trader2 = accounts[2]
    trader3 = accounts[3]
    weth = (await createContract("WETH9", [])) as WETH9
  })

  beforeEach(async () => {
    timestampOfTest = await time.latest()
    timestampOfTest = Math.ceil(timestampOfTest / 3600) * 3600 // move to the next hour

    // token
    usdc = (await createContract("MockERC20", ["USDC", "USDC", 6])) as MockERC20
    await usdc.mint(trader1.address, toUnit("100000", 6))

    // core
    core = (await createContract("TestMux3", [])) as TestMux3
    await core.initialize(weth.address)
    await core.addCollateralToken(usdc.address, 6, true)

    // orderBook
    const libOrderBook = await createContract("LibOrderBook")
    const libOrderBook2 = await createContract("LibOrderBook2")
    orderBook = (await createContract("OrderBook", [], {
      "contracts/libraries/LibOrderBook.sol:LibOrderBook": libOrderBook,
      "contracts/libraries/LibOrderBook2.sol:LibOrderBook2": libOrderBook2,
    })) as OrderBook
    await orderBook.initialize(core.address, weth.address)
    await orderBook.setConfig(ethers.utils.id("MCO_ORDER_GAS_FEE_GWEI"), u2b(BigNumber.from("1000000")))

    // collateral pool
    const emitter = await createContract("CollateralPoolEventEmitter")
    await emitter.initialize(core.address)
    imp = (await createContract("CollateralPool", [
      core.address,
      orderBook.address,
      weth.address,
      emitter.address,
    ])) as CollateralPool
    await core.setCollateralPoolImplementation(imp.address)

    // pool 1
    await core.createCollateralPool("TN1", "TS1", usdc.address, 0)
    const pool1Addr = (await core.listCollateralPool())[0]
    pool1 = (await ethers.getContractAt("CollateralPool", pool1Addr)) as CollateralPool

    // markets only uses pool1
    await core.createMarket(
      long1,
      "Long1",
      true, // isLong
      [pool1.address],
    )
    await core.setMarketConfig(long1, ethers.utils.id("MM_LOT_SIZE"), u2b(toWei("0.1")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_INITIAL_MARGIN_RATE"), u2b(toWei("0.006")))
    await core.setMarketConfig(long1, ethers.utils.id("MM_ORACLE_ID"), a2b(weth.address))
    await core.setMarketConfig(long1, ethers.utils.id("MM_OPEN_INTEREST_CAP_USD"), u2b(toWei("100000000")))

    // delegator
    delegator = (await createContract("Delegator", [
      orderBook.address,
      zeroAddress,
      zeroAddress,
      zeroAddress,
    ])) as Delegator
    await delegator.initialize()

    // role
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), delegator.address)
    await core.grantRole(ethers.utils.id("ORDER_BOOK_ROLE"), orderBook.address)

    // swapper
    swapper = (await createContract("Swapper", [])) as Swapper
    await swapper.initialize(weth.address)
    await core.setConfig(ethers.utils.id("MC_SWAPPER"), a2b(swapper.address))

    // prices
    await core.setMockPrice(a2b(weth.address), toWei("1000"))
    await core.setMockPrice(a2b(usdc.address), toWei("1"))
  })

  it("setDelegation, getDelegation", async () => {
    // set delegate
    await delegator.connect(trader1).delegate(trader2.address, 0, { value: toWei("1") })
    expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([trader2.address, toWei("0")])

    await delegator.connect(trader1).delegate(trader2.address, 100, { value: toWei("1") })
    expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([
      trader2.address,
      BigNumber.from("100"),
    ])

    await delegator.connect(trader1).delegate(trader3.address, 200, { value: toWei("1") })
    expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([
      trader3.address,
      BigNumber.from("200"),
    ])

    await delegator.connect(trader1).delegate(trader3.address, 0, { value: toWei("1") })
    expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([trader3.address, BigNumber.from("0")])
  })

  it("setInitialLeverage", async () => {
    await delegator.connect(trader1).delegate(trader2.address, 100, { value: toWei("1") })
    expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([
      trader2.address,
      BigNumber.from("100"),
    ])

    const positionId = encodePositionId(trader1.address, 0)
    await delegator.connect(trader2).mux3SetInitialLeverage(positionId, long1, toWei("20"))
    expect(await core.getInitialLeverage(positionId, long1)).to.equal(toWei("20"))
    expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([
      trader2.address,
      BigNumber.from("100"), // setInitialLeverage does not consume action count
    ])
  })

  it("place, cancel", async () => {
    // set delegate
    const balance1 = await ethers.provider.getBalance(trader2.address)
    await delegator.connect(trader1).delegate(trader2.address, 0, { value: toWei("1") })
    const balance2 = await ethers.provider.getBalance(trader2.address)
    expect(balance2.sub(balance1)).to.equal(toWei("1"))

    // open short, using usdc
    const positionId = encodePositionId(trader1.address, 0)
    await usdc.connect(trader1).approve(orderBook.address, toUnit("1000", 6))
    const args = {
      positionId,
      marketId: long1,
      size: toWei("1"),
      flags: PositionOrderFlags.OpenPosition,
      limitPrice: toWei("1000"),
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
    {
      await expect(delegator.connect(trader3).mux3PlacePositionOrder(args, refCode)).to.revertedWith("Not authorized")
      await expect(delegator.connect(trader2).mux3PlacePositionOrder(args, refCode)).to.revertedWith("No action count")
      await delegator.connect(trader1).delegate(trader2.address, 100)
      await delegator.connect(trader2).mux3SetInitialLeverage(positionId, long1, toWei("100"))
      const tx1 = await delegator
        .connect(trader2)
        .multicall(
          [
            delegator.interface.encodeFunctionData("mux3DepositGas", [trader1.address, toWei("0.001")]),
            delegator.interface.encodeFunctionData("mux3PlacePositionOrder", [args, refCode]),
          ],
          { value: toWei("0.001") },
        )
      await expect(tx1)
        .to.emit(orderBook, "NewPositionOrder")
        .withArgs(trader1.address, 0, [
          args.positionId,
          args.marketId,
          args.size,
          args.flags,
          args.limitPrice,
          args.expiration,
          args.lastConsumedToken,
          args.collateralToken,
          args.collateralAmount,
          args.withdrawUsd,
          args.withdrawSwapToken,
          args.withdrawSwapSlippage,
          args.tpPriceDiff,
          args.slPriceDiff,
          args.tpslExpiration,
          args.tpslFlags,
          args.tpslWithdrawSwapToken,
          args.tpslWithdrawSwapSlippage,
        ])
      expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([
        trader2.address,
        BigNumber.from("99"),
      ])
      expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("99000", 6))
      expect(await usdc.balanceOf(orderBook.address)).to.equal(toUnit("1000", 6))
    }
    // cancel
    {
      await expect(delegator.connect(trader3).mux3CancelOrder(0)).to.revertedWith("Not authorized")
      await delegator.connect(trader2).delegate(trader3.address, 100)
      await expect(delegator.connect(trader3).mux3CancelOrder(0)).to.revertedWith("Not authorized")
      await expect(delegator.connect(trader2).mux3CancelOrder(1)).to.revertedWith("No such orderId")
      await delegator.connect(trader2).mux3CancelOrder(0)
      expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([
        trader2.address,
        BigNumber.from("98"),
      ])
      expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("100000", 6))
      expect(await usdc.balanceOf(orderBook.address)).to.equal(toUnit("0", 6))
    }
  })

  it("deposit, withdraw, cancel withdraw", async () => {
    // set delegate
    const balance1 = await ethers.provider.getBalance(trader2.address)
    await delegator.connect(trader1).delegate(trader2.address, 0, { value: toWei("1") })
    const balance2 = await ethers.provider.getBalance(trader2.address)
    expect(balance2.sub(balance1)).to.equal(toWei("1"))

    const positionId = encodePositionId(trader1.address, 0)
    await usdc.connect(trader1).approve(orderBook.address, toUnit("1000", 6))
    // deposit
    {
      await expect(
        delegator.connect(trader3).mux3DepositCollateral(positionId, usdc.address, toUnit("1000", 6)),
      ).to.revertedWith("Not authorized")
      await expect(
        delegator.connect(trader2).mux3DepositCollateral(positionId, usdc.address, toUnit("1000", 6)),
      ).to.revertedWith("No action count")
      await delegator.connect(trader1).delegate(trader2.address, 100)
      const tx1 = await delegator
        .connect(trader2)
        .multicall([
          delegator.interface.encodeFunctionData("mux3DepositCollateral", [
            positionId,
            usdc.address,
            toUnit("1000", 6),
          ]),
        ])
      await expect(tx1).to.emit(core, "Deposit").withArgs(trader1.address, positionId, usdc.address, toUnit("1000", 6))
      await expect(tx1)
        .to.emit(core, "DepositWithdrawFinish")
        .withArgs(trader1.address, positionId, toWei("0"), [usdc.address], [toWei("1000")])
      expect(await usdc.balanceOf(core.address)).to.equal(toUnit("1000", 6))
      expect(await core.listAccountCollaterals(positionId)).to.deep.equal([[usdc.address, toUnit("1000", 18)]])
      expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([
        trader2.address,
        BigNumber.from("100"), // deposit does not consume action count
      ])
    }
    // withdraw
    {
      const tx1 = await delegator.connect(trader2).multicall(
        [
          delegator.interface.encodeFunctionData("mux3DepositGas", [trader1.address, toWei("0.001")]),
          delegator.interface.encodeFunctionData("mux3PlaceWithdrawalOrder", [
            {
              positionId: positionId,
              tokenAddress: usdc.address,
              rawAmount: toUnit("500", 6),
              isUnwrapWeth: false,
              lastConsumedToken: zeroAddress,
              withdrawSwapToken: zeroAddress,
              withdrawSwapSlippage: toWei("0"),
            },
          ]),
        ],
        { value: toWei("0.001") },
      )
      await expect(tx1)
        .to.emit(orderBook, "NewWithdrawalOrder")
        .withArgs(trader1.address, 0, [positionId, usdc.address, toUnit("500", 6), false])
      expect(await usdc.balanceOf(core.address)).to.equal(toUnit("1000", 6))
      expect(await core.listAccountCollaterals(positionId)).to.deep.equal([[usdc.address, toUnit("1000", 18)]])
      expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([
        trader2.address,
        BigNumber.from("99"),
      ])
    }
    // cancel withdraw
    await delegator.connect(trader2).mux3CancelOrder(0)
    expect(await delegator.getDelegationByOwner(trader1.address)).to.deep.equal([trader2.address, BigNumber.from("98")])
  })

  it("delegator cannot deposit to another", async () => {
    const amount = toUnit("50000", 6)
    const trader2PositionId = encodePositionId(trader2.address, 0)
    await usdc.connect(trader1).approve(orderBook.address, amount)
    await delegator.connect(trader1).delegate(trader2.address, 100)
    // trader2 tries to deposit into trader2's position via delegation from trader1
    // _consumeDelegation checks delegation.delegator == msg.sender, but positionId owner is trader2, not trader1
    // so _consumeDelegation(trader2, 0) fails because trader1 delegated to trader2, not trader2 delegated to trader2
    await expect(
      delegator.connect(trader2).mux3DepositCollateral(trader2PositionId, usdc.address, amount),
    ).to.revertedWith("Not authorized")
  })

  it("delegator.mux3PositionCall via aggregator proxy factory", async () => {
    // deploy MockMuxAggregatorProxyFactory
    const mockAggFactory = await createContract("MockMuxAggregatorProxyFactory", [orderBook.address])
    // grant DELEGATOR_ROLE to mockAggFactory so it can call transferTokenFrom
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), mockAggFactory.address)
    // register delegator contract as a delegator in mockAggFactory
    // deploy a new delegator pointing to mockAggFactory as _mux2ProxyFactory
    const delegator2 = (await createContract("Delegator", [
      orderBook.address,
      mockAggFactory.address,
      zeroAddress,
      zeroAddress,
    ])) as Delegator
    await delegator2.initialize()
    // grant DELEGATOR_ROLE to delegator2
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), delegator2.address)
    // register delegator2 as a delegator in mockAggFactory
    await mockAggFactory.setDelegator(delegator2.address, true)
    // setup delegation
    const positionId = encodePositionId(trader1.address, 0)
    await usdc.connect(trader1).approve(orderBook.address, toUnit("1000", 6))
    await delegator2.connect(trader1).delegate(trader2.address, 100)
    // encode placePositionOrder params (without function selector, as ProxyFactory prepends it)
    const orderParams = {
      positionId,
      marketId: long1,
      size: toWei("1"),
      flags: PositionOrderFlags.OpenPosition,
      limitPrice: toWei("1000"),
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
    const positionOrderCallData = ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(bytes32,bytes32,uint256,uint256,uint256,uint64,address,address,uint256,uint256,address,uint256,uint256,uint256,uint64,uint256,address,uint256)",
        "bytes32",
      ],
      [
        [
          orderParams.positionId,
          orderParams.marketId,
          orderParams.size,
          orderParams.flags,
          orderParams.limitPrice,
          orderParams.expiration,
          orderParams.lastConsumedToken,
          orderParams.collateralToken,
          orderParams.collateralAmount,
          orderParams.withdrawUsd,
          orderParams.withdrawSwapToken,
          orderParams.withdrawSwapSlippage,
          orderParams.tpPriceDiff,
          orderParams.slPriceDiff,
          orderParams.tpslExpiration,
          orderParams.tpslFlags,
          orderParams.tpslWithdrawSwapToken,
          orderParams.tpslWithdrawSwapSlippage,
        ],
        toBytes32(""), // referralCode
      ],
    )
    // set initial leverage first
    await delegator2.connect(trader2).mux3SetInitialLeverage(positionId, long1, toWei("100"))
    // delegator.multicall → delegator.mux3PositionCall → ProxyFactory.mux3PositionCall → OrderBook
    const tx1 = await delegator2.connect(trader2).multicall(
      [
        delegator2.interface.encodeFunctionData("mux3DepositGas", [trader1.address, toWei("0.001")]),
        delegator2.interface.encodeFunctionData("mux3PositionCall", [
          usdc.address,
          toUnit("1000", 6),
          positionOrderCallData,
          0, // initialLeverage already set
          0, // gas already deposited above
        ]),
      ],
      { value: toWei("0.001") },
    )
    await expect(tx1).to.emit(orderBook, "NewPositionOrder")
    expect(await usdc.balanceOf(trader1.address)).to.equal(toUnit("99000", 6))
    expect(await usdc.balanceOf(orderBook.address)).to.equal(toUnit("1000", 6))
    expect(await delegator2.getDelegationByOwner(trader1.address)).to.deep.equal([
      trader2.address,
      BigNumber.from("99"), // mux3PositionCall consumes 1 action
    ])
  })

  it("delegator.mux3PositionCall cannot route funds to wrong positionId", async () => {
    // deploy MockMuxAggregatorProxyFactory
    const mockAggFactory = await createContract("MockMuxAggregatorProxyFactory", [orderBook.address])
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), mockAggFactory.address)
    const delegator2 = (await createContract("Delegator", [
      orderBook.address,
      mockAggFactory.address,
      zeroAddress,
      zeroAddress,
    ])) as Delegator
    await delegator2.initialize()
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), delegator2.address)
    await mockAggFactory.setDelegator(delegator2.address, true)
    // trader1 delegates to trader2
    await delegator2.connect(trader1).delegate(trader2.address, 100)
    await usdc.connect(trader1).approve(orderBook.address, toUnit("1000", 6))
    // trader2 tries to open a position with trader3's positionId using trader1's funds
    const trader3PositionId = encodePositionId(trader3.address, 0)
    const badOrderParams = ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(bytes32,bytes32,uint256,uint256,uint256,uint64,address,address,uint256,uint256,address,uint256,uint256,uint256,uint64,uint256,address,uint256)",
        "bytes32",
      ],
      [
        [
          trader3PositionId, // wrong owner
          long1,
          toWei("1"),
          PositionOrderFlags.OpenPosition,
          toWei("1000"),
          timestampOfTest + 86400 * 2 + 930 + 300,
          zeroAddress,
          usdc.address,
          toUnit("1000", 6),
          toWei("0"),
          zeroAddress,
          toWei("0"),
          toWei("0"),
          toWei("0"),
          0,
          0,
          zeroAddress,
          toWei("0"),
        ],
        toBytes32(""),
      ],
    )
    // fails at _consumeDelegation: positionId owner is trader3, but trader3 has no delegation to trader2
    await expect(
      delegator2.connect(trader2).mux3PositionCall(usdc.address, toUnit("1000", 6), badOrderParams, 0, 0),
    ).to.revertedWith("Not authorized")
  })

  it("mux3PositionCall rejects collateralAmount mismatch", async () => {
    const mockAggFactory = await createContract("MockMuxAggregatorProxyFactory", [orderBook.address])
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), mockAggFactory.address)
    const delegator2 = (await createContract("Delegator", [
      orderBook.address,
      mockAggFactory.address,
      zeroAddress,
      zeroAddress,
    ])) as Delegator
    await delegator2.initialize()
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), delegator2.address)
    await mockAggFactory.setDelegator(delegator2.address, true)
    const positionId = encodePositionId(trader1.address, 0)
    await delegator2.connect(trader1).delegate(trader2.address, 100)
    await usdc.connect(trader1).approve(orderBook.address, toUnit("50000", 6))
    // inner collateralAmount = 1000, outer = 50000 → mismatch
    const positionOrderCallData = ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(bytes32,bytes32,uint256,uint256,uint256,uint64,address,address,uint256,uint256,address,uint256,uint256,uint256,uint64,uint256,address,uint256)",
        "bytes32",
      ],
      [
        [
          positionId,
          long1,
          toWei("1"),
          PositionOrderFlags.OpenPosition,
          toWei("1000"),
          timestampOfTest + 86400 * 2 + 930 + 300,
          zeroAddress,
          usdc.address,
          toUnit("1000", 6), // inner: 1000
          toWei("0"),
          zeroAddress,
          toWei("0"),
          toWei("0"),
          toWei("0"),
          0,
          0,
          zeroAddress,
          toWei("0"),
        ],
        toBytes32(""),
      ],
    )
    await expect(
      delegator2.connect(trader2).mux3PositionCall(
        usdc.address,
        toUnit("50000", 6), // outer: 50000 — mismatch
        positionOrderCallData,
        0,
        0,
      ),
    ).to.revertedWith("CollateralAmountMismatch")
  })

  it("mux3PositionCall rejects outer collateral on close order", async () => {
    // close order has inner collateralToken=0, collateralAmount=0
    // attacker sets outer collateralAmount > 0 to steal funds via phantom surplus
    const mockAggFactory = await createContract("MockMuxAggregatorProxyFactory", [orderBook.address])
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), mockAggFactory.address)
    const delegator2 = (await createContract("Delegator", [
      orderBook.address,
      mockAggFactory.address,
      zeroAddress,
      zeroAddress,
    ])) as Delegator
    await delegator2.initialize()
    await orderBook.grantRole(ethers.utils.id("DELEGATOR_ROLE"), delegator2.address)
    await mockAggFactory.setDelegator(delegator2.address, true)
    const positionId = encodePositionId(trader1.address, 0)
    await delegator2.connect(trader1).delegate(trader2.address, 100)
    await usdc.connect(trader1).approve(orderBook.address, toUnit("50000", 6))
    // close order: inner collateralToken=0, collateralAmount=0
    const closeOrderCallData = ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(bytes32,bytes32,uint256,uint256,uint256,uint64,address,address,uint256,uint256,address,uint256,uint256,uint256,uint64,uint256,address,uint256)",
        "bytes32",
      ],
      [
        [
          positionId,
          long1,
          toWei("1"),
          0, // flags: no POSITION_OPEN → close order
          toWei("1000"),
          timestampOfTest + 86400 * 2 + 930 + 300,
          zeroAddress,
          zeroAddress, // inner collateralToken = 0
          0, // inner collateralAmount = 0
          toWei("0"),
          zeroAddress,
          toWei("0"),
          toWei("0"),
          toWei("0"),
          0,
          0,
          zeroAddress,
          toWei("0"),
        ],
        toBytes32(""),
      ],
    )
    // outer collateralToken=usdc, inner collateralToken=0 → token mismatch
    await expect(
      delegator2.connect(trader2).mux3PositionCall(
        usdc.address,
        toUnit("50000", 6),
        closeOrderCallData,
        0,
        0,
      ),
    ).to.revertedWith("CollateralTokenMismatch")
  })
})
