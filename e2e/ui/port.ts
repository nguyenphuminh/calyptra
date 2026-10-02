// The UI tier runs its own dev chain on port 8547 (data in .devnode-8547/), so a UI run never shares a
// chain with the integration tier on 8545. Imported before scripts/lib/devnode.ts, which reads the port
// when it loads; an explicit CALYPTRA_DEVNODE_PORT still wins.
process.env.CALYPTRA_DEVNODE_PORT ??= '8547';
