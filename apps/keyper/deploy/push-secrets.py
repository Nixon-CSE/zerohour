#!/usr/bin/env python3
"""Send keyper secrets from this machine's secrets/ folder to the always-on VM, without printing them.

    python3 apps/keyper/deploy/push-secrets.py ubuntu@<vm-ip> 1 2 3

For each keyper id it writes /etc/zerohour/keyper-<id>.env on the VM (root-owned, 0600) with
KEYPER_MNEMONIC and KEYPER_CHAIN_SECRET, streamed over SSH stdin, so the values never appear in a command
line, a shell history or this terminal. Uses the SSH key ~/.ssh/zerohour_oci.
"""
import json, os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
S = os.path.join(ROOT, "secrets")
KEYPERS = {
    # id: (seed chain on the v2 clock, account phrase, extra settings)
    "1": ("v2/keyper1-home/chain.secret.json", "drill.secret.json", {"WINDOW_TXS": "1", "WINDOW_BLOCKS": "600"}),  # drill account: 1-tx windows
    "2": ("v2/keyper2-home/chain.secret.json", "keyper2-home/account.secret.json", {}),
    "3": ("v2/keyper3-home/chain.secret.json", "keyper3-home/account.secret.json", {}),
}

def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    host, ids = sys.argv[1], sys.argv[2:]
    key = os.path.expanduser("~/.ssh/zerohour_oci")
    for i in ids:
        chain_file, account_file, extra = KEYPERS[i]
        chain = json.load(open(os.path.join(S, chain_file)))
        mnemonic = json.load(open(os.path.join(S, account_file)))["mnemonic"].strip()
        assert set(chain) >= {"top", "maxRound", "genesis", "roundSeconds"} and len(mnemonic.split()) in (12, 24)
        body = f'KEYPER_MNEMONIC="{mnemonic}"\nKEYPER_CHAIN_SECRET=\'{json.dumps(chain, separators=(",", ":"))}\'\n'
        body += "".join(f"{k}={v}\n" for k, v in extra.items())
        subprocess.run(
            ["ssh", "-i", key, "-o", "StrictHostKeyChecking=accept-new", host,
             f"sudo install -m 0600 -o root -g root /dev/stdin /etc/zerohour/keyper-{i}.env"],
            input=body.encode(), check=True)
        print(f"keyper {i}: /etc/zerohour/keyper-{i}.env written (0600, root)")

if __name__ == "__main__":
    main()
