// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Stand-in for the 0x0A01 pqcVerify precompile in local tests.
///      A "signature" is valid iff it equals keccak256(pubkey ‖ message) — enough to test
///      the authorisation logic; real ML-DSA-87 is exercised against the live testnet.
contract MockPqcVerify {
    fallback(bytes calldata data) external returns (bytes memory) {
        (bytes memory pubkey, bytes memory sig, bytes memory message) = abi.decode(data[4:], (bytes, bytes, bytes));
        bool ok = keccak256(sig) == keccak256(abi.encodePacked(keccak256(abi.encodePacked(pubkey, message))));
        return abi.encode(ok);
    }
}

/// @dev Stand-in for the 0x0A02 pqcKeyStatus precompile. Returns the 4-field shape the docs
///      describe (the registry must tolerate both 3- and 4-field answers).
contract MockPqcKeyStatus {
    mapping(address => bytes) public keyOf;

    function setKey(address account, bytes calldata pubkey) external {
        keyOf[account] = pubkey;
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        bytes memory pk = keyOf[account];
        return (pk.length > 0, pk.length > 0 ? 1 : 0, pk, pk.length > 0);
    }
}
