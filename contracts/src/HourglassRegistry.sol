// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QorePQC} from "./QorePQC.sol";

/// @title Hourglass v2 — post-quantum, accountable time-lock keyper registry
/// @notice Each keyper commits to a backward hash chain of round seeds:
///             seed[r-1] = keccak256(seed[r]),  anchor = keccak256(seed[0])
///         Seed r deterministically derives that keyper's ML-KEM-1024 keypair for round r
///         (off-chain; the public keys are committed via `pkRoot`). Releasing seed r at
///         `roundTime(r)` unlocks every ciphertext sealed to round r. Revealing a seed
///         *before* its time is self-incriminating: anyone who knew it can claim half the bond.
/// @dev    Every keyper action is authorised by the keyper's registered ML-DSA-87 key
///         (pqcVerify / pqcKeyStatus precompiles) and can be relayed by anyone, so the
///         keyper's classical ECDSA key has no authority here at all (Q-Day Drill posture).
///         There is no owner and no admin function.
contract HourglassRegistry {
    // ---------------------------------------------------------------- constants
    bytes32 public constant REGISTER_TAG = keccak256("HOURGLASS_REGISTER_V1");
    bytes32 public constant EXIT_TAG = keccak256("HOURGLASS_EXIT_V1");
    bytes32 public constant WITHDRAW_TAG = keccak256("HOURGLASS_WITHDRAW_V1");
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_STEPS = 50_000; // hash-chain steps per call
    uint256 public constant REPORT_REVEAL_WINDOW = 1 days;

    uint256 public immutable minBond;
    uint256 public immutable exitDelay;

    // ---------------------------------------------------------------- storage
    struct Keyper {
        bytes32 anchor; // keccak256(seed[0])
        bytes32 pkRoot; // Merkle root of round public keys (verified off-chain)
        uint64 genesis; // unix time of round 0
        uint32 roundSeconds;
        uint32 maxRound;
        uint32 nextRound; // lowest round not yet revealed (0 = none revealed)
        bytes32 lastHash; // = anchor until the first release, then keccak(seed[nextRound-1])… see _walk
        uint128 bond;
        uint64 exitAt; // 0 = active
        bool slashed;
        bool registered;
    }

    struct Report {
        uint64 committedAt;
    }

    mapping(address => Keyper) public keypers;
    mapping(address => mapping(uint32 => bytes32)) public seedOf; // published seeds
    mapping(address => mapping(bytes32 => Report)) public reports; // reporter => commitment
    /// v2: a keyper that withdrew is retired for good. Re-registering would leave stale
    /// nextRound/exitAt and let old (public) exit/withdraw signatures be replayed.
    mapping(address => bool) public retired;

    // ---------------------------------------------------------------- events
    event KeyperRegistered(
        address indexed keyper, bytes32 anchor, bytes32 pkRoot, uint64 genesis, uint32 roundSeconds, uint32 maxRound, uint256 bond
    );
    event SeedReleased(address indexed keyper, uint32 indexed round, bytes32 seed);
    event ReportCommitted(address indexed reporter, bytes32 commitment);
    event KeyperSlashed(address indexed keyper, uint32 indexed round, bytes32 seed, address indexed reporter, uint256 reward);
    event ExitRequested(address indexed keyper, uint64 withdrawableAt);
    event BondWithdrawn(address indexed keyper, address to, uint256 amount);

    // ---------------------------------------------------------------- errors
    error AlreadyRegistered();
    error NotRegistered();
    error BondTooSmall();
    error BadParams();
    error BadPqcSignature();
    error TooEarly();
    error RoundOutOfRange();
    error AlreadyReleased();
    error BadSeed();
    error TooManySteps();
    error KeyperSlashed_();
    error NotEarly();
    error NoCommitment();
    error RevealWindowOver();
    error ExitNotRequested();
    error ExitPending();
    error TransferFailed();

    constructor(uint256 minBond_, uint256 exitDelay_) {
        minBond = minBond_;
        exitDelay = exitDelay_;
    }

    // ================================================================ views
    function roundTime(address keyper, uint32 round) public view returns (uint256) {
        Keyper storage k = keypers[keyper];
        return uint256(k.genesis) + uint256(round) * k.roundSeconds;
    }

    function registerDigest(
        address keyper,
        bytes32 anchor,
        bytes32 pkRoot,
        uint64 genesis,
        uint32 roundSeconds,
        uint32 maxRound
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(REGISTER_TAG, block.chainid, address(this), keyper, anchor, pkRoot, genesis, roundSeconds, maxRound)
        );
    }

    function exitDigest(address keyper) public view returns (bytes32) {
        return keccak256(abi.encode(EXIT_TAG, block.chainid, address(this), keyper));
    }

    function withdrawDigest(address keyper, address to) public view returns (bytes32) {
        return keccak256(abi.encode(WITHDRAW_TAG, block.chainid, address(this), keyper, to));
    }

    function reportCommitment(address keyper, uint32 round, bytes32 seed, bytes32 salt, address reporter)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(keyper, round, seed, salt, reporter));
    }

    // ================================================================ keyper lifecycle
    /// @notice Register `keyper` with a bond. Callable by anyone (relayer); authorised by
    ///         the keyper's on-chain ML-DSA-87 key signing `registerDigest(...)`.
    function register(
        address keyper,
        bytes32 anchor,
        bytes32 pkRoot,
        uint64 genesis,
        uint32 roundSeconds,
        uint32 maxRound,
        bytes calldata pqcSignature
    ) external payable {
        Keyper storage k = keypers[keyper];
        if (k.registered || retired[keyper]) revert AlreadyRegistered();
        if (msg.value < minBond || msg.value > type(uint128).max) revert BondTooSmall();
        if (anchor == bytes32(0) || roundSeconds == 0 || maxRound == 0) revert BadParams();
        bytes32 digest = registerDigest(keyper, anchor, pkRoot, genesis, roundSeconds, maxRound);
        if (!QorePQC.verifyBy(keyper, digest, pqcSignature)) revert BadPqcSignature();

        k.anchor = anchor;
        k.lastHash = anchor;
        k.pkRoot = pkRoot;
        k.genesis = genesis;
        k.roundSeconds = roundSeconds;
        k.maxRound = maxRound;
        k.bond = uint128(msg.value);
        k.registered = true;
        emit KeyperRegistered(keyper, anchor, pkRoot, genesis, roundSeconds, maxRound, msg.value);
    }

    /// @notice Publish seed `round` once its time has come. Permissionless: the seed itself
    ///         is the authorisation (it must hash down the committed chain).
    function release(address keyper, uint32 round, bytes32 seed) external {
        Keyper storage k = keypers[keyper];
        if (!k.registered) revert NotRegistered();
        if (k.slashed) revert KeyperSlashed_();
        if (round > k.maxRound) revert RoundOutOfRange();
        if (round < k.nextRound) revert AlreadyReleased();
        if (block.timestamp < roundTime(keyper, round)) revert TooEarly();
        _walk(k, round, seed);
        k.nextRound = round + 1;
        k.lastHash = seed;
        seedOf[keyper][round] = seed;
        emit SeedReleased(keyper, round, seed);
    }

    // ================================================================ accountability
    /// @notice Step 1 of a leak report: commit to (keyper, round, seed, salt, msg.sender).
    ///         Binding the reporter prevents mempool front-running of the reward.
    function commitReport(bytes32 commitment) external {
        reports[msg.sender][commitment] = Report(uint64(block.timestamp));
        emit ReportCommitted(msg.sender, commitment);
    }

    /// @notice Step 2: reveal. If the seed was known (committed) before its round time,
    ///         the keyper is slashed: half the bond to the reporter, half burned.
    function revealReport(address keyper, uint32 round, bytes32 seed, bytes32 salt) external {
        Keyper storage k = keypers[keyper];
        if (!k.registered) revert NotRegistered();
        if (k.slashed) revert KeyperSlashed_();
        bytes32 c = reportCommitment(keyper, round, seed, salt, msg.sender);
        uint64 committedAt = reports[msg.sender][c].committedAt;
        if (committedAt == 0) revert NoCommitment();
        if (block.timestamp > uint256(committedAt) + REPORT_REVEAL_WINDOW) revert RevealWindowOver();
        if (committedAt >= roundTime(keyper, round)) revert NotEarly();
        if (round > k.maxRound) revert RoundOutOfRange();
        // A seed for a round already released is public knowledge, so it is not evidence.
        if (round < k.nextRound) revert AlreadyReleased();
        _walk(k, round, seed);
        delete reports[msg.sender][c];

        uint256 bond = k.bond;
        k.slashed = true;
        k.bond = 0;
        uint256 reward = bond / 2;
        _send(msg.sender, reward);
        _send(BURN, bond - reward);
        emit KeyperSlashed(keyper, round, seed, msg.sender, reward);
    }

    // ================================================================ exit (PQ-authorised)
    function requestExit(address keyper, bytes calldata pqcSignature) external {
        Keyper storage k = keypers[keyper];
        if (!k.registered) revert NotRegistered();
        if (k.slashed) revert KeyperSlashed_();
        if (!QorePQC.verifyBy(keyper, exitDigest(keyper), pqcSignature)) revert BadPqcSignature();
        uint64 at = uint64(block.timestamp + exitDelay);
        k.exitAt = at;
        emit ExitRequested(keyper, at);
    }

    /// @notice Withdraw the bond to `to` — `to` is bound inside the ML-DSA-87 signature,
    ///         so a stolen ECDSA key cannot redirect funds.
    function withdraw(address keyper, address to, bytes calldata pqcSignature) external {
        Keyper storage k = keypers[keyper];
        if (!k.registered) revert NotRegistered();
        if (k.slashed) revert KeyperSlashed_();
        if (k.exitAt == 0) revert ExitNotRequested();
        if (block.timestamp < k.exitAt) revert ExitPending();
        if (!QorePQC.verifyBy(keyper, withdrawDigest(keyper, to), pqcSignature)) revert BadPqcSignature();
        uint256 amount = k.bond;
        k.bond = 0;
        k.registered = false;
        retired[keyper] = true; // never again: a new chain needs a new account
        _send(to, amount);
        emit BondWithdrawn(keyper, to, amount);
    }

    // ================================================================ internal
    /// @dev Check that hashing `seed` (round - nextRound + 1) times reaches `lastHash`.
    function _walk(Keyper storage k, uint32 round, bytes32 seed) private view {
        uint256 steps = uint256(round) + 1 - k.nextRound;
        if (steps > MAX_STEPS) revert TooManySteps();
        bytes32 h = seed;
        for (uint256 i; i < steps; ++i) {
            h = keccak256(abi.encodePacked(h));
        }
        if (h != k.lastHash) revert BadSeed();
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
