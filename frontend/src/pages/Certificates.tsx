import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Award, FileDown, QrCode, Loader2 } from "lucide-react";
import { api, API_BASE_URL, type EvidenceRecord } from "../lib/api";

export default function Certificates() {
  const [evidence, setEvidence] = useState<EvidenceRecord[] | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);

  useEffect(() => {
    api.get<EvidenceRecord[]>("/evidence").then(({ data }) => setEvidence(data));
  }, []);

  const downloadCertificate = (id: string) => {
    window.open(`${API_BASE_URL}/evidence/${id}/certificate`, "_blank");
  };

  return (
    <div className="p-8 max-w-4xl mx-auto fade-up">
      <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500 mb-2">Forensic documents</div>
      <div className="flex items-center gap-2 mb-1">
        <Award className="text-accent-500" size={20} />
        <h1 className="text-2xl font-bold text-white tracking-tight">Evidence certificates</h1>
      </div>
      <p className="text-sm text-slate-500 mb-8">
        Every finalized evidence item can produce a court-ready certificate with real hash, custody, and blockchain
        data -- and a QR code linking to public, independent verification.
      </p>

      {evidence === null && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 size={14} className="animate-spin" /> Loading evidence...
        </div>
      )}

      {evidence?.length === 0 && (
        <div className="text-center py-16 border border-dashed border-ink-700 rounded-xl">
          <p className="text-slate-500 text-sm">No evidence registered yet.</p>
        </div>
      )}

      <div className="space-y-3">
        {evidence?.map((ev) => (
          <div key={ev.evidence_id} className="glass-panel rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <Link to={`/evidence/${ev.evidence_id}`} className="text-sm mono text-accent-500 hover:underline">
                  {ev.evidence_id}
                </Link>
                <div className="text-xs text-slate-500 mt-0.5">{ev.case_id} · {ev.camera_id}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setQrFor(qrFor === ev.evidence_id ? null : ev.evidence_id)}
                  className="flex items-center gap-1.5 text-xs border border-ink-700 rounded-xl px-3 py-1.5 hover:border-accent-500/50 hover:text-accent-500 transition-colors"
                >
                  <QrCode size={13} /> QR
                </button>
                <button
                  onClick={() => downloadCertificate(ev.evidence_id)}
                  className="flex items-center gap-1.5 text-xs bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold rounded-xl px-3 py-1.5 transition-colors"
                >
                  <FileDown size={13} /> Certificate
                </button>
              </div>
            </div>
            {qrFor === ev.evidence_id && (
              <div className="mt-4 flex items-center gap-4 border-t border-ink-800 pt-4">
                <img
                  src={`${API_BASE_URL}/evidence/${ev.evidence_id}/qr`}
                  alt={`QR verification code for ${ev.evidence_id}`}
                  className="w-28 h-28 rounded-lg bg-white p-1.5"
                />
                <div className="text-xs text-slate-500">
                  <p>Scans to the public verification page -- no login required.</p>
                  <Link to={`/verify/${ev.evidence_id}`} className="text-accent-500 hover:underline mt-1 inline-block">
                    Open verification page →
                  </Link>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
