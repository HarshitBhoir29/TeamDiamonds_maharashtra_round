const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function main() {
  const [owner, beneficiary, g1, g2, g3] = await ethers.getSigners();
  const heirloom = await ethers.deployContract("Heirloom", [true]);
  const log = (m) => console.log("→", m);

  await heirloom.connect(owner).createPlan(beneficiary.address, [g1.address, g2.address, g3.address], 2, 60, 120);
  log("Plan created (2-of-3, inactivity 60s, grace 120s)");

  const hash = ethers.keccak256(ethers.toUtf8Bytes("pretend-encrypted-bytes"));
  await heirloom.connect(owner).addAsset(1, hash, "ipfs://QmEncryptedWill");
  log("Encrypted asset registered");

  await heirloom.connect(owner).simulateInactivity();
  log("Inactivity simulated");

  await heirloom.connect(g1).startRecovery(owner.address);
  await heirloom.connect(g1).approveRecovery(owner.address);
  await heirloom.connect(g2).approveRecovery(owner.address);
  log("Recovery started, 2 guardians approved → quorum reached, grace period running");

  await time.increase(121);
  await heirloom.connect(beneficiary).finalizeRecovery(owner.address);
  log("Grace period elapsed, beneficiary finalized");
  log("isReleasedTo(beneficiary) = " + (await heirloom.isReleasedTo(owner.address, beneficiary.address)));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
