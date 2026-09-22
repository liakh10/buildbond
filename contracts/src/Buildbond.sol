// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Pons V2 on Robinhood Chain, the parts Buildbond calls. Addresses verified on chain 4663.
struct PonsSocials { string twitter; string telegram; string discord; string website; string farcaster; }
struct PonsLaunchParams {
    string name; string symbol; string logo; string description; PonsSocials socials;
    address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt;
}
struct PonsLaunchedToken {
    address token; address curve; address deployer; address creatorFeeRecipient; address pairToken;
    uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled;
    uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists;
}
interface IPonsFactory {
    function launchFee() external view returns (uint256);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function launchToken(PonsLaunchParams calldata params, uint256 launchConfigId, address pairToken) external payable returns (address token, address curve);
    function getLaunchedToken(address token) external view returns (PonsLaunchedToken memory);
    function memeHook() external view returns (address);
}
interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sweepFees(uint256 minBuybackTokensOut) external;
}
interface IPonsEscrow {
    function balanceOf(address) external view returns (uint256);
    function claim() external;
    function balanceOfToken(address who, address token) external view returns (uint256);
    function claimToken(address token) external;
}
interface IERC20B { function balanceOf(address) external view returns (uint256); function transfer(address, uint256) external returns (bool); }
struct PoolKeyB { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct SwapParamsB { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface IPoolManagerB {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKeyB memory key, SwapParamsB memory params, bytes calldata hookData) external returns (int256);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}
library BAddrs {
    address internal constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant MIN_SQRT = 4295128740;
}
interface IBondFactoryV { function builder() external view returns (address); }

/// @title Buildbond vault
/// One per coin. Pons pays the coin's creator fees here, and `harvest` splits every wei that arrives:
///   60% stays as the agent's build budget,
///   25% goes to the factory, which buys $BOND with it and burns it,
///   15% is owed to the launcher, who claims it.
/// The budget has one way out: `bill`, which only the platform's builder can call, pays for agent usage with the hash
/// of the usage receipt, at most MAX_BILL per call and DAILY_CAP per day. Nobody can withdraw the budget, the launcher
/// included. The launch stake is refunded when the first version ships, or after STAKE_WAIT if nothing ever ships.
contract BondVault {
    uint256 public constant BUDGET_BPS = 6000;
    uint256 public constant BURN_BPS = 2500;
    uint256 public constant MAX_BILL = 0.02 ether;
    uint256 public constant DAILY_CAP = 0.05 ether;
    uint256 public constant STAKE_WAIT = 30 days;

    address public factory;
    address public launcher;
    address public coin;
    uint64 public launchedAt;
    string public brief;

    uint256 public stake;
    bool public stakeSettled;
    uint256 public budget;
    uint256 public launcherOwed;
    uint256 public totalHarvested;
    uint256 public totalToppedUp;
    uint256 public totalBilled;
    uint256 public totalToBurn;
    uint256 public totalToLauncher;
    uint256 public totalCoinBurned;
    uint32 public version;
    mapping(uint256 => uint256) public billedOn;
    bool internal _entered;

    event Harvested(uint256 eth, uint256 toBudget, uint256 toBurn, uint256 toLauncher, uint256 coinBurned, address caller);
    event ToppedUp(address indexed from, uint256 amount);
    event Billed(uint256 amount, bytes32 indexed receipt, uint256 budgetLeft);
    event Shipped(uint32 indexed version, bytes32 commit, string url);
    event StakeReturned(address indexed to, uint256 amount, bool shipped);
    event ShareClaimed(address indexed to, uint256 amount);
    event LauncherChanged(address indexed previous, address indexed next);

    modifier nonReentrant() { require(!_entered, "reentrant"); _entered = true; _; _entered = false; }
    modifier onlyBuilder() { require(msg.sender == IBondFactoryV(factory).builder(), "builder"); _; }

    function initialize(address _launcher, address _coin, string calldata _brief) external payable {
        require(factory == address(0), "initialized");
        require(_launcher != address(0) && _coin != address(0), "zero");
        factory = msg.sender; launcher = _launcher; coin = _coin; brief = _brief;
        launchedAt = uint64(block.timestamp); stake = msg.value;
    }

    /// Fees arrive from the Pons escrow inside `harvest` and are counted there. Anything else sent here is a top-up:
    /// it goes straight into the build budget, which is how anyone relights a dormant app.
    receive() external payable {
        if (msg.sender == BAddrs.ESCROW) return;
        budget += msg.value; totalToppedUp += msg.value;
        emit ToppedUp(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ fees in
    /// Anyone can call it. Moves the curve's accrued creator tax into the escrow, claims it, and splits it. Fees that
    /// arrive as the coin itself are burned.
    function harvest() external nonReentrant returns (uint256 eth) {
        IPonsEscrow esc = IPonsEscrow(BAddrs.ESCROW);
        address curve = IPonsFactory(BAddrs.PONS).getLaunchedToken(coin).curve;
        if (curve.code.length > 0) { try IPonsCurve(curve).sweepFees(0) {} catch {} }
        uint256 before = address(this).balance;
        if (esc.balanceOf(address(this)) > 0) esc.claim();
        eth = address(this).balance - before;
        uint256 coinBurned;
        if (esc.balanceOfToken(address(this), coin) > 0) {
            uint256 c0 = IERC20B(coin).balanceOf(address(this));
            esc.claimToken(coin);
            coinBurned = IERC20B(coin).balanceOf(address(this)) - c0;
            if (coinBurned > 0) require(IERC20B(coin).transfer(BAddrs.DEAD, coinBurned), "burn");
        }
        uint256 toBudget = eth * BUDGET_BPS / 10_000;
        uint256 toBurn = eth * BURN_BPS / 10_000;
        uint256 toLauncher = eth - toBudget - toBurn;
        budget += toBudget; launcherOwed += toLauncher;
        totalHarvested += eth; totalToBurn += toBurn; totalToLauncher += toLauncher; totalCoinBurned += coinBurned;
        if (toBurn > 0) { (bool ok,) = factory.call{value: toBurn}(""); require(ok, "burn share"); }
        emit Harvested(eth, toBudget, toBurn, toLauncher, coinBurned, msg.sender);
    }
    function waitingInEscrow() external view returns (uint256) { return IPonsEscrow(BAddrs.ESCROW).balanceOf(address(this)); }

    // ------------------------------------------------------------------ the builder
    /// Pays the builder for agent usage out of the budget. `receipt` is the sha256 of the usage record the site
    /// publishes for this run, so every bill can be checked against what the agent actually did.
    function bill(uint256 amount, bytes32 receipt) external onlyBuilder nonReentrant {
        require(amount > 0 && amount <= MAX_BILL, "bill size");
        require(amount <= budget, "over budget");
        uint256 d = block.timestamp / 1 days;
        require(billedOn[d] + amount <= DAILY_CAP, "daily cap");
        billedOn[d] += amount; budget -= amount; totalBilled += amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
        emit Billed(amount, receipt, budget);
    }

    /// Records a shipped version. The first one returns the launch stake to the launcher.
    function ship(uint32 v, bytes32 commit, string calldata url) external onlyBuilder nonReentrant {
        require(v == version + 1, "version");
        version = v;
        emit Shipped(v, commit, url);
        if (v == 1) _returnStake(true);
    }

    // ------------------------------------------------------------------ the launcher
    function claimShare() external nonReentrant {
        uint256 a = launcherOwed;
        require(a > 0, "nothing owed");
        launcherOwed = 0;
        (bool ok,) = launcher.call{value: a}("");
        require(ok, "send");
        emit ShareClaimed(launcher, a);
    }
    /// If nothing has shipped STAKE_WAIT after the launch, the launcher takes the stake back.
    function reclaimStake() external nonReentrant {
        require(version == 0 && block.timestamp >= launchedAt + STAKE_WAIT, "not yet");
        _returnStake(false);
    }
    function setLauncher(address next) external {
        require(msg.sender == launcher && next != address(0), "launcher");
        emit LauncherChanged(launcher, next);
        launcher = next;
    }
    function _returnStake(bool shipped) internal {
        if (stakeSettled) return;
        stakeSettled = true;
        uint256 s = stake;
        if (s == 0) return;
        /* a launcher that refuses ETH does not block the ship; its stake joins the budget instead */
        (bool ok,) = launcher.call{value: s}("");
        if (ok) emit StakeReturned(launcher, s, shipped);
        else { budget += s; emit ToppedUp(address(this), s); }
    }

    struct State {
        address launcher; address coin; uint64 launchedAt; string brief; uint256 stake; bool stakeSettled;
        uint256 budget; uint256 launcherOwed; uint256 waiting; uint256 totalHarvested; uint256 totalToppedUp;
        uint256 totalBilled; uint256 totalToBurn; uint256 totalToLauncher; uint256 totalCoinBurned; uint32 version; uint256 billedToday;
    }
    function state() external view returns (State memory) {
        return State(launcher, coin, launchedAt, brief, stake, stakeSettled, budget, launcherOwed,
            IPonsEscrow(BAddrs.ESCROW).balanceOf(address(this)), totalHarvested, totalToppedUp, totalBilled,
            totalToBurn, totalToLauncher, totalCoinBurned, version, billedOn[block.timestamp / 1 days]);
    }
}

/// @title Buildbond factory
/// Launches coins on Pons with a vault as the creator fee recipient, and burns $BOND with the 25% every vault sends it.
/// The guardian names $BOND once, and can change the builder only through a 48 hour timelock. The factory keeps no fee.
contract BondFactory {
    uint256 public constant STAKE = 0.01 ether;
    uint16 public constant CREATOR_TAX_BPS = 100;
    uint256 public constant BUILDER_DELAY = 48 hours;
    uint256 public constant MAX_BRIEF = 600;

    address public immutable vaultImpl;
    address public guardian;
    address public pendingGuardian;
    address public builder;
    address public nextBuilder;
    uint64 public nextBuilderAt;
    address public bondToken;

    uint256 public totalReceived;
    uint256 public totalBurnedEth;
    uint256 public totalBurnedBond;

    struct Entry { address vault; address launcher; address coin; uint64 launchedAt; }
    Entry[] internal _entries;
    mapping(address => bool) public isVault;
    mapping(address => address) public vaultOf;
    bool internal _entered;

    event Launched(address indexed vault, address indexed launcher, address indexed coin, string name, string symbol, string brief);
    event BurnShare(address indexed vault, uint256 amount);
    event Burned(uint256 ethIn, uint256 bondBurned, bytes32 attestation);
    event BondTokenSet(address token);
    event BuilderProposed(address builder, uint64 activeAt);
    event BuilderSet(address builder);
    event GuardianTransferred(address indexed previous, address indexed next);

    modifier onlyGuardian() { require(msg.sender == guardian, "guardian"); _; }
    modifier nonReentrant() { require(!_entered, "reentrant"); _entered = true; _; _entered = false; }

    constructor(address _vaultImpl, address _builder) {
        require(_vaultImpl != address(0) && _builder != address(0), "zero");
        vaultImpl = _vaultImpl; builder = _builder; guardian = msg.sender;
    }

    receive() external payable {
        if (msg.sender == BAddrs.POOL_MANAGER) return;
        totalReceived += msg.value;
        emit BurnShare(msg.sender, msg.value);
    }

    /// msg.value = Pons launch fee + STAKE + an optional first buy, which goes to the launcher.
    function launch(string calldata name, string calldata symbol, string calldata logo, string calldata brief, uint256 minFirstBuyOut)
        external payable nonReentrant returns (address vault, address coin)
    {
        require(bytes(name).length > 0 && bytes(name).length <= 32 && bytes(symbol).length > 0 && bytes(symbol).length <= 10, "name");
        require(bytes(brief).length >= 20 && bytes(brief).length <= MAX_BRIEF, "brief");
        IPonsFactory pons = IPonsFactory(BAddrs.PONS);
        uint256 fee = pons.launchFee();
        require(msg.value >= fee + STAKE, "fee and stake");
        uint256 firstBuy = msg.value - fee - STAKE;
        vault = _clone(vaultImpl);
        PonsLaunchParams memory p = PonsLaunchParams({
            name: name, symbol: symbol, logo: logo, description: brief, socials: PonsSocials("", "", "", "", ""),
            creatorFeeRecipient: vault, creatorTaxBps: CREATOR_TAX_BPS, buybackEnabled: false,
            expectedEconomics: pons.previewLaunchEconomics(0, address(0)), salt: keccak256(abi.encode(vault, _entries.length))
        });
        address curve;
        (coin, curve) = pons.launchToken{value: fee}(p, 0, address(0));
        BondVault(payable(vault)).initialize{value: STAKE}(msg.sender, coin, brief);
        if (firstBuy > 0) IPonsCurve(curve).buy{value: firstBuy}(firstBuy, minFirstBuyOut, msg.sender);
        _entries.push(Entry(vault, msg.sender, coin, uint64(block.timestamp)));
        isVault[vault] = true; vaultOf[coin] = vault;
        emit Launched(vault, msg.sender, coin, name, symbol, brief);
    }

    /// Buys $BOND with the burn pool and sends it to the dead address. On the Pons curve before graduation, in the
    /// Uniswap v4 pool after. `attestation` is the sha256 of the list of harvests this burn spends, published by the site.
    function burn(uint256 amount, uint256 minOut, bytes32 attestation) external nonReentrant returns (uint256 burned) {
        require(msg.sender == builder || msg.sender == guardian, "keeper");
        require(bondToken != address(0), "no bond token yet");
        require(amount > 0 && amount <= address(this).balance && minOut > 0, "amount");
        uint256 deadBefore = IERC20B(bondToken).balanceOf(BAddrs.DEAD);
        uint256 ethBefore = address(this).balance;
        PonsLaunchedToken memory lt = IPonsFactory(BAddrs.PONS).getLaunchedToken(bondToken);
        if (lt.phase < 2) IPonsCurve(lt.curve).buy{value: amount}(amount, minOut, BAddrs.DEAD);
        else IPoolManagerB(BAddrs.POOL_MANAGER).unlock(abi.encode(PoolKeyB(address(0), bondToken, lt.poolFee, lt.tickSpacing, IPonsFactory(BAddrs.PONS).memeHook()), amount));
        burned = IERC20B(bondToken).balanceOf(BAddrs.DEAD) - deadBefore;
        uint256 spent = ethBefore - address(this).balance;
        require(burned >= minOut && spent <= amount, "min out");
        totalBurnedEth += spent; totalBurnedBond += burned;
        emit Burned(spent, burned, attestation);
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == BAddrs.POOL_MANAGER && _entered, "pool manager");
        (PoolKeyB memory key, uint256 amountIn) = abi.decode(data, (PoolKeyB, uint256));
        IPoolManagerB pm = IPoolManagerB(BAddrs.POOL_MANAGER);
        int256 d = pm.swap(key, SwapParamsB(true, -int256(amountIn), BAddrs.MIN_SQRT + 1), "");
        int128 paid = int128(d >> 128); int128 got = int128(d);
        require(paid < 0 && uint256(uint128(-paid)) <= amountIn && got > 0, "swap");
        pm.settle{value: uint256(uint128(-paid))}();
        pm.take(key.currency1, BAddrs.DEAD, uint256(uint128(got)));
        return "";
    }

    // ------------------------------------------------------------------ guardian
    function setBondToken(address token) external onlyGuardian {
        require(bondToken == address(0), "already set");
        require(IPonsFactory(BAddrs.PONS).getLaunchedToken(token).exists, "not a Pons coin");
        bondToken = token;
        emit BondTokenSet(token);
    }
    function proposeBuilder(address next) external onlyGuardian {
        require(next != address(0), "zero");
        nextBuilder = next; nextBuilderAt = uint64(block.timestamp + BUILDER_DELAY);
        emit BuilderProposed(next, nextBuilderAt);
    }
    function activateBuilder() external {
        require(nextBuilder != address(0) && block.timestamp >= nextBuilderAt, "wait");
        builder = nextBuilder; nextBuilder = address(0); nextBuilderAt = 0;
        emit BuilderSet(builder);
    }
    function transferGuardian(address next) external onlyGuardian { pendingGuardian = next; }
    function acceptGuardian() external {
        require(msg.sender == pendingGuardian, "pending");
        emit GuardianTransferred(guardian, msg.sender);
        guardian = msg.sender; pendingGuardian = address(0);
    }

    // ------------------------------------------------------------------ reading
    function count() external view returns (uint256) { return _entries.length; }
    function entries(uint256 from, uint256 n) external view returns (Entry[] memory out) {
        uint256 total = _entries.length;
        if (from >= total) return new Entry[](0);
        uint256 end = from + n > total ? total : from + n;
        out = new Entry[](end - from);
        for (uint256 i = from; i < end; i++) out[i - from] = _entries[i];
    }
    function burnPool() external view returns (uint256) { return address(this).balance; }

    function _clone(address impl) internal returns (address inst) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            inst := create(0, ptr, 0x37)
        }
        require(inst != address(0), "clone");
    }
}
