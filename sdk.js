/* Buildbond SDK for the apps the agent ships. One script tag, no build step:
     <script src="https://<site>/sdk.js" data-vault="0x…" data-coin="0x…" data-symbol="TIP"></script>
   Bond.connect()                 asks the wallet, switches it to Robinhood Chain, resolves to the address
   Bond.address                   the connected address or null
   Bond.balance(addr?)            the coin balance as a BigInt (18 decimals)
   Bond.isHolder(addr?)           true if the address holds any of the coin
   Bond.list(key, limit?)         shared list, newest first: [{ by, at, holder, value }]
   Bond.push(key, value, opts?)   adds to the shared list, signed by the wallet; opts.holders = holders only
   Bond.buyUrl                    where to buy the coin
   Bond.on('account', fn)         called when the wallet account changes */
(() => {
  const tag = document.currentScript;
  const origin = new URL(tag.src).origin;
  const RPC = 'https://rpc.mainnet.chain.robinhood.com';
  const CHAIN = '0x1237';
  const listeners = new Set();
  const pad = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const rpc = (method, params) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.json()).then(j => { if (j.error) throw Error(j.error.message); return j.result; });
  const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');

  const Bond = {
    vault: tag.dataset.vault, coin: tag.dataset.coin, symbol: tag.dataset.symbol || '',
    address: null,
    get buyUrl() { return 'https://www.ponsfamily.com/launchpad/' + this.coin; },
    on(ev, fn) { if (ev === 'account') listeners.add(fn); return () => listeners.delete(fn); },
    async connect() {
      const eth = window.ethereum;
      if (!eth) throw Error('No wallet found. Open this app in a wallet browser or install MetaMask or Rabby.');
      const [a] = await eth.request({ method: 'eth_requestAccounts' });
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN }] }); }
      catch (e) {
        if (e && e.code === 4902) await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CHAIN, chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] }] });
      }
      set(a);
      if (eth.on && !Bond._bound) { Bond._bound = true; eth.on('accountsChanged', x => set(x && x[0])); }
      return Bond.address;
    },
    async balance(addr) {
      const who = addr || Bond.address;
      if (!who) return 0n;
      return BigInt(await rpc('eth_call', [{ to: Bond.coin, data: '0x70a08231' + pad(who) }, 'latest']));
    },
    async isHolder(addr) { return (await Bond.balance(addr)) > 0n; },
    async list(key, limit = 50) {
      const r = await fetch(`${origin}/api/kv?vault=${Bond.vault}&key=${encodeURIComponent(key)}&limit=${limit}`).then(r => r.json());
      if (r.error) throw Error(r.error);
      return r.items;
    },
    async push(key, value, opts = {}) {
      if (!Bond.address) await Bond.connect();
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const ts = Date.now();
      const message = `Buildbond app ${Bond.vault.toLowerCase()}\nkey: ${key}\nvalue: ${await sha256(text)}\nts: ${ts}`;
      const sig = await window.ethereum.request({ method: 'personal_sign', params: [toHex(message), Bond.address] });
      const r = await fetch(`${origin}/api/kv`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vault: Bond.vault, key, value: text, address: Bond.address, ts, sig, holders: !!opts.holders }) }).then(r => r.json());
      if (r.error) throw Error(r.error);
      return r.item;
    }
  };
  function toHex(s) { return '0x' + [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join(''); }
  function set(a) { const next = a || null; if (next === Bond.address) return; Bond.address = next; listeners.forEach(fn => { try { fn(next); } catch {} }); }
  if (window.ethereum) window.ethereum.request({ method: 'eth_accounts' }).then(x => set(x && x[0])).catch(() => {});
  window.Bond = Bond;
})();
