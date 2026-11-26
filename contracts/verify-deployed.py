#!/usr/bin/env python3
"""Check that the v2 contracts on QoreChain testnet are exactly this repository's source.

QoreChain's explorer does not verify source code, so this does it locally:
    cd contracts && forge build && python3 verify-deployed.py
It fetches each contract's runtime bytecode from the public EVM RPC and compares it with the local build,
masking only the immutables that the constructor fills in (addresses and parameters). Standard library only.
"""
import json
import sys
import urllib.request

RPC = "https://evm-testnet.qore.host"
CONTRACTS = {  # deployments/testnet.json
    "HourglassRegistry": "0xAF59A5e81c0F5D85ec79f3fE6F33Bd8A923fD834",
    "ZeroHourExam": "0x358545bc6d0321705f8944e32560681e788949ad",
}


def onchain_code(address: str) -> bytes:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getCode", "params": [address, "latest"]}).encode()
    req = urllib.request.Request(RPC, body, {"content-type": "application/json", "user-agent": "zerohour-verify"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return bytes.fromhex(json.load(r)["result"][2:])


def main() -> int:
    ok = True
    for name, address in CONTRACTS.items():
        art = json.load(open(f"out/{name}.sol/{name}.json"))
        local = bytearray.fromhex(art["deployedBytecode"]["object"][2:])
        chain = bytearray(onchain_code(address))
        for refs in art["deployedBytecode"].get("immutableReferences", {}).values():
            for ref in refs:
                s, n = ref["start"], ref["length"]
                local[s : s + n] = chain[s : s + n] = b"\0" * n
        same = local == chain
        ok &= same
        print(f"{name} {address}: {len(chain)} bytes on chain, {len(local)} built -> {'IDENTICAL' if same else 'DIFFERENT'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
