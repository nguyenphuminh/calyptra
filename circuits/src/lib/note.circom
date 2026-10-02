pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "merkle.circom";

// Commitment of a note: H(token * 2^64 + amount, H(ownerTag, salt)).
// Callers range-check amount (64 bits) and token (160 bits), which makes the packing unambiguous.
template NoteCommitment() {
    signal input amount;
    signal input token;
    signal input ownerTag;
    signal input salt;
    signal output out;

    component inner = Poseidon(2);
    inner.inputs[0] <== ownerTag;
    inner.inputs[1] <== salt;

    component outer = Poseidon(2);
    outer.inputs[0] <== token * 18446744073709551616 + amount;
    outer.inputs[1] <== inner.out;
    out <== outer.out;
}

// Spends one input note: its amount is in range, its nullifier is H(nullifierSecret, commitment),
// and unless its amount is zero (a dummy input) the note is in the tree under `root`.
template InputNote(levels) {
    signal input root;
    signal input amount;
    signal input token;
    signal input owner;
    signal input salt;
    signal input nullifierSecret;
    signal input leafIndex;
    signal input pathElements[levels];
    signal input nullifier;
    signal output commitment;

    component amountBits = Num2Bits(64);
    amountBits.in <== amount;

    component note = NoteCommitment();
    note.amount <== amount;
    note.token <== token;
    note.ownerTag <== owner;
    note.salt <== salt;
    commitment <== note.out;

    component nf = Poseidon(2);
    nf.inputs[0] <== nullifierSecret;
    nf.inputs[1] <== note.out;
    nf.out === nullifier;

    component tree = MerkleRoot(levels);
    tree.leaf <== note.out;
    tree.leafIndex <== leafIndex;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
    }

    component isDummy = IsZero();
    isDummy.in <== amount;
    component inTree = ForceEqualIfEnabled();
    inTree.enabled <== 1 - isDummy.out;
    inTree.in[0] <== root;
    inTree.in[1] <== tree.root;
}

// Creates one output note: its amount is in range and its commitment matches the public one.
template OutputNote() {
    signal input amount;
    signal input token;
    signal input owner;
    signal input salt;
    signal input commitment;

    component amountBits = Num2Bits(64);
    amountBits.in <== amount;

    component note = NoteCommitment();
    note.amount <== amount;
    note.token <== token;
    note.ownerTag <== owner;
    note.salt <== salt;
    note.out === commitment;
}
