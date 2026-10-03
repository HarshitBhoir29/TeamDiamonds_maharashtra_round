const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const INACTIVITY = 30 * DAY;
const GRACE = 2 * DAY;
const Status = { None: 0n, Pending: 1n, QuorumReached: 2n, Cancelled: 3n, Finalized: 4n };

async function deployFixture() {
  const [owner, beneficiary, g1, g2, g3, stranger] = await ethers.getSigners();
  const heirloom = await ethers.deployContract("Heirloom", [true]);
  return { heirloom, owner, beneficiary, g1, g2, g3, stranger };
}

async function planFixture() {
  const ctx = await deployFixture();
  const { heirloom, owner, beneficiary, g1, g2, g3 } = ctx;
  await heirloom.connect(owner).createPlan(
    beneficiary.address, [g1.address, g2.address, g3.address], 2, INACTIVITY, GRACE
  );
  return ctx;
}

async function inactiveFixture() {
  const ctx = await planFixture();
  await time.increase(INACTIVITY + 1);
  return ctx;
}

async function quorumFixture() {
  const ctx = await inactiveFixture();
  const { heirloom, owner, g1, g2 } = ctx;
  await heirloom.connect(g1).startRecovery(owner.address);
  await heirloom.connect(g1).approveRecovery(owner.address);
  await heirloom.connect(g2).approveRecovery(owner.address);
  return ctx;
}

