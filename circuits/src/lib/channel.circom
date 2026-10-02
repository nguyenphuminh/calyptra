pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/eddsaposeidon.circom";

// Hashes the channel parameters P = (pkA, pkB, channelSecret, window) and a channel state S,
// and, when enabled, checks that both channel keys from P signed H(S).
template ChannelStateCheck() {
    signal input enabled;
    signal input pk[2][2];
    signal input channelSecret;
    signal input window;
    signal input contribs[2];
    signal input bal[2];
    signal input payout[2];
    signal input closingFee;
    signal input nonce;
    signal input final;
    signal input sigR8[2][2];
    signal input sigS[2];
    signal output paramsHash;
    signal output stateHash;

    final * (final - 1) === 0;

    component params = Poseidon(6);
    params.inputs[0] <== pk[0][0];
    params.inputs[1] <== pk[0][1];
    params.inputs[2] <== pk[1][0];
    params.inputs[3] <== pk[1][1];
    params.inputs[4] <== channelSecret;
    params.inputs[5] <== window;
    paramsHash <== params.out;

    component state = Poseidon(10);
    state.inputs[0] <== params.out;
    state.inputs[1] <== contribs[0];
    state.inputs[2] <== contribs[1];
    state.inputs[3] <== bal[0];
    state.inputs[4] <== bal[1];
    state.inputs[5] <== payout[0];
    state.inputs[6] <== payout[1];
    state.inputs[7] <== closingFee;
    state.inputs[8] <== nonce;
    state.inputs[9] <== final;
    stateHash <== state.out;

    component sig[2];
    for (var i = 0; i < 2; i++) {
        sig[i] = EdDSAPoseidonVerifier();
        sig[i].enabled <== enabled;
        sig[i].Ax <== pk[i][0];
        sig[i].Ay <== pk[i][1];
        sig[i].R8x <== sigR8[i][0];
        sig[i].R8y <== sigR8[i][1];
        sig[i].S <== sigS[i];
        sig[i].M <== state.out;
    }
}
