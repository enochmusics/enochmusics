import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/config';

const rpcUrl = process.env.RPC_URL || '';
const privateKey = process.env.PRIVATE_KEY || '';

const config: HardhatUserConfig = {
  solidity: '0.8.24',
  networks: {
    abstractTestnet: {
      url: rpcUrl,
      accounts: privateKey ? [privateKey] : [],
    },
  },
};

export default config;
