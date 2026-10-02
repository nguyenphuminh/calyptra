pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";
include "constants.circom";
include "note.circom";

// The shape every pool transfer shares: 2 inputs, 3 outputs (two regular outputs and the relayer's
// fee note), one token. Each input is unlocked either personally (knows the spending secret) or
// through the channel (its owner slot is the channel tag of P and the caller checked a signed state).
// When `channelOn` is 1 the outputs are fixed by the state: balances to payout tags, the closing fee
// as the fee note, payout salts derived from the state, and every listed contribution must be spent.
template SpendCore(levels) {
    signal input root;
    signal input publicAmount;
    signal input inNullifier[2];
    signal input outCommitment[3];

    signal input token;
    signal input inAmount[2];
    signal input inSalt[2];
    signal input inLeafIndex[2];
    signal input inPathElements[2][levels];
    signal input inMode[2];
    signal input inSecret[2];
    signal input inRefundTag[2];
    signal input outAmount[3];
    signal input outOwner[3];
    signal input outSalt[3];

    signal input channelOn;
    signal input channelSecret;
    signal input paramsHash;
    signal input stateHash;
    signal input stateContribs[2];
    signal input stateBal[2];
    signal input statePayout[2];
    signal input stateClosingFee;

    component tokenBits = Num2Bits(160);
    tokenBits.in <== token;

    component personalTag[2];
    component channelTag[2];
    component inputs[2];
    signal ownerDelta[2];
    signal owner[2];
    signal secretDelta[2];
    signal nullifierSecret[2];
    signal listed[2];
    for (var i = 0; i < 2; i++) {
        inMode[i] * (inMode[i] - 1) === 0;

        personalTag[i] = Poseidon(1);
        personalTag[i].inputs[0] <== inSecret[i];
        channelTag[i] = Poseidon(3);
        channelTag[i].inputs[0] <== CHANNEL_DOMAIN();
        channelTag[i].inputs[1] <== paramsHash;
        channelTag[i].inputs[2] <== inRefundTag[i];

        ownerDelta[i] <== inMode[i] * (channelTag[i].out - personalTag[i].out);
        owner[i] <== personalTag[i].out + ownerDelta[i];
        secretDelta[i] <== inMode[i] * (channelSecret - inSecret[i]);
        nullifierSecret[i] <== inSecret[i] + secretDelta[i];

        inputs[i] = InputNote(levels);
        inputs[i].root <== root;
        inputs[i].amount <== inAmount[i];
        inputs[i].token <== token;
        inputs[i].owner <== owner[i];
        inputs[i].salt <== inSalt[i];
        inputs[i].nullifierSecret <== nullifierSecret[i];
        inputs[i].leafIndex <== inLeafIndex[i];
        for (var j = 0; j < levels; j++) {
            inputs[i].pathElements[j] <== inPathElements[i][j];
        }
        inputs[i].nullifier <== inNullifier[i];

        // A channel-unlocked input must be one of the contributions the signed state lists.
        listed[i] <== (inputs[i].commitment - stateContribs[0]) * (inputs[i].commitment - stateContribs[1]);
        inMode[i] * listed[i] === 0;
    }

    // Every contribution the state lists is spent by this transaction.
    signal missing[2];
    signal missingListed[2];
    for (var j = 0; j < 2; j++) {
        missing[j] <== (inputs[0].commitment - stateContribs[j]) * (inputs[1].commitment - stateContribs[j]);
        missingListed[j] <== stateContribs[j] * missing[j];
        channelOn * missingListed[j] === 0;
    }

    component outputs[3];
    for (var k = 0; k < 3; k++) {
        outputs[k] = OutputNote();
        outputs[k].amount <== outAmount[k];
        outputs[k].token <== token;
        outputs[k].owner <== outOwner[k];
        outputs[k].salt <== outSalt[k];
        outputs[k].commitment <== outCommitment[k];
    }

    // Outputs are exactly the state's balances to its payout tags, plus the closing fee as the fee note.
    channelOn * (outAmount[0] - stateBal[0]) === 0;
    channelOn * (outOwner[0] - statePayout[0]) === 0;
    channelOn * (outAmount[1] - stateBal[1]) === 0;
    channelOn * (outOwner[1] - statePayout[1]) === 0;
    channelOn * (outAmount[2] - stateClosingFee) === 0;

    // Payout salts come from the state, so each party can rebuild its payout note on its own.
    component payoutSalt[2];
    for (var k = 0; k < 2; k++) {
        payoutSalt[k] = Poseidon(3);
        payoutSalt[k].inputs[0] <== channelSecret;
        payoutSalt[k].inputs[1] <== stateHash;
        payoutSalt[k].inputs[2] <== k;
        channelOn * (outSalt[k] - payoutSalt[k].out) === 0;
    }

    inAmount[0] + inAmount[1] === outAmount[0] + outAmount[1] + outAmount[2] + publicAmount;
}
