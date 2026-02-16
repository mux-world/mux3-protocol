import { ethers, waffle } from "hardhat"
import "@nomiclabs/hardhat-waffle"
import { expect } from "chai"
import { toWei, createContract, toUnit } from "../scripts/deployUtils"
import { MockBalancer2, MockUniswap3, Swapper } from "../typechain"

const SWAPPER_UNI3 = "00"
const SWAPPER_BAL2 = "01"
const UNI_FEE_005 = "0001f4"

describe("Swapper", () => {
  let user0: any
  let user1: any
  let user2: any

  let uniswap3: MockUniswap3
  let balancer2: MockBalancer2
  let swapper: Swapper

  let usdc: any
  let weth: any
  let wbtc: any
  let arb: any

  before(async () => {
    const signers = await ethers.getSigners()
    user0 = signers[0]
    user1 = signers[1]
    user2 = signers[2]
  })

  beforeEach(async () => {
    usdc = await createContract("MockERC20", ["USDC", "USDC", 18])
    weth = await createContract("WETH9", [])
    wbtc = await createContract("MockERC20", ["WBTC", "WBTC", 18])
    arb = await createContract("MockERC20", ["ARB", "ARB", 18])

    uniswap3 = (await createContract("MockUniswap3", [
      usdc.address,
      weth.address,
      wbtc.address,
      arb.address,
    ])) as MockUniswap3
    balancer2 = (await createContract("MockBalancer2", [
      usdc.address,
      weth.address,
      wbtc.address,
      arb.address,
    ])) as MockBalancer2
    swapper = (await createContract("Swapper", [])) as Swapper
    await swapper.initialize(weth.address)
    await swapper.grantRole(await swapper.SET_ROUTE_ROLE(), user0.address)
    await swapper.setUniswap3(uniswap3.address, uniswap3.address)
    await swapper.setBalancer2(balancer2.address)
  })

  it("uniswap3 swap weth=>usdc", async () => {
    await swapper.setSwapPath(weth.address, usdc.address, [
      "0x" + SWAPPER_UNI3 + weth.address.slice(2) + UNI_FEE_005 + usdc.address.slice(2),
    ])
    await usdc.mint(uniswap3.address, toWei("10000"))

    await weth.deposit({ value: toWei("1") })
    await weth.transfer(swapper.address, toWei("1"))
    expect(await weth.balanceOf(swapper.address)).to.equal(toWei("1"))
    expect(await usdc.balanceOf(user0.address)).to.equal(toWei("0"))

    await swapper.swapAndTransfer(weth.address, toWei("1"), usdc.address, toUnit("3000", 6), user0.address, false)
    expect(await weth.balanceOf(swapper.address)).to.equal(toWei("0"))
    expect(await usdc.balanceOf(user0.address)).to.equal(toUnit("3000", 6))
  })

  it("uniswap3 swap usdc=>weth", async () => {
    await swapper.setSwapPath(usdc.address, weth.address, [
      "0x" + SWAPPER_UNI3 + usdc.address.slice(2) + UNI_FEE_005 + weth.address.slice(2),
    ])
    await weth.deposit({ value: toWei("2") })
    await weth.transfer(uniswap3.address, toWei("2"))

    await usdc.mint(swapper.address, toUnit("6000", 6))
    expect(await weth.balanceOf(user1.address)).to.equal(toWei("0"))
    expect(await usdc.balanceOf(swapper.address)).to.equal(toUnit("6000", 6))

    await swapper.swapAndTransfer(usdc.address, toUnit("6000", 6), weth.address, toWei("2"), user1.address, false)
    expect(await usdc.balanceOf(swapper.address)).to.equal(toWei("0"))
    expect(await usdc.balanceOf(user1.address)).to.equal(toWei("0"))
    expect(await weth.balanceOf(user1.address)).to.equal(toWei("2"))
  })

  it("uniswap3 swap usdc=>weth, unwrap", async () => {
    await swapper.setSwapPath(usdc.address, weth.address, [
      "0x" + SWAPPER_UNI3 + usdc.address.slice(2) + UNI_FEE_005 + weth.address.slice(2),
    ])
    await weth.deposit({ value: toWei("2") })
    await weth.transfer(uniswap3.address, toWei("2"))

    await usdc.mint(swapper.address, toUnit("6000", 6))
    expect(await weth.balanceOf(user0.address)).to.equal(toWei("0"))
    expect(await usdc.balanceOf(swapper.address)).to.equal(toUnit("6000", 6))

    const rawBalance = await waffle.provider.getBalance(user1.address)
    await swapper.swapAndTransfer(usdc.address, toUnit("6000", 6), weth.address, toWei("2"), user1.address, true)
    expect(await usdc.balanceOf(swapper.address)).to.equal(toWei("0"))
    expect(await waffle.provider.getBalance(user1.address)).to.equal(rawBalance.add(toWei("2")))
  })

  it("no path", async () => {
    await usdc.mint(swapper.address, toUnit("6000", 6))
    const tx1 = await swapper.swapAndTransfer(
      usdc.address,
      toUnit("6000", 6),
      weth.address,
      toWei("2"),
      user1.address,
      false
    )
    await expect(tx1).to.emit(swapper, "MissingSwapPath").withArgs(usdc.address, weth.address)
    expect(await usdc.balanceOf(user1.address)).to.equal(toUnit("6000", 6))
  })

  it("balancer2 swap weth=>usdc", async () => {
    /*
      struct Args {
        address[] assets;
        BatchSwapStep[] swaps;
      }
      struct BatchSwapStep {
        bytes32 poolId;
        uint256 assetInIndex;
        uint256 assetOutIndex;
        uint256 amount;
        bytes userData;
      }
    */
    const path1 =
      "0x" +
      SWAPPER_BAL2 +
      ethers.utils.defaultAbiCoder
        .encode(
          ["(address[],tuple(bytes32,uint256,uint256,uint256,bytes)[])"],
          [
            [
              [weth.address, usdc.address],
              [["0x0000000000000000000000000000000000000000000000000000000000000000", 0, 1, "0", "0x"]],
            ],
          ]
        )
        .slice(2)
    await swapper.setSwapPath(weth.address, usdc.address, [path1])
    await usdc.mint(balancer2.address, toWei("10000"))

    await weth.deposit({ value: toWei("1") })
    await weth.transfer(swapper.address, toWei("1"))
    expect(await weth.balanceOf(swapper.address)).to.equal(toWei("1"))
    expect(await usdc.balanceOf(user0.address)).to.equal(toWei("0"))

    await swapper.swapAndTransfer(weth.address, toWei("1"), usdc.address, toUnit("3000", 6), user0.address, false)
    expect(await weth.balanceOf(swapper.address)).to.equal(toWei("0"))
    expect(await usdc.balanceOf(user0.address)).to.equal(toUnit("3000", 6))
  })
})
