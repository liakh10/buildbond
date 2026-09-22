/* Buildbond against a fork of Robinhood Chain mainnet: the real Pons V2 factory, curve and escrow. A coin is launched
   with its vault as the Pons fee recipient, traders buy it, the fees are harvested and split 60 / 25 / 15, the builder
   bills agent usage and ships versions, and the factory buys $BOND with its share and burns it. */
import fs from 'node:fs';
import path from 'node:path';
import { formatEther, parseAbi, keccak256, toHex } from 'viem';
import { fork, E, addr } from './fork.mjs';

const dir = path.dirname(new URL(import.meta.url).pathname);
const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
const FA = art('BondFactory'), VA = art('BondVault'), NOETH = art('NoEth');
const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', DEAD = '0x000000000000000000000000000000000000dEaD';
const PONSF = parseAbi([
  'function launchFee() view returns (uint256)',
  'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))'
]);
const CURVE = parseAbi(['function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)']);

const T = await fork(dir, [...FA.abi, ...VA.abi]);
const { ok, must, reverts, view, tx, bal, giveEth, ethBal, deploy } = T;
const guardian = addr(0xd0), builder = addr(0xb7), launcher = addr(0xa1), launcher2 = addr(0xa2), eve = addr(0xee), bob = addr(0xb0), carol = addr(0xca), builder2 = addr(0xb8), guardian2 = addr(0xd1);
for (const w of [guardian, builder, launcher, launcher2, eve, bob, carol, builder2, guardian2]) await giveEth(w, E(50));
const fee = await view(PONS, PONSF, 'launchFee');
const STAKE = E(0.01);
const BRIEF = 'A tip jar for street musicians: scan a code, leave ETH, holders get a monthly playlist of the best tipped songs.';

const IMPL = await deploy(guardian, VA, []);
const F = await deploy(guardian, FA, [IMPL, builder]);
console.log('fork block', Number(T.head.number), `· vault ${VA.deployedSize} bytes, factory ${FA.deployedSize} bytes · Pons launch fee ${formatEther(fee)} ETH`);
ok((await view(F, FA.abi, 'builder')) === builder && (await view(F, FA.abi, 'guardian')) === guardian && (await view(F, FA.abi, 'vaultImpl')) === IMPL, 'factory wired');

// ------------------------------------------------------------------ launch
await reverts(launcher, F, FA.abi, 'launch', ['Tipjar', 'TIP', '', BRIEF, 0n], 'fee and stake', 'a launch without the stake is refused', fee);
await reverts(launcher, F, FA.abi, 'launch', ['Tipjar', 'TIP', '', 'too short', 0n], 'brief', 'a brief under 20 bytes is refused', fee + STAKE);
await reverts(launcher, F, FA.abi, 'launch', ['Tipjar', 'TOOLONGTICKER', '', BRIEF, 0n], 'name', 'a ticker over 10 bytes is refused', fee + STAKE);
const L = await must(launcher, F, FA.abi, 'launch', ['Tipjar', 'TIP', 'https://example.org/t.png', BRIEF, 1n], 'the launcher launches a coin with a first buy', fee + STAKE + E(0.1));
const ev = L.logs.find(l => l.eventName === 'Launched');
const V = ev.args.vault, COIN = ev.args.coin;
const lt = await view(PONS, PONSF, 'getLaunchedToken', [COIN]);
ok(lt.exists && lt.creatorFeeRecipient === V && lt.creatorTaxBps === 100, 'Pons pays the coin\'s creator fees to the vault at 1%');
ok((await bal(COIN, launcher)) > 0n, 'the first buy landed with the launcher');
const st0 = await view(V, VA.abi, 'state');
ok(st0.launcher === launcher && st0.coin === COIN && st0.stake === STAKE && st0.brief === BRIEF && st0.version === 0 && st0.budget === 0n, 'the vault holds the stake and the brief');
ok((await ethBal(V)) === STAKE, 'the stake is the only ETH in the vault');
ok((await view(F, FA.abi, 'vaultOf', [COIN])) === V && (await view(F, FA.abi, 'isVault', [V])) && (await view(F, FA.abi, 'count')) === 1n, 'the factory lists it');
await reverts(eve, V, VA.abi, 'initialize', [eve, COIN, 'x'], 'initialized', 'a vault cannot be initialized twice');

