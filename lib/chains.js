/* Buildbond lives on Robinhood Chain only. */
export const CHAINS = {
  4663: {
    id: 4663, key: 'robinhood', name: 'Robinhood Chain', short: 'Robinhood',
    /* window.DEV_RPC exists only when dev.mjs serves the page against contracts/devchain.mjs */
    rpc: typeof window !== 'undefined' && window.DEV_RPC && /^(localhost|127\.)/.test(location.hostname) ? [window.DEV_RPC] : ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'],
    explorer: 'https://robinhoodchain.blockscout.com', dex: 'robinhood'
  }
};
export const CHAIN_IDS = [4663];
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export function viemChain(id) {
  const c = CHAINS[id];
  return {
    id: c.id, name: c.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: c.rpc } }, blockExplorers: { default: { name: 'Blockscout', url: c.explorer } },
    contracts: { multicall3: { address: MULTICALL3 } }
  };
}
export const explorer = (id, kind, v) => `${CHAINS[id].explorer}/${kind}/${v}`;
