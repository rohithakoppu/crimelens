import { useEffect, useState } from "react";
import { KeyRound, Plus, Loader2, Copy, Send } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

interface ApiClient {
  id: string;
  name: string;
  tier: string;
  key_prefix: string;
  created_at: string;
  active: boolean;
}

export default function ApiAccess() {
  const { user } = useAuth();
  const [clients, setClients] = useState<ApiClient[]>([]);
  const [name, setName] = useState("");
  const [tier, setTier] = useState("free");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [apiKey, setApiKey] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [txid, setTxid] = useState("");
  const [callResult, setCallResult] = useState<Record<string, unknown> | null>(null);
  const [callStatus, setCallStatus] = useState<number | null>(null);
  const [calling, setCalling] = useState(false);

  const loadClients = () => {
    if (user?.role !== "admin") return;
    api.get<ApiClient[]>("/api/v1/clients").then(({ data }) => setClients(data)).catch(() => setClients([]));
  };
  useEffect(loadClients, [user]);

  const createClient = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const { data } = await api.post("/api/v1/clients", { name, tier });
      setNewKey(data.api_key);
      setName("");
      loadClients();
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
      setError(message ?? "Could not create API client.");
    } finally {
      setCreating(false);
    }
  };

  const callVerifyApi = async () => {
    setCalling(true);
    setCallResult(null);
    setCallStatus(null);
    try {
      const headers: Record<string, string> = { "X-API-Key": apiKey };
      if (txid) headers["X-PAYMENT"] = txid;
      const resp = await fetch(`${api.defaults.baseURL}/api/v1/verification/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ evidence_id: evidenceId }),
      });
      const body = await resp.json();
      setCallStatus(resp.status);
      setCallResult(body);
    } catch {
      setCallStatus(0);
      setCallResult({ error: "Network error calling the API" });
    } finally {
      setCalling(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto fade-up">
      <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500 mb-2">Developer access</div>
      <div className="flex items-center gap-2 mb-2">
        <KeyRound className="text-accent-500" size={20} />
        <h1 className="text-2xl font-bold text-white tracking-tight">API Access &amp; x402 Payment Layer</h1>
      </div>
      <p className="text-sm text-slate-500 mb-6 max-w-2xl">
        External systems (insurance, forensic partners) call <code className="mono">/api/v1/verification/verify</code>{" "}
        with an API key. Once a tier's free hourly quota is exhausted, the API returns a real{" "}
        <span className="text-warn-500 font-medium">HTTP 402 Payment Required</span> with machine-readable payment
        requirements — settlement is verified for real against the Algorand Indexer, never simulated.
      </p>

      {user?.role === "admin" && (
        <div className="mb-8">
          <p className="text-xs text-slate-500 mb-3">Issue an API key</p>
          <form onSubmit={createClient} className="flex flex-wrap gap-3 items-end glass-panel rounded-2xl p-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Client name</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Insurance"
                className="bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Tier</label>
              <select value={tier} onChange={(e) => setTier(e.target.value)} className="bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60">
                <option value="free">Free (10/hr)</option>
                <option value="pro">Pro (1000/hr)</option>
                <option value="enterprise">Enterprise (unlimited)</option>
              </select>
            </div>
            <button disabled={creating} className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-sm rounded-xl px-4 py-2 disabled:opacity-60">
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create key
            </button>
          </form>
          {error && <p className="text-xs text-danger-500 mt-2">{error}</p>}
          {newKey && (
            <div className="mt-3 flex items-center gap-2 bg-accent-500/10 border border-accent-500/30 rounded-lg px-3 py-2 text-xs">
              <span className="mono text-accent-500 break-all">{newKey}</span>
              <button onClick={() => navigator.clipboard.writeText(newKey)} className="text-slate-400 hover:text-slate-200 shrink-0"><Copy size={13} /></button>
              <span className="text-slate-500 shrink-0">(shown once — save it now)</span>
            </div>
          )}

          <div className="glass-panel rounded-2xl overflow-hidden mt-4">
            <table className="w-full text-sm">
              <thead className="bg-ink-800 text-slate-400 text-xs">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium">Tier</th>
                  <th className="text-left px-4 py-2.5 font-medium">Key prefix</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-t border-ink-700">
                    <td className="px-4 py-2.5 text-slate-200">{c.name}</td>
                    <td className="px-4 py-2.5 capitalize text-slate-400">{c.tier}</td>
                    <td className="px-4 py-2.5 mono text-slate-500">{c.key_prefix}…</td>
                    <td className="px-4 py-2.5 text-slate-400">{c.active ? "Active" : "Disabled"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <p className="text-xs text-slate-500 mb-3">Try the paid verification API</p>
        <div className="glass-panel rounded-2xl p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">API key</label>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="eca_..."
                className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500 mono" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Evidence ID</label>
              <input value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} placeholder="EVD-2026-..."
                className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500 mono" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">X-PAYMENT (Algorand txid, optional)</label>
              <input value={txid} onChange={(e) => setTxid(e.target.value)} placeholder="only needed after a 402"
                className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500 mono" />
            </div>
          </div>
          <button onClick={callVerifyApi} disabled={calling || !apiKey || !evidenceId}
            className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-sm rounded-xl px-4 py-2 disabled:opacity-60">
            {calling ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Call /api/v1/verification/verify
          </button>

          {callStatus !== null && (
            <div>
              <div className={`text-xs font-medium mb-1 ${callStatus === 200 ? "text-accent-500" : callStatus === 402 ? "text-warn-500" : "text-danger-500"}`}>
                HTTP {callStatus} {callStatus === 402 ? "PAYMENT REQUIRED" : callStatus === 200 ? "OK" : ""}
              </div>
              <pre className="text-[11px] text-slate-400 bg-ink-800 rounded-lg p-3 overflow-x-auto scrollbar-thin whitespace-pre-wrap">
                {JSON.stringify(callResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
