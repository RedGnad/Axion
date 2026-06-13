import { AgentClient } from '@croo-network/sdk';
import { Orchestrator } from './orchestrator.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name} (see .env.example)`);
  return v;
}

async function main(): Promise<void> {
  const client = new AgentClient(
    {
      baseURL: requireEnv('CROO_API_URL'),
      wsURL: requireEnv('CROO_WS_URL'),
      ...(process.env.BASE_RPC_URL ? { rpcURL: process.env.BASE_RPC_URL } : {}),
    },
    requireEnv('CROO_SDK_KEY'),
  );

  const orchestrator = new Orchestrator(client);

  // Scaffold entrypoint. The first milestone is the vertical slice:
  // one goal -> N real hires -> composed result, settled + verifiable on-chain (Base).
  // TODO(builder): wire the provider side (Foreman's own service) + the requester loop.
  void orchestrator;
  console.log('Foreman scaffold ready. Implement the vertical slice (see CLAUDE.md).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
