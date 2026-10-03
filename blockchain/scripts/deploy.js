const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const demoMode = (process.env.DEMO_MODE ?? "true") === "true";
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address, "| demoMode:", demoMode);

  const heirloom = await hre.ethers.deployContract("Heirloom", [demoMode]);
  await heirloom.waitForDeployment();
  const address = await heirloom.getAddress();
  console.log("Heirloom deployed to:", address);

  // On a real network, wait a few blocks so Etherscan can see it before verifying
  if (hre.network.name !== "hardhat") {
    await heirloom.deploymentTransaction().wait(5);
  }

  // Save address + ABI so the backend (Phase 2) and frontend (Phase 3) can reuse them
  const artifact = await hre.artifacts.readArtifact("Heirloom");
  const network = await hre.ethers.provider.getNetwork();
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${hre.network.name}.json`),
    JSON.stringify(
      { network: hre.network.name, chainId: network.chainId.toString(), address, demoMode, deployer: deployer.address, abi: artifact.abi },
      null, 2
    )
  );
  console.log(`Saved deployments/${hre.network.name}.json`);
  console.log(`Verify with: npx hardhat verify --network ${hre.network.name} ${address} ${demoMode}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });