import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  FolderOpen, Plus, ArrowUpRight, Video, AlertTriangle, ShieldCheck, Database, Blocks, Radio, RefreshCw
} from "lucide-react";
import { api, type CaseSummary, type HealthStatus, type EvidenceRecord, type Incident, type CameraRecord } from "../lib/api";

export default function Dashboard() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [evidenceList, setEvidenceList] = useState<EvidenceRecord[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [cameras, setCameras] = useState<CameraRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newCaseId, setNewCaseId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const navigate = useNavigate();

  const loadData = async () => {
    setLoading(true);
    try {
      const [casesRes, evidenceRes, healthRes, incidentsRes, camerasRes] = await Promise.allSettled([
        api.get<CaseSummary[]>("/case"),
        api.get<EvidenceRecord[]>("/evidence"),
        api.get<HealthStatus>("/health"),
        api.get<Incident[]>("/incidents"),
        api.get<CameraRecord[]>("/cameras"),
      ]);

      if (casesRes.status === "fulfilled") setCases(casesRes.value.data);
      if (evidenceRes.status === "fulfilled") setEvidenceList(evidenceRes.value.data);
      if (healthRes.status === "fulfilled") setHealth(healthRes.value.data);
      if (incidentsRes.status === "fulfilled") setIncidents(incidentsRes.value.data);
      if (camerasRes.status === "fulfilled") setCameras(camerasRes.value.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.post("/case", { case_id: newCaseId, title: newTitle });
    setShowCreate(false);
    setNewCaseId("");
    setNewTitle("");
    loadData();
  };

  const totalEvidence = evidenceList.length;
  const anchoredCount = evidenceList.filter((e) => e.blockchain_status === "CONFIRMED").length;
  const storedCount = evidenceList.filter((e) => e.storage_status === "STORED").length;
  const openIncidents = incidents.filter((i) => i.status === "OPEN").length;
  const firebaseOnline = health?.services?.firebase?.configured ?? false;
  const algorandOnline = health?.services?.algorand?.connected ?? false;

  return (
    <div className="max-w-7xl mx-auto space-y-8 fade-up">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-ink-800 pb-6">
        <div>
          <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500">Command center</div>
          <div className="flex items-center gap-2 mt-2">
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">Forensic Command Center</h1>
            <span className="mono text-[10px] uppercase bg-accent-500/10 text-accent-500 px-2 py-0.5 rounded-full font-semibold">
              Live Operation
            </span>
          </div>
          <p className="mono text-xs text-slate-500 mt-2">
            CAPTURE → SEGMENT → HASH CHAIN → REMOTE STORAGE → BLOCKCHAIN ANCHOR
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadData}
            className="p-2.5 rounded-xl border border-ink-700 bg-ink-900 text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
            title="Refresh Data"
          >
            <RefreshCw size={16} className={loading ? "animate-spin text-accent-500" : ""} />
          </button>
          <Link
            to="/camera"
            className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 text-sm font-bold rounded-xl px-4 py-2.5 transition-colors"
          >
            <Video size={16} /> Open Live Camera
          </Link>
        </div>
      </div>

      {/* Real Command Center Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label="Registered Cameras"
          value={cameras.length}
          subtext={cameras.length > 0 ? "WebCameraSource" : "None registered yet"}
          icon={Video}
          color="accent"
        />
        <MetricCard
          label="Protected Evidence"
          value={totalEvidence}
          subtext={`${storedCount} Stored (Encrypted)`}
          icon={ShieldCheck}
          color="accent"
        />
        <MetricCard
          label="Blockchain Anchors"
          value={anchoredCount}
          subtext={algorandOnline ? "Algorand Testnet" : "Chain Pending"}
          icon={Blocks}
          color={algorandOnline ? "accent" : "warn"}
        />
        <MetricCard
          label="Active Alerts"
          value={openIncidents}
          subtext={openIncidents > 0 ? "Requires Attention" : "All Clear"}
          icon={Radio}
          color={openIncidents > 0 ? "danger" : "accent"}
        />
      </div>

      {/* System Health Notices -- only fires on a genuine problem, not a
         permanent architectural fallback: evidence files live on local
         encrypted disk storage by design (backend/data/evidence/), not
         Firebase Cloud Storage, so there's nothing to warn about unless
         Firestore itself (metadata/custody/auth) is actually unreachable. */}
      {health && !firebaseOnline && (
        <div className="flex items-start gap-3 text-xs text-warn-500 bg-warn-500/10 border border-warn-500/20 rounded-xl p-4">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold block mb-0.5">Firestore Unreachable</span>
            Case/evidence metadata, custody events, and authentication depend on Firestore -- verify FIREBASE_* config in backend/.env.
          </div>
        </div>
      )}
      {evidenceList.some((e) => e.storage_status === "UNAVAILABLE") && (
        <div className="flex items-start gap-3 text-xs text-danger-500 bg-danger-500/10 border border-danger-500/30 rounded-xl p-4">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold block mb-0.5">Some evidence files failed to store locally</span>
            Check backend/data/evidence/ disk permissions and free space -- this is a real write failure, not expected behavior.
          </div>
        </div>
      )}

      {/* Main Grid: Cases & Live Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Cases */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="mono text-xs font-semibold text-slate-300 flex items-center gap-2 uppercase tracking-wider">
              <FolderOpen size={16} className="text-accent-500" /> Active Investigation Cases ({cases.length})
            </h2>
            <button
              onClick={() => setShowCreate((v) => !v)}
              className="flex items-center gap-1.5 text-xs bg-ink-900 border border-ink-700 rounded-lg px-3 py-1.5 text-slate-300 hover:border-accent-500/40 hover:text-accent-500 transition-colors"
            >
              <Plus size={14} /> New Case
            </button>
          </div>

          {showCreate && (
            <form onSubmit={handleCreate} className="glass-panel rounded-2xl p-5 flex flex-col md:flex-row gap-3 items-end">
              <div className="flex-1 w-full">
                <label className="text-xs text-slate-400 block mb-1.5">Case ID</label>
                <input
                  required
                  value={newCaseId}
                  onChange={(e) => setNewCaseId(e.target.value)}
                  placeholder="CASE-2026-001"
                  className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60 text-slate-100"
                />
              </div>
              <div className="flex-1 w-full">
                <label className="text-xs text-slate-400 block mb-1.5">Title</label>
                <input
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="HQ CCTV Monitoring Case"
                  className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60 text-slate-100"
                />
              </div>
              <button className="bg-accent-500 hover:bg-accent-600 text-ink-950 text-xs font-bold rounded-xl px-4 py-2.5 transition-colors shrink-0">
                Create Case
              </button>
            </form>
          )}

          {loading ? (
            <div className="p-8 text-center mono text-xs text-slate-500">Loading cases...</div>
          ) : cases.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-ink-800 rounded-2xl bg-ink-900/30">
              <FolderOpen className="mx-auto text-slate-600 mb-3" size={32} />
              <p className="text-slate-400 text-xs font-medium">No cases active yet.</p>
              <p className="text-slate-600 text-[11px] mt-1">Create a case or start recording from the Live Camera.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {cases.map((c) => (
                <button
                  key={c.case_id}
                  onClick={() => navigate(`/case/${c.case_id}`)}
                  className="glass-panel text-left rounded-2xl p-5 hover:border-accent-500/30 hover:-translate-y-0.5 transition-all group"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="mono text-[11px] text-accent-500">{c.case_id}</div>
                      <div className="text-sm font-semibold text-slate-100 mt-1">{c.title}</div>
                    </div>
                    <ArrowUpRight
                      size={16}
                      className="text-slate-500 group-hover:text-accent-500 transition-colors shrink-0"
                    />
                  </div>
                  <div className="flex items-center gap-3 mt-4 text-xs text-slate-400">
                    <span className="capitalize px-2 py-0.5 rounded-full bg-ink-950 mono text-[10px]">
                      {c.status}
                    </span>
                    <span className="mono text-[11px]">{c.evidence_count} evidence item{c.evidence_count === 1 ? "" : "s"}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Column: Recent Evidence Feed */}
        <div className="space-y-4">
          <h2 className="mono text-xs font-semibold text-slate-300 flex items-center gap-2 uppercase tracking-wider">
            <Database size={16} className="text-accent-500" /> Recent Evidence Records
          </h2>

          <div className="glass-panel rounded-2xl p-4 space-y-3">
            {evidenceList.length === 0 ? (
              <div className="text-center py-8 mono text-xs text-slate-500">
                No evidence captured yet.<br />Use Live Camera to start.
              </div>
            ) : (
              evidenceList.slice(0, 5).map((ev) => (
                <Link
                  key={ev.evidence_id}
                  to={`/evidence/${ev.evidence_id}`}
                  className="block p-3 rounded-xl bg-ink-950/60 border border-ink-800/70 hover:border-accent-500/30 transition-all"
                >
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="mono text-accent-500 font-medium">{ev.evidence_id}</span>
                    <span className="mono text-[10px] text-slate-500">
                      {ev.captured_at ? new Date(ev.captured_at).toLocaleTimeString() : "Recent"}
                    </span>
                  </div>
                  <div className="mono text-[11px] text-slate-400 truncate">
                    Hash: {ev.sha256.substring(0, 16)}...
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-ink-800/60 text-[10px]">
                    <span className={`px-1.5 py-0.5 rounded-full mono ${ev.blockchain_status === "CONFIRMED" ? "bg-accent-500/10 text-accent-500" : "bg-ink-800 text-slate-400"}`}>
                      Chain: {ev.blockchain_status}
                    </span>
                    <span className="text-slate-500">Storage: {ev.storage_status}</span>
                  </div>
                </Link>
              ))
            )}

            <Link
              to="/verify"
              className="block text-center text-xs mono text-accent-500 hover:underline pt-2"
            >
              Open Verification Engine →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  subtext,
  icon: Icon,
  color = "accent",
}: {
  label: string;
  value: number;
  subtext: string;
  icon: React.ElementType;
  color?: "accent" | "warn" | "danger";
}) {
  const colorMap = {
    accent: "text-accent-500 bg-accent-500/10",
    warn: "text-warn-500 bg-warn-500/10",
    danger: "text-danger-500 bg-danger-500/10",
  };

  return (
    <div className="glass-panel rounded-2xl p-4 flex flex-col justify-between">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{label}</span>
        <div className={`p-1.5 rounded-lg ${colorMap[color]}`}>
          <Icon size={16} />
        </div>
      </div>
      <div>
        <div className="mono text-2xl font-bold text-white">{value}</div>
        <div className="mono text-[11px] text-slate-500 mt-1">{subtext}</div>
      </div>
    </div>
  );
}

