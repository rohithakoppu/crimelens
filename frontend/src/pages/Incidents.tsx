import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Radio, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { api, type Incident } from "../lib/api";

const SEVERITY_STYLE: Record<Incident["severity"], string> = {
  HIGH: "text-danger-500 border-danger-500/30 bg-danger-500/10",
  MEDIUM: "text-warn-500 border-warn-500/30 bg-warn-500/10",
  LOW: "text-slate-400 border-ink-600 bg-ink-800",
};

export default function Incidents() {
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Incident[]>("/incidents")
      .then(({ data }) => setIncidents(data))
      .catch((err) => {
        const detail = err?.response?.data?.detail;
        setError(detail ?? "Could not load incidents.");
      });
  }, []);

  return (
    <div className="p-8 max-w-4xl mx-auto fade-up">
      <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500 mb-2">Threat monitoring</div>
      <div className="flex items-center gap-2 mb-1">
        <Radio className="text-accent-500" size={20} />
        <h1 className="text-2xl font-bold text-white tracking-tight">Camera incidents</h1>
      </div>
      <p className="text-sm text-slate-500 mb-8">
        Real camera-attack incidents -- created automatically when Live Camera obstruction detection fires.
      </p>

      {error && <p className="text-sm text-danger-500">{error}</p>}

      {!error && incidents === null && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 size={14} className="animate-spin" /> Loading...
        </div>
      )}

      {incidents?.length === 0 && (
        <div className="text-center py-16 border border-dashed border-ink-700 rounded-xl">
          <CheckCircle2 className="mx-auto text-slate-600 mb-3" size={28} />
          <p className="text-slate-500 text-sm">No incidents detected.</p>
        </div>
      )}

      {incidents && incidents.length > 0 && (
        <div className="space-y-3">
          {incidents.map((inc) => (
            <div key={inc.id} className="glass-panel rounded-2xl p-4 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 w-7 h-7 rounded-full border flex items-center justify-center shrink-0 ${SEVERITY_STYLE[inc.severity]}`}>
                  <AlertTriangle size={13} />
                </span>
                <div>
                  <div className="text-sm text-slate-200">{inc.incident_type.replace(/_/g, " ")}</div>
                  <div className="text-xs text-slate-500 mt-0.5 mono">
                    {inc.camera_id} {inc.case_id ? `· ${inc.case_id}` : ""}
                  </div>
                  <div className="text-[11px] text-slate-600 mt-1">
                    {new Date(inc.created_at).toLocaleString()}
                    {typeof inc.metadata.confidence === "number" && ` · ${inc.metadata.confidence}% confidence`}
                  </div>
                  {inc.case_id && (
                    <Link to={`/case/${inc.case_id}`} className="text-[11px] text-accent-500 hover:underline mt-1 inline-block">
                      View case →
                    </Link>
                  )}
                </div>
              </div>
              <span className={`text-[10px] px-2 py-1 rounded-full border shrink-0 ${SEVERITY_STYLE[inc.severity]}`}>
                {inc.severity}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
