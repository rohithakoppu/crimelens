import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft, FileDown, CheckCircle2, XCircle, Loader2, History, ExternalLink, ShieldCheck, KeyRound, Lock,
  Cloud, CloudOff, Link2, QrCode, PlayCircle, Copy,
} from "lucide-react";
import {
  api, API_BASE_URL, type EvidenceRecord, type VerifyResult, type CustodyEvent, type CustodyChainStatus,
  type EvidenceSegment, type SegmentChainStatus, type BlockchainProofResult,
} from "../lib/api";

interface AIResultRow {
  type: string;
  result: Record<string, unknown>;
  hash: string | null;
  created_at: string;
}

export default function EvidenceDetail() {
  const { evidenceId } = useParams<{ evidenceId: string }>();
  const navigate = useNavigate();
  const [evidence, setEvidence] = useState<EvidenceRecord | null>(null);
  const [aiResults, setAiResults] = useState<AIResultRow[]>([]);
  const [custodyChain, setCustodyChain] = useState<CustodyChainStatus | null>(null);
  const [custodyEvents, setCustodyEvents] = useState<CustodyEvent[]>([]);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [segments, setSegments] = useState<EvidenceSegment[]>([]);
  const [segmentChain, setSegmentChain] = useState<SegmentChainStatus | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [blockchainProof, setBlockchainProof] = useState<BlockchainProofResult | null>(null);
  const [anchoring, setAnchoring] = useState(false);
  const [deriving, setDeriving] = useState(false);

  const load = () => {
    if (!evidenceId) return;
    api.get(`/evidence/${evidenceId}`).then(({ data }) => {
      setEvidence(data.evidence);
      setAiResults(data.ai_results);
      setCustodyChain(data.custody_chain);
      setLoading(false);
    });
    api.get(`/evidence/${evidenceId}/custody`).then(({ data }) => setCustodyEvents(data.events));
    api.get(`/evidence/${evidenceId}/segments`).then(({ data }) => {
      setSegments(data.segments);
      setSegmentChain(data.chain);
    });
    api.get<BlockchainProofResult>(`/evidence/${evidenceId}/blockchain`).then(({ data }) => setBlockchainProof(data));
  };

  useEffect(load, [evidenceId]);

  // Depends only on primitive values (not the whole `evidence` object) so
  // this never re-fetches the video blob just because load() ran again
  // (e.g. after logging a custody event or anchoring) and produced a new
  // object reference for the same underlying file -- previously this
  // re-downloaded and re-decrypted the full evidence file, sometimes tens
  // of MB, on every unrelated action on the page.
  const storageStatus = evidence?.storage_status;
  useEffect(() => {
    if (storageStatus !== "STORED" || !evidenceId) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .get(`/evidence/${evidenceId}/file`, { responseType: "blob" })
      .then((res) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
        setVideoUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setVideoError("Could not load the stored file for playback.");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [storageStatus, evidenceId]);

  const runVerify = async () => {
    setVerifying(true);
    try {
      const { data } = await api.get(`/evidence/${evidenceId}/verify`);
      setVerify(data);
    } finally {
      setVerifying(false);
    }
  };

  const logCustody = async (action: string) => {
    await api.post(`/evidence/${evidenceId}/custody`, { action, note: "" });
    load();
  };

  const anchorNow = async () => {
    setAnchoring(true);
    try {
      await api.post(`/evidence/${evidenceId}/anchor`);
    } finally {
      setAnchoring(false);
      load();
    }
  };

  const downloadCertificate = () => {
    window.open(`${api.defaults.baseURL}/evidence/${evidenceId}/certificate`, "_blank");
  };

  const createDerivedCopy = async () => {
    setDeriving(true);
    try {
      const { data } = await api.post<EvidenceRecord>(`/evidence/${evidenceId}/derive`);
      navigate(`/evidence/${data.evidence_id}`);
    } finally {
      setDeriving(false);
    }
  };

  if (loading) return <div className="p-8 text-sm text-slate-500">Loading evidence...</div>;
  if (!evidence) return <div className="p-8 text-sm text-slate-500">Evidence not found.</div>;

  return (
    <div className="p-8 max-w-4xl mx-auto fade-up">
      <Link
        to={evidence.is_derived && evidence.original_evidence_id ? `/evidence/${evidence.original_evidence_id}` : `/case/${evidence.case_id}`}
        className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 mb-4"
      >
        <ArrowLeft size={14} /> {evidence.is_derived ? "Back to original evidence" : "Back to case"}
      </Link>

      {evidence.is_derived && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warn-500/10 border border-warn-500/30 text-xs text-warn-500 mb-4 font-mono font-semibold">
          <Copy size={14} className="shrink-0" /> DERIVED COPY — NOT ORIGINAL EVIDENCE
          {evidence.original_evidence_id && (
            <Link to={`/evidence/${evidence.original_evidence_id}`} className="underline ml-1">
              (view original)
            </Link>
          )}
        </div>
      )}

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500">Evidence record</div>
          <h1 className="text-xl font-bold text-white mono break-all mt-1.5">{evidence.evidence_id}</h1>
          <p className="text-xs text-slate-500 mt-1">
            Case {evidence.case_id} · Camera {evidence.camera_id}
            {evidence.file_name && ` · ${evidence.file_name}`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!evidence.is_derived && (
            <button
              onClick={createDerivedCopy}
              disabled={deriving}
              title="Creates a real, separately-stored copy with its own evidence ID, clearly marked as a derived copy. The original file, hash, and custody chain are never modified."
              className="flex items-center gap-2 bg-ink-800 hover:bg-ink-700 border border-ink-700 text-xs rounded-xl px-3 py-2 transition-colors text-slate-300 disabled:opacity-40"
            >
              {deriving ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />} Create Derived Copy
            </button>
          )}
          <button
            onClick={() => setShowQr((v) => !v)}
            className="flex items-center gap-2 bg-ink-800 hover:bg-ink-700 border border-ink-700 text-xs rounded-xl px-3 py-2 transition-colors text-slate-300"
          >
            <QrCode size={13} /> QR
          </button>
          <button
            onClick={downloadCertificate}
            className="flex items-center gap-2 bg-accent-500/10 hover:bg-accent-500/20 text-accent-500 text-xs font-semibold rounded-xl px-3.5 py-2 transition-colors"
          >
            <FileDown size={14} /> Download Certificate
          </button>
        </div>
      </div>

      {/* Write-Once Immutability Banner */}
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-ink-900 border border-ink-800 text-xs text-slate-400 mb-6 font-mono">
        <Lock size={14} className="text-accent-500 shrink-0" />
        <span>IMMUTABLE EVIDENCE: Original video, SHA-256 hash, and custody log are write-once read-only.</span>
      </div>

      {showQr && (
        <div className="flex items-center gap-4 glass-panel rounded-2xl p-4 mb-6">
          <img
            src={`${API_BASE_URL}/evidence/${evidence.evidence_id}/qr`}
            alt="QR verification code"
            className="w-24 h-24 rounded-lg bg-white p-1.5"
          />
          <div className="text-xs text-slate-500">
            <p>No login required to verify. Scan or open:</p>
            <Link to={`/verify/${evidence.evidence_id}`} className="text-accent-500 hover:underline mt-1 inline-block">
              /verify/{evidence.evidence_id} →
            </Link>
          </div>
        </div>
      )}

      {/* Video player -- plays the real file from local encrypted disk storage
         (backend/data/evidence/) via /evidence/{id}/file. Honestly unavailable
         only on a genuine local write failure. */}
      <div className="bg-black rounded-2xl overflow-hidden border border-ink-700 mb-6 aspect-video flex items-center justify-center">
        {evidence.storage_status === "STORED" && videoUrl ? (
          <video src={videoUrl} controls className="w-full h-full" />
        ) : evidence.storage_status === "STORED" ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 size={14} className="animate-spin" /> Loading stored file...
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-center px-6">
            <PlayCircle className="text-slate-700" size={28} />
            <p className="text-xs text-slate-500">
              {videoError ?? "Original file not available for playback -- local evidence storage failed when this evidence was ingested."}
            </p>
            {evidence.storage_error && <p className="text-[10px] text-slate-700 mono break-all max-w-md">{evidence.storage_error}</p>}
          </div>
        )}
      </div>

      {/* Integrity pillars */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <PillarCard icon={KeyRound} label="Hash" ok={!!evidence.sha256} value="SHA-256" />
        <PillarCard icon={ShieldCheck} label="Signature" ok={!!evidence.signature} value="Ed25519" />
        <PillarCard icon={Lock} label="Encryption" ok={true} value="AES-256-GCM" />
        <StoragePillarCard status={evidence.storage_status} />
        <BlockchainPillarCard status={evidence.blockchain_status} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="glass-panel rounded-2xl p-5">
          <p className="text-xs text-slate-500 mb-2">SHA-256 (at registration)</p>
          <p className="text-xs mono break-all text-slate-300">{evidence.sha256}</p>
        </div>
        <div className="glass-panel rounded-2xl p-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-500">Deterministic verification</p>
            <button
              onClick={runVerify}
              disabled={verifying}
              className="text-xs text-accent-500 hover:underline flex items-center gap-1"
            >
              {verifying && <Loader2 size={12} className="animate-spin" />}
              Verify now
            </button>
          </div>
          {verify ? (
            <>
              <div
                className={`flex items-center gap-1.5 text-sm font-medium mb-3 ${
                  verify.verdict === "AUTHENTIC" ? "text-accent-500" : "text-danger-500"
                }`}
              >
                {verify.verdict === "AUTHENTIC" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                {verify.verdict}
              </div>
              <ul className="space-y-1 text-[11px] text-slate-400">
                <CheckRow label="Original hash match" ok={verify.hash_match} />
                <CheckRow label="Signature valid" ok={verify.signature_valid} />
                <CheckRow label="Custody chain intact" ok={verify.custody_chain_intact} />
                <CheckRow label="Segment chain intact" ok={verify.segment_chain_intact} />
                {verify.root_hash_checked && <CheckRow label="Root hash match" ok={!!verify.root_hash_match} />}
                <CheckRow label="Blockchain anchor" ok={verify.blockchain.verified} note={verify.blockchain.reason} />
              </ul>
              {verify.verdict !== "AUTHENTIC" && (verify.failure_reason || verify.failed_segment !== null) && (
                <p className="text-[11px] text-danger-500 mt-2">
                  {verify.failure_reason?.replace(/_/g, " ")}
                  {verify.failed_segment !== null && ` (segment ${verify.failed_segment})`}
                </p>
              )}
              {verify.root_hash && (
                <p className="text-[10px] text-slate-600 mono mt-2 break-all">
                  Root hash ({verify.segment_count} segments): {verify.root_hash}
                </p>
              )}
              <p className="text-[10px] text-slate-600 mt-2">
                Blockchain status: {verify.blockchain_status} -- reported independently of the integrity verdict above.
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-600">Click "Verify now" to recompute hash, re-check the signature, validate the custody chain, verify the segment chain and Evidence Root Hash, and re-verify the Algorand anchor via Indexer.</p>
          )}
        </div>
      </div>

      {/* Blockchain proof -- real, independently-read smart-contract state,
         never a cached/fabricated status. See custody/verification.py. */}
      <div className={`rounded-xl border px-4 py-4 mb-6 ${blockchainProof?.verification_status === "CONFIRMED" ? "border-accent-500/30 bg-accent-500/5" : "border-warn-500/30 bg-warn-500/5"}`}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-slate-300">BLOCKCHAIN PROOF</span>
          <span className={`text-[11px] font-medium ${blockchainProof?.verification_status === "CONFIRMED" ? "text-accent-500" : "text-warn-500"}`}>
            {blockchainProof?.verification_status ?? "..."}
          </span>
        </div>
        {blockchainProof && (
          <dl className="grid grid-cols-2 gap-3 text-[11px] mono">
            <div><dt className="text-slate-500">Network</dt><dd className="text-slate-300">{blockchainProof.network}</dd></div>
            <div><dt className="text-slate-500">Application ID</dt><dd className="text-slate-300">{blockchainProof.application_id}</dd></div>
            <div className="col-span-2"><dt className="text-slate-500">Transaction ID</dt><dd className="text-slate-300 break-all">{blockchainProof.transaction_id}</dd></div>
            <div className="col-span-2"><dt className="text-slate-500">Anchored Root Hash</dt><dd className="text-slate-300 break-all">{blockchainProof.anchored_root_hash}</dd></div>
            <div><dt className="text-slate-500">Anchor Timestamp</dt><dd className="text-slate-300">{blockchainProof.anchor_timestamp}</dd></div>
          </dl>
        )}
        {blockchainProof?.detail.reason && (
          <p className="text-[11px] text-warn-500 mt-3">Reason: {blockchainProof.detail.reason}</p>
        )}
        {evidence.blockchain_status !== "CONFIRMED" && (
          <button onClick={anchorNow} disabled={anchoring}
            className="flex items-center gap-1.5 text-xs bg-warn-500/20 text-warn-500 border border-warn-500/40 rounded-lg px-3 py-1.5 mt-3 disabled:opacity-40">
            {anchoring && <Loader2 size={12} className="animate-spin" />} Retry anchor
          </button>
        )}
        {evidence.algorand_txid && (
          <a
            href={`https://testnet.explorer.perawallet.app/tx/${evidence.algorand_txid}`}
            target="_blank" rel="noreferrer"
            className="flex items-center gap-2 text-xs text-purple-500 hover:underline mt-3 mono"
          >
            <ExternalLink size={12} /> View on Algorand Explorer
          </a>
        )}
      </div>

      <div className="mb-8">
        <p className="text-xs text-slate-500 mb-3">Log a custody event</p>
        <div className="flex gap-2 flex-wrap">
          {["ACCESSED", "EXPORTED", "TRANSFERRED", "ANALYZED"].map((action) => (
            <button
              key={action}
              onClick={() => logCustody(action)}
              className="flex items-center gap-1.5 text-xs border border-ink-600 rounded-lg px-3 py-1.5 hover:border-accent-500/50 hover:text-accent-500 transition-colors"
            >
              <History size={12} /> {action}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-slate-500">Chain of custody</p>
          {custodyChain && (
            <span className={`text-[11px] flex items-center gap-1 ${custodyChain.intact ? "text-accent-500" : "text-danger-500"}`}>
              {custodyChain.intact ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
              {custodyChain.intact ? "Chain of Custody Intact" : "Custody Chain Broken"}
            </span>
          )}
        </div>
        <div className="relative pl-6 border-l border-ink-700 space-y-3">
          {custodyEvents.map((ev) => (
            <div key={ev.id} className="relative">
              <span className="absolute -left-[27px] w-4 h-4 rounded-full bg-ink-800 border border-accent-500/30" />
              <div className="bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-200">{ev.event_type.replace(/_/g, " ")}</span>
                  <span className="text-slate-600">{new Date(ev.occurred_at).toLocaleString()}</span>
                </div>
                {ev.actor_name && <span className="text-slate-500">{ev.actor_name} ({ev.actor_role})</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {segments.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-500 flex items-center gap-1.5"><Link2 size={12} /> Segment hash chain</p>
            {segmentChain && (
              <span className={`text-[11px] flex items-center gap-1 ${segmentChain.intact ? "text-accent-500" : "text-danger-500"}`}>
                {segmentChain.intact ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {segmentChain.intact ? `${segmentChain.segment_count} segments intact` : `Broken at segment ${segmentChain.broken_at?.sequence}`}
              </span>
            )}
          </div>
          <div className="space-y-2">
            {segments.map((seg) => (
              <div key={seg.id} className="bg-ink-900 border border-ink-700 rounded-xl px-3 py-2.5 text-[11px]">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-slate-200 font-medium">
                    Segment {seg.sequence} · {seg.duration_seconds}s · {new Date(seg.created_at).toLocaleTimeString()}
                  </span>
                  {seg.storage_status === "STORED" ? (
                    <span className="flex items-center gap-1 text-accent-500"><Cloud size={11} /> Stored</span>
                  ) : (
                    <span className="flex items-center gap-1 text-warn-500"><CloudOff size={11} /> Unavailable</span>
                  )}
                </div>
                <dl className="grid grid-cols-1 gap-1 mono text-slate-500">
                  <div><dt className="inline text-slate-600">SHA-256: </dt><dd className="inline text-slate-400 break-all">{seg.sha256}</dd></div>
                  <div><dt className="inline text-slate-600">Previous hash: </dt><dd className="inline text-slate-400 break-all">{seg.prev_segment_hash}</dd></div>
                  <div><dt className="inline text-slate-600">Segment hash: </dt><dd className="inline text-slate-400 break-all">{seg.segment_hash}</dd></div>
                </dl>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-xs text-slate-500 mb-3">AI analysis results</p>
        <div className="space-y-3">
          {aiResults.length === 0 && <p className="text-xs text-slate-600">No AI results recorded.</p>}
          {aiResults.map((r, i) => (
            <div key={i} className="glass-panel rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase tracking-wide text-slate-400">{r.type}</span>
                <span className="text-[11px] text-slate-600">{new Date(r.created_at).toLocaleString()}</span>
              </div>
              <pre className="text-[11px] text-slate-400 overflow-x-auto scrollbar-thin whitespace-pre-wrap">
                {JSON.stringify(r.result, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CheckRow({ label, ok, note }: { label: string; ok: boolean; note?: string }) {
  return (
    <li className="flex items-center gap-1.5">
      {ok ? <CheckCircle2 size={12} className="text-accent-500" /> : <XCircle size={12} className="text-danger-500" />}
      {label}
      {note && !ok && <span className="text-slate-600">— {note}</span>}
    </li>
  );
}

function PillarCard({ icon: Icon, label, ok, value }: { icon: typeof KeyRound; label: string; ok: boolean; value: string }) {
  return (
    <div className={`rounded-xl border p-3 ${ok ? "border-accent-500/30 bg-accent-500/5" : "border-ink-600 bg-ink-900"}`}>
      <Icon size={14} className={ok ? "text-accent-500" : "text-slate-600"} />
      <p className="text-[11px] text-slate-500 mt-2">{label}</p>
      <p className={`text-xs mt-0.5 ${ok ? "text-slate-200" : "text-slate-600"}`}>{value}</p>
    </div>
  );
}

function StoragePillarCard({ status }: { status: EvidenceRecord["storage_status"] }) {
  const ok = status === "STORED";
  return (
    <div className={`rounded-xl border p-3 ${ok ? "border-accent-500/30 bg-accent-500/5" : "border-warn-500/30 bg-warn-500/5"}`}>
      {ok ? <Cloud size={14} className="text-accent-500" /> : <CloudOff size={14} className="text-warn-500" />}
      <p className="text-[11px] text-slate-500 mt-2">Storage</p>
      <p className={`text-xs mt-0.5 ${ok ? "text-slate-200" : "text-warn-500"}`}>{ok ? "Stored" : "Unavailable"}</p>
    </div>
  );
}

function BlockchainPillarCard({ status }: { status: EvidenceRecord["blockchain_status"] }) {
  const map = {
    CONFIRMED: { ok: true, label: "Algorand Confirmed" },
    PENDING: { ok: false, label: "Anchor Pending" },
    UNAVAILABLE: { ok: false, label: "Anchor Unavailable" },
    FAILED: { ok: false, label: "Anchor Failed" },
  } as const;
  const { ok, label } = map[status];
  return (
    <div className={`rounded-xl border p-3 ${ok ? "border-purple-500/30 bg-purple-500/5" : "border-ink-600 bg-ink-900"}`}>
      <ShieldCheck size={14} className={ok ? "text-purple-500" : "text-slate-600"} />
      <p className="text-[11px] text-slate-500 mt-2">Blockchain</p>
      <p className={`text-xs mt-0.5 ${ok ? "text-slate-200" : "text-slate-600"}`}>{label}</p>
    </div>
  );
}
