import type { RuntimeState } from "../runtime/context";

export async function stopCatspubWork(
  state: RuntimeState,
  activeTurns: ReadonlyMap<string, string>,
  restartSidecar: () => Promise<void>,
  settleTurn: (sessionId: string, turnId: string) => Promise<unknown>,
  cancelTools: (sessionId: string) => void,
): Promise<void> {
  const sidecar = state.sidecar;
  const turns = [...activeTurns];
  const bridge = state.agentHostBridge;
  // Close the transport before awaiting I/O: late launches cannot enter the old runtime.
  state.sidecar = null;
  const dispose = sidecar?.dispose();
  try {
    const result = await state.host?.call<{ sessions: Array<{ id: string }> }>("session.list", {});
    const ids = new Set([...(result?.sessions ?? []).map((s) => s.id), ...turns.map(([id]) => id)]);
    const removed = await Promise.allSettled([...ids].flatMap((id) => {
      cancelTools(id);
      return (bridge?.queue.list(id) ?? []).map((queued) => bridge!.queue.remove(queued.id));
    }));
    const settled = await Promise.allSettled(turns.map(([id, turnId]) => settleTurn(id, turnId)));
    const failure = [...removed, ...settled].find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    await dispose;
    await restartSidecar();
  }
}
