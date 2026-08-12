import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  FlaskConical, PlayCircle, CheckCircle2, XCircle, AlertOctagon, Loader2, Video, HardDrive, Cloud,
  Link2, ScanSearch, Sparkles, ArrowRight, Circle, FileWarning, Upload, Fingerprint, QrCode, FileDown,
  ShieldCheck, GitCompareArrows,
} from "lucide-react";
import {
  api, API_BASE_URL, type EvidenceRecord, type EvidenceSegment, type SegmentChainStatus, type VerifyResult,
  type BlockchainProofResult, type CameraFrameResult,
} from "../lib/api";
import { WebCameraSource } from "../lib/cameraSource";

/**
 * Prototype/testing input layer for demoing the CrimeLens pipeline when no
 * physical webcam is available. Does NOT touch cameraSource.ts or
 * LiveCamera.tsx -- this is a second, independent input path into the same
 * production endpoints (/evidence/ingest, /evidence/{id}/segments,
 * /evidence/{id}/verify, /evidence/{id}/verify-copy,
 * /evidence/{id}/verify-chain-test, /cameras/{id}/frame). A pre-recorded
 * <video> (either one of the three preset files or an uploaded one) is
 * played and captured with the browser's real captureStream()/MediaRecorder
 * APIs -- the exact same chunk-then-upload mechanism LiveCamera.tsx uses
 * for a live getUserMedia stream -- so segmentation, hashing, and chaining
 * are all genuinely computed from real bytes, not simulated client-side.
 */

const TEST_VIDEOS = [
  { id: "aug-11", label: "AUG 11", path: "/test-videos/aug-11.mp4" },
  { id: "aug-10", label: "AUG 10", path: "/test-videos/aug-10.mp4" },
  { id: "aug-09", label: "AUG 09", path: "/test-videos/aug-09.mp4" },
] as const;

const CHUNK_DURATION_MS = 15_000;
const OBSTRUCTION_SCAN_INTERVAL_MS = 2_000;

type FileStatus = "CHECKING" | "READY" | "NOT_FOUND";
type Stage = "idle" | "loading" | "hashing" | "processing" | "storing" | "complete" | "error";

interface DetectedFile {
  status: FileStatus;
  sizeBytes: number | null;
}

interface PipelineStage {
  key: string;
  label: string;
  done: boolean;
  detail?: string;
}

interface ChainTestResult {
  evidence_id: string;
  original_segment_count: number;
  test_segment_count: number;
  chain: { intact: boolean; segment_count: number; broken_at: { sequence: number; reason: string } | null };
  verdict: "AUTHENTIC" | "INTEGRITY_FAILURE";
  failure_reason: string | null;
  failed_segment: number | null;
}

interface CopyVerifyResult {
  registered_hash: string;
  test_copy_hash: string;
  hash_match: boolean;
  verdict: "AUTHENTIC" | "TAMPERED";
  reason: string | null;
}

interface AIResultRow {
  result_type?: string;
  type?: string;
  result?: Record<string, unknown>;
  result_json?: Record<string, unknown>;
}

