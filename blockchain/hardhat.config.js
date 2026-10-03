require("@nomicfoundation/hardhat-toolbox"); // Hardhat + ethers v6 + chai tests + verify plugin
require("dotenv").config();                  // loads secrets from .env

const { SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: {}, // built-in local test chain
    // Only register Sepolia if credentials exist, so local tests work without .env
    ...(SEPOLIA_RPC_URL && PRIVATE_KEY
      ? { sepolia: { url: SEPOLIA_RPC_URL, accounts: [PRIVATE_KEY], chainId: 11155111 } }
      : {}),
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
};