pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract DAO_Treasury_Hedge_FHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted state
    mapping(uint256 => mapping(address => euint32)) public encryptedAssetAmounts; // batchId => assetAddress => amount
    mapping(uint256 => mapping(address => euint32)) public encryptedHedgeAmounts; // batchId => assetAddress => amount

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidDecryptionProof();
    error NotInitialized();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSecondsChanged(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event AssetSubmitted(uint256 indexed batchId, address indexed provider, address indexed asset, euint32 amount);
    event HedgeSubmitted(uint256 indexed batchId, address indexed provider, address indexed asset, euint32 amount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] assetAmounts, uint256[] hedgeAmounts);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
        lastSubmissionTime[msg.sender] = block.timestamp;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionCooldown(address submitter) {
        if (block.timestamp < lastSubmissionTime[submitter] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier decryptionCooldown(address requester) {
        if (block.timestamp < lastDecryptionRequestTime[requester] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
        lastDecryptionRequestTime[requester] = block.timestamp;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        currentBatchId = 1; // Start with batch 1
        emit BatchOpened(currentBatchId);
        cooldownSeconds = 60; // Default 60 seconds cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, _cooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner whenNotPaused {
        isBatchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedAssetAmount(
        uint256 batchId,
        address asset,
        euint32 amount
    ) external onlyProvider whenNotPaused submissionCooldown(msg.sender) {
        if (batchId != currentBatchId) revert InvalidBatch();
        if (isBatchClosed[batchId]) revert BatchClosed();

        _initIfNeeded(amount);
        encryptedAssetAmounts[batchId][asset] = amount;
        emit AssetSubmitted(batchId, msg.sender, asset, amount);
    }

    function submitEncryptedHedgeAmount(
        uint256 batchId,
        address asset,
        euint32 amount
    ) external onlyProvider whenNotPaused submissionCooldown(msg.sender) {
        if (batchId != currentBatchId) revert InvalidBatch();
        if (isBatchClosed[batchId]) revert BatchClosed();

        _initIfNeeded(amount);
        encryptedHedgeAmounts[batchId][asset] = amount;
        emit HedgeSubmitted(batchId, msg.sender, asset, amount);
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused decryptionCooldown(msg.sender) {
        if (!isBatchClosed[batchId]) revert InvalidBatch(); // Only closed batches can be decrypted

        // 1. Prepare Ciphertexts
        // For simplicity, this example assumes a fixed list of assets.
        // In a real scenario, you'd iterate over known assets or use a more dynamic approach.
        address[] memory assets = new address[](2);
        assets[0] = 0x1111111111111111111111111111111111111111; // Example Asset 1
        assets[1] = 0x2222222222222222222222222222222222222222; // Example Asset 2

        bytes32[] memory cts = new bytes32[](assets.length * 2); // 2 ciphertexts per asset (amount + hedge)
        uint256 ctsIdx = 0;
        for (uint256 i = 0; i < assets.length; i++) {
            cts[ctsIdx++] = FHE.toBytes32(encryptedAssetAmounts[batchId][assets[i]]);
            cts[ctsIdx++] = FHE.toBytes32(encryptedHedgeAmounts[batchId][assets[i]]);
        }

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext memory context = decryptionContexts[requestId];

        // a. Replay Guard
        if (context.processed) revert ReplayAttempt();

        // b. State Verification
        // Rebuild cts array in the exact same order as in requestBatchDecryption
        address[] memory assets = new address[](2);
        assets[0] = 0x1111111111111111111111111111111111111111; // Example Asset 1
        assets[1] = 0x2222222222222222222222222222222222222222; // Example Asset 2

        bytes32[] memory cts = new bytes32[](assets.length * 2);
        uint256 ctsIdx = 0;
        for (uint256 i = 0; i < assets.length; i++) {
            cts[ctsIdx++] = FHE.toBytes32(encryptedAssetAmounts[context.batchId][assets[i]]);
            cts[ctsIdx++] = FHE.toBytes32(encryptedHedgeAmounts[context.batchId][assets[i]]);
        }
        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != context.stateHash) {
            revert StateMismatch();
        }

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidDecryptionProof();
        }

        // d. Decode & Finalize
        uint256 numAssets = assets.length;
        uint256[] memory assetAmounts = new uint256[](numAssets);
        uint256[] memory hedgeAmounts = new uint256[](numAssets);

        uint256 cleartextIdx = 0;
        for (uint256 i = 0; i < numAssets; i++) {
            assetAmounts[i] = abi.decode(cleartexts[cleartextIdx:cleartextIdx + 32], (uint256));
            cleartextIdx += 32;
            hedgeAmounts[i] = abi.decode(cleartexts[cleartextIdx:cleartextIdx + 32], (uint256));
            cleartextIdx += 32;
        }

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, context.batchId, assetAmounts, hedgeAmounts);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value) internal {
        if (!FHE.isInitialized(value)) {
            revert NotInitialized();
        }
    }

    function _requireInitialized(euint32 value) internal pure {
        if (!FHE.isInitialized(value)) {
            revert NotInitialized();
        }
    }
}