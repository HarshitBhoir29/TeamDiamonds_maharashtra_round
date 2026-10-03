// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Heirloom - trust-minimized digital inheritance (metadata + rules only)
/// @notice NEVER store secrets here. Only hashes, references, addresses and rules.
contract Heirloom {
    // ───────────── Types ─────────────
    enum RecoveryStatus { None, Pending, QuorumReached, Cancelled, Finalized }

    struct Plan {
        bool exists;
        address beneficiary;
        uint256 requiredApprovals;   // e.g. 2 (of 3 guardians)
        uint256 inactivityPeriod;    // seconds without check-in before recovery may start
        uint256 gracePeriod;         // seconds the owner has to cancel after quorum
        uint256 lastCheckIn;         // timestamp of the owner's last sign of life
        address[] guardians;
    }

    struct Asset {
        bool exists;
        bytes32 assetHash;           // hash of the encrypted file (integrity check)
        string storageRef;           // e.g. IPFS CID of the ENCRYPTED file
        uint256 addedAt;
    }

    struct Recovery {
        RecoveryStatus status;
        uint256 round;               // increments on every new attempt
        uint256 approvals;
        uint256 startedAt;
        uint256 quorumReachedAt;
        address startedBy;
    }

    // ───────────── Storage ─────────────
    uint256 public constant MAX_GUARDIANS = 10;

    /// If true, the owner may call simulateInactivity() (for demos/tests only).
    bool public immutable demoMode;

    mapping(address => Plan) private plans;                                  // owner => plan
    mapping(address => mapping(address => bool)) public isGuardianOf;        // owner => guardian => bool
    mapping(address => mapping(uint256 => Asset)) private assets;            // owner => assetId => asset
    mapping(address => uint256[]) private assetIds;                          // owner => list of ids
    mapping(address => Recovery) private recoveries;                         // owner => current recovery
    mapping(address => mapping(uint256 => mapping(address => bool))) private approvedInRound;

    // ───────────── Events (the audit trail) ─────────────
    event PlanCreated(
        address indexed owner,
        address indexed beneficiary,
        address[] guardians,
        uint256 requiredApprovals,
        uint256 inactivityPeriod,
        uint256 gracePeriod
    );
    event AssetAdded(address indexed owner, uint256 indexed assetId, bytes32 assetHash, string storageRef);
    event CheckIn(address indexed owner, uint256 timestamp);
    event RecoveryStarted(address indexed owner, address indexed startedBy, uint256 round, uint256 timestamp);
    event RecoveryApproved(address indexed owner, address indexed guardian, uint256 approvals, uint256 required);
    event QuorumReached(address indexed owner, uint256 quorumReachedAt, uint256 releasableAt);
    event RecoveryCancelled(address indexed owner, uint256 timestamp);
    event RecoveryFinalized(address indexed owner, address indexed beneficiary, uint256 timestamp);
    event InactivitySimulated(address indexed owner, uint256 newLastCheckIn);

    // ───────────── Constructor ─────────────
    constructor(bool _demoMode) {
        demoMode = _demoMode;
    }

    // ───────────── Modifiers ─────────────
    modifier onlyPlanOwner() {
        require(plans[msg.sender].exists, "No plan for caller");
        _;
    }

    // ───────────── Owner actions ─────────────

    /// @notice Create your inheritance plan. Caller becomes the owner.
    function createPlan(
        address beneficiary,
        address[] calldata guardians,
        uint256 requiredApprovals,
        uint256 inactivityPeriod,
        uint256 gracePeriod
    ) external {
        Plan storage p = plans[msg.sender];
        require(!p.exists, "Plan already exists");
        require(beneficiary != address(0) && beneficiary != msg.sender, "Invalid beneficiary");
        require(guardians.length >= 2 && guardians.length <= MAX_GUARDIANS, "Need 2-10 guardians");
        require(requiredApprovals >= 2, "Quorum must be at least 2");
        require(requiredApprovals <= guardians.length, "Quorum exceeds guardians");
        require(inactivityPeriod > 0 && gracePeriod > 0, "Periods must be > 0");

        for (uint256 i = 0; i < guardians.length; i++) {
            address g = guardians[i];
            require(g != address(0), "Zero guardian");
            require(g != msg.sender && g != beneficiary, "Guardian cannot be owner/beneficiary");
            require(!isGuardianOf[msg.sender][g], "Duplicate guardian");
            isGuardianOf[msg.sender][g] = true;
            p.guardians.push(g);
        }

        p.exists = true;
        p.beneficiary = beneficiary;
        p.requiredApprovals = requiredApprovals;
        p.inactivityPeriod = inactivityPeriod;
        p.gracePeriod = gracePeriod;
        p.lastCheckIn = block.timestamp;

        emit PlanCreated(msg.sender, beneficiary, guardians, requiredApprovals, inactivityPeriod, gracePeriod);
    }

    /// @notice Register an ENCRYPTED asset (hash + storage pointer only).
    function addAsset(uint256 assetId, bytes32 assetHash, string calldata storageRef) external onlyPlanOwner {
        require(recoveries[msg.sender].status != RecoveryStatus.Finalized, "Plan already released");
        require(!assets[msg.sender][assetId].exists, "Asset ID already used");
        require(assetHash != bytes32(0), "Empty hash");
        require(bytes(storageRef).length > 0, "Empty storage reference");

        assets[msg.sender][assetId] = Asset(true, assetHash, storageRef, block.timestamp);
        assetIds[msg.sender].push(assetId);

        emit AssetAdded(msg.sender, assetId, assetHash, storageRef);
    }

    /// @notice "I'm still here." Resets the timer. Also cancels any active recovery.
    function checkIn() external onlyPlanOwner {
        Recovery storage r = recoveries[msg.sender];
        require(r.status != RecoveryStatus.Finalized, "Plan already released");

        if (_isActive(r.status)) {
            _cancel(msg.sender);
        }
        plans[msg.sender].lastCheckIn = block.timestamp;
        emit CheckIn(msg.sender, block.timestamp);
    }

    /// @notice Owner vetoes a recovery (Pending or during the grace period).
    function cancelRecovery() external onlyPlanOwner {
        require(_isActive(recoveries[msg.sender].status), "No active recovery");
        _cancel(msg.sender);
        plans[msg.sender].lastCheckIn = block.timestamp; // cancelling proves the owner is alive
    }

    /// @notice DEMO ONLY: pretend the owner has been silent for the full inactivity period.
    function simulateInactivity() external onlyPlanOwner {
        require(demoMode, "Demo mode disabled");
        Plan storage p = plans[msg.sender];
        p.lastCheckIn = block.timestamp > p.inactivityPeriod ? block.timestamp - p.inactivityPeriod : 0;
        emit InactivitySimulated(msg.sender, p.lastCheckIn);
    }

    // ───────────── Recovery flow ─────────────

    /// @notice Guardian or beneficiary opens a recovery once the owner is inactive.
    function startRecovery(address owner) external {
        Plan storage p = _plan(owner);
        require(msg.sender == p.beneficiary || isGuardianOf[owner][msg.sender], "Not guardian/beneficiary");
        require(isInactive(owner), "Owner still active");

        Recovery storage r = recoveries[owner];
        require(r.status != RecoveryStatus.Finalized, "Already released");
        require(!_isActive(r.status), "Recovery already active");

        r.round += 1;
        r.status = RecoveryStatus.Pending;
        r.approvals = 0;
        r.startedAt = block.timestamp;
        r.quorumReachedAt = 0;
        r.startedBy = msg.sender;

        emit RecoveryStarted(owner, msg.sender, r.round, block.timestamp);
    }

    /// @notice A guardian votes yes. One vote per guardian per round.
    function approveRecovery(address owner) external {
        Plan storage p = _plan(owner);
        require(isGuardianOf[owner][msg.sender], "Not a guardian");

        Recovery storage r = recoveries[owner];
        require(r.status == RecoveryStatus.Pending, "Not accepting approvals");
        require(!approvedInRound[owner][r.round][msg.sender], "Already approved");

        approvedInRound[owner][r.round][msg.sender] = true;
        r.approvals += 1;
        emit RecoveryApproved(owner, msg.sender, r.approvals, p.requiredApprovals);

        if (r.approvals >= p.requiredApprovals) {
            r.status = RecoveryStatus.QuorumReached;
            r.quorumReachedAt = block.timestamp;
            emit QuorumReached(owner, block.timestamp, block.timestamp + p.gracePeriod);
        }
    }

    /// @notice Beneficiary finalizes after quorum + grace period with no cancellation.
    function finalizeRecovery(address owner) external {
        Plan storage p = _plan(owner);
        require(msg.sender == p.beneficiary, "Only beneficiary");

        Recovery storage r = recoveries[owner];
        require(r.status == RecoveryStatus.QuorumReached, "Quorum not reached");
        require(block.timestamp >= r.quorumReachedAt + p.gracePeriod, "Grace period not over");

        r.status = RecoveryStatus.Finalized;
        emit RecoveryFinalized(owner, p.beneficiary, block.timestamp);
    }

    // ───────────── Views (used by backend & frontend) ─────────────

    function hasPlan(address owner) external view returns (bool) {
        return plans[owner].exists;
    }

    function getPlan(address owner) external view returns (
        address beneficiary,
        uint256 requiredApprovals,
        uint256 inactivityPeriod,
        uint256 gracePeriod,
        uint256 lastCheckIn,
        address[] memory guardians
    ) {
        Plan storage p = _plan(owner);
        return (p.beneficiary, p.requiredApprovals, p.inactivityPeriod, p.gracePeriod, p.lastCheckIn, p.guardians);
    }

    function getAsset(address owner, uint256 assetId) external view returns (bytes32 assetHash, string memory storageRef, uint256 addedAt) {
        Asset storage a = assets[owner][assetId];
        require(a.exists, "Asset not found");
        return (a.assetHash, a.storageRef, a.addedAt);
    }

    function getAssetIds(address owner) external view returns (uint256[] memory) {
        return assetIds[owner];
    }

    function getRecovery(address owner) external view returns (Recovery memory) {
        return recoveries[owner];
    }

    function hasApproved(address owner, address guardian) external view returns (bool) {
        return approvedInRound[owner][recoveries[owner].round][guardian];
    }

    function isInactive(address owner) public view returns (bool) {
        Plan storage p = plans[owner];
        return p.exists && block.timestamp >= p.lastCheckIn + p.inactivityPeriod;
    }

    /// @notice Timestamp when the beneficiary may finalize (0 if quorum not reached).
    function releasableAt(address owner) external view returns (uint256) {
        Recovery storage r = recoveries[owner];
        if (r.status != RecoveryStatus.QuorumReached) return 0;
        return r.quorumReachedAt + plans[owner].gracePeriod;
    }

    /// @notice Backend uses this to decide whether to hand key shares to `user`.
    function isReleasedTo(address owner, address user) external view returns (bool) {
        return recoveries[owner].status == RecoveryStatus.Finalized && plans[owner].beneficiary == user;
    }

    // ───────────── Internal helpers ─────────────

    function _plan(address owner) internal view returns (Plan storage) {
        Plan storage p = plans[owner];
        require(p.exists, "Plan not found");
        return p;
    }

    function _isActive(RecoveryStatus s) internal pure returns (bool) {
        return s == RecoveryStatus.Pending || s == RecoveryStatus.QuorumReached;
    }

    function _cancel(address owner) internal {
        recoveries[owner].status = RecoveryStatus.Cancelled;
        emit RecoveryCancelled(owner, block.timestamp);
    }
}