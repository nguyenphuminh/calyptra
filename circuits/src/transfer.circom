pragma circom 2.2.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "lib/channel.circom";
include "lib/spend.circom";

// Private transfer, withdrawal, channel funding and cooperative close (BRD 2.2.3, 2.2.5, 2.2.9).
// The token is public only in a withdrawal; a cooperative close needs a final state signed by both keys.
template Transfer(levels) {
    signal input root;
    signal input publicAmount;
    signal input publicToken;
    signal input extDataHash;
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

    signal input pk[2][2];
    signal input channelSecret;
    signal input window;
    signal input stateContribs[2];
    signal input stateBal[2];
    signal input statePayout[2];
    signal input stateClosingFee;
    signal input stateNonce;
    signal input stateFinal;
    signal input sigR8[2][2];
    signal input sigS[2];

    component publicAmountBits = Num2Bits(64);
    publicAmountBits.in <== publicAmount;
    component noWithdrawal = IsZero();
    noWithdrawal.in <== publicAmount;
    publicToken === token * (1 - noWithdrawal.out);

    signal anyChannel <== inMode[0] + inMode[1] - inMode[0] * inMode[1];

    component state = ChannelStateCheck();
    state.enabled <== anyChannel;
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
    state.nonce <== stateNonce;
    state.final <== stateFinal;
    anyChannel * (stateFinal - 1) === 0;

    component spend = SpendCore(levels);
    spend.root <== root;
    spend.publicAmount <== publicAmount;
    spend.token <== token;
    for (var i = 0; i < 2; i++) {
        spend.inNullifier[i] <== inNullifier[i];
        spend.inAmount[i] <== inAmount[i];
        spend.inSalt[i] <== inSalt[i];
        spend.inLeafIndex[i] <== inLeafIndex[i];
        for (var j = 0; j < levels; j++) {
            spend.inPathElements[i][j] <== inPathElements[i][j];
        }
        spend.inMode[i] <== inMode[i];
        spend.inSecret[i] <== inSecret[i];
        spend.inRefundTag[i] <== inRefundTag[i];
        spend.stateContribs[i] <== stateContribs[i];
        spend.stateBal[i] <== stateBal[i];
        spend.statePayout[i] <== statePayout[i];
    }
    for (var k = 0; k < 3; k++) {
        spend.outCommitment[k] <== outCommitment[k];
        spend.outAmount[k] <== outAmount[k];
        spend.outOwner[k] <== outOwner[k];
        spend.outSalt[k] <== outSalt[k];
    }
    spend.channelOn <== anyChannel;
    spend.channelSecret <== channelSecret;
    spend.paramsHash <== state.paramsHash;
    spend.stateHash <== state.stateHash;
    spend.stateClosingFee <== stateClosingFee;

    // Binds the recipient and the ciphertexts to the proof.
    signal extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, publicAmount, publicToken, extDataHash, inNullifier, outCommitment]} = Transfer(20);