// ------------------------------------------------------------------ fees in and split
T.now += 60n;
for (const [w, v] of [[bob, 1.5], [carol, 1]]) ok(!(await tx(w, lt.curve, CURVE, 'buy', [E(v), 1n, w], E(v))).reverted, `a trader buys with ${v} ETH`);
const fBefore = await ethBal(F);
const hv = await must(eve, V, VA.abi, 'harvest', [], 'anyone harvests the vault');
const h = hv.logs.find(l => l.eventName === 'Harvested').args;
console.log(`  harvested ${formatEther(h.eth)} ETH: budget ${formatEther(h.toBudget)}, burn ${formatEther(h.toBurn)}, launcher ${formatEther(h.toLauncher)}`);
ok(h.eth > 0n, 'the trades paid creator fees');
ok(h.toBudget === h.eth * 6000n / 10000n && h.toBurn === h.eth * 2500n / 10000n && h.toBudget + h.toBurn + h.toLauncher === h.eth, 'split 60 / 25 / 15 to the wei');
ok((await ethBal(F)) - fBefore === h.toBurn && (await view(F, FA.abi, 'totalReceived')) === h.toBurn, 'the burn share reached the factory');
ok(hv.logs.some(l => l.eventName === 'BurnShare' && l.args.vault === V && l.args.amount === h.toBurn), 'the factory logged whose share it was');
const st1 = await view(V, VA.abi, 'state');
ok(st1.budget === h.toBudget && st1.launcherOwed === h.toLauncher && (await ethBal(V)) === STAKE + h.toBudget + h.toLauncher, 'the vault accounts for every wei it holds');
const hv2 = await must(eve, V, VA.abi, 'harvest', [], 'a second harvest with nothing new');
ok(hv2.logs.find(l => l.eventName === 'Harvested').args.eth === 0n, 'and it brings nothing');

// ------------------------------------------------------------------ launcher share
const lb = await ethBal(launcher);
await must(eve, V, VA.abi, 'claimShare', [], 'anyone can push the launcher\'s share');
ok((await ethBal(launcher)) - lb === h.toLauncher && (await view(V, VA.abi, 'launcherOwed')) === 0n, 'the launcher got exactly 15%');
await reverts(eve, V, VA.abi, 'claimShare', [], 'nothing owed', 'nothing left to claim');

// ------------------------------------------------------------------ top-up
const tu = await T.exec(bob, V, '0x', E(0.05));
ok(!tu.reverted && tu.logs.some(l => l.eventName === 'ToppedUp' && l.args.amount === E(0.05)), 'anyone tops the budget up by sending ETH');
const budget = (await view(V, VA.abi, 'state')).budget;
ok(budget === h.toBudget + E(0.05), 'the top-up is budget');

// ------------------------------------------------------------------ bills
const R = keccak256(toHex('run 1 usage'));
await reverts(eve, V, VA.abi, 'bill', [E(0.001), R], 'builder', 'only the builder bills');
await reverts(launcher, V, VA.abi, 'bill', [E(0.001), R], 'builder', 'the launcher cannot bill either');
await reverts(builder, V, VA.abi, 'bill', [E(0.021), R], 'bill size', 'a bill over 0.02 ETH is refused');
await reverts(builder, V, VA.abi, 'bill', [0n, R], 'bill size', 'an empty bill is refused');
const bb = await ethBal(builder);
const b1 = await must(builder, V, VA.abi, 'bill', [E(0.0123), R], 'the builder bills agent usage');
ok((await ethBal(builder)) - bb === E(0.0123) && b1.logs.some(l => l.eventName === 'Billed' && l.args.receipt === R), 'paid with the receipt hash on chain');
ok((await view(V, VA.abi, 'budget')) === budget - E(0.0123), 'the budget went down by the bill');
await must(builder, V, VA.abi, 'bill', [E(0.02), R], 'a second bill the same day');
await reverts(builder, V, VA.abi, 'bill', [E(0.02), R], 'daily cap', 'the third one breaks the 0.05 ETH daily cap');
T.now += 86400n;
ok((await view(V, VA.abi, 'state')).billedToday === 0n, 'the cap resets the next day');
const left = await view(V, VA.abi, 'budget');
if (left < E(0.02)) await reverts(builder, V, VA.abi, 'bill', [E(0.02), R], 'over budget', 'a bill over the budget is refused');
else { await must(builder, V, VA.abi, 'bill', [left > E(0.02) ? E(0.02) : left, R], 'bill on day two'); }
ok((await view(V, VA.abi, 'totalBilled')) === (await view(V, VA.abi, 'state')).totalBilled, 'bills are totalled');

