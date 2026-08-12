"""CrimeLens Evidence Registry -- Algorand smart contract (PyTeal -> TEAL).

Replaces the unused `crimelens/` HelloWorld scaffold as the real,
CrimeLens-specific on-chain proof registry. Compiled and deployed via
`scripts/deploy_contract.py`, called at runtime from
`blockchain/algorand/contract.py`.

PURPOSE
-------
An immutable, independently-queryable (evidence_id -> proof) mapping.
Anyone -- not just this backend -- can read a box directly via algod's
public box API and confirm what root hash was registered for a given
evidence_id, without trusting Firestore or this backend's cache.

WHY BOXES, NOT GLOBAL STATE
----------------------------
Algorand application global state is a fixed, small key/value table (64
slots by default) -- it cannot hold an unbounded, growing set of evidence
records. Box storage (AVM 8+) has no such limit: each evidence_id gets its
own box, paid for by the application account's balance (box minimum-balance
requirement, ~2500 + 400*bytes microAlgos per box). This is the correct
design for "one record per evidence item, indefinitely many evidence
items," not a stand-in for something simpler.

STATE SCHEMA
------------
One box per evidence item:

    box name  = evidence_id, UTF-8 bytes (e.g. b"EVD-2026-A1B2C3")
    box value = exactly 104 bytes, fixed layout:
        [0:32]   root_hash        raw SHA-256 digest (NOT hex-encoded)
        [32:40]  registered_at    uint64 big-endian, Unix seconds
                                   (Global.latest_timestamp() at registration)
        [40:72]  registrant       32-byte raw Algorand address of Txn.sender()
        [72:104] metadata_hash    raw SHA-256 digest of an off-chain metadata
                                   reference (e.g. "case_id|camera_id|the
                                   Firestore document path") -- never the
                                   metadata itself, never evidence bytes

No video, no image, no file content, no free-text ever touches this
contract. Only three 32-byte digests and one 8-byte timestamp.

IMMUTABILITY
-------------
`register_evidence` asserts the box does NOT already exist
(`App.box_length` returns no value) before writing. Once a box exists for
an evidence_id, every subsequent `register_evidence` call for the same ID
fails the assertion and the whole transaction is rejected by the AVM --
there is no code path that overwrites an existing box. The application
also rejects `UpdateApplication` and `DeleteApplication` outright, so the
contract's own logic can never be swapped out from under existing records.

READS
-----
There is deliberately no `get_evidence` contract method. Reading a box's
current value does not require calling into the contract or paying a fee
at all -- the idiomatic Algorand pattern is to query
`algod.application_box_by_name(app_id, box_name)` directly (see
`blockchain/algorand/contract.py::get_evidence_from_contract`). Adding a
contract method that does nothing but echo box storage back would just be
a slower, fee-costing wrapper around a free public read.
"""
from pyteal import (
    App,
    Approve,
    Assert,
    Bytes,
    Cond,
    Concat,
    Global,
    Int,
    Itob,
    Len,
    Mode,
    OnComplete,
    Reject,
    Seq,
    Txn,
    compileTeal,
)

METHOD_REGISTER_EVIDENCE = Bytes("register_evidence")

ROOT_HASH_LEN = 32
METADATA_HASH_LEN = 32
ADDRESS_LEN = 32
TIMESTAMP_LEN = 8
BOX_VALUE_LEN = ROOT_HASH_LEN + TIMESTAMP_LEN + ADDRESS_LEN + METADATA_HASH_LEN  # 104


def approval_program():
    evidence_id = Txn.application_args[1]
    root_hash = Txn.application_args[2]
    metadata_hash = Txn.application_args[3]

    existing_box_length = App.box_length(evidence_id)

    on_register_evidence = Seq(
        Assert(Txn.application_args.length() == Int(4)),
        Assert(Len(evidence_id) > Int(0)),
        Assert(Len(root_hash) == Int(ROOT_HASH_LEN)),
        Assert(Len(metadata_hash) == Int(METADATA_HASH_LEN)),
        existing_box_length,
        # Immutability: refuse to touch a box that already exists. This is
        # the ENTIRE duplicate-registration/overwrite defense -- there is no
        # other code path that writes a box.
        Assert(existing_box_length.hasValue() == Int(0)),
        App.box_put(
            evidence_id,
            Concat(
                root_hash,
                Itob(Global.latest_timestamp()),
                Txn.sender(),
                metadata_hash,
            ),
        ),
        Approve(),
    )

    on_create = Approve()
    on_no_op = Cond(
        [Txn.application_args[0] == METHOD_REGISTER_EVIDENCE, on_register_evidence],
    )

    program = Cond(
        [Txn.application_id() == Int(0), on_create],
        [Txn.on_completion() == OnComplete.NoOp, on_no_op],
        # Immutable by design: no update, no delete, no opt-in/close-out
        # semantics needed since this contract holds no per-account local
        # state -- every other OnComplete is rejected outright.
        [Txn.on_completion() == OnComplete.OptIn, Reject()],
        [Txn.on_completion() == OnComplete.CloseOut, Reject()],
        [Txn.on_completion() == OnComplete.UpdateApplication, Reject()],
        [Txn.on_completion() == OnComplete.DeleteApplication, Reject()],
    )
    return program


def clear_state_program():
    return Approve()


def compile_approval(version: int = 8) -> str:
    return compileTeal(approval_program(), mode=Mode.Application, version=version)


def compile_clear(version: int = 8) -> str:
    return compileTeal(clear_state_program(), mode=Mode.Application, version=version)


if __name__ == "__main__":
    # Real, runnable compilation check -- `python evidence_registry.py`
    # prints both TEAL programs, proving the contract is syntactically valid
    # PyTeal, independent of any network/deployment step.
    print("=== approval program ===")
    print(compile_approval())
    print("\n=== clear state program ===")
    print(compile_clear())
