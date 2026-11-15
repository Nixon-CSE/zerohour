// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Thin wrapper over QoreChain's post-quantum precompiles (testnet `qorechain-diana`).
///         0x…0A01 pqcVerify(bytes pubkey, bytes signature, bytes message) -> bool   (ML-DSA-87)
///         0x…0A02 pqcKeyStatus(address) -> (bool registered, uint8 algorithmId, bytes pubkey, …)
/// @dev Calls are made with staticcall and decoded defensively: the docs list a 4th return
///      field (possessionProven) that the kit ABI omits, so only the first three are read.
library QorePQC {
    address internal constant PQC_VERIFY = address(0x0A01);
    address internal constant PQC_KEY_STATUS = address(0x0A02);
    uint8 internal constant ALG_ML_DSA_87 = 1;

    error PqcPrecompileFailed();

    function verify(bytes memory pubkey, bytes memory signature, bytes memory message) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            PQC_VERIFY.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pubkey, signature, message));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }

    /// @return registered whether the account has a PQC key on chain
    /// @return pubkey the registered ML-DSA-87 public key (empty if none / other algorithm)
    function keyOf(address account) internal view returns (bool registered, bytes memory pubkey) {
        (bool ok, bytes memory ret) =
            PQC_KEY_STATUS.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", account));
        if (!ok || ret.length < 96) revert PqcPrecompileFailed();
        uint8 alg;
        (registered, alg, pubkey) = abi.decode(ret, (bool, uint8, bytes));
        if (alg != ALG_ML_DSA_87) return (false, "");
    }

    /// @notice Verify that `account`'s registered ML-DSA-87 key signed `digest`.
    function verifyBy(address account, bytes32 digest, bytes memory signature) internal view returns (bool) {
        (bool registered, bytes memory pubkey) = keyOf(account);
        if (!registered) return false;
        return verify(pubkey, signature, abi.encodePacked(digest));
    }
}
