import { ethers, waffle } from "hardhat"
import "@nomiclabs/hardhat-waffle"
import { expect } from "chai"
import { toWei, createContract, toUnit } from "../scripts/deployUtils"
import { MockBalancer2, MockUniswap3, Swapper, MockSUSDC } from "../typechain"
import { BigNumber } from "ethers"

const SWAPPER_UNI3 = "00"
const SWAPPER_BAL2 = "01"
const UNI_FEE_005 = "0001f4"

describe("Swapper with sUSDC", () => {
  let user0: any
  let user1: any
  let user2: any

  let uniswap3: MockUniswap3
  let balancer2: MockBalancer2
  let swapper: Swapper
  let susdc: MockSUSDC

  let usdc: any
  let weth: any
  let wbtc: any

  // nav ~1.06: 1.06e6 USDC = 1e18 sUSDC
  const NAV_MULTIPLIER = 1060000
  const NAV_SCALE = 1e6

  before(async () => {
    const signers = await ethers.getSigners()
    user0 = signers[0]
    user1 = signers[1]
    user2 = signers[2]
  })

  beforeEach(async () => {
    // deploy tokens with correct decimals
    usdc = await createContract("MockERC20", ["USDC", "USDC", 6])
    weth = await createContract("WETH9", [])
    wbtc = await createContract("MockERC20", ["WBTC", "WBTC", 8])

    // deploy mock sUSDC vault
    susdc = (await createContract("MockSUSDC", [usdc.address])) as MockSUSDC

    // deploy mock DEXs
    uniswap3 = (await createContract("MockUniswap3", [
      usdc.address,
      weth.address,
      wbtc.address,
      ethers.constants.AddressZero, // arb not needed
    ])) as MockUniswap3

    balancer2 = (await createContract("MockBalancer2", [
      usdc.address,
      weth.address,
      wbtc.address,
      ethers.constants.AddressZero,
    ])) as MockBalancer2

    // deploy and configure swapper
    swapper = (await createContract("Swapper", [])) as Swapper
    await swapper.initialize(weth.address)
    await swapper.grantRole(await swapper.SET_ROUTE_ROLE(), user0.address)
    await swapper.setUniswap3(uniswap3.address, uniswap3.address)
    await swapper.setBalancer2(balancer2.address)
    await swapper.setSUSDC(susdc.address, usdc.address)

    // setup USDC <=> WETH paths (sUSDC will use these automatically)
    await swapper.setSwapPath(usdc.address, weth.address, [
      "0x" + SWAPPER_UNI3 + usdc.address.slice(2) + UNI_FEE_005 + weth.address.slice(2),
    ])
    await swapper.setSwapPath(weth.address, usdc.address, [
      "0x" + SWAPPER_UNI3 + weth.address.slice(2) + UNI_FEE_005 + usdc.address.slice(2),
    ])

    // fund DEXs for swaps
    // uniswap3 mock: 1 WETH = 3000 USDC
    await usdc.mint(uniswap3.address, toUnit("100000", 6))
    await weth.deposit({ value: toWei("100") })
    await weth.transfer(uniswap3.address, toWei("100"))
  })

  describe("sUSDC <=> USDC conversion", () => {
    it("should correctly convert sUSDC to USDC amounts", async () => {
      // test conversion: 1e18 sUSDC = 1.06e6 USDC
      const susdcAmount = toWei("1")
      const expectedUsdcAmount = toUnit("1.06", 6)

      const usdcAmount = await susdc.previewRedeem(susdcAmount)
      expect(usdcAmount).to.equal(expectedUsdcAmount)
    })

    it("should correctly convert USDC to sUSDC amounts", async () => {
      // test conversion: 1.06e6 USDC = 1e18 sUSDC
      const usdcAmount = toUnit("1.06", 6)
      const expectedSusdcAmount = toWei("1")

      const susdcAmount = await susdc.previewDeposit(usdcAmount)
      expect(susdcAmount).to.equal(expectedSusdcAmount)
    })
  })

  describe("Direct sUSDC <=> USDC swaps", () => {
    beforeEach(async () => {
      // mint USDC to user0 for testing
      await usdc.mint(user0.address, toUnit("10000", 6))
    })

    it("should swap USDC to sUSDC directly", async () => {
      // transfer USDC to swapper
      await usdc.transfer(swapper.address, toUnit("1060", 6))

      // quote USDC => sUSDC
      const quote = await swapper.callStatic.quote(usdc.address, susdc.address, toUnit("1060", 6))
      expect(quote.quoteSuccess).to.be.true
      expect(quote.bestOutAmount).to.equal(toWei("1000"))

      // execute swap
      const result = await swapper.swapAndTransfer(
        usdc.address,
        toUnit("1060", 6),
        susdc.address,
        toWei("999"), // min amount with slippage
        user1.address,
        false
      )

      // verify swap success
      const tx = await result.wait()
      const swapSuccessEvent = tx.events?.find(e => e.event === "SwapSuccess")
      expect(swapSuccessEvent).to.not.be.undefined

      // check balances
      expect(await usdc.balanceOf(swapper.address)).to.equal(0)
      expect(await susdc.balanceOf(user1.address)).to.equal(toWei("1000"))
    })

    it("swap 0 USDC to sUSDC", async () => {
      // transfer USDC to swapper
      await usdc.transfer(swapper.address, toUnit("1060", 6))

      // quote USDC => sUSDC
      const quote = await swapper.callStatic.quote(usdc.address, susdc.address, toUnit("0", 6))
      expect(quote.quoteSuccess).to.be.true
      expect(quote.bestOutAmount).to.equal(toWei("0"))

      // execute swap
      const result = await swapper.swapAndTransfer(
        usdc.address,
        toUnit("0", 6),
        susdc.address,
        toWei("0"), // min amount with slippage
        user1.address,
        false
      )

      // verify swap success
      const tx = await result.wait()
      const swapSuccessEvent = tx.events?.find(e => e.event === "SwapSuccess")
      expect(swapSuccessEvent).to.not.be.undefined
    })

    it("should swap sUSDC to USDC directly", async () => {
      // first mint sUSDC by depositing USDC
      await usdc.approve(susdc.address, toUnit("1060", 6))
      await susdc.deposit(toUnit("1060", 6), user0.address)

      // transfer sUSDC to swapper
      await susdc.transfer(swapper.address, toWei("1000"))

      // quote sUSDC => USDC
      const quote = await swapper.callStatic.quote(susdc.address, usdc.address, toWei("1000"))
      expect(quote.quoteSuccess).to.be.true
      expect(quote.bestOutAmount).to.equal(toUnit("1060", 6))

      // execute swap
      const result = await swapper.swapAndTransfer(
        susdc.address,
        toWei("1000"),
        usdc.address,
        toUnit("1059", 6), // min amount with slippage
        user1.address,
        false
      )

      // verify swap success
      const tx = await result.wait()
      const swapSuccessEvent = tx.events?.find(e => e.event === "SwapSuccess")
      expect(swapSuccessEvent).to.not.be.undefined

      // check balances
      expect(await susdc.balanceOf(swapper.address)).to.equal(0)
      expect(await usdc.balanceOf(user1.address)).to.equal(toUnit("1060", 6))
    })

    it("swap 0 sUSDC to USDC", async () => {
      // quote sUSDC => USDC
      const quote = await swapper.callStatic.quote(susdc.address, usdc.address, toWei("0"))
      expect(quote.quoteSuccess).to.be.true
      expect(quote.bestOutAmount).to.equal(toUnit("0", 6))

      // execute swap
      const result = await swapper.swapAndTransfer(
        susdc.address,
        toWei("0"),
        usdc.address,
        toUnit("0", 6), // min amount with slippage
        user1.address,
        false
      )

      // verify swap success
      const tx = await result.wait()
      const swapSuccessEvent = tx.events?.find(e => e.event === "SwapSuccess")
      expect(swapSuccessEvent).to.not.be.undefined
    })

    it("should handle failed sUSDC to USDC swap due to minAmountOut", async () => {
      // first mint sUSDC by depositing USDC
      await usdc.approve(susdc.address, toUnit("1060", 6))
      await susdc.deposit(toUnit("1060", 6), user0.address)

      // transfer sUSDC to swapper
      await susdc.transfer(swapper.address, toWei("1000"))

      // execute swap with unrealistic minAmountOut
      const result = await swapper.swapAndTransfer(
        susdc.address,
        toWei("1000"),
        usdc.address,
        toUnit("2000", 6), // impossible amount
        user1.address,
        false
      )

      // verify swap failed
      const tx = await result.wait()
      const swapFailedEvent = tx.events?.find(e => e.event === "SwapFailed")
      expect(swapFailedEvent).to.not.be.undefined

      // sUSDC should be returned to user1
      expect(await susdc.balanceOf(user1.address)).to.equal(toWei("1000"))
      expect(await susdc.balanceOf(swapper.address)).to.equal(0)
      expect(await usdc.balanceOf(user1.address)).to.equal(0)
    })

    it("should handle failed USDC to sUSDC swap due to minAmountOut", async () => {
      // transfer USDC to swapper
      await usdc.transfer(swapper.address, toUnit("1060", 6))

      // execute swap with unrealistic minAmountOut
      const result = await swapper.swapAndTransfer(
        usdc.address,
        toUnit("1060", 6),
        susdc.address,
        toWei("2000"), // impossible amount
        user1.address,
        false
      )

      // verify swap failed
      const tx = await result.wait()
      const swapFailedEvent = tx.events?.find(e => e.event === "SwapFailed")
      expect(swapFailedEvent).to.not.be.undefined

      // USDC should be returned to user1
      expect(await usdc.balanceOf(user1.address)).to.equal(toUnit("1060", 6))
      expect(await usdc.balanceOf(swapper.address)).to.equal(0)
      expect(await susdc.balanceOf(user1.address)).to.equal(0)
    })
  })

  describe("sUSDC => WETH swaps", () => {
    beforeEach(async () => {
      // mint USDC to user0, then deposit to get sUSDC
      await usdc.mint(user0.address, toUnit("10600", 6))
      await usdc.approve(susdc.address, toUnit("10600", 6))
      await susdc.deposit(toUnit("10600", 6), user0.address)

      // user0 should have 10000e18 sUSDC
      expect(await susdc.balanceOf(user0.address)).to.equal(toWei("10000"))
    })

    it("should swap sUSDC to WETH via USDC", async () => {
      // transfer sUSDC to swapper
      await susdc.transfer(swapper.address, toWei("1000"))

      // quote swap: 1000 sUSDC => ? WETH
      const quote = await swapper.callStatic.quote(susdc.address, weth.address, toWei("1000"))
      expect(quote.quoteSuccess).to.be.true

      // expected: 1000 sUSDC = 1060 USDC = 1060/3000 WETH = 0.353333... WETH
      const expectedWeth = BigNumber.from("353333333333333333") // ~0.353333 WETH
      expect(quote.bestOutAmount).to.be.closeTo(expectedWeth, toWei("0.001"))

      // execute swap
      const result = await swapper.swapAndTransfer(
        susdc.address,
        toWei("1000"),
        weth.address,
        expectedWeth.sub(toWei("0.001")), // minAmountOut with small slippage
        user1.address,
        false
      )

      // verify swap success
      const tx = await result.wait()
      const swapSuccessEvent = tx.events?.find(e => e.event === "SwapSuccess")
      expect(swapSuccessEvent).to.not.be.undefined
      expect(swapSuccessEvent?.args?.tokenIn).to.equal(susdc.address)
      expect(swapSuccessEvent?.args?.tokenOut).to.equal(weth.address)

      // check final balances
      expect(await susdc.balanceOf(swapper.address)).to.equal(0)
      expect(await usdc.balanceOf(swapper.address)).to.equal(0)
      expect(await weth.balanceOf(user1.address)).to.be.closeTo(expectedWeth, toWei("0.001"))
    })

    it("should handle swap failure by returning sUSDC", async () => {
      // transfer sUSDC to swapper
      await susdc.transfer(swapper.address, toWei("1000"))

      // try swap with unrealistic minAmountOut
      const result = await swapper.swapAndTransfer(
        susdc.address,
        toWei("1000"),
        weth.address,
        toWei("10"), // impossible amount
        user1.address,
        false
      )

      // verify swap failed and sUSDC was returned
      const tx = await result.wait()
      const swapFailedEvent = tx.events?.find(e => e.event === "SwapFailed")
      expect(swapFailedEvent).to.not.be.undefined

      // sUSDC should be transferred to user1
      expect(await susdc.balanceOf(user1.address)).to.equal(toWei("1000"))
      expect(await susdc.balanceOf(swapper.address)).to.equal(0)
      expect(await usdc.balanceOf(swapper.address)).to.equal(0)
    })
  })

  describe("WETH => sUSDC swaps", () => {
    beforeEach(async () => {
      // mint WETH to swapper
      await weth.deposit({ from: user0.address, value: toWei("10") })
      await weth.transfer(swapper.address, toWei("10"))
    })

    it("should swap WETH to sUSDC via USDC", async () => {
      // quote swap: 1 WETH => ? sUSDC
      const quote = await swapper.callStatic.quote(weth.address, susdc.address, toWei("1"))
      expect(quote.quoteSuccess).to.be.true

      // expected: 1 WETH = 3000 USDC = 3000/1.06 sUSDC = ~2830.188679 sUSDC
      const expectedSusdc = BigNumber.from("2830188679245283018867") // ~2830.188679 sUSDC
      expect(quote.bestOutAmount).to.be.closeTo(expectedSusdc, toWei("1"))

      // execute swap
      const result = await swapper.swapAndTransfer(
        weth.address,
        toWei("1"),
        susdc.address,
        expectedSusdc.sub(toWei("1")), // minAmountOut with small slippage
        user1.address,
        false
      )

      // verify swap success
      const tx = await result.wait()
      const swapSuccessEvent = tx.events?.find(e => e.event === "SwapSuccess")
      expect(swapSuccessEvent).to.not.be.undefined
      expect(swapSuccessEvent?.args?.tokenIn).to.equal(weth.address)
      expect(swapSuccessEvent?.args?.tokenOut).to.equal(susdc.address)

      // check final balances
      expect(await weth.balanceOf(swapper.address)).to.equal(toWei("9"))
      expect(await usdc.balanceOf(swapper.address)).to.equal(0)
      expect(await susdc.balanceOf(user1.address)).to.be.closeTo(expectedSusdc, toWei("1"))
    })

    it("should handle no path for sUSDC correctly", async () => {
      // clear USDC => WETH path to test missing path handling
      await swapper.setSwapPath(usdc.address, weth.address, [])

      // transfer sUSDC to swapper
      await usdc.mint(user0.address, toUnit("1060", 6))
      await usdc.approve(susdc.address, toUnit("1060", 6))
      await susdc.deposit(toUnit("1060", 6), user0.address)
      await susdc.transfer(swapper.address, toWei("1000"))

      // try swap - should fail due to missing path and return sUSDC
      const result = await swapper.swapAndTransfer(
        susdc.address,
        toWei("1000"),
        weth.address,
        0,
        user1.address,
        false
      )

      // verify path missing event
      const tx = await result.wait()
      const missingPathEvent = tx.events?.find(e => e.event === "MissingSwapPath")
      expect(missingPathEvent).to.not.be.undefined

      // sUSDC should be returned to user1
      expect(await susdc.balanceOf(user1.address)).to.equal(toWei("1000"))
      expect(await susdc.balanceOf(swapper.address)).to.equal(0)
    })
  })

  describe("Price accuracy verification", () => {
    it("should maintain price accuracy through sUSDC wrapping", async () => {
      // test round-trip: WETH => sUSDC => WETH
      const initialWeth = toWei("1")

      // step 1: quote WETH => sUSDC
      const quoteToSusdc = await swapper.callStatic.quote(weth.address, susdc.address, initialWeth)
      const susdcAmount = quoteToSusdc.bestOutAmount

      // step 2: quote sUSDC => WETH
      const quoteToWeth = await swapper.callStatic.quote(susdc.address, weth.address, susdcAmount)
      const finalWeth = quoteToWeth.bestOutAmount

      // round-trip should be close to original (small loss due to conversion)
      expect(finalWeth).to.be.closeTo(initialWeth, toWei("0.001"))
    })

    it("should correctly calculate minAmountOut for sUSDC", async () => {
      // prepare: mint WETH to swapper
      await weth.deposit({ value: toWei("1") })
      await weth.transfer(swapper.address, toWei("1"))

      // calculate expected sUSDC for 1 WETH
      // 1 WETH = 3000 USDC = 3000/1.06 sUSDC = ~2830.188679 sUSDC
      const minSusdc = BigNumber.from("2830000000000000000000") // 2830 sUSDC (with slippage tolerance)

      // execute swap with specific minAmountOut
      const result = await swapper.swapAndTransfer(
        weth.address,
        toWei("1"),
        susdc.address,
        minSusdc,
        user1.address,
        false
      )

      // verify success
      const tx = await result.wait()
      const swapSuccessEvent = tx.events?.find(e => e.event === "SwapSuccess")
      expect(swapSuccessEvent).to.not.be.undefined

      // verify received amount meets minimum
      const receivedSusdc = await susdc.balanceOf(user1.address)
      expect(receivedSusdc).to.be.gte(minSusdc)
    })
  })

  describe("Edge cases", () => {
    it("should handle sUSDC to sUSDC swap (no-op)", async () => {
      // mint sUSDC to swapper
      await usdc.mint(user0.address, toUnit("1060", 6))
      await usdc.approve(susdc.address, toUnit("1060", 6))
      await susdc.deposit(toUnit("1060", 6), swapper.address)

      const susdcAmount = await susdc.balanceOf(swapper.address)

      // swap sUSDC to sUSDC (should just transfer)
      await swapper.swapAndTransfer(
        susdc.address,
        susdcAmount,
        susdc.address,
        0,
        user1.address,
        false
      )

      // should just transfer without swapping
      expect(await susdc.balanceOf(user1.address)).to.equal(susdcAmount)
      expect(await susdc.balanceOf(swapper.address)).to.equal(0)
    })

    it("should handle swap when sUSDC is not configured", async () => {
      // deploy new swapper without sUSDC configuration
      const newSwapper = (await createContract("Swapper", [])) as Swapper
      await newSwapper.initialize(weth.address)
      await newSwapper.grantRole(await newSwapper.SET_ROUTE_ROLE(), user0.address)
      await newSwapper.setUniswap3(uniswap3.address, uniswap3.address)

      // setup USDC => WETH path
      await newSwapper.setSwapPath(usdc.address, weth.address, [
        "0x" + SWAPPER_UNI3 + usdc.address.slice(2) + UNI_FEE_005 + weth.address.slice(2),
      ])

      // mint USDC to newSwapper
      await usdc.mint(newSwapper.address, toUnit("3000", 6))

      // normal USDC => WETH swap should work
      await newSwapper.swapAndTransfer(
        usdc.address,
        toUnit("3000", 6),
        weth.address,
        toWei("0.9"),
        user1.address,
        false
      )

      expect(await weth.balanceOf(user1.address)).to.equal(toWei("1"))
    })
  })
})