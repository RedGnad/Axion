"use client";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useAccount, useConnect } from "wagmi";

/** Wallet picker as a true overlay modal, in our own art direction (wagmi ships no UI; RainbowKit
 *  and friends would drag in a generic-looking dependency). Sign-only copy up front so nobody fears
 *  a drain; closes itself the moment a connection lands. Rendered through a portal so no ancestor
 *  transform or stacking context can trap or clip it. */
export default function ConnectModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { connectors, connect, isPending } = useConnect();
  const { isConnected } = useAccount();
  useEffect(() => {
    if (open && isConnected) onClose();
  }, [open, isConnected, onClose]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  // EIP-6963 discovery + the plain injected connector can both list the same wallet: de-dupe by name.
  const seen = new Set<string>();
  const wallets = connectors.filter((c) =>
    seen.has(c.name) ? false : (seen.add(c.name), true),
  );
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Connect wallet"
    >
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="reveal relative w-full max-w-sm rounded-lg border border-line bg-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-display text-xl uppercase tracking-wide text-ink">
              Connect wallet
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-dim">
              sign-only. Nothing moves without a separate confirmation
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="close"
            className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-dim transition hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="mt-4 grid gap-2">
          {wallets.length === 0 ? (
            <div className="rounded-md border border-line/70 bg-panel2/40 px-3 py-4 text-center font-mono text-[12px] leading-relaxed text-dim">
              no wallet detected. Install MetaMask, Rabby or Phantom, then
              reload.
            </div>
          ) : (
            wallets.map((c) => (
              <button
                key={c.uid}
                onClick={() => connect({ connector: c })}
                disabled={isPending}
                className="flex w-full items-center gap-3 rounded-md border border-line bg-panel2/40 px-4 py-3 text-left transition hover:border-volt/60 hover:bg-volt/[0.04] disabled:opacity-50"
              >
                {c.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element -- EIP-6963 data-URI icon from the wallet itself
                  <img src={c.icon} alt="" className="h-6 w-6 rounded" />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center rounded bg-volt/15 font-mono text-[11px] text-volt">
                    W
                  </span>
                )}
                <span className="font-display text-[15px] uppercase tracking-wide text-ink">
                  {c.name}
                </span>
                {isPending ? (
                  <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-dim">
                    connecting…
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