describe("Heirloom", () => {
  describe("createPlan", () => {
    it("stores the plan and emits PlanCreated", async () => {
      const { heirloom, owner, beneficiary, g1, g2, g3 } = await loadFixture(deployFixture);
      await expect(
        heirloom.connect(owner).createPlan(beneficiary.address, [g1.address, g2.address, g3.address], 2, INACTIVITY, GRACE)
      ).to.emit(heirloom, "PlanCreated");
      const plan = await heirloom.getPlan(owner.address);
      expect(plan.beneficiary).to.equal(beneficiary.address);
      expect(plan.requiredApprovals).to.equal(2n);
      expect(plan.guardians.length).to.equal(3);
    });

    it("rejects a second plan from the same owner", async () => {
      const { heirloom, owner, beneficiary, g1, g2 } = await loadFixture(planFixture);
      await expect(
        heirloom.connect(owner).createPlan(beneficiary.address, [g1.address, g2.address], 2, INACTIVITY, GRACE)
      ).to.be.revertedWith("Plan already exists");
    });

    it("rejects quorum of 1 (single guardian control)", async () => {
      const { heirloom, owner, beneficiary, g1, g2 } = await loadFixture(deployFixture);
      await expect(
        heirloom.connect(owner).createPlan(beneficiary.address, [g1.address, g2.address], 1, INACTIVITY, GRACE)
      ).to.be.revertedWith("Quorum must be at least 2");
    });

    it("rejects quorum larger than guardian count", async () => {
      const { heirloom, owner, beneficiary, g1, g2 } = await loadFixture(deployFixture);
      await expect(
        heirloom.connect(owner).createPlan(beneficiary.address, [g1.address, g2.address], 3, INACTIVITY, GRACE)
      ).to.be.revertedWith("Quorum exceeds guardians");
    });

    it("rejects duplicate guardians and owner-as-guardian", async () => {
      const { heirloom, owner, beneficiary, g1 } = await loadFixture(deployFixture);
      await expect(
        heirloom.connect(owner).createPlan(beneficiary.address, [g1.address, g1.address], 2, INACTIVITY, GRACE)
      ).to.be.revertedWith("Duplicate guardian");
      await expect(
        heirloom.connect(owner).createPlan(beneficiary.address, [g1.address, owner.address], 2, INACTIVITY, GRACE)
      ).to.be.revertedWith("Guardian cannot be owner/beneficiary");
    });
  });

  describe("addAsset", () => {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("encrypted-file-bytes"));

    it("registers an asset and emits AssetAdded", async () => {
      const { heirloom, owner } = await loadFixture(planFixture);
      await expect(heirloom.connect(owner).addAsset(1, hash, "ipfs://QmEncrypted")).to.emit(heirloom, "AssetAdded");
      const a = await heirloom.getAsset(owner.address, 1);
      expect(a.assetHash).to.equal(hash);
      expect(a.storageRef).to.equal("ipfs://QmEncrypted");
    });

    it("rejects duplicate IDs and non-owners", async () => {
      const { heirloom, owner, stranger } = await loadFixture(planFixture);
      await heirloom.connect(owner).addAsset(1, hash, "ipfs://x");
      await expect(heirloom.connect(owner).addAsset(1, hash, "ipfs://x")).to.be.revertedWith("Asset ID already used");
      await expect(heirloom.connect(stranger).addAsset(2, hash, "ipfs://x")).to.be.revertedWith("No plan for caller");
    });
  });

  describe("checkIn", () => {
    it("updates lastCheckIn and emits CheckIn", async () => {
      const { heirloom, owner } = await loadFixture(planFixture);
      await time.increase(DAY);
      await expect(heirloom.connect(owner).checkIn()).to.emit(heirloom, "CheckIn");
      const plan = await heirloom.getPlan(owner.address);
      expect(plan.lastCheckIn).to.equal(BigInt(await time.latest()));
    });
  });

  describe("startRecovery", () => {
    it("fails while the owner is still active", async () => {
      const { heirloom, owner, g1 } = await loadFixture(planFixture);
      await expect(heirloom.connect(g1).startRecovery(owner.address)).to.be.revertedWith("Owner still active");
    });

    it("fails for strangers", async () => {
      const { heirloom, owner, stranger } = await loadFixture(inactiveFixture);
      await expect(heirloom.connect(stranger).startRecovery(owner.address)).to.be.revertedWith("Not guardian/beneficiary");
    });

    it("lets a guardian start it after inactivity", async () => {
      const { heirloom, owner, g1 } = await loadFixture(inactiveFixture);
      await expect(heirloom.connect(g1).startRecovery(owner.address)).to.emit(heirloom, "RecoveryStarted");
      expect((await heirloom.getRecovery(owner.address)).status).to.equal(Status.Pending);
    });

    it("can't start twice while one is active", async () => {
      const { heirloom, owner, g1 } = await loadFixture(inactiveFixture);
      await heirloom.connect(g1).startRecovery(owner.address);
      await expect(heirloom.connect(g1).startRecovery(owner.address)).to.be.revertedWith("Recovery already active");
    });
  });

  describe("approveRecovery", () => {
    it("prevents duplicate approvals", async () => {
      const { heirloom, owner, g1 } = await loadFixture(inactiveFixture);
      await heirloom.connect(g1).startRecovery(owner.address);
      await heirloom.connect(g1).approveRecovery(owner.address);
      await expect(heirloom.connect(g1).approveRecovery(owner.address)).to.be.revertedWith("Already approved");
    });

    it("rejects non-guardians", async () => {
      const { heirloom, owner, g1, beneficiary } = await loadFixture(inactiveFixture);
      await heirloom.connect(g1).startRecovery(owner.address);
      await expect(heirloom.connect(beneficiary).approveRecovery(owner.address)).to.be.revertedWith("Not a guardian");
    });

    it("reaches quorum only at 2 of 3 (one guardian is not enough)", async () => {
      const { heirloom, owner, g1, g2 } = await loadFixture(inactiveFixture);
      await heirloom.connect(g1).startRecovery(owner.address);
      await heirloom.connect(g1).approveRecovery(owner.address);
      expect((await heirloom.getRecovery(owner.address)).status).to.equal(Status.Pending);
      await expect(heirloom.connect(g2).approveRecovery(owner.address)).to.emit(heirloom, "QuorumReached");
      expect((await heirloom.getRecovery(owner.address)).status).to.equal(Status.QuorumReached);
    });
  });

  describe("finalizeRecovery", () => {
    it("fails before the grace period ends", async () => {
      const { heirloom, owner, beneficiary } = await loadFixture(quorumFixture);
      await expect(heirloom.connect(beneficiary).finalizeRecovery(owner.address)).to.be.revertedWith("Grace period not over");
    });

    it("fails without quorum", async () => {
      const { heirloom, owner, beneficiary, g1 } = await loadFixture(inactiveFixture);
      await heirloom.connect(g1).startRecovery(owner.address);
      await heirloom.connect(g1).approveRecovery(owner.address);
      await time.increase(GRACE + 1);
      await expect(heirloom.connect(beneficiary).finalizeRecovery(owner.address)).to.be.revertedWith("Quorum not reached");
    });

    it("succeeds for the beneficiary after the grace period", async () => {
      const { heirloom, owner, beneficiary } = await loadFixture(quorumFixture);
      await time.increase(GRACE + 1);
      await expect(heirloom.connect(beneficiary).finalizeRecovery(owner.address)).to.emit(heirloom, "RecoveryFinalized");
      expect(await heirloom.isReleasedTo(owner.address, beneficiary.address)).to.equal(true);
    });

    it("rejects anyone but the beneficiary", async () => {
      const { heirloom, owner, g1 } = await loadFixture(quorumFixture);
      await time.increase(GRACE + 1);
      await expect(heirloom.connect(g1).finalizeRecovery(owner.address)).to.be.revertedWith("Only beneficiary");
    });
  });

  describe("cancelRecovery", () => {
    it("owner can cancel during the grace period, blocking finalization", async () => {
      const { heirloom, owner, beneficiary } = await loadFixture(quorumFixture);
      await expect(heirloom.connect(owner).cancelRecovery()).to.emit(heirloom, "RecoveryCancelled");
      await time.increase(GRACE + 1);
      await expect(heirloom.connect(beneficiary).finalizeRecovery(owner.address)).to.be.revertedWith("Quorum not reached");
      expect(await heirloom.isReleasedTo(owner.address, beneficiary.address)).to.equal(false);
    });

    it("guardians and strangers cannot cancel", async () => {
      const { heirloom, g1, stranger } = await loadFixture(quorumFixture);
      await expect(heirloom.connect(g1).cancelRecovery()).to.be.revertedWith("No plan for caller");
      await expect(heirloom.connect(stranger).cancelRecovery()).to.be.revertedWith("No plan for caller");
    });

    it("checkIn during recovery auto-cancels it", async () => {
      const { heirloom, owner } = await loadFixture(quorumFixture);
      await expect(heirloom.connect(owner).checkIn()).to.emit(heirloom, "RecoveryCancelled");
      expect((await heirloom.getRecovery(owner.address)).status).to.equal(Status.Cancelled);
    });

    it("after cancel, a new recovery needs inactivity again", async () => {
      const { heirloom, owner, g1 } = await loadFixture(quorumFixture);
      await heirloom.connect(owner).cancelRecovery();
      await expect(heirloom.connect(g1).startRecovery(owner.address)).to.be.revertedWith("Owner still active");
    });
  });

  describe("simulateInactivity (demo mode)", () => {
    it("lets the owner skip the wait", async () => {
      const { heirloom, owner } = await loadFixture(planFixture);
      expect(await heirloom.isInactive(owner.address)).to.equal(false);
      await heirloom.connect(owner).simulateInactivity();
      expect(await heirloom.isInactive(owner.address)).to.equal(true);
    });

    it("is disabled when demoMode is false", async () => {
      const [owner, beneficiary, g1, g2] = await ethers.getSigners();
      const prod = await ethers.deployContract("Heirloom", [false]);
      await prod.connect(owner).createPlan(beneficiary.address, [g1.address, g2.address], 2, INACTIVITY, GRACE);
      await expect(prod.connect(owner).simulateInactivity()).to.be.revertedWith("Demo mode disabled");
    });
  });
});