// ------------------------------------------------------------------ ship and the stake
await reverts(eve, V, VA.abi, 'ship', [1, keccak256(toHex('c1')), 'https://x/tip/'], 'builder', 'only the builder ships');
await reverts(builder, V, VA.abi, 'ship', [2, keccak256(toHex('c1')), 'https://x/tip/'], 'version', 'versions cannot skip');
const lb2 = await ethBal(launcher);
const s1 = await must(builder, V, VA.abi, 'ship', [1, keccak256(toHex('c1')), 'https://x/tip/'], 'the builder ships v1');
ok((await ethBal(launcher)) - lb2 === STAKE && s1.logs.some(l => l.eventName === 'StakeReturned' && l.args.shipped === true), 'v1 returns the stake to the launcher');
ok(s1.logs.some(l => l.eventName === 'Shipped' && l.args.version === 1 && l.args.url === 'https://x/tip/'), 'the ship is on chain with its url');
const lb3 = await ethBal(launcher);
await must(builder, V, VA.abi, 'ship', [2, keccak256(toHex('c2')), 'https://x/tip/'], 'v2 ships');
ok((await ethBal(launcher)) === lb3 && (await view(V, VA.abi, 'version')) === 2, 'the stake is returned only once');
await reverts(launcher, V, VA.abi, 'reclaimStake', [], 'not yet', 'nothing to reclaim after a ship');

// ------------------------------------------------------------------ a second coin that never ships
const L2 = await must(launcher2, F, FA.abi, 'launch', ['Quiet', 'QUIET', '', 'A coin whose app never gets built, to test the stake.', 0n], 'a second launch without a first buy', fee + STAKE);
const V2 = L2.logs.find(l => l.eventName === 'Launched').args.vault;
await reverts(launcher2, V2, VA.abi, 'reclaimStake', [], 'not yet', 'the stake is locked for 30 days');
T.now += 30n * 86400n;
const l2b = await ethBal(launcher2);
const rc = await must(eve, V2, VA.abi, 'reclaimStake', [], 'after 30 days with nothing shipped, the stake goes back');
ok((await ethBal(launcher2)) - l2b === STAKE && rc.logs.some(l => l.eventName === 'StakeReturned' && l.args.shipped === false), 'to the launcher');
const l2c = await ethBal(launcher2);
await must(builder, V2, VA.abi, 'ship', [1, keccak256(toHex('late')), 'https://x/quiet/'], 'a late v1 still ships');
ok((await ethBal(launcher2)) === l2c, 'but pays no second stake');

// ------------------------------------------------------------------ a launcher that refuses ETH
const NO = await deploy(guardian, NOETH, []);
const L3 = await must(launcher, F, FA.abi, 'launch', ['Stubborn', 'STUB', '', 'A launcher that refuses ETH must not block the ship.', 0n], 'a third launch', fee + STAKE);
const V3 = L3.logs.find(l => l.eventName === 'Launched').args.vault;
await reverts(eve, V3, VA.abi, 'setLauncher', [NO], 'launcher', 'only the launcher hands the seat over');
await must(launcher, V3, VA.abi, 'setLauncher', [NO], 'the launcher hands it to a contract that refuses ETH');
await must(builder, V3, VA.abi, 'ship', [1, keccak256(toHex('s')), 'https://x/stub/'], 'v1 still ships');
ok((await view(V3, VA.abi, 'budget')) === STAKE && (await view(V3, VA.abi, 'stakeSettled')), 'the refused stake joined the budget');