const STAGE_LABEL: Record<Stage, string> = {
  idle: "READY",
  loading: "LOADING VIDEO",
  hashing: "HASHING",
  processing: "CREATING SEGMENTS",
  storing: "STORING",
  complete: "COMPLETE",
  error: "ERROR",
};

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function PrototypeEvidence() {
  const [files, setFiles] = useState<Record<string, DetectedFile>>({});
  const [selected, setSelected] = useState<(typeof TEST_VIDEOS)[number] | null>(null);
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [customPreviewUrl, setCustomPreviewUrl] = useState<string | null>(null);
  const [caseId, setCaseId] = useState("CASE-PROTOTYPE-VIDEO");

  const previewRef = useRef<HTMLVideoElement | null>(null);
  const captureRef = useRef<HTMLVideoElement | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewMeta, setPreviewMeta] = useState<{ duration: number; width: number; height: number } | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [originalHash, setOriginalHash] = useState<string | null>(null);
  const [processProgress, setProcessProgress] = useState(0); // 0..1 of video duration
  const [processError, setProcessError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRecord | null>(null);
  const [segments, setSegments] = useState<EvidenceSegment[]>([]);
  const [segmentChain, setSegmentChain] = useState<SegmentChainStatus | null>(null);
  const [aiResults, setAiResults] = useState<AIResultRow[]>([]);
  const [blockchainProof, setBlockchainProof] = useState<BlockchainProofResult | null>(null);
  const [obstructionEvents, setObstructionEvents] = useState<NonNullable<CameraFrameResult["event"]>[]>([]);

  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  const [copyResult, setCopyResult] = useState<CopyVerifyResult | null>(null);
  const [copyChecking, setCopyChecking] = useState<"clean" | "modified" | null>(null);

  const [chainTest, setChainTest] = useState<ChainTestResult | null>(null);
  const [chainTestRunning, setChainTestRunning] = useState<"missing" | "reorder" | "modify" | null>(null);

  const [showQr, setShowQr] = useState(false);

  const originalBlobRef = useRef<Blob | null>(null);

  const activeLabel = selected ? selected.label : customFile ? customFile.name : null;
  const activeFilename = selected ? `${selected.id}.mp4` : customFile?.name ?? null;
  const activePreviewSrc = selected ? selected.path : customPreviewUrl;
  const activeCameraSuffix = selected ? selected.id.toUpperCase() : "CUSTOM-UPLOAD";
  const activeReady = selected ? files[selected.id]?.status === "READY" : !!customFile;

  // ---------------------------------------------------------- detection ---

  useEffect(() => {
    TEST_VIDEOS.forEach((v) => {
      setFiles((f) => ({ ...f, [v.id]: { status: "CHECKING", sizeBytes: null } }));
      fetch(v.path, { method: "HEAD" })
        .then((res) => {
          const contentType = res.headers.get("content-type") ?? "";
          // Vite's dev server (and some static hosts) return 200 + index.html
          // for any unmatched path under public/ instead of a real 404 --
          // an .ok check alone would misreport a missing file as READY.
          // A genuine video response is never text/html.
          if (!res.ok || contentType.startsWith("text/html")) {
            setFiles((f) => ({ ...f, [v.id]: { status: "NOT_FOUND", sizeBytes: null } }));
            return;
          }
          const len = res.headers.get("content-length");
          setFiles((f) => ({ ...f, [v.id]: { status: "READY", sizeBytes: len ? Number(len) : null } }));
        })
        .catch(() => setFiles((f) => ({ ...f, [v.id]: { status: "NOT_FOUND", sizeBytes: null } })));
    });
  }, []);

  const resetSelection = () => {
    setPreviewMeta(null);
    setStage("idle");
    setProcessError(null);
    setOriginalHash(null);
    setEvidence(null);
    setSegments([]);
    setSegmentChain(null);
    setAiResults([]);
    setBlockchainProof(null);
    setObstructionEvents([]);
    setVerifyResult(null);
    setCopyResult(null);
    setChainTest(null);
    setShowQr(false);
    originalBlobRef.current = null;
  };

  // Fetches the real bytes for whatever is currently selected (preset path
  // or uploaded File) and computes their real SHA-256 client-side via the
  // Web Crypto API -- shown immediately, independent of whether the video
  // has been run through the backend pipeline yet.
  const loadAndHashOriginal = async (source: { kind: "preset"; path: string } | { kind: "custom"; file: File }) => {
    setStage("loading");
    try {
      const blob = source.kind === "preset" ? await (await fetch(source.path)).blob() : source.file;
      originalBlobRef.current = blob;
      setStage("hashing");
      const buf = await blob.arrayBuffer();
      const hex = await sha256Hex(buf);
      setOriginalHash(hex);
      setStage("idle");
    } catch (err: unknown) {
      setStage("error");
      setProcessError(err instanceof Error ? err.message : "Could not load the video.");
    }
  };

  const selectVideo = (v: (typeof TEST_VIDEOS)[number]) => {
    resetSelection();
    setSelected(v);
    setCustomFile(null);
    if (customPreviewUrl) URL.revokeObjectURL(customPreviewUrl);
    setCustomPreviewUrl(null);
    void loadAndHashOriginal({ kind: "preset", path: v.path });
  };

  const handleCustomUpload = (file: File) => {
    resetSelection();
    setSelected(null);
    setCustomFile(file);
    const url = URL.createObjectURL(file);
    if (customPreviewUrl) URL.revokeObjectURL(customPreviewUrl);
    setCustomPreviewUrl(url);
    void loadAndHashOriginal({ kind: "custom", file });
  };

  // ------------------------------------------------- refresh evidence data --

  const refreshEvidence = async (evidenceId: string) => {
    const { data } = await api.get(`/evidence/${evidenceId}`);
    setEvidence(data.evidence);
    setAiResults(data.ai_results ?? []);
    const segRes = await api.get(`/evidence/${evidenceId}/segments`);
    setSegments(segRes.data.segments);
    setSegmentChain(segRes.data.chain);
    const bcRes = await api.get<BlockchainProofResult>(`/evidence/${evidenceId}/blockchain`);
    setBlockchainProof(bcRes.data);
  };

  // -------------------------------------------- process as evidence (real) --

  const processAsEvidence = async () => {
    if (!activeReady || !originalBlobRef.current) return;
    setStage("processing");
    setProcessError(null);
    setProcessProgress(0);
    setObstructionEvents([]);

    const cameraId = `CAM-PROTOTYPE-${activeCameraSuffix}`;

    try {
      const blob = originalBlobRef.current;
      const captureEl = captureRef.current;
      if (!captureEl) throw new Error("Capture video element unavailable.");
      const objectUrl = URL.createObjectURL(blob);
      captureEl.src = objectUrl;
      captureEl.muted = true;
      await captureEl.play();

      // Real captureStream() of the actually-decoding video element -- a
      // genuine MediaStream, not a simulation. Same mimeType-selection logic
      // WebCameraSource uses (read-only reuse; cameraSource.ts is untouched).
      const mediaCaptureEl = captureEl as HTMLVideoElement & { captureStream?: () => MediaStream };
      if (!mediaCaptureEl.captureStream) {
        throw new Error("This browser does not support HTMLVideoElement.captureStream() -- required to feed a pre-recorded file through the real MediaRecorder segmentation pipeline.");
      }
      const stream = mediaCaptureEl.captureStream();
      const mimeType = new WebCameraSource().pickMimeType();

      // Periodically reuses the EXISTING camera obstruction-detection
      // endpoint (the same one LiveCamera.tsx polls) against real decoded
      // frames of this test video -- honest reuse, not a fabricated result.
      // If the test footage never contains an obstructed period, no event
      // fires and the panel below says so truthfully.
      const scanTimer = window.setInterval(async () => {
        const canvas = scanCanvasRef.current;
        if (!canvas || captureEl.videoWidth === 0) return;
        canvas.width = captureEl.videoWidth;
        canvas.height = captureEl.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(captureEl, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(async (frameBlob) => {
          if (!frameBlob) return;
          const form = new FormData();
          form.append("frame", frameBlob, "frame.jpg");
          form.append("case_id", caseId);
          try {
            const { data } = await api.post<CameraFrameResult>(`/cameras/${cameraId}/frame`, form, {
              headers: { "Content-Type": "multipart/form-data" },
            });
            if (data.event) setObstructionEvents((evts) => [...evts, data.event!]);
          } catch {
            // non-fatal -- this is a bonus real-CV scan, not part of the
            // core integrity pipeline
          }
        }, "image/jpeg", 0.75);
      }, OBSTRUCTION_SCAN_INTERVAL_MS);

      let chunkIndex = 0;
      let currentEvidenceId: string | null = null;
      let ended = false;

      const uploadChunk = async (chunkBlob: Blob, index: number, durationSeconds: number) => {
        if (chunkBlob.size === 0) return;
        if (index === 0) {
          const form = new FormData();
          form.append("case_id", caseId);
          form.append("camera_id", cameraId);
          form.append("captured_at", new Date().toISOString());
          form.append("duration_seconds", String(durationSeconds));
          form.append("file", chunkBlob, `${activeFilename ?? "evidence"}-root.webm`);
          const { data } = await api.post<EvidenceRecord>("/evidence/ingest", form, {
            headers: { "Content-Type": "multipart/form-data" },
          });
          currentEvidenceId = data.evidence_id;
          setEvidence(data);
        } else if (currentEvidenceId) {
          const form = new FormData();
          form.append("duration_seconds", String(durationSeconds));
          form.append("file", chunkBlob, `${activeFilename ?? "evidence"}-seg-${index}.webm`);
          await api.post(`/evidence/${currentEvidenceId}/segments`, form, {
            headers: { "Content-Type": "multipart/form-data" },
          });
        }
        if (currentEvidenceId) {
          setStage("storing");
          await refreshEvidence(currentEvidenceId);
          if (!ended) setStage("processing");
        }
      };

      await new Promise<void>((resolve, reject) => {
        const recordNextChunk = () => {
          const bytes: BlobPart[] = [];
          const startedAt = performance.now();
          const recorder = new MediaRecorder(stream, { mimeType });
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) bytes.push(e.data);
          };
          recorder.onstop = () => {
            const chunkBlob = new Blob(bytes, { type: mimeType });
            const durationSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
            const idx = chunkIndex;
            chunkIndex += 1;
            uploadChunk(chunkBlob, idx, durationSeconds)
              .then(() => {
                if (ended) resolve();
                else recordNextChunk();
              })
              .catch(reject);
          };
          recorder.start();
          const timer = window.setTimeout(() => {
            if (recorder.state === "recording") recorder.stop();
          }, CHUNK_DURATION_MS);
          if (ended) {
            window.clearTimeout(timer);
            if (recorder.state === "recording") recorder.stop();
          }
        };

        captureEl.ontimeupdate = () => {
          if (captureEl.duration) setProcessProgress(captureEl.currentTime / captureEl.duration);
        };
        captureEl.onended = () => {
          ended = true;
          setProcessProgress(1);
        };

        recordNextChunk();
      });

      window.clearInterval(scanTimer);
      URL.revokeObjectURL(objectUrl);
      setStage("complete");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Processing failed.";
      setProcessError(message);
      setStage("error");
    }
  };

  // ----------------------------------------------------------- verification --

  const runVerify = async () => {
    if (!evidence) return;
    setVerifying(true);
    try {
      const { data } = await api.get(`/evidence/${evidence.evidence_id}/verify`);
      setVerifyResult(data);
    } finally {
      setVerifying(false);
    }
  };

  const runCopyCheck = async (mode: "clean" | "modified") => {
    if (!evidence || !originalBlobRef.current) return;
    setCopyChecking(mode);
    setCopyResult(null);
    try {
      let testBlob = originalBlobRef.current;
      if (mode === "modified") {
        const buf = await originalBlobRef.current.arrayBuffer();
        const bytes = new Uint8Array(buf.slice(0)); // real copy, original untouched
        bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff; // flip one real byte
        testBlob = new Blob([bytes], { type: originalBlobRef.current.type });
      }
      const form = new FormData();
      form.append("file", testBlob, `${activeFilename ?? "test"}-${mode === "modified" ? "tampered" : "copy"}.mp4`);
      const { data } = await api.post<CopyVerifyResult>(`/evidence/${evidence.evidence_id}/verify-copy`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setCopyResult(data);
    } finally {
      setCopyChecking(null);
    }
  };

  const runChainTest = async (mode: "missing" | "reorder" | "modify") => {
    if (!evidence) return;
    setChainTestRunning(mode);
    setChainTest(null);
    try {
      const body =
        mode === "missing" ? { exclude_sequences: [1] } :
        mode === "reorder" ? { reorder: true } :
        { corrupt_sequences: [0] };
      const { data } = await api.post<ChainTestResult>(`/evidence/${evidence.evidence_id}/verify-chain-test`, body);
      setChainTest(data);
    } finally {
      setChainTestRunning(null);
    }
  };

  const downloadCertificate = () => {
    if (!evidence) return;
    window.open(`${API_BASE_URL}/evidence/${evidence.evidence_id}/certificate`, "_blank");
  };

  // ------------------------------------------------------------------ UI ---

  const rootHash = evidence ? (evidence as unknown as { root_hash?: string }).root_hash ?? null : null;
  const storagePath = evidence ? (evidence as unknown as { storage_path?: string }).storage_path ?? null : null;

  const stages: PipelineStage[] = [
    { key: "video", label: "Video Loaded", done: !!previewMeta || !!originalHash },
    { key: "hash", label: "SHA-256 Calculated", done: !!originalHash },
    { key: "segments", label: "Segments Created", done: segments.length > 0 },
    { key: "chain", label: "Hash Chain Created", done: !!segmentChain && segmentChain.segment_count > 0 },
    { key: "root", label: "Root Hash Calculated", done: !!rootHash },
    { key: "storage", label: "Evidence Stored", done: evidence?.storage_status === "STORED", detail: evidence?.storage_status },
    { key: "firestore", label: "Firestore Metadata Stored", done: !!evidence?.evidence_id },
    {
      key: "ai", label: "AI Analysis",
      done: aiResults.length > 0 && !aiResults.some((r) => (r.result ?? r.result_json)?.error),
      detail: aiResults.length === 0 ? "not yet run" : undefined,
    },
    { key: "verify", label: "Verification Available", done: !!evidence?.evidence_id },
    { key: "blockchain", label: "Blockchain Proof", done: evidence?.blockchain_status === "CONFIRMED", detail: evidence?.blockchain_status },
  ];

  return (
    <div className="p-8 max-w-6xl mx-auto fade-up">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <div className="mono text-[10px] uppercase tracking-[.2em] text-warn-500">Simulation input</div>
          <h1 className="text-2xl font-bold text-white tracking-tight mt-2 flex items-center gap-2">
            <FlaskConical className="text-warn-500" size={22} /> Prototype Evidence Recordings
          </h1>
        </div>
        <Link to="/camera" className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-accent-500 transition-colors">
          <Video size={13} /> Use real camera instead
        </Link>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-warn-500/10 text-warn-500 text-[11px] font-semibold mono w-fit mb-8">
        <FileWarning size={13} /> PROTOTYPE / TEST EVIDENCE — not real-world police evidence
      </div>

      {/* How it works */}
      <div className="glass-panel rounded-2xl p-5 mb-8">
        <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-3 flex items-center gap-1.5">
          <ShieldCheck size={13} /> How CrimeLens Protects Evidence
        </div>
        <ol className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-slate-400 list-decimal list-inside">
          <li>Original video is received.</li>
          <li>SHA-256 is calculated.</li>
          <li>Video is divided into segments.</li>
          <li>Every segment gets its own hash.</li>
          <li>Segments are linked through the hash chain.</li>
          <li>Evidence Root Hash is generated.</li>
          <li>Evidence is encrypted and stored.</li>
          <li>Metadata and integrity information are stored.</li>
          <li>Verification recalculates the hashes.</li>
          <li>Any modification can cause a hash mismatch.</li>
        </ol>
      </div>

      {/* Select evidence video */}
      <div className="mono text-[10px] uppercase tracking-[.18em] text-slate-500 mb-3">Select Evidence Video</div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        {TEST_VIDEOS.map((v) => {
          const f = files[v.id];
          return (
            <button
              key={v.id}
              onClick={() => f?.status === "READY" && selectVideo(v)}
              disabled={f?.status !== "READY"}
              className={`text-left glass-panel rounded-2xl p-5 transition-all ${
                selected?.id === v.id ? "border-accent-500/40" : ""
              } ${f?.status === "READY" ? "hover:-translate-y-0.5 hover:border-accent-500/30" : "opacity-60 cursor-not-allowed"}`}
            >
              <div className="mono text-lg font-bold text-white">{v.label}</div>
              <div className="text-xs text-slate-500 mt-1">Evidence Recording</div>
              <div className="flex items-center gap-1.5 text-xs text-accent-500 mt-3">
                <PlayCircle size={14} /> Preview
              </div>
              <div className="mt-4 pt-3 border-t border-ink-800 flex items-center justify-between">
                <span className="text-[10px] text-slate-600 uppercase tracking-wider">Status</span>
                {f?.status === "CHECKING" && <span className="flex items-center gap-1 text-[11px] text-slate-500 mono"><Loader2 size={11} className="animate-spin" /> CHECKING</span>}
                {f?.status === "READY" && <span className="text-[11px] text-accent-500 mono font-bold">READY</span>}
                {f?.status === "NOT_FOUND" && <span className="text-[11px] text-danger-500 mono font-bold">NOT FOUND</span>}
              </div>
              {f?.status === "NOT_FOUND" && (
                <p className="text-[10px] text-slate-600 mt-2 leading-relaxed">
                  Place a real video at <span className="mono">frontend/public{v.path}</span>
                </p>
              )}
            </button>
          );
        })}

        <label className={`text-left glass-panel rounded-2xl p-5 transition-all cursor-pointer flex flex-col ${customFile ? "border-accent-500/40" : "hover:-translate-y-0.5 hover:border-accent-500/30"}`}>
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleCustomUpload(file);
            }}
          />
          <div className="flex items-center gap-2 text-white font-bold">
            <Upload size={16} className="text-accent-500" /> Upload Video
          </div>
          <div className="text-xs text-slate-500 mt-1">Any real, playable video file</div>
          <div className="mt-auto pt-3 text-[10px] text-slate-600 uppercase tracking-wider">
            {customFile ? <span className="text-accent-500 mono font-bold">{customFile.name}</span> : "No file selected"}
          </div>
        </label>
      </div>

      {(selected || customFile) && activeReady && (
        <div className="space-y-6">
          {/* Preview */}
          <div className="glass-panel rounded-2xl p-5">
            <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-3">
              {activeLabel} — Evidence Recording
            </div>
            <video
              ref={previewRef}
              src={activePreviewSrc ?? undefined}
              controls
              className="w-full rounded-xl bg-black max-h-[420px]"
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                setPreviewMeta({ duration: el.duration, width: el.videoWidth, height: el.videoHeight });
              }}
            />
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-4 text-xs">
              <div><div className="text-slate-500">Filename</div><div className="mono text-slate-200 mt-1 break-all">{activeFilename}</div></div>
              <div><div className="text-slate-500">Duration</div><div className="mono text-slate-200 mt-1">{previewMeta ? formatDuration(previewMeta.duration) : "—"}</div></div>
              <div><div className="text-slate-500">Resolution</div><div className="mono text-slate-200 mt-1">{previewMeta ? `${previewMeta.width}×${previewMeta.height}` : "—"}</div></div>
              <div><div className="text-slate-500">File Size</div><div className="mono text-slate-200 mt-1">{formatBytes(selected ? files[selected.id]?.sizeBytes ?? customFile?.size ?? null : customFile?.size ?? null)}</div></div>
              <div><div className="text-slate-500">Video Type</div><div className="mono text-slate-200 mt-1">{customFile?.type || "video/mp4"}</div></div>
            </div>

            {/* Original hash -- computed client-side via Web Crypto the moment
               the video is selected/uploaded, independent of backend processing. */}
            <div className="mt-4 rounded-xl bg-ink-900/60 p-4">
              <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-2 flex items-center gap-1.5">
                <Fingerprint size={13} /> Original Evidence
              </div>
              <div className="text-xs text-slate-500">File: <span className="text-slate-300 mono">{activeFilename}</span></div>
              <div className="text-xs text-slate-500 mt-1">
                SHA-256:{" "}
                {stage === "loading" || stage === "hashing" ? (
                  <span className="mono text-slate-400 inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> {STAGE_LABEL[stage]}...</span>
                ) : (
                  <span className="mono text-accent-500 break-all">{originalHash ?? "—"}</span>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <input
                value={caseId}
                onChange={(e) => setCaseId(e.target.value)}
                disabled={stage === "processing" || !!evidence}
                className="bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60 mono disabled:opacity-50"
              />
              <button
                onClick={processAsEvidence}
                disabled={stage === "processing" || stage === "loading" || stage === "hashing" || !!evidence || !originalHash}
                className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-sm rounded-xl px-4 py-2.5 disabled:opacity-50 transition-colors"
              >
                {stage === "processing" || stage === "storing" ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                {evidence ? "Processed" : stage === "processing" || stage === "storing" ? `${STAGE_LABEL[stage]}… ${(processProgress * 100).toFixed(0)}%` : "Process as Evidence"}
              </button>
              <span className="mono text-[10px] text-slate-500 uppercase tracking-wider">Status: {STAGE_LABEL[stage]}</span>
            </div>
            {(stage === "processing" || stage === "storing") && (
              <div className="mt-2 h-1 rounded-full bg-ink-800 overflow-hidden">
                <div className="h-1 bg-accent-500 transition-all" style={{ width: `${processProgress * 100}%` }} />
              </div>
            )}
            {processError && <p className="text-xs text-danger-500 mt-3">{processError}</p>}
            <p className="text-[11px] text-slate-600 mt-3">
              Real-time: the video plays through a hidden element and is captured/chunked with the browser's actual
              MediaRecorder API (same mechanism as the live camera), so processing takes roughly as long as the
              video's own duration.
            </p>
          </div>

          <video ref={captureRef} className="hidden" playsInline />
          <canvas ref={scanCanvasRef} className="hidden" />

          {/* Source vs storage */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="glass-panel rounded-2xl p-5">
              <div className="mono text-[10px] uppercase tracking-[.18em] text-warn-500 mb-3">Input Video</div>
              <dl className="text-xs space-y-2">
                <div className="flex justify-between"><dt className="text-slate-500">Source</dt><dd className="text-slate-200">{selected ? "Prototype Test Video" : "Uploaded File"}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Browser Path</dt><dd className="mono text-slate-300 break-all text-right">{selected ? selected.path : `(local file) ${customFile?.name}`}</dd></div>
              </dl>
            </div>
            <div className="glass-panel rounded-2xl p-5">
              <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-3 flex items-center gap-1.5"><HardDrive size={13} /> Evidence Storage</div>
              {!evidence ? (
                <p className="text-xs text-slate-600">Not processed yet.</p>
              ) : (
                <dl className="text-xs space-y-2">
                  <div className="flex justify-between"><dt className="text-slate-500">Storage Type</dt><dd className="text-slate-200">Encrypted Local Evidence Store</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Evidence ID</dt><dd className="mono text-accent-500">{evidence.evidence_id}</dd></div>
                  {storagePath && <div className="flex justify-between"><dt className="text-slate-500">Logical Path</dt><dd className="mono text-slate-300 break-all text-right">{storagePath}</dd></div>}
                  <div className="flex justify-between"><dt className="text-slate-500">Segment Storage</dt><dd className="mono text-slate-300 break-all text-right">evidence/{evidence.case_id}/{evidence.evidence_id}/segments/</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Encryption</dt><dd className="text-slate-200">AES-256-GCM</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Original SHA-256</dt><dd className="mono text-slate-300 break-all text-right">{evidence.sha256}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Segments</dt><dd className="text-slate-200">{segments.length}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Evidence Root Hash</dt><dd className="mono text-slate-300 break-all text-right">{rootHash ?? "UNAVAILABLE"}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Metadata</dt><dd className="text-accent-500 font-semibold">Firestore</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Hash Records</dt><dd className="text-accent-500 font-semibold">Firestore</dd></div>
                </dl>
              )}
            </div>
          </div>

          {/* Pipeline */}
          <div className="glass-panel rounded-2xl p-5">
            <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-4 flex items-center gap-1.5"><Link2 size={13} /> Data Flow Pipeline</div>
            <div className="space-y-2">
              {stages.map((s) => (
                <div key={s.key} className="flex items-center justify-between rounded-xl bg-ink-900/60 px-3 py-2 text-xs">
                  <span className="flex items-center gap-2">
                    {s.done ? <CheckCircle2 size={14} className="text-accent-500" /> : <Circle size={14} className="text-slate-600" />}
                    <span className={s.done ? "text-slate-200" : "text-slate-500"}>{s.label}</span>
                  </span>
                  {s.detail && <span className="mono text-[10px] text-slate-500">{s.detail}</span>}
                </div>
              ))}
            </div>
          </div>

          {evidence && (
            <>
              {/* AI */}
              <div className="glass-panel rounded-2xl p-5">
                <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-3 flex items-center gap-1.5"><Sparkles size={13} /> AI Analysis</div>
                {aiResults.length === 0 ? (
                  <p className="text-xs text-slate-500">UNAVAILABLE — no AI result recorded for this evidence yet.</p>
                ) : (
                  <div className="space-y-2">
                    {aiResults.map((r, i) => {
                      const result = r.result ?? r.result_json ?? {};
                      const errored = "error" in result;
                      return (
                        <div key={i} className="text-xs bg-ink-900/60 rounded-xl px-3 py-2">
                          <div className="flex items-center justify-between">
                            <span className="text-slate-300 font-semibold">{r.result_type ?? r.type}</span>
                            {errored ? <span className="text-warn-500 mono text-[10px]">UNAVAILABLE</span> : <span className="text-accent-500 mono text-[10px]">COMPLETE</span>}
                          </div>
                          {errored ? (
                            <p className="text-slate-600 mt-1">Reason: {String((result as { error: unknown }).error)}</p>
                          ) : (
                            <pre className="text-slate-500 mt-1 overflow-x-auto scrollbar-thin whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Obstruction scan (real reuse of the live-camera CV endpoint) */}
              <div className="glass-panel rounded-2xl p-5">
                <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-3 flex items-center gap-1.5"><ScanSearch size={13} /> Camera Obstruction Scan</div>
                <p className="text-[11px] text-slate-500 mb-3">
                  Reuses the same obstruction-detection endpoint Live Camera uses, run periodically against real
                  decoded frames of this test video while it processed.
                </p>
                {obstructionEvents.length === 0 ? (
                  <p className="text-xs text-slate-600">No obstruction detected in this test video.</p>
                ) : (
                  <div className="space-y-2">
                    {obstructionEvents.map((ev, i) => (
                      <div key={i} className={`text-xs rounded-lg px-3 py-2 ${ev.type === "OBSTRUCTION_DETECTED" ? "bg-danger-500/10 text-danger-400" : "bg-accent-500/10 text-accent-500"}`}>
                        {ev.type === "OBSTRUCTION_DETECTED" ? "CAMERA OBSTRUCTION DETECTED" : "CAMERA FEED RESTORED"}
                        {ev.confidence !== undefined && ` · confidence ${ev.confidence}%`}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Segments */}
              <div className="glass-panel rounded-2xl p-5">
                <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-3">
                  {activeLabel} — Segment Chain ({segments.length})
                </div>
                {segments.length === 0 ? (
                  <p className="text-xs text-slate-500">No segments yet.</p>
                ) : (
                  <div className="space-y-2">
                    {segments.map((seg) => {
                      const broken = segmentChain?.broken_at;
                      const segStatus = !segmentChain || segmentChain.intact ? "VALID" : broken?.sequence === seg.sequence ? "BROKEN" : "UNVERIFIED";
                      return (
                        <div key={seg.id} className="bg-ink-900/60 rounded-xl px-3 py-2.5 text-[11px]">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-bold text-slate-200">SEGMENT {String(seg.sequence).padStart(3, "0")}</span>
                            <span className={segStatus === "VALID" ? "text-accent-500" : segStatus === "BROKEN" ? "text-danger-500" : "text-slate-500"}>{segStatus}</span>
                          </div>
                          <div className="text-slate-500">{seg.duration_seconds.toFixed(1)}s</div>
                          <div className="mono text-slate-500 break-all mt-1">SHA-256: {seg.sha256}</div>
                          <div className="mono text-slate-600 break-all mt-0.5">Previous: {seg.prev_segment_hash}</div>
                          <div className="mono text-slate-600 break-all mt-0.5">Segment Hash: {seg.segment_hash}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {segmentChain && (
                  <div className={`mt-3 text-xs flex items-center gap-2 ${segmentChain.intact ? "text-accent-500" : "text-danger-500"}`}>
                    {segmentChain.intact ? <CheckCircle2 size={13} /> : <AlertOctagon size={13} />}
                    Chain {segmentChain.intact ? "intact" : "broken"}
                  </div>
                )}
              </div>

              {/* Verify */}
              <div className="glass-panel rounded-2xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 flex items-center gap-1.5"><ScanSearch size={13} /> Verify Original</div>
                  <button onClick={runVerify} disabled={verifying} className="flex items-center gap-1.5 text-xs bg-accent-500/10 text-accent-500 rounded-lg px-3 py-1.5 disabled:opacity-50">
                    {verifying ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />} Verify
                  </button>
                </div>
                {verifyResult && (
                  <div className={`rounded-xl p-3 text-xs mono ${verifyResult.verdict === "AUTHENTIC" ? "bg-accent-500/5 text-accent-500" : "bg-danger-500/5 text-danger-500"}`}>
                    <div className="font-bold flex items-center gap-1.5">
                      {verifyResult.verdict === "AUTHENTIC" ? <CheckCircle2 size={14} /> : <AlertOctagon size={14} />} VERDICT: {verifyResult.verdict}
                    </div>
                    <div className="mt-2 text-slate-400">Original SHA-256: <span className="text-slate-300 break-all">{verifyResult.original_hash}</span></div>
                    <div className="mt-1 text-slate-400">Current SHA-256: <span className="text-slate-300 break-all">{verifyResult.current_hash}</span></div>
                    <div className="mt-1 text-slate-400">Hash match: {verifyResult.hash_match ? "✓" : "✕"}</div>
                    <div className="mt-1 text-slate-400">Blockchain: {verifyResult.verification_status}</div>
                  </div>
                )}
              </div>

              {/* QR + Certificate */}
              <div className="glass-panel rounded-2xl p-5">
                <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-3">Public Verification</div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setShowQr((v) => !v)} className="flex items-center gap-1.5 text-xs border border-ink-700 rounded-xl px-3 py-1.5 hover:border-accent-500/50 hover:text-accent-500 transition-colors">
                    <QrCode size={13} /> Generate QR
                  </button>
                  <button onClick={downloadCertificate} className="flex items-center gap-1.5 text-xs bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold rounded-xl px-3 py-1.5 transition-colors">
                    <FileDown size={13} /> Download Certificate
                  </button>
                </div>
                {showQr && (
                  <div className="mt-4 flex items-center gap-4 border-t border-ink-800 pt-4">
                    <img
                      src={`${API_BASE_URL}/evidence/${evidence.evidence_id}/qr`}
                      alt={`QR verification code for ${evidence.evidence_id}`}
                      className="w-28 h-28 rounded-lg bg-white p-1.5"
                    />
                    <div className="text-xs text-slate-500">
                      <p>Scans to the real public verification page -- no login required.</p>
                      <Link to={`/verify/${evidence.evidence_id}`} className="text-accent-500 hover:underline mt-1 inline-block">
                        Open verification page →
                      </Link>
                    </div>
                  </div>
                )}
              </div>

              {/* Tamper test / before-after */}
              <div className="glass-panel rounded-2xl p-5">
                <div className="mono text-[10px] uppercase tracking-[.18em] text-warn-500 mb-3 flex items-center gap-1.5"><FlaskConical size={13} /> Evidence Integrity Test</div>
                <p className="text-[11px] text-slate-500 mb-3">
                  Creates a real in-memory <span className="mono">{activeFilename?.replace(/\.[^.]+$/, "")}-tampered</span> copy
                  and (for the tamper test) flips one real byte in it, then hashes both with the same SHA-256 the
                  backend uses. The original evidence file is never touched. Even a small modification to the file
                  produces a completely different cryptographic hash.
                </p>
                <div className="flex flex-wrap gap-2 mb-4">
                  <button onClick={() => runCopyCheck("clean")} disabled={copyChecking !== null} className="flex items-center gap-1.5 text-xs bg-ink-900 border border-ink-700 rounded-lg px-3 py-1.5 disabled:opacity-40">
                    {copyChecking === "clean" && <Loader2 size={12} className="animate-spin" />} Create Tamper Test Copy
                  </button>
                  <button onClick={() => runCopyCheck("modified")} disabled={copyChecking !== null} className="flex items-center gap-1.5 text-xs bg-warn-500/10 text-warn-500 rounded-lg px-3 py-1.5 disabled:opacity-40">
                    {copyChecking === "modified" && <Loader2 size={12} className="animate-spin" />} Modify Test Copy → Compare
                  </button>
                </div>

                {copyResult && (
                  <div>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div className="rounded-xl border border-accent-500/30 bg-accent-500/5 p-3 text-xs">
                        <div className="mono text-[10px] uppercase tracking-wider text-accent-500 mb-2">Original</div>
                        <div className="text-slate-500">File: <span className="text-slate-300 mono">{activeFilename}</span></div>
                        <div className="text-slate-500 mt-1 break-all">SHA-256: <span className="text-slate-300 mono">{copyResult.registered_hash}</span></div>
                        <div className="text-slate-500 mt-1 break-all">Root Hash: <span className="text-slate-300 mono">{rootHash ?? "UNAVAILABLE"}</span></div>
                        <div className="text-accent-500 font-bold mt-2 flex items-center gap-1.5"><CheckCircle2 size={13} /> AUTHENTIC</div>
                      </div>
                      <div className={`rounded-xl border p-3 text-xs ${copyResult.hash_match ? "border-accent-500/30 bg-accent-500/5" : "border-danger-500/30 bg-danger-500/5"}`}>
                        <div className={`mono text-[10px] uppercase tracking-wider mb-2 ${copyResult.hash_match ? "text-accent-500" : "text-danger-500"}`}>Tamper Test Copy</div>
                        <div className="text-slate-500">File: <span className="text-slate-300 mono">{activeFilename?.replace(/\.[^.]+$/, "")}-{copyResult.hash_match ? "copy" : "tampered"}.mp4</span></div>
                        <div className="text-slate-500 mt-1 break-all">SHA-256: <span className="text-slate-300 mono">{copyResult.test_copy_hash}</span></div>
                        <div className={`font-bold mt-2 flex items-center gap-1.5 ${copyResult.hash_match ? "text-accent-500" : "text-danger-500"}`}>
                          {copyResult.hash_match ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {copyResult.verdict}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 rounded-xl bg-ink-900/60 p-3 text-xs flex items-center gap-2">
                      <GitCompareArrows size={14} className={copyResult.hash_match ? "text-accent-500" : "text-danger-500"} />
                      {copyResult.hash_match ? "HASH MATCH ✓" : "HASH MISMATCH ✕"}
                    </div>
                    {!copyResult.hash_match && (
                      <div className="mt-3 rounded-xl bg-danger-500/10 border border-danger-500/30 p-3 text-xs text-danger-400 font-bold flex items-center gap-2">
                        <AlertOctagon size={14} /> ⚠ INTEGRITY VIOLATION DETECTED
                      </div>
                    )}
                    {copyResult.reason && <div className="mt-2 text-[11px] text-slate-500">{copyResult.reason}</div>}
                  </div>
                )}
              </div>

              {/* Segment tamper */}
              <div className="glass-panel rounded-2xl p-5">
                <div className="mono text-[10px] uppercase tracking-[.18em] text-warn-500 mb-3 flex items-center gap-1.5"><FlaskConical size={13} /> Segment-Level Integrity Tests</div>
                <p className="text-[11px] text-slate-500 mb-3">
                  Runs the real production `verify_segments()` function against this evidence's actual stored
                  segments with one transformation applied to an in-memory copy only. Nothing is written back.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => runChainTest("missing")} disabled={chainTestRunning !== null || segments.length < 2} className="flex items-center gap-1.5 text-xs bg-ink-900 border border-ink-700 rounded-lg px-3 py-1.5 disabled:opacity-40">
                    {chainTestRunning === "missing" && <Loader2 size={12} className="animate-spin" />} Test Missing Segment
                  </button>
                  <button onClick={() => runChainTest("reorder")} disabled={chainTestRunning !== null || segments.length < 2} className="flex items-center gap-1.5 text-xs bg-ink-900 border border-ink-700 rounded-lg px-3 py-1.5 disabled:opacity-40">
                    {chainTestRunning === "reorder" && <Loader2 size={12} className="animate-spin" />} Test Reorder Segment
                  </button>
                  <button onClick={() => runChainTest("modify")} disabled={chainTestRunning !== null || segments.length < 1} className="flex items-center gap-1.5 text-xs bg-ink-900 border border-ink-700 rounded-lg px-3 py-1.5 disabled:opacity-40">
                    {chainTestRunning === "modify" && <Loader2 size={12} className="animate-spin" />} Test Modify Segment
                  </button>
                </div>
                {segments.length < 2 && (
                  <p className="text-[11px] text-slate-600 mt-3">
                    This video only produced {segments.length} segment{segments.length === 1 ? "" : "s"} (15s chunks) --
                    missing/reorder tests need at least 2 real segments to demonstrate. Try a longer test video.
                  </p>
                )}
                {chainTest && (
                  <div className={`mt-4 rounded-xl p-3 text-xs mono ${chainTest.chain.intact ? "bg-accent-500/5 text-accent-500" : "bg-danger-500/5 text-danger-500"}`}>
                    <div className="font-bold flex items-center gap-1.5">
                      {chainTest.chain.intact ? <CheckCircle2 size={14} /> : <AlertOctagon size={14} />} {chainTest.verdict}
                    </div>
                    <div className="mt-2 text-slate-400">Original segments: {chainTest.original_segment_count} · Test segments: {chainTest.test_segment_count}</div>
                    {chainTest.failed_segment !== null && <div className="mt-1 text-slate-400">Failed segment: <span className="text-danger-500">{chainTest.failed_segment}</span></div>}
                    {chainTest.failure_reason && <div className="mt-1 text-slate-400">Reason: <span className="text-danger-500">{chainTest.failure_reason.replace(/_/g, " ")}</span></div>}
                  </div>
                )}
              </div>

              {/* Blockchain */}
              <div className="glass-panel rounded-2xl p-5">
                <div className="mono text-[10px] uppercase tracking-[.18em] text-accent-500 mb-3 flex items-center gap-1.5"><Cloud size={13} /> Blockchain Proof</div>
                {blockchainProof ? (
                  <dl className="text-xs space-y-2">
                    <div className="flex justify-between"><dt className="text-slate-500">Network</dt><dd className="text-slate-200">{blockchainProof.network}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Application ID</dt><dd className="mono text-slate-200">{blockchainProof.application_id}</dd></div>
                    <div className="flex justify-between"><dt className="text-slate-500">Verification status</dt><dd className={blockchainProof.verification_status === "CONFIRMED" ? "text-accent-500 font-bold" : "text-warn-500 font-bold"}>{blockchainProof.verification_status}</dd></div>
                  </dl>
                ) : (
                  <p className="text-xs text-slate-500">Loading…</p>
                )}
                <p className="text-[11px] text-slate-600 mt-3">
                  Blockchain status never affects the cryptographic verdict above -- NOT_CONFIGURED/UNAVAILABLE is a
                  real, honest state, not tampering.
                </p>
              </div>

              <Link
                to={`/evidence/${evidence.evidence_id}`}
                className="flex items-center justify-center gap-2 text-sm text-accent-500 hover:underline py-3"
              >
                Open full Evidence Detail page (custody, certificate, QR) <ArrowRight size={14} />
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  if (!isFinite(totalSeconds)) return "—";
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
