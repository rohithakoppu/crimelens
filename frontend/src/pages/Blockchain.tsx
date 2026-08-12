import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Blocks, CheckCircle2, AlertTriangle, ExternalLink, Loader2, FileCode2 } from "lucide-react";
import { api, type EvidenceRecord, type HealthStatus } from "../lib/api";

export default function Blockchain() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<HealthStatus>("/health"),
      api.get<EvidenceRecord[]>("/evidence"),
    ])
      .then(([h, e]) => {
        setHealth(h.data);
        setEvidence(e.data);
      })
      .finally(() => setLoading(false));
  }, []);

  const algo = health?.services.algorand;
  const contract = health?.services.smart_contract;
  const connected = !!algo?.connected;
  const funded = (algo?.balance_microalgos ?? 0) > 0;
  const deployed = contract?.status === "DEPLOYED";

  return (
    <div className="p-8 max-w-4xl mx-auto fade-up">
      <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500 mb-2">Trust anchor</div>
      <div className="flex items-center gap-2 mb-1">
        <Blocks className="text-accent-500" size={20} />
        <h1 className="text-2xl font-bold text-white tracking-tight">Blockchain registry</h1>
      </div>
      <p className="text-sm text-slate-500 mb-8">
        Each evidence item's Root Hash -- the fingerprint of its entire segment chain, not just the first
        chunk -- is registered on the real CrimeLens Evidence Registry smart contract. No fabricated
        transaction or application IDs are ever shown in place of a real one.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 size={14} className="animate-spin" /> Checking blockchain status...
        </div>
      ) : (
        <>
          {/* Smart contract deployment status */}
          <div className={`rounded-2xl border p-6 mb-6 ${deployed ? "border-ink-700/60 glass-panel" : "border-warn-500/30 bg-warn-500/5"}`}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
                <FileCode2 size={13} /> Evidence Registry Smart Contract
              </span>
              {deployed ? (
                <span className="flex items-center gap-1.5 text-xs text-accent-500"><CheckCircle2 size={13} /> Deployed</span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-warn-500"><AlertTriangle size={13} /> Not Configured</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <dt className="text-slate-500 mb-1">Network</dt>
                <dd className="text-slate-200 capitalize">{contract?.network ?? "unknown"}</dd>
              </div>
              <div>
                <dt className="text-slate-500 mb-1">Application ID</dt>
                <dd className="text-slate-200 mono">{contract?.app_id ?? "UNAVAILABLE"}</dd>
              </div>
            </dl>
            {!deployed && (
              <p className="text-[11px] text-slate-500 mt-4 leading-relaxed">
                No real Application ID is configured (ALGORAND_APP_ID is empty in backend/.env) -- the contract
                has not been deployed yet. Deploy it via <code className="mono">scripts/deploy_contract.py</code>,
                which requires the system account below to hold enough ALGO to cover the deployment fee and
                subsequent box-storage costs.
              </p>
            )}
          </div>

          {/* System anchor account */}
          <div className={`rounded-2xl border p-6 mb-8 ${connected ? "border-ink-700/60 glass-panel" : "border-danger-500/30 bg-danger-500/5"}`}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs uppercase tracking-widest text-slate-500">System Anchor Account</span>
              {connected ? (
                <span className="flex items-center gap-1.5 text-xs text-accent-500"><CheckCircle2 size={13} /> Node Reachable</span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-danger-500"><AlertTriangle size={13} /> Not Connected</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <dt className="text-slate-500 mb-1">Address</dt>
                <dd className="text-slate-200 mono break-all">{algo?.address ?? "not configured"}</dd>
              </div>
              <div>
                <dt className="text-slate-500 mb-1">Balance</dt>
                <dd className={funded ? "text-accent-500" : "text-warn-500"}>
                  {algo?.balance_microalgos !== null && algo?.balance_microalgos !== undefined
                    ? `${(algo.balance_microalgos / 1_000_000).toFixed(3)} ALGO`
                    : "unknown"}
                </dd>
              </div>
            </dl>
            {!funded && (
              <p className="text-[11px] text-slate-500 mt-4 leading-relaxed">
                Fund this address via the Algorand Testnet dispenser (bank.testnet.algorand.network) to enable
                deployment and real registrations.
              </p>
            )}
          </div>

          <p className="text-xs text-slate-500 mb-3">Evidence Root Hash anchor status</p>
          {evidence.length === 0 ? (
            <p className="text-sm text-slate-600">No evidence registered yet.</p>
          ) : (
            <div className="space-y-2">
              {evidence.map((ev) => (
                <div key={ev.evidence_id} className="glass-panel rounded-xl p-3 flex items-center justify-between">
                  <div>
                    <Link to={`/evidence/${ev.evidence_id}`} className="text-xs mono text-accent-500 hover:underline">
                      {ev.evidence_id}
                    </Link>
                    <div className="text-[11px] text-slate-600 mt-0.5">{ev.case_id} · {ev.camera_id}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill status={ev.blockchain_status} />
                    {ev.algorand_txid && (
                      <a
                        href={`https://testnet.explorer.perawallet.app/tx/${ev.algorand_txid}`}
                        target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 text-[11px] text-purple-500 hover:underline"
                      >
                        <ExternalLink size={11} /> Explorer
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    CONFIRMED: "text-accent-500 border-accent-500/30 bg-accent-500/10",
    PENDING: "text-warn-500 border-warn-500/30 bg-warn-500/10",
    NOT_CONFIGURED: "text-slate-400 border-ink-600 bg-ink-800",
    BLOCKED: "text-danger-500 border-danger-500/30 bg-danger-500/10",
    UNAVAILABLE: "text-slate-400 border-ink-600 bg-ink-800",
  };
  return (
    <span className={`text-[10px] px-2 py-1 rounded-full border ${map[status] ?? map.UNAVAILABLE}`}>
      {status}
    </span>
  );
}
