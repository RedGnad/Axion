import { AgentClient, EventType, DeliverableType, type Event } from '@croo-network/sdk';

/**
 * Runs the PROVIDER side of one leaf-agent (its own SDK-Key).
 *
 * Verified CAP flow (tier [P]): to make an order exist, the provider must accept the
 * negotiation — the backend then creates the order on-chain. After the buyer pays,
 * `OrderPaid` fires and the provider delivers. With needEvaluation=false (default),
 * deliverOrder auto-releases payment → CLEAR.
 *
 * `produce(requirements)` computes the deliverable text when an order is paid.
 */
export async function startLeafProvider(
  client: AgentClient,
  label: string,
  produce: (requirements: string) => Promise<string>,
): Promise<void> {
  const ws = await client.connectWebSocket();

  ws.on(EventType.NegotiationCreated, (e: Event) => {
    void (async () => {
      if (!e.negotiation_id) return;
      try {
        await client.acceptNegotiation(e.negotiation_id);
        console.log(`[${label}] accepted negotiation ${e.negotiation_id}`);
      } catch (err) {
        console.error(`[${label}] acceptNegotiation failed:`, (err as Error).message);
      }
    })();
  });

  ws.on(EventType.OrderPaid, (e: Event) => {
    void (async () => {
      if (!e.order_id) return;
      try {
        const order = await client.getOrder(e.order_id);
        const negotiation = await client.getNegotiation(order.negotiationId);
        const text = await produce(negotiation.requirements ?? '');
        const res = await client.deliverOrder(e.order_id, {
          deliverableType: DeliverableType.Text,
          deliverableText: text,
        });
        console.log(`[${label}] delivered order ${e.order_id} (tx ${res.txHash})`);
      } catch (err) {
        console.error(`[${label}] deliverOrder failed:`, (err as Error).message);
      }
    })();
  });

  console.log(`[${label}] provider listening (accept negotiations + deliver on pay).`);
}
