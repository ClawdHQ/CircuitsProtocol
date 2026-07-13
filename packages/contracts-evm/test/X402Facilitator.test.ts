import { expect } from "chai";
import { ethers } from "hardhat";
import type { X402Facilitator, MockUSDC } from "../typechain-types";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const KEY = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function deployFixture() {
  const [owner, facilitatorSigner, payer, recipient, other] = await ethers.getSigners();

  const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const usdc = (await MockUSDCFactory.deploy()) as unknown as MockUSDC;

  const FacilitatorFactory = await ethers.getContractFactory("X402Facilitator");
  const facilitator = (await FacilitatorFactory.deploy(
    await owner.getAddress(),
    await usdc.getAddress(),
    await facilitatorSigner.getAddress()
  )) as unknown as X402Facilitator;

  await usdc.mint(await payer.getAddress(), USDC(1_000));
  await usdc.connect(payer).approve(await facilitator.getAddress(), USDC(1_000));

  return { owner, facilitatorSigner, payer, recipient, other, usdc, facilitator };
}

describe("X402Facilitator", () => {
  it("pulls an allowance-backed payment and emits PaymentPulled", async () => {
    const { facilitatorSigner, payer, recipient, usdc, facilitator } = await deployFixture();

    await expect(
      facilitator.connect(facilitatorSigner).pullPayment(await payer.getAddress(), await recipient.getAddress(), USDC(5), KEY("call-1"))
    )
      .to.emit(facilitator, "PaymentPulled")
      .withArgs(await payer.getAddress(), await recipient.getAddress(), USDC(5), KEY("call-1"));

    expect(await usdc.balanceOf(await recipient.getAddress())).to.equal(USDC(5));
    expect(await usdc.balanceOf(await payer.getAddress())).to.equal(USDC(995));
  });

  it("rejects a reused idempotency key rather than double-pulling", async () => {
    const { facilitatorSigner, payer, recipient, facilitator } = await deployFixture();

    await facilitator.connect(facilitatorSigner).pullPayment(await payer.getAddress(), await recipient.getAddress(), USDC(5), KEY("call-1"));

    await expect(
      facilitator.connect(facilitatorSigner).pullPayment(await payer.getAddress(), await recipient.getAddress(), USDC(5), KEY("call-1"))
    ).to.be.revertedWithCustomError(facilitator, "IdempotencyKeyAlreadyUsed");
  });

  it("rejects a pull from anyone but the authorized facilitator signer", async () => {
    const { payer, recipient, other, facilitator } = await deployFixture();

    await expect(
      facilitator.connect(other).pullPayment(await payer.getAddress(), await recipient.getAddress(), USDC(5), KEY("call-1"))
    ).to.be.revertedWithCustomError(facilitator, "NotFacilitator");
  });

  it("reverts on insufficient allowance, standard ERC20 behavior", async () => {
    const { facilitatorSigner, payer, recipient, facilitator } = await deployFixture();

    await expect(
      facilitator.connect(facilitatorSigner).pullPayment(await payer.getAddress(), await recipient.getAddress(), USDC(5_000), KEY("call-1"))
    ).to.be.reverted;
  });

  it("kill switch blocks new pulls without touching existing allowances", async () => {
    const { owner, facilitatorSigner, payer, recipient, usdc, facilitator } = await deployFixture();

    await facilitator.connect(owner).setPaused(true);
    await expect(
      facilitator.connect(facilitatorSigner).pullPayment(await payer.getAddress(), await recipient.getAddress(), USDC(5), KEY("call-1"))
    ).to.be.revertedWithCustomError(facilitator, "FacilitatorPaused");

    expect(await usdc.allowance(await payer.getAddress(), await facilitator.getAddress())).to.equal(USDC(1_000));

    await facilitator.connect(owner).setPaused(false);
    await expect(
      facilitator.connect(facilitatorSigner).pullPayment(await payer.getAddress(), await recipient.getAddress(), USDC(5), KEY("call-1"))
    ).to.emit(facilitator, "PaymentPulled");
  });

  it("only the owner can rotate the facilitator signer or the kill switch", async () => {
    const { other, facilitator } = await deployFixture();

    await expect(facilitator.connect(other).setFacilitator(await other.getAddress())).to.be.revertedWithCustomError(
      facilitator,
      "OwnableUnauthorizedAccount"
    );
    await expect(facilitator.connect(other).setPaused(true)).to.be.revertedWithCustomError(facilitator, "OwnableUnauthorizedAccount");
  });

  it("lets the owner rotate the facilitator signer", async () => {
    const { owner, payer, recipient, other, facilitator } = await deployFixture();

    await facilitator.connect(owner).setFacilitator(await other.getAddress());
    await expect(facilitator.connect(other).pullPayment(await payer.getAddress(), await recipient.getAddress(), USDC(5), KEY("call-1"))).to
      .emit(facilitator, "PaymentPulled");
  });
});
