// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QorePQC} from "./QorePQC.sol";
import {HourglassRegistry} from "./HourglassRegistry.sol";

/// @title ZeroHour v2 — exam papers no centre can open before the bell
/// @notice Each exam centre receives its own permuted variant of the paper, encrypted with
///         two locks: an Hourglass time-lock (t-of-n keyper seeds for the start round) and a
///         QoreSeal recipient lock to the centre's registered ML-KEM-1024 key. This contract
///         records commitments, the backup-paper switch, opening receipts, leak reports and the
///         post-exam fairness reveal. Board, centre and Leak Hunter actions are authorised by
///         their ML-DSA-87 keys (relayable by anyone); classical keys carry no authority.
contract ZeroHourExam {
    bytes32 public constant CREATE_TAG = keccak256("ZEROHOUR_CREATE_V1");
    bytes32 public constant CENTRE_TAG = keccak256("ZEROHOUR_CENTRE_V1");
    bytes32 public constant SWITCH_TAG = keccak256("ZEROHOUR_SWITCH_V1");
    bytes32 public constant OPEN_TAG = keccak256("ZEROHOUR_OPEN_V1");
    bytes32 public constant LEAK_TAG = keccak256("ZEROHOUR_LEAK_V1");
    bytes32 public constant REVEAL_TAG = keccak256("ZEROHOUR_REVEAL_V1");

    HourglassRegistry public immutable hourglass;

    struct Exam {
        address board; // exam authority (ML-DSA-87 registered account)
        address leakHunter; // AI agent account allowed to file signed leak reports
        uint8 threshold; // t of the keyper set
        bool usingBackup;
        bool revealed;
        uint32 roundA; // Hourglass round that unlocks paper set A
        uint32 roundB; // later round that unlocks the pre-sealed backup set B
        bytes32 paperCommitA; // keccak(canonicalPaperA, saltA): fairness commitment
        bytes32 paperCommitB;
        bytes32 manifestRoot; // Merkle root of (centre, variant ciphertext hashes) — off-chain manifest
        address[] keypers;
    }

    struct Centre {
        bool registered;
        bytes32 ctHashA; // hash of the centre's encrypted variant (set A)
        bytes32 ctHashB; // backup set B
        bytes32 permCommit; // keccak(permutationSeed, salt): proves the variant is a reordering
        uint64 openedAt; // signed opening receipt timestamp
        uint32 leakReports;
    }

    mapping(bytes32 => Exam) internal exams;
    mapping(bytes32 => mapping(address => Centre)) public centres;
    mapping(bytes32 => address[]) internal centreList;
    /// v2: per-set signed receipt = keccak256 of the plaintext paper the centre decrypted.
    ///     After the fairness reveal anyone can rebuild each centre's copy and compare.
    mapping(bytes32 => mapping(address => mapping(bool => bytes32))) public receiptOf;
    uint256 public constant MAX_KEYPERS = 32;

    event ExamCreated(bytes32 indexed examId, address indexed board, uint32 roundA, uint32 roundB, uint8 threshold, address[] keypers);
    event CentreAdded(bytes32 indexed examId, address indexed centre, bytes32 ctHashA, bytes32 ctHashB, bytes32 permCommit);
    event SwitchedToBackup(bytes32 indexed examId, bytes32 reasonHash);
    event PaperOpened(bytes32 indexed examId, address indexed centre, bool backup, uint64 at, bytes32 paperHash);
    event LeakReported(bytes32 indexed examId, address indexed centre, bytes32 evidenceHash, uint16 confidenceBps, bytes32 sealedEvidenceRef);
    event FairnessRevealed(bytes32 indexed examId, bytes32 canonicalPaperHash, bytes32 salt);

    error ExamExists();
    error NoExam();
    error BadParams();
    error BadPqcSignature();
    error CentreExists();
    error UnknownCentre();
    error NotUnlocked();
    error AlreadyOpened();
    error TooLate();
    error AlreadyRevealed();
    error CommitMismatch();
    error NotOver();
    error BadKeyper(address keyper);

    constructor(HourglassRegistry hourglass_) {
        hourglass = hourglass_;
    }

    // ============================================================ digests (signed off-chain with ML-DSA-87)
    function createDigest(
        bytes32 examId,
        address board,
        address leakHunter,
        address[] calldata keypers,
        uint8 threshold,
        uint32 roundA,
        uint32 roundB,
        bytes32 paperCommitA,
        bytes32 paperCommitB,
        bytes32 manifestRoot
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                CREATE_TAG, block.chainid, address(this), examId, board, leakHunter,
                keccak256(abi.encode(keypers)), threshold, roundA, roundB, paperCommitA, paperCommitB, manifestRoot
            )
        );
    }

    function centreDigest(bytes32 examId, address centre, bytes32 ctHashA, bytes32 ctHashB, bytes32 permCommit)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(CENTRE_TAG, block.chainid, address(this), examId, centre, ctHashA, ctHashB, permCommit));
    }

    function switchDigest(bytes32 examId, bytes32 reasonHash) public view returns (bytes32) {
        return keccak256(abi.encode(SWITCH_TAG, block.chainid, address(this), examId, reasonHash));
    }

    function openDigest(bytes32 examId, address centre, bool backup, bytes32 paperHash) public view returns (bytes32) {
        return keccak256(abi.encode(OPEN_TAG, block.chainid, address(this), examId, centre, backup, paperHash));
    }

    /// @notice v2: an exam id is bound to its board, so nobody can squat a predictable id.
    function examIdOf(address board, bytes32 label) public pure returns (bytes32) {
        return keccak256(abi.encode(board, label));
    }

    function leakDigest(bytes32 examId, address centre, bytes32 evidenceHash, uint16 confidenceBps, bytes32 sealedEvidenceRef)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(LEAK_TAG, block.chainid, address(this), examId, centre, evidenceHash, confidenceBps, sealedEvidenceRef)
        );
    }

    function revealDigest(bytes32 examId, bytes32 canonicalPaperHash, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(REVEAL_TAG, block.chainid, address(this), examId, canonicalPaperHash, salt));
    }

    // ============================================================ board actions
    function createExam(
        bytes32 label,
        address board,
        address leakHunter,
        address[] calldata keypers,
        uint8 threshold,
        uint32 roundA,
        uint32 roundB,
        bytes32 paperCommitA,
        bytes32 paperCommitB,
        bytes32 manifestRoot,
        bytes calldata boardSig
    ) external {
        bytes32 examId = examIdOf(board, label);
        if (exams[examId].board != address(0)) revert ExamExists();
        if (board == address(0) || threshold == 0 || threshold > keypers.length || keypers.length > MAX_KEYPERS || roundB <= roundA) {
            revert BadParams();
        }
        _checkKeypers(keypers, roundA, roundB);
        bytes32 d = createDigest(examId, board, leakHunter, keypers, threshold, roundA, roundB, paperCommitA, paperCommitB, manifestRoot);
        if (!QorePQC.verifyBy(board, d, boardSig)) revert BadPqcSignature();
        Exam storage e = exams[examId];
        e.board = board;
        e.leakHunter = leakHunter;
        e.threshold = threshold;
        e.roundA = roundA;
        e.roundB = roundB;
        e.paperCommitA = paperCommitA;
        e.paperCommitB = paperCommitB;
        e.manifestRoot = manifestRoot;
        e.keypers = keypers;
        emit ExamCreated(examId, board, roundA, roundB, threshold, keypers);
    }

    function addCentre(bytes32 examId, address centre, bytes32 ctHashA, bytes32 ctHashB, bytes32 permCommit, bytes calldata boardSig)
        external
    {
        Exam storage e = _exam(examId);
        Centre storage c = centres[examId][centre];
        if (c.registered) revert CentreExists();
        if (block.timestamp >= _unlockTime(e, false)) revert TooLate();
        if (!QorePQC.verifyBy(e.board, centreDigest(examId, centre, ctHashA, ctHashB, permCommit), boardSig)) {
            revert BadPqcSignature();
        }
        c.registered = true;
        c.ctHashA = ctHashA;
        c.ctHashB = ctHashB;
        c.permCommit = permCommit;
        centreList[examId].push(centre);
        emit CentreAdded(examId, centre, ctHashA, ctHashB, permCommit);
    }

    /// @notice Leak confirmed? Move every centre to the pre-sealed backup set B in one call.
    ///         Must happen before set B unlocks.
    function switchToBackup(bytes32 examId, bytes32 reasonHash, bytes calldata boardSig) external {
        Exam storage e = _exam(examId);
        if (e.usingBackup) revert BadParams();
        if (block.timestamp >= _unlockTime(e, true)) revert TooLate();
        if (!QorePQC.verifyBy(e.board, switchDigest(examId, reasonHash), boardSig)) revert BadPqcSignature();
        e.usingBackup = true;
        emit SwitchedToBackup(examId, reasonHash);
    }

    /// @notice After the exam, reveal the canonical paper commitment so anyone can check every
    ///         centre's variant is a reordering of the same questions.
    function revealFairness(bytes32 examId, bytes32 canonicalPaperHash, bytes32 salt, bytes calldata boardSig) external {
        Exam storage e = _exam(examId);
        if (e.revealed) revert AlreadyRevealed();
        if (!isUnlocked(examId)) revert NotOver();
        bytes32 expected = e.usingBackup ? e.paperCommitB : e.paperCommitA;
        if (keccak256(abi.encodePacked(canonicalPaperHash, salt)) != expected) revert CommitMismatch();
        if (!QorePQC.verifyBy(e.board, revealDigest(examId, canonicalPaperHash, salt), boardSig)) revert BadPqcSignature();
        e.revealed = true;
        emit FairnessRevealed(examId, canonicalPaperHash, salt);
    }

    // ============================================================ centre + agent actions
    /// @notice Signed opening receipt. Only possible once the active set's round is unlocked
    ///         on Hourglass (>= threshold keyper seeds published) — proof no centre opened early.
    function recordOpening(bytes32 examId, address centre, bytes32 paperHash, bytes calldata centreSig) external {
        Exam storage e = _exam(examId);
        Centre storage c = centres[examId][centre];
        if (!c.registered) revert UnknownCentre();
        bool backup = e.usingBackup;
        if (receiptOf[examId][centre][backup] != bytes32(0)) revert AlreadyOpened();
        if (paperHash == bytes32(0)) revert BadParams();
        if (!isUnlocked(examId)) revert NotUnlocked();
        if (!QorePQC.verifyBy(centre, openDigest(examId, centre, backup, paperHash), centreSig)) revert BadPqcSignature();
        receiptOf[examId][centre][backup] = paperHash;
        c.openedAt = uint64(block.timestamp);
        emit PaperOpened(examId, centre, backup, uint64(block.timestamp), paperHash);
    }

    /// @notice Leak Hunter files an ML-DSA-signed attribution: the leaked copy's fingerprint
    ///         matched `centre` with `confidenceBps`. Full evidence is QoreSeal-sealed to
    ///         investigators; only its hash and storage reference go on chain.
    function reportLeak(
        bytes32 examId,
        address centre,
        bytes32 evidenceHash,
        uint16 confidenceBps,
        bytes32 sealedEvidenceRef,
        bytes calldata hunterSig
    ) external {
        Exam storage e = _exam(examId);
        Centre storage c = centres[examId][centre];
        if (!c.registered) revert UnknownCentre();
        if (confidenceBps > 10_000) revert BadParams();
        bytes32 d = leakDigest(examId, centre, evidenceHash, confidenceBps, sealedEvidenceRef);
        if (!QorePQC.verifyBy(e.leakHunter, d, hunterSig)) revert BadPqcSignature();
        c.leakReports += 1;
        emit LeakReported(examId, centre, evidenceHash, confidenceBps, sealedEvidenceRef);
    }

    // ============================================================ views
    function activeRound(bytes32 examId) public view returns (uint32) {
        Exam storage e = _exam(examId);
        return e.usingBackup ? e.roundB : e.roundA;
    }

    /// @notice True once >= threshold keypers have revealed the active round's seed.
    /// @dev A keyper's chain is public up to `nextRound - 1`: releasing a later round also
    ///      reveals every earlier seed (seed[r-1] = keccak(seed[r])), even though `seedOf` only
    ///      stores the round that was posted. So "revealed" means `round < nextRound`.
    function isUnlocked(bytes32 examId) public view returns (bool) {
        Exam storage e = _exam(examId);
        uint32 round = e.usingBackup ? e.roundB : e.roundA;
        uint256 n;
        for (uint256 i; i < e.keypers.length; ++i) {
            (,,,,, uint32 nextRound,,,,,) = hourglass.keypers(e.keypers[i]);
            if (round < nextRound) n++;
        }
        return n >= e.threshold;
    }

    function getExam(bytes32 examId) external view returns (Exam memory) {
        return _exam(examId);
    }

    function getCentres(bytes32 examId) external view returns (address[] memory) {
        return centreList[examId];
    }

    /// @dev Unlock time of a set, measured on the first keyper's clock (all keypers in an exam
    ///      are expected to share genesis/roundSeconds; the board checks this off-chain).
    function _unlockTime(Exam storage e, bool backup) private view returns (uint256) {
        return hourglass.roundTime(e.keypers[0], backup ? e.roundB : e.roundA);
    }

    /// @dev v2: distinct, registered, unslashed keypers on one clock whose chains cover both
    ///      rounds, and a bell still in the future. Duplicates would fake the threshold.
    function _checkKeypers(address[] calldata keypers, uint32 roundA, uint32 roundB) private view {
        (,, uint64 genesis0, uint32 seconds0,,,,,,,) = hourglass.keypers(keypers[0]);
        for (uint256 i; i < keypers.length; ++i) {
            for (uint256 j; j < i; ++j) if (keypers[j] == keypers[i]) revert BadKeyper(keypers[i]);
            (,, uint64 genesis, uint32 roundSeconds, uint32 maxRound, uint32 nextRound,,,, bool slashed, bool registered) =
                hourglass.keypers(keypers[i]);
            if (!registered || slashed || genesis != genesis0 || roundSeconds != seconds0 || roundB > maxRound || roundA < nextRound) {
                revert BadKeyper(keypers[i]);
            }
        }
        if (block.timestamp >= uint256(genesis0) + uint256(roundA) * seconds0) revert TooLate();
    }

    function _exam(bytes32 examId) private view returns (Exam storage e) {
        e = exams[examId];
        if (e.board == address(0)) revert NoExam();
    }
}
