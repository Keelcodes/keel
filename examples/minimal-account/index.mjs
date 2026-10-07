// Minimal account wiring.
//
// Exercises the "1 + 3 thin glue" surface of @keelcodes/adapters: one standard
// ERC-7579 module-manager call path shared by every supported account, plus the
// single genuine install-time quirk (Kernel). Every encoder below is pure, so
// this runs offline; point `client` at a real RPC to probe a live account with
// `isModuleInstalled`.
//
// Imported from the package's built entry point so the example runs from a
// checkout after `pnpm build`, with no workspace install. In your own project
// this is `import { ... } from '@keelcodes/adapters'`.
import { KernelAdapter, MODULE_TYPE, createAdapter } from '../../packages/adapters/dist/index.js';

// OwnerECDSAValidator — Keel's ERC-7579 validator, deployed at the same address
// on BSC / Base / ETH (docs/internal/KEEL_PLAN.md §4.4⑦).
const VALIDATOR = '0x26423D1c7EFf7F21a56DD3065081eB700Cd02f50';

// A smart account that already speaks ERC-7579.
const ACCOUNT = '0x000000000000000000000000000000000000dead';

// `createAdapter` wants a viem PublicClient for on-chain probes. The methods
// used here are pure encoders, so an offline stub is enough. On a live setup,
// replace it with `createPublicClient({ chain, transport: http(rpcUrl) })` and
// call `isModuleInstalled({ account: ACCOUNT, module: VALIDATOR })` to read
// chain state instead of trusting a silent no-op.
const offlineClient = {
  getCode: async () => '0x',
  readContract: async () => false,
};

for (const kind of ['kernel', 'nexus', 'safe7579']) {
  const adapter = createAdapter(kind, { client: offlineClient });

  // The same two calls for every account: ERC-7579 is the common surface.
  const install = adapter.encodeInstallModule({
    moduleType: MODULE_TYPE.VALIDATOR,
    module: VALIDATOR,
    initData: '0x', // Nexus / Safe7579: the validator's own enableData
  });
  const uninstall = adapter.encodeUninstallModule({
    moduleType: MODULE_TYPE.VALIDATOR,
    module: VALIDATOR,
  });

  console.log(`${kind.padEnd(9)} installModule   → ${install.slice(0, 10)}… (${(install.length - 2) / 2} bytes)`);
  console.log(`${kind.padEnd(9)} uninstallModule → ${uninstall.slice(0, 10)}… (${(uninstall.length - 2) / 2} bytes)`);
}

// Kernel is the one account with a real quirk: `installModule` decodes the hook
// from the first 20 bytes of `initData` and changed its tail layout in v3.1.
// Passing a raw `enableData` does not revert — the module installs
// uninitialised while `isModuleInstalled` still reports true. Always wrap it
// with `encodeValidatorInstallData`.
const kernel = new KernelAdapter({ client: offlineClient, version: '0.3.1' });
const enableData = '0x1234'; // validator-specific enableData
const initData = kernel.encodeValidatorInstallData(enableData);
const install = kernel.encodeInstallModule({
  moduleType: MODULE_TYPE.VALIDATOR,
  module: VALIDATOR,
  initData,
});

console.log(`kernel    wrapped initData  → ${initData.slice(0, 10)}… (${(initData.length - 2) / 2} bytes)`);
console.log(`kernel    installModule     → ${install.slice(0, 10)}… for ${ACCOUNT}`);
