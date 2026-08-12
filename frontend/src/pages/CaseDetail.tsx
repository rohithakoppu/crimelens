import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Camera,
  ShieldAlert,
  ScanEye,
  History,
  UploadCloud,
  Sparkles,
  Loader2,
  Send,
} from "lucide-react";
import { api, type TimelineEvent } from "../lib/api";

const EVENT_ICON: Record<string, typeof Camera> = {
  capture: Camera,
  tamper: ShieldAlert,
  detection: ScanEye,
  custody: History,
};

const EVENT_COLOR: Record<string, string> = {
  capture: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  tamper: "text-warn-500 border-warn-500/30 bg-warn-500/10",
  detection: "text-violet-400 border-violet-500/30 bg-violet-500/10",
  custody: "text-accent-500 border-accent-500/30 bg-accent-500/10",
};

function eventTitle(e: TimelineEvent): string {
  switch (e.type) {
    case "capture":
      return `Evidence captured (camera ${e.camera_id ?? "unknown"})`;
    case "tamper": {
      const result = e.result as { tamper_suspected?: boolean } | undefined;
      return result?.tamper_suspected ? "Tamper check flagged an anomaly" : "Tamper check passed";
    }
    case "detection": {
      const result = e.result as { detections?: unknown[] } | undefined;
      return `Object detection: ${result?.detections?.length ?? 0} object(s) found`;
    }
    case "custody":
      return `${e.action} by ${e.actor}`;
    default:
      return "Event";
  }
}

export default function CaseDetail() {
  const { caseId } = useParams<{ caseId: string }>();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"timeline" | "ingest" | "assistant">("timeline");

  const loadTimeline = () => {
    if (!caseId) return;
    setLoading(true);
    api
      .get(`/case/${caseId}/timeline`)
      .then(({ data }) => setEvents(data.events))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  return (
    <div className="p-8 max-w-5xl mx-auto fade-up">
      <Link to="/dashboard" className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 mb-4">
        <ArrowLeft size={14} /> Back to cases
      </Link>
      <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500">Case file</div>
      <h1 className="text-2xl font-bold text-white mono mt-2">{caseId}</h1>

      <div className="flex gap-1 mt-6 border-b border-ink-800">
        {(["timeline", "ingest", "assistant"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize border-b-2 transition-colors ${
              tab === t ? "border-accent-500 text-accent-500" : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            {t === "ingest" ? "Ingest evidence" : t === "assistant" ? "AI assistant" : "Case timeline"}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "timeline" && (
          <TimelineView events={events} loading={loading} onRefresh={loadTimeline} caseId={caseId!} />
        )}
        {tab === "ingest" && <IngestForm caseId={caseId!} onIngested={loadTimeline} />}
        {tab === "assistant" && <AssistantPanel caseId={caseId!} />}
      </div>
    </div>
  );
}

function TimelineView({
  events,
  loading,
  onRefresh,
}: {
  events: TimelineEvent[];
  loading: boolean;
  onRefresh: () => void;
  caseId: string;
}) {
  if (loading) return <p className="text-sm text-slate-500">Loading timeline...</p>;
  if (events.length === 0) {
    return (
      <div className="text-center py-16 border border-dashed border-ink-700 rounded-xl">
        <p className="text-slate-500 text-sm">
          No events yet. Ingest evidence from the "Ingest evidence" tab to populate the timeline.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={onRefresh} className="text-xs text-slate-500 hover:text-accent-500">
          Refresh
        </button>
      </div>
      <div className="relative pl-6 border-l border-ink-700 space-y-6">
        {events.map((e, i) => {
          const Icon = EVENT_ICON[e.type] ?? History;
          const color = EVENT_COLOR[e.type] ?? "text-slate-400 border-ink-600 bg-ink-800";
          return (
            <div key={i} className="relative">
              <span
                className={`absolute -left-[31px] w-6 h-6 rounded-full border flex items-center justify-center ${color}`}
              >
                <Icon size={13} />
              </span>
              <div className="glass-panel rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-100">{eventTitle(e)}</span>
                  <span className="text-[11px] text-slate-500">{new Date(e.timestamp).toLocaleString()}</span>
                </div>
                <Link
                  to={`/evidence/${e.evidence_id}`}
                  className="text-[11px] text-accent-500 hover:underline mono block mt-1"
                >
                  {e.evidence_id.slice(0, 22)}...
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IngestForm({ caseId, onIngested }: { caseId: string; onIngested: () => void }) {
  const [cameraId, setCameraId] = useState("CAM-NORTHGATE-04");
  const [lat, setLat] = useState("28.6139");
  const [lon, setLon] = useState("77.2090");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("case_id", caseId);
      form.append("camera_id", cameraId);
      form.append("gps_lat", lat);
      form.append("gps_lon", lon);
      form.append("file", file);
      const { data } = await api.post("/evidence/ingest", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setResult(data.evidence_id);
      onIngested();
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
      setError(message ?? "Ingestion failed. Is the backend + local chain running?");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="glass-panel rounded-2xl p-6 max-w-lg space-y-4">
      <div className="flex items-center gap-2 text-slate-300 text-sm mb-2">
        <UploadCloud size={16} className="text-accent-500" />
        Hash → sign → anchor → encrypted storage, in that order
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1.5">Camera ID</label>
        <input
          value={cameraId}
          onChange={(e) => setCameraId(e.target.value)}
          className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-400 block mb-1.5">GPS Lat</label>
          <input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1.5">GPS Lon</label>
          <input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1.5">Evidence file (image)</label>
        <input
          type="file"
          accept="image/*"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-xs text-slate-400 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-ink-800 file:text-slate-300"
        />
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
      {result && (
        <p className="text-xs text-accent-500 mono break-all">
          Evidence created: {result}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-sm rounded-xl px-4 py-2.5 transition-colors disabled:opacity-60"
      >
        {submitting && <Loader2 size={14} className="animate-spin" />}
        Ingest evidence
      </button>
    </form>
  );
}

function AssistantPanel({ caseId }: { caseId: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; sources?: { text: string; relevance: number }[] } | null>(
    null
  );
  const [loading, setLoading] = useState(false);

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post(`/case/${caseId}/assistant/query`, { question });
      setAnswer(data);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <form onSubmit={handleAsk} className="flex gap-2 mb-6">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Was any tampering detected on this case?"
          className="flex-1 bg-ink-900 border border-ink-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-accent-500/60"
        />
        <button
          disabled={loading || !question}
          className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-sm rounded-xl px-4 py-2.5 transition-colors disabled:opacity-60"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </form>

      {answer && (
        <div className="glass-panel rounded-2xl p-5">
          <div className="flex items-center gap-2 text-accent-500 text-xs mb-3">
            <Sparkles size={14} /> Grounded in this case's logged events only
          </div>
          <p className="text-sm text-slate-200 leading-relaxed">{answer.answer}</p>
          {answer.sources && answer.sources.length > 0 && (
            <div className="mt-4 space-y-1.5">
              <p className="text-xs text-slate-500">Sources</p>
              {answer.sources.map((s, i) => (
                <div key={i} className="text-xs text-slate-400 bg-ink-800 rounded px-3 py-2">
                  {s.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
