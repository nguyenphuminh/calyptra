pragma circom 2.2.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";
include "lib/channel.circom";
include "lib/constants.circom";
include "lib/merkle.circom";

// Starts or answers a dispute (BRD 2.2.10.1). Reveals only the channel nullifier, the nonce, the
// state hash and the dispute window. Every contribution the state lists must exist in the pool, so a
// counterparty that never funded cannot block a refund with a state listing a missing contribution.
template SubmitState(levels) {
    signal input root;
    signal input channelNullifier;
    signal input nonce;
    signal input stateHash;
    signal input window;

    signal input pk[2][2];
    signal input channelSecret;
    signal input stateContribs[2];
    signal input stateBal[2];
    signal input statePayout[2];
    signal input stateClosingFee;
    signal input stateFinal;
    signal input sigR8[2][2];
    signal input sigS[2];
    signal input contribLeafIndex[2];
    signal input contribPathElements[2][levels];

    component nonceBits = Num2Bits(128);
    nonceBits.in <== nonce;

    component state = ChannelStateCheck();
    state.enabled <== 1;
    for (var i = 0; i < 2; i++) {
        state.pk[i][0] <== pk[i][0];
        state.pk[i][1] <== pk[i][1];
        state.contribs[i] <== stateContribs[i];
        state.bal[i] <== stateBal[i];
        state.payout[i] <== statePayout[i];
        state.sigR8[i][0] <== sigR8[i][0];
        state.sigR8[i][1] <== sigR8[i][1];
        state.sigS[i] <== sigS[i];
    }
    state.channelSecret <== channelSecret;
    state.window <== window;
    state.closingFee <== stateClosingFee;
    state.nonce <== nonce;
    state.final <== stateFinal;
    state.stateHash === stateHash;

    component nullifier = Poseidon(2);
    nullifier.inputs[0] <== channelSecret;
    nullifier.inputs[1] <== CLOSE_DOMAIN();
    nullifier.out === channelNullifier;

    component tree[2];
    component empty[2];
    component inTree[2];
    for (var j = 0; j < 2; j++) {
        tree[j] = MerkleRoot(levels);
        tree[j].leaf <== stateContribs[j];
        tree[j].leafIndex <== contribLeafIndex[j];
        for (var l = 0; l < levels; l++) {
            tree[j].pathElements[l] <== contribPathElements[j][l];
        }
        empty[j] = IsZero();
        empty[j].in <== stateContribs[j];
        inTree[j] = ForceEqualIfEnabled();
        inTree[j].enabled <== 1 - empty[j].out;
        inTree[j].in[0] <== root;
        inTree[j].in[1] <== tree[j].root;
    }
}

component main {public [root, channelNullifier, nonce, stateHash, window]} = SubmitState(20);
