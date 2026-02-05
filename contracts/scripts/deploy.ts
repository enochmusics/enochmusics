import { ethers } from 'hardhat';

async function main() {
  const factory = await ethers.getContractFactory('Deposit');
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log('Deposit deployed to:', address);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
