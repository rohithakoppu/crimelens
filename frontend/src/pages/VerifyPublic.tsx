import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ShieldCheck, Search, CheckCircle2, XCircle, Loader2, ExternalLink, FlaskConical, AlertOctagon, ArrowLeft, Upload,
} from "lucide-react";
import { api, type VerifyResult } from "../lib/api";

interface CopyVerifyResult {
  evidence_id: string;
  registered_hash: string;
  test_copy_hash: string;
  hash_match: boolean;
  verdict: "AUTHENTIC" | "TAMPERED";
  reason: string | null;
}

interface ChainTestResult {
  evidence_id: string;
  original_segment_count: number;
  test_segment_count: number;
  excluded_sequences: number[];
  reordered: boolean;
  chain: { intact: boolean; segment_count: number; broken_at: { sequence: number; reason: string } | null };
  verdict: "AUTHENTIC" | "INTEGRITY_FAILURE";
  failure_reason: string | null;
  failed_segment: number | null;
}

export default function VerifyPublic() {
  const { evidenceId: routeEvidenceId } = useParams<{ evidenceId?: string }>();
  const [evidenceId, setEvidenceId] = useState(routeEvidenceId ?? "");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [testFile, setTestFile] = useState<File | null>(null);
  const [copyResult, setCopyResult] = useState<CopyVerifyResult | null>(null);
  const [copyChecking, setCopyChecking] = useState(false);

  const [chainTestResult, setChainTestResult] = useState<ChainTestResult | null>(null);
  const [chainTestChecking, setChainTestChecking] = useState<"missing" | "reorder" | null>(null);

  const runVerification = async (id: string) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setCopyResult(null);
    try {
      const { data } = await api.get(`/evidence/${id.trim()}/verify`);
      setResult(data);
    } catch {
      setError("Could not find or verify that evidence ID.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (routeEvidenceId) runVerification(routeEvidenceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeEvidenceId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runVerification(evidenceId);
  };

  const runCopyCheck = async () => {
    if (!testFile || !result) return;
    setCopyChecking(true);
    setCopyResult(null);
    try {
      const form = new FormData();
      form.append("file", testFile);
      const { data } = await api.post<CopyVerifyResult>(`/evidence/${result.evidence_id}/verify-copy`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setCopyResult(data);
    } finally {
      setCopyChecking(false);
    }
  };

  const runChainTest = async (mode: "missing" | "reorder") => {
    if (!result) return;
    setChainTestChecking(mode);
    setChainTestResult(null);
    try {
      const body = mode === "missing" ? { exclude_sequences: [1] } : { reorder: true };
      const { data } = await api.post<ChainTestResult>(`/evidence/${result.evidence_id}/verify-chain-test`, body);
      setChainTestResult(data);
    } finally {
      setChainTestChecking(null);
    }
  };

  const authentic = result?.verdict === "AUTHENTIC";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 grid-bg py-12 text-slate-100">
      <div className="w-full max-w-2xl fade-up">
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs mono text-slate-400 hover:text-white mb-6">
          <ArrowLeft size={13} /> Back to CrimeLens
        </Link>

        <div className="flex flex-col items-center mb-8 text-center">
          <div className="w-12 h-12 rounded-2xl bg-accent-500/10 flex items-center justify-center mb-4 text-accent-500">
            <ShieldCheck size={26} />
          </div>
          <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500 mb-3">Integrity engine</div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Evidence Verification Engine</h1>
          <p className="text-xs text-slate-400 mt-2 max-w-md">
            No login required. Public deterministic verification engine re-checking SHA-256 payload hash,
            Ed25519 digital signature, custody event sequence, and Algorand Testnet anchor.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
          <input
            value={evidenceId}
            onChange={(e) => setEvidenceId(e.target.value)}
            placeholder="Enter Evidence ID (e.g. EVD-2026-000001)"
            className="flex-1 glass-panel rounded-2xl px-4 py-3 text-sm outline-none focus:border-accent-500/60 mono text-slate-100"
          />
          <button
            disabled={loading || !evidenceId}
            className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-xs rounded-2xl px-5 py-3 transition-all disabled:opacity-60"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Verify
          </button>
        </form>

        {error && <p className="text-xs text-danger-500 text-center font-mono mb-4">{error}</p>}

        {result && (
          <div className="space-y-6">
            {/* Verification Result Card */}
            <div className={`glass-panel border rounded-2xl p-6 ${authentic ? "border-accent-500/30" : "border-danger-500/30"}`}>
              <div className="flex items-center justify-between mb-6 pb-4 border-b border-ink-800">
                <div className={`flex items-center gap-2 text-xl font-bold mono ${authentic ? "text-accent-500" : "text-danger-500"}`}>
                  {authentic ? <CheckCircle2 size={24} /> : <AlertOctagon size={24} />}
                  VERDICT: {result.verdict}
                </div>
                <span className="text-xs mono text-slate-400">
                  {new Date().toLocaleTimeString()}
                </span>
              </div>

              {/* Cryptographic integrity -- entirely independent of blockchain
                 status, per custody/verification.py's verdict layering. */}
              <span className="text-[11px] uppercase tracking-widest text-slate-500 font-mono block mb-2">Local Cryptographic Verification</span>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
                <CheckTile label="Original Hash" ok={result.hash_match} />
                <CheckTile label="Signature" ok={result.signature_valid} />
                <CheckTile label="Custody Chain" ok={result.custody_chain_intact} />
                <CheckTile label="Segment Chain" ok={result.segment_chain_intact} />
                <CheckTile
                  label="Root Hash"
                  ok={result.root_hash_checked ? !!result.root_hash_match : true}
                  neutral={!result.root_hash_checked}
                />
              </div>

              {result.verdict !== "AUTHENTIC" && (result.failure_reason || result.failed_segment !== null) && (
                <div className="mb-6 rounded-xl border border-danger-500/30 bg-danger-500/5 p-4">
                  <div className="flex items-center gap-2 text-sm font-bold text-danger-500 font-mono mb-2">
                    <AlertOctagon size={16} /> INTEGRITY FAILURE
                  </div>
                  <dl className="text-xs font-mono space-y-1 text-slate-300">
                    {result.failed_segment !== null && (
                      <div>Segment: <span className="text-danger-500">{result.failed_segment}</span></div>
                    )}
                    {result.failure_reason && (
                      <div>Reason: <span className="text-danger-500">{result.failure_reason.replace(/_/g, " ")}</span></div>
                    )}
                    <div>Segment chain: <span className={result.segment_chain_intact ? "text-accent-500" : "text-danger-500"}>{result.segment_chain_intact ? "INTACT" : "BROKEN"}</span></div>
                  </dl>
                </div>
              )}

              <div className="space-y-4 text-xs font-mono bg-ink-950 p-4 rounded-xl border border-ink-800 mb-6">
                <div>
                  <dt className="text-slate-500 mb-1">REGISTERED ORIGINAL HASH</dt>
                  <dd className="text-slate-300 break-all bg-ink-900 px-3 py-1.5 rounded border border-ink-800">
                    {result.original_hash}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 mb-1">RECOMPUTED CURRENT HASH (from stored file)</dt>
                  <dd className={`break-all px-3 py-1.5 rounded border ${result.hash_match ? "text-slate-300 bg-ink-900 border-ink-800" : "text-danger-500 bg-danger-500/10 border-danger-500/30 font-semibold"}`}>
                    {result.current_hash}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 mb-1">
                    EVIDENCE ROOT HASH ({result.segment_count} segment{result.segment_count === 1 ? "" : "s"})
                  </dt>
                  <dd className="text-slate-300 break-all bg-ink-900 px-3 py-1.5 rounded border border-ink-800">
                    {result.root_hash ?? "UNAVAILABLE (no segments recorded)"}
                  </dd>
                </div>
              </div>

              {/* Blockchain verification -- a SEPARATE check from local
                 cryptographic integrity above, never folded into it.
                 UNAVAILABLE/NOT_CONFIGURED here never means TAMPERED. */}
              <div className="rounded-xl border border-ink-800 bg-ink-950 p-4 text-xs font-mono mb-2">
                <span className="text-slate-500 block mb-2">BLOCKCHAIN VERIFICATION</span>
                <span className={result.verification_status === "CONFIRMED" ? "text-accent-500 font-bold" : "text-warn-500 font-bold"}>
                  {result.verification_status}
                </span>
                <dl className="grid grid-cols-2 gap-2 mt-3 text-[10px]">
                  <div><dt className="text-slate-600">Network</dt><dd className="text-slate-300">{result.network}</dd></div>
                  <div><dt className="text-slate-600">Application ID</dt><dd className="text-slate-300">{result.application_id}</dd></div>
                  <div className="col-span-2"><dt className="text-slate-600">Transaction ID</dt><dd className="text-slate-300 break-all">{result.transaction_id}</dd></div>
                  <div className="col-span-2">
                    <dt className="text-slate-600">Blockchain Root Hash</dt>
                    <dd className={result.verification_status === "HASH_MISMATCH" ? "text-danger-500 break-all" : "text-slate-300 break-all"}>
                      {result.anchored_root_hash}
                    </dd>
                  </div>
                </dl>
                {!result.blockchain.checked && (
                  <p className="text-slate-600 mt-2">No blockchain anchor recorded for this evidence yet.</p>
                )}
                {result.blockchain.checked && !result.blockchain.verified && result.blockchain.reason && (
                  <p className="text-warn-500 mt-2">{result.blockchain.reason}</p>
                )}
                {result.blockchain.explorer_url && (
                  <a
                    href={result.blockchain.explorer_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-purple-500 hover:underline break-all mt-2"
                  >
                    <ExternalLink size={12} className="shrink-0" /> {result.blockchain.explorer_url}
                  </a>
                )}
              </div>
            </div>

            {/* Real controlled tamper test -- hashes an actually-uploaded file,
               never fabricates a result. Original evidence is never touched. */}
            <div className="glass-panel rounded-2xl p-4">
              <div className="flex items-center gap-2 text-xs text-warn-500 font-mono mb-3">
                <FlaskConical size={16} />
                <span>Controlled tamper test (uploads a real file, hashes it for real)</span>
              </div>
              <p className="text-[11px] text-slate-500 mb-3">
                Upload any file -- e.g. a copy of the original with one byte changed -- to see its real SHA-256
                compared against this evidence's registered hash. This never modifies the original evidence.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  onChange={(e) => setTestFile(e.target.files?.[0] ?? null)}
                  className="text-xs text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-ink-800 file:text-slate-300 flex-1"
                />
                <button
                  onClick={runCopyCheck}
                  disabled={!testFile || copyChecking}
                  className="flex items-center gap-1.5 text-xs bg-warn-500/20 text-warn-500 border border-warn-500/40 rounded-lg px-3 py-1.5 disabled:opacity-40"
                >
                  {copyChecking ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  Check test copy
                </button>
              </div>

              {copyResult && (
                <div className={`mt-4 rounded-lg p-3 border text-xs font-mono ${copyResult.hash_match ? "border-accent-500/30 bg-accent-500/5 text-accent-500" : "border-danger-500/30 bg-danger-500/5 text-danger-500"}`}>
                  <div className="font-bold flex items-center gap-1.5 mb-2">
                    {copyResult.hash_match ? <CheckCircle2 size={14} /> : <AlertOctagon size={14} />}
                    TEST COPY VERDICT: {copyResult.verdict}
                  </div>
                  <div className="space-y-1 text-[10px] text-slate-400">
                    <div>Registered: <span className="text-slate-300 break-all">{copyResult.registered_hash}</span></div>
                    <div>Test copy: <span className="break-all">{copyResult.test_copy_hash}</span></div>
                  </div>
                  {copyResult.reason && <p className="text-[11px] mt-2">{copyResult.reason}</p>}
                </div>
              )}
            </div>

            {/* Real segment-chain algorithm test -- pulls this evidence's
               ACTUAL stored segments, drops/reorders them in memory only
               (nothing written back), and runs the production
               verify_segments() function against the result. */}
            <div className="glass-panel rounded-2xl p-4">
              <div className="flex items-center gap-2 text-xs text-warn-500 font-mono mb-3">
                <FlaskConical size={16} />
                <span>Segment chain integrity test (real algorithm, no data modified)</span>
              </div>
              <p className="text-[11px] text-slate-500 mb-3">
                Runs the actual chain-verification function against a simulated missing or reordered segment,
                using this evidence's real stored segment hashes.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => runChainTest("missing")}
                  disabled={chainTestChecking !== null}
                  className="flex items-center gap-1.5 text-xs bg-warn-500/20 text-warn-500 border border-warn-500/40 rounded-lg px-3 py-1.5 disabled:opacity-40"
                >
                  {chainTestChecking === "missing" && <Loader2 size={12} className="animate-spin" />}
                  Simulate missing segment
                </button>
                <button
                  onClick={() => runChainTest("reorder")}
                  disabled={chainTestChecking !== null}
                  className="flex items-center gap-1.5 text-xs bg-warn-500/20 text-warn-500 border border-warn-500/40 rounded-lg px-3 py-1.5 disabled:opacity-40"
                >
                  {chainTestChecking === "reorder" && <Loader2 size={12} className="animate-spin" />}
                  Simulate reordered segments
                </button>
              </div>

              {chainTestResult && (
                <div className={`mt-4 rounded-lg p-3 border text-xs font-mono ${chainTestResult.chain.intact ? "border-accent-500/30 bg-accent-500/5 text-accent-500" : "border-danger-500/30 bg-danger-500/5 text-danger-500"}`}>
                  <div className="font-bold flex items-center gap-1.5 mb-2">
                    {chainTestResult.chain.intact ? <CheckCircle2 size={14} /> : <AlertOctagon size={14} />}
                    {chainTestResult.verdict}
                  </div>
                  <div className="space-y-1 text-[10px] text-slate-400">
                    <div>Original segments: {chainTestResult.original_segment_count} · Test segments: {chainTestResult.test_segment_count}</div>
                    {chainTestResult.failed_segment !== null && <div>Failed segment: <span className="text-danger-500">{chainTestResult.failed_segment}</span></div>}
                    {chainTestResult.failure_reason && <div>Reason: <span className="text-danger-500">{chainTestResult.failure_reason.replace(/_/g, " ")}</span></div>}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CheckTile({ label, ok, neutral }: { label: string; ok: boolean; neutral?: boolean }) {
  if (neutral) {
    return (
      <div className="rounded-xl border px-3 py-2.5 flex items-center gap-2 text-xs font-mono border-ink-700 bg-ink-800 text-slate-500">
        <span className="truncate">{label} N/A</span>
      </div>
    );
  }
  return (
    <div className={`rounded-xl border px-3 py-2.5 flex items-center gap-2 text-xs font-mono ${ok ? "border-accent-500/30 bg-accent-500/10 text-accent-500" : "border-danger-500/30 bg-danger-500/10 text-danger-500"}`}>
      {ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
      <span className="truncate">{label}</span>
    </div>
  );
}