// ------------------------------------------------------------------ $BOND burns
await reverts(builder, F, FA.abi, 'burn', [E(0.001), 1n, keccak256(toHex('a'))], 'no bond token yet', 'no burn before $BOND is named');
await reverts(eve, F, FA.abi, 'setBondToken', [COIN], 'guardian', 'only the guardian names $BOND');
await reverts(guardian, F, FA.abi, 'setBondToken', [eve], 'not a Pons coin', '$BOND must be a Pons coin');
const LB = await must(guardian, F, FA.abi, 'launch', ['Buildbond', 'BOND', '', 'The platform coin; 25% of every app coin\'s fees buys it and burns it.', 0n], 'the guardian launches BOND through the factory', fee + STAKE);
const BOND = LB.logs.find(l => l.eventName === 'Launched').args.coin;
await must(guardian, F, FA.abi, 'setBondToken', [BOND], 'the guardian names $BOND');
await reverts(guardian, F, FA.abi, 'setBondToken', [COIN], 'already set', '$BOND can be named once');
const pool = await view(F, FA.abi, 'burnPool');
ok(pool === h.toBurn, 'the burn pool is the 25% share', formatEther(pool));
const A = keccak256(toHex('harvests 1'));
await reverts(eve, F, FA.abi, 'burn', [pool, 1n, A], 'keeper', 'a stranger cannot trigger the burn');
await reverts(builder, F, FA.abi, 'burn', [pool + 1n, 1n, A], 'amount', 'the burn cannot spend more than the pool');
await reverts(builder, F, FA.abi, 'burn', [pool, 0n, A], 'amount', 'a burn needs a minimum out');
await reverts(builder, F, FA.abi, 'burn', [pool, 10n ** 40n, A], null, 'a burn below its minimum reverts (the Pons curve refuses it)');
const d0 = await bal(BOND, DEAD);
const bn = await must(builder, F, FA.abi, 'burn', [pool, 1n, A], 'the keeper burns the pool');
const be = bn.logs.find(l => l.eventName === 'Burned').args;
ok((await bal(BOND, DEAD)) - d0 === be.bondBurned && be.bondBurned > 0n && be.attestation === A && be.ethIn === pool, '$BOND bought on the curve landed at the dead address');
ok((await view(F, FA.abi, 'totalBurnedBond')) === be.bondBurned && (await view(F, FA.abi, 'burnPool')) === 0n, 'burn totals recorded, pool empty');
console.log(`  burned ${be.bondBurned / 10n ** 18n} BOND for ${formatEther(be.ethIn)} ETH`);

// ------------------------------------------------------------------ builder timelock and guardian
await reverts(eve, F, FA.abi, 'proposeBuilder', [builder2], 'guardian', 'only the guardian proposes a builder');
await must(guardian, F, FA.abi, 'proposeBuilder', [builder2], 'the guardian proposes a new builder');
await reverts(eve, F, FA.abi, 'activateBuilder', [], 'wait', 'it waits 48 hours');
T.now += 48n * 3600n;
await must(eve, F, FA.abi, 'activateBuilder', [], 'anyone activates it after 48 hours');
await reverts(builder, V, VA.abi, 'bill', [E(0.001), R], 'builder', 'the old builder can no longer bill');
await must(builder2, V, VA.abi, 'ship', [3, keccak256(toHex('c3')), 'https://x/tip/'], 'the new builder ships');
await must(guardian, F, FA.abi, 'transferGuardian', [guardian2], 'guardian transfer proposed');
await reverts(eve, F, FA.abi, 'acceptGuardian', [], 'pending', 'only the named guardian accepts');
await must(guardian2, F, FA.abi, 'acceptGuardian', [], 'the new guardian accepts');
ok((await view(F, FA.abi, 'guardian')) === guardian2, 'guardian changed');
const es = await view(F, FA.abi, 'entries', [0n, 10n]);
ok(es.length === 4 && es[0].vault === V && es[3].coin === BOND, 'the factory lists all four launches in order');

T.done();
