import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Database, Loader2, AlertTriangle, FileCheck2, ArrowRight } from "lucide-react";
import { api, type EvidenceRecord } from "../lib/api";

/**
 * Real Evidence Library list page -- reads the same GET /evidence endpoint
 * already used by Dashboard/Certificates/Blockchain. Previously there was
 * no route mounted at /evidence (only /evidence/:evidenceId existed), so
 * the "Evidence Library" nav link fell through to the catch-all route and
 * redirected to the landing page instead of showing anything -- that
 * missing route was the actual bug, not the API or data layer, both of
 * which already worked correctly elsewhere in the app.
 */
export default function EvidenceLibrary() {
  const [evidence, setEvidence] = useState<EvidenceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .get<EvidenceRecord[]>("/evidence")
      .then(({ data }) => setEvidence(data))
      .catch((err: unknown) => {
        const detail =
          err && typeof err === "object" && "response" in err
            ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
            : undefined;
        const message =
          err && typeof err === "object" && "message" in err ? (err as { message?: string }).message : undefined;
        setError(detail ?? message ?? "Could not reach the server.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div className="p-8 max-w-6xl mx-auto fade-up">
      <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500 mb-2">Evidence vault</div>
      <div className="flex items-center gap-2 mb-1">
        <Database className="text-accent-500" size={20} />
        <h1 className="text-2xl font-bold text-white tracking-tight">Evidence Library</h1>
      </div>
      <p className="text-sm text-slate-500 mb-8">
        Every evidence record actually created via Live Camera, Prototype Video, or case ingest -- read live from
        the backend, never hardcoded.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 size={14} className="animate-spin" /> Loading evidence...
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-3 text-sm text-danger-500 bg-danger-500/10 rounded-2xl p-5">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">UNABLE TO LOAD EVIDENCE</p>
            <p className="text-xs text-danger-400 mt-1">{error}</p>
          </div>
        </div>
      )}

      {!loading && !error && evidence !== null && evidence.length === 0 && (
        <div className="text-center py-20 border border-dashed border-ink-800 rounded-2xl bg-ink-900/30">
          <FileCheck2 className="mx-auto text-slate-600 mb-3" size={32} />
          <p className="text-slate-300 text-sm font-semibold">NO EVIDENCE RECORDS</p>
          <p className="text-slate-600 text-xs mt-1">No evidence has been captured yet.</p>
          <Link to="/camera" className="inline-flex items-center gap-1.5 text-xs text-accent-500 hover:underline mt-4">
            Open Live Camera <ArrowRight size={12} />
          </Link>
        </div>
      )}

      {!loading && !error && evidence !== null && evidence.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {evidence.map((ev) => (
            <Link
              key={ev.evidence_id}
              to={`/evidence/${ev.evidence_id}`}
              className="glass-panel rounded-2xl p-5 hover:-translate-y-0.5 hover:border-accent-500/30 transition-all"
            >
              <div className="flex items-start justify-between">
                <div className="rounded-lg bg-accent-500/10 p-2 text-accent-500">
                  <FileCheck2 size={16} />
                </div>
                <span
                  className={`text-[10px] px-2 py-1 rounded-full mono ${
                    ev.blockchain_status === "CONFIRMED" ? "bg-accent-500/10 text-accent-500" : "bg-ink-800 text-slate-400"
                  }`}
                >
                  {ev.blockchain_status}
                </span>
              </div>
              <div className="mono mt-4 text-sm font-bold text-white break-all">{ev.evidence_id}</div>
              <div className="text-xs text-slate-500 mt-1.5">
                {ev.case_id} · {ev.camera_id}
              </div>
              <div className="mt-3 text-[11px] mono text-slate-500 truncate">SHA-256: {ev.sha256}</div>
              <div className="mt-4 pt-3 border-t border-ink-800 flex items-center justify-between text-[11px]">
                <span className="text-slate-500">
                  {ev.ingested_at ? new Date(ev.ingested_at).toLocaleString() : "—"}
                </span>
                <span className={ev.storage_status === "STORED" ? "text-accent-500" : "text-warn-500"}>
                  {ev.storage_status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
