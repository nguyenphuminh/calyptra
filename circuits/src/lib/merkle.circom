pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

// Root of the tree containing `leaf` at `leafIndex`, given the sibling at each level.
template MerkleRoot(levels) {
    signal input leaf;
    signal input leafIndex;
    signal input pathElements[levels];
    signal output root;

    component indexBits = Num2Bits(levels);
    indexBits.in <== leafIndex;

    component hashers[levels];
    signal node[levels + 1];
    signal left[levels];
    node[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        // index bit 0: the node is the left child; bit 1: it is the right child.
        left[i] <== node[i] + indexBits.out[i] * (pathElements[i] - node[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== node[i] + pathElements[i] - left[i];
        node[i + 1] <== hashers[i].out;
    }
    root <== node[levels];
}
