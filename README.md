# Calyptra

Calyptra is a ZK state channel built on top of Monad, with instant gasless payments, a mobile-first
wallet and complete privacy for users.

Money is held in a shielded pool, and every private transfer carries a Groth16 proof made on the user's
device. Payments between two people (tabs) and per-second payments to a service (subscriptions) run over
private two-party channels inside that pool. Each payment is a signed message sent peer to peer over
encrypted libp2p, so only opening and settling a channel touch the chain. The app is a website that
installs on a phone. A desktop client runs the same node from the command line, optionally as a
transaction relayer, a libp2p relay or a merchant.

## Resources

| | |
|---|---|
| Live app | [calyptra.space](https://calyptra.space) (Monad testnet, installs on any phone) |
| Demo video | [youtu.be/3XV2H2RBLuA](https://youtu.be/3XV2H2RBLuA) |
| Pitch video | [youtu.be/iEmCklt5s6Q](https://youtu.be/iEmCklt5s6Q) |
| Short ad video | [youtu.be/k0gn4H1vne0](https://youtu.be/k0gn4H1vne0) |
| Track | Monad Metropolis, Track 02 – Consumer Products & Payments |
| Bounties | Mera: One Passkey, Many Keys; Mera: Best Mera-Powered UX; Envio: Best Use of Envio; Agora: Best Cross-Border Payments App |

**Contracts on Monad testnet** (chain id 10143, deployed at block 70436926, verified on Sourcify):

| Contract | Address |
|---|---|
| Pool | [`0x949a9e04fa9a0a619855c1cbf79da25d73152c13`](https://testnet.monadvision.com/address/0x949a9e04fa9a0a619855c1cbf79da25d73152c13) |
| Disputes | [`0xe33b1144efd35596a5cca72fc52941a442436145`](https://testnet.monadvision.com/address/0xe33b1144efd35596a5cca72fc52941a442436145) |
| Verifier (Groth16) | [`0x2b1952402392a08e66e87c13a6ccfe1a9d1c190c`](https://testnet.monadvision.com/address/0x2b1952402392a08e66e87c13a6ccfe1a9d1c190c) |
| Hasher (Poseidon) | [`0x45cf6064e35df5feb4451843a5a63fe286b8f7e6`](https://testnet.monadvision.com/address/0x45cf6064e35df5feb4451843a5a63fe286b8f7e6) |

## Setup and run

### Try the live app

1. Open [calyptra.space](https://calyptra.space) and choose **Continue with passkey**.
2. Get testnet MON and AUSD (see [Testnet funds](#testnet-funds)), then use **Add money**.
3. Under **Services**, subscribe to "Calyptra AI · powered by Gemini" and chat while the meter runs.

### Install

Requirements: Linux x64. Everything else installs into your home directory, with no sudo.

```sh
bash scripts/setup-tools.sh       # Node 24, circom 2.2.3, Foundry, the 2^17 powers of tau
source scripts/env.sh             # in every new shell
npm install
npm run setup                     # compile circuits, Groth16 setup, generate the verifier, test fixtures
npx playwright install chromium   # for the UI tests
```

`npm run setup` runs the Groth16 phase-2 trusted setup on your machine with a single contributor. The
team ran the setup behind the live contracts the same way, alone, so it is for testing only: whoever
kept its randomness could forge proofs. Production needs a multi-party ceremony.

### Run locally

```sh
npm run demo                                      # a local chain (anvil) with fresh contracts, the desktop
                                                  # client as relayer + libp2p relay, and the website
npm run demo -- fund <address> [native] [stable]  # test MON / test stablecoin for an account
npm run demo -- --testnet                         # the website + a local relayer/relay on Monad testnet
```

With `GEMINI_API_KEY` set, the demo also runs the AI chat merchant.

### Tests

```sh
npm test               # every tier: lint, typecheck, contracts-lint, framework, circuits,
                       # contracts, desktop, web, integration (anvil), ui (Playwright)
npm test -- --fast     # all but the integration and UI tiers
npm run test:live      # end to end on Monad testnet (needs ~/.calyptra-secrets/funder.key)
```

### Deploy to Monad testnet

1. **Contracts.** The deployer only needs MON for gas.
   ```sh
   CALYPTRA_DEPLOYER_KEY=0x… npm run deploy:network -- --network monad-testnet
   ```
   Put the printed addresses in `packages/framework/src/modules/chain/chain.config.ts`.
2. **Relay host and website** (Google Cloud VM + Cloudflare).
   ```sh
   CALYPTRA_ENVIO_TOKEN=… GEMINI_API_KEY=… npm run deploy:live -- --project <gcp-project>
   ```
   It needs:
   - the domain set in `scripts/deploy-live.ts`;
   - a Cloudflare token for that zone in `~/.calyptra-secrets/cloudflare.token`;
   - `wrangler login`;
   - a funded key in `~/.calyptra-secrets/funder.key`, which tops up the relayer.

   The script creates the VM, DNS and TLS (Caddy), installs the desktop client as relayer, libp2p relay,
   event cache and merchant, and deploys the website. It is idempotent.

   This puts the merchant and the relayer on one host, so its operator can match the fundings of its own
   merchant's subscriptions by their timing. That is acceptable for a demo only.

### Desktop client

```sh
node apps/desktop/src/main.ts init --phrase      # CALYPTRA_PASSWORD / CALYPTRA_SECRET or prompted
node apps/desktop/src/main.ts start --relayer --relayer-account <unused account> --libp2p-relay
node apps/desktop/src/main.ts help
```

### Testnet funds

- **MON:** https://faucet.monad.xyz
- **AUSD:** the faucet contract `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`, `requestFunds(address)`,
  which pays 10,000 AUSD.

## AI disclosure

This project was built with the help of AI coding tools.

## Copyright and license

Copyright (c) 2026 Nguyen Phu Minh. Calyptra is released under the [MIT License](LICENSE).

Third-party code keeps its own license:
- circomlib, snarkjs and ffjavascript are GPL-3.0.
- `contracts/lib/poseidon-solidity` is derived from
  [poseidon-solidity](https://github.com/vimwitch/poseidon-solidity) by Chance Hudson (MIT); its license
  is in that folder.
- The Monad logo in the network selector comes from Monad's brand kit.
