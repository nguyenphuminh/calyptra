pragma circom 2.2.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/poseidon.circom";
include "lib/constants.circom";
include "lib/note.circom";

// Gives a contributor back a contribution the finalized state did not include (BRD 2.2.10.3).
// Input 0 is the contribution, unlocked by the secret behind the refund tag in its channel tag;
// input 1 is an ordinary personal note (or a dummy). The pool checks the channel was finalized.
template Reclaim(levels) {
    signal input root;
    signal input extDataHash;
    signal input inNullifier[2];
    signal input outCommitment[3];
    signal input channelNullifier;

    signal input token;
    signal input inAmount[2];
    signal input inSalt[2];
    signal input inLeafIndex[2];
    signal input inPathElements[2][levels];
    signal input refundSecret;
    signal input personalSecret;
    signal input pk[2][2];
    signal input channelSecret;
    signal input window;
    signal input outAmount[3];
    signal input outOwner[3];
    signal input outSalt[3];

    component tokenBits = Num2Bits(160);
    tokenBits.in <== token;

    component params = Poseidon(6);
    params.inputs[0] <== pk[0][0];
    params.inputs[1] <== pk[0][1];
    params.inputs[2] <== pk[1][0];
    params.inputs[3] <== pk[1][1];
    params.inputs[4] <== channelSecret;
    params.inputs[5] <== window;

    component refundTag = Poseidon(1);
    refundTag.inputs[0] <== refundSecret;
    component channelTag = Poseidon(3);
    channelTag.inputs[0] <== CHANNEL_DOMAIN();
    channelTag.inputs[1] <== params.out;
    channelTag.inputs[2] <== refundTag.out;

    component personalTag = Poseidon(1);
    personalTag.inputs[0] <== personalSecret;

    component inputs[2];
    for (var i = 0; i < 2; i++) {
        inputs[i] = InputNote(levels);
        inputs[i].root <== root;
        inputs[i].amount <== inAmount[i];
        inputs[i].token <== token;
        inputs[i].salt <== inSalt[i];
        inputs[i].leafIndex <== inLeafIndex[i];
        for (var j = 0; j < levels; j++) {
            inputs[i].pathElements[j] <== inPathElements[i][j];
        }
        inputs[i].nullifier <== inNullifier[i];
    }
    inputs[0].owner <== channelTag.out;
    inputs[0].nullifierSecret <== channelSecret;
    inputs[1].owner <== personalTag.out;
    inputs[1].nullifierSecret <== personalSecret;

    component nullifier = Poseidon(2);
    nullifier.inputs[0] <== channelSecret;
    nullifier.inputs[1] <== CLOSE_DOMAIN();
    nullifier.out === channelNullifier;

    component outputs[3];
    for (var k = 0; k < 3; k++) {
        outputs[k] = OutputNote();
        outputs[k].amount <== outAmount[k];
        outputs[k].token <== token;
        outputs[k].owner <== outOwner[k];
        outputs[k].salt <== outSalt[k];
        outputs[k].commitment <== outCommitment[k];
    }

    inAmount[0] + inAmount[1] === outAmount[0] + outAmount[1] + outAmount[2];

    signal extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, extDataHash, inNullifier, outCommitment, channelNullifier]} = Reclaim(20);
