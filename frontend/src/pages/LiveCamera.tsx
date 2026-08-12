import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Video, VideoOff, Circle, Square, AlertTriangle, ShieldCheck, Loader2, ExternalLink, FlaskConical, Activity,
  Link2, CloudOff, Cloud, RefreshCw,
} from "lucide-react";
import { api, type CameraFrameResult, type CameraEvent, type EvidenceRecord, type EvidenceSegment, type SegmentChainStatus } from "../lib/api";
import { WebCameraSource, checkCameraSupport, CameraAccessError, CAMERA_ERROR_LABELS, type CameraErrorCode } from "../lib/cameraSource";

// Real, distinguishable states -- LIVE is only ever set after a genuine
// MediaStream exists, has a live video track, and the <video> element is
// actually rendering frames (see WebCameraSource._validatePlayback). No
// intermediate state is ever displayed as LIVE just because a promise
// resolved.
type CameraStatus = "IDLE" | "REQUESTING" | "LIVE" | "ERROR";

interface CameraErrorState {
  code: CameraErrorCode;
  message: string;
}

const CHUNK_DURATION_MS = 15_000;

interface SegmentLogEntry {
  key: string;
  index: number;
  status: "uploading" | "done" | "error";
  segment?: EvidenceSegment | EvidenceRecord;
  isRoot?: boolean; // true for the very first chunk, which creates the Evidence record itself
  error?: string;
}

export default function LiveCamera() {
  const [cameraId, setCameraId] = useState("CAM-001");
  const [caseId, setCaseId] = useState("CASE-2026-00417");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceRef = useRef<WebCameraSource>(new WebCameraSource());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunkBytesRef = useRef<BlobPart[]>([]);
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chunkStartedAtRef = useRef<number>(0);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef(false);
  const chunkIndexRef = useRef(0);
  const evidenceIdRef = useRef<string | null>(null);
  const secondsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("IDLE");
  const [cameraError, setCameraError] = useState<CameraErrorState | null>(null);
  const live = cameraStatus === "LIVE";
  const [videoInfo, setVideoInfo] = useState<{ width?: number; height?: number; frameRate?: number } | null>(null);

  const [monitoring, setMonitoring] = useState(false);
  const [analysisFps, setAnalysisFps] = useState(5);
  const [frameResult, setFrameResult] = useState<CameraFrameResult | null>(null);
  const [cameraEvents, setCameraEvents] = useState<CameraEvent[]>([]);
  const [restoredAt, setRestoredAt] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [segmentLog, setSegmentLog] = useState<SegmentLogEntry[]>([]);
  const [chainStatus, setChainStatus] = useState<SegmentChainStatus | null>(null);
  const [rootEvidence, setRootEvidence] = useState<EvidenceRecord | null>(null);

  const [testMode, setTestMode] = useState(false);
  const [testFile, setTestFile] = useState<File | null>(null);
  const [testSubmitting, setTestSubmitting] = useState(false);

  // ------------------------------------------------------------- webcam --
  // All camera access below goes through the CameraSource abstraction, not
  // getUserMedia/MediaRecorder directly -- see lib/cameraSource.ts. The
  // hackathon prototype only wires up WebCameraSource (the real laptop
  // webcam); a future RTSP/ONVIF-backed CameraSource would plug in here
  // without touching anything downstream.

  const startWebcam = useCallback(async () => {
    setCameraStatus("REQUESTING");
    setCameraError(null);
    try {
      const info = await sourceRef.current.start(videoRef.current!);
      setVideoInfo(info);
      setCameraStatus("LIVE");
    } catch (err) {
      setCameraStatus("ERROR");
      if (err instanceof CameraAccessError) {
        setCameraError({ code: err.code, message: err.message });
      } else {
        setCameraError({ code: "UNKNOWN", message: "Could not access the webcam." });
      }
    }
  }, []);

  const stopWebcam = useCallback(() => {
    sourceRef.current.stop();
    setCameraStatus("IDLE");
    setCameraError(null);
    setVideoInfo(null);
    // A stopped camera stream must not leave the obstruction-monitoring
    // interval running against a dead <video>/<canvas> pair -- previously
    // this was never cleared here, so restarting the camera and clicking
    // Start Monitoring again created a second, permanently-orphaned
    // interval (the first's id was overwritten in frameTimerRef and could
    // no longer be cleared by Stop Monitoring).
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    frameTimerRef.current = null;
    setMonitoring(false);
    setFrameResult(null);
  }, []);

  // Proactively check secure-context/API support on mount, before the user
  // even clicks Start Camera -- an insecure origin or unsupported browser
  // can be reported immediately instead of waiting for a click to fail.
  useEffect(() => {
    const support = checkCameraSupport();
    if (!support.ok) {
      setCameraStatus("ERROR");
      setCameraError({ code: support.error.code, message: support.error.message });
    }
  }, []);

  useEffect(() => () => {
    stopWebcam();
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
    if (secondsTimerRef.current) clearInterval(secondsTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------- obstruction monitor --

  const refreshCameraEvents = useCallback(async (id: string) => {
    try {
      const { data } = await api.get<CameraEvent[]>(`/cameras/${id}/events`);
      setCameraEvents(data);
    } catch {
      // non-fatal -- event history just won't refresh this tick
    }
  }, []);

  // Real, audible alert -- a short synthesized tone via the Web Audio API
  // (no external asset needed). Plays once per confirmed obstruction, not
  // once per abnormal frame.
  const playObstructionAlert = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
      osc.onended = () => ctx.close();
    } catch {
      // Audio playback can fail (autoplay policy, no audio device) --
      // never let that break the real visual alert already shown.
    }
  }, []);

  const startMonitoring = useCallback(async () => {
    // Without this guard, nothing prevented startMonitoring from being
    // invoked a second time while already monitoring (e.g. a fast double
    // click before the button label re-rendered to "Stop Monitoring") --
    // each call unconditionally created a new setInterval and overwrote
    // frameTimerRef, permanently leaking the previous interval (it kept
    // firing captureFrame/POST calls with no way left to clear it, since
    // Stop Monitoring can only ever clear whatever is in frameTimerRef
    // *now*). That orphaned loop is the real cause behind monitoring
    // "not remaining active correctly" -- multiple competing loops racing
    // against a single frameResult/monitoring state.
    if (!live || monitoring) return;
    let fps = 5;
    try {
      const { data } = await api.get(`/cameras/${cameraId}/status`);
      fps = data.analysis_fps ?? 5;
    } catch {
      fps = 5;
    }
    setAnalysisFps(fps);
    setMonitoring(true);
    refreshCameraEvents(cameraId);

    const period = Math.max(100, Math.round(1000 / fps));
    frameTimerRef.current = setInterval(async () => {
      const capture = await sourceRef.current.captureFrame(videoRef.current!, canvasRef.current!);
      if (!capture) return;
      const form = new FormData();
      form.append("frame", capture.blob, "frame.jpg");
      form.append("case_id", caseId);
      try {
        const { data } = await api.post<CameraFrameResult>(`/cameras/${cameraId}/frame`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        setFrameResult(data);
        if (data.event?.type === "OBSTRUCTION_DETECTED") {
          playObstructionAlert();
          setRestoredAt(null);
        }
        if (data.event?.type === "CAMERA_RECOVERED") setRestoredAt(new Date().toISOString());
        if (data.event) refreshCameraEvents(cameraId);
      } catch {
        // transient network hiccup -- next tick will retry, no fake state shown
      }
    }, period);
  }, [live, monitoring, cameraId, caseId, refreshCameraEvents, playObstructionAlert]);

  const stopMonitoring = useCallback(() => {
    setMonitoring(false);
    setFrameResult(null);
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    frameTimerRef.current = null;
  }, []);

  // ---------------------------------------------------------- segment log --

  const refreshChain = useCallback(async (evidenceId: string) => {
    try {
      const { data } = await api.get<{ segments: EvidenceSegment[]; chain: SegmentChainStatus }>(`/evidence/${evidenceId}/segments`);
      setChainStatus(data.chain);
    } catch {
      // non-fatal
    }
  }, []);

  const uploadRootChunk = useCallback(async (blob: Blob, index: number) => {
    const key = `${Date.now()}-${index}`;
    setSegmentLog((log) => [{ key, index, status: "uploading", isRoot: true }, ...log]);

    const form = new FormData();
    form.append("case_id", caseId);
    form.append("camera_id", cameraId);
    form.append("captured_at", new Date().toISOString());
    form.append("file", blob, `evidence-root-${index}.webm`);

    try {
      const { data } = await api.post<EvidenceRecord>("/evidence/ingest", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      evidenceIdRef.current = data.evidence_id;
      setRootEvidence(data);
      setSegmentLog((log) => log.map((e) => (e.key === key ? { ...e, status: "done", segment: data } : e)));
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
      setSegmentLog((log) => log.map((e) => (e.key === key ? { ...e, status: "error", error: message ?? "Upload failed" } : e)));
    }
  }, [caseId, cameraId]);

  const uploadSegmentChunk = useCallback(async (blob: Blob, index: number, durationSeconds: number) => {
    const evidenceId = evidenceIdRef.current;
    if (!evidenceId) return;
    const key = `${Date.now()}-${index}`;
    setSegmentLog((log) => [{ key, index, status: "uploading" }, ...log]);

    const form = new FormData();
    form.append("duration_seconds", String(durationSeconds));
    form.append("file", blob, `evidence-segment-${index}.webm`);

    try {
      const { data } = await api.post<EvidenceSegment>(`/evidence/${evidenceId}/segments`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setSegmentLog((log) => log.map((e) => (e.key === key ? { ...e, status: "done", segment: data } : e)));
      refreshChain(evidenceId);
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
      setSegmentLog((log) => log.map((e) => (e.key === key ? { ...e, status: "error", error: message ?? "Upload failed" } : e)));
    }
  }, [refreshChain]);

  // ------------------------------------------------------------ record ---

  const beginChunk = useCallback(() => {
    if (!sourceRef.current.isLive()) return;
    chunkBytesRef.current = [];
    chunkStartedAtRef.current = performance.now();
    const recorder = sourceRef.current.createRecorder();
    const mimeType = recorder.mimeType;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunkBytesRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunkBytesRef.current, { type: mimeType });
      const idx = chunkIndexRef.current;
      const durationSeconds = Math.round((performance.now() - chunkStartedAtRef.current) / 100) / 10;
      chunkIndexRef.current += 1;
      if (blob.size > 0) {
        if (idx === 0) uploadRootChunk(blob, idx);
        else uploadSegmentChunk(blob, idx, durationSeconds);
      }
      if (recordingRef.current) beginChunk(); // seamlessly continue into the next chunk
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    chunkTimerRef.current = setTimeout(() => {
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    }, CHUNK_DURATION_MS);
  }, [uploadRootChunk, uploadSegmentChunk]);

  const startRecording = useCallback(() => {
    if (!live || recording) return;
    recordingRef.current = true;
    chunkIndexRef.current = 0;
    evidenceIdRef.current = null;
    setRootEvidence(null);
    setChainStatus(null);
    setRecording(true);
    setRecordingSeconds(0);
    beginChunk();
    secondsTimerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
  }, [live, recording, beginChunk]);

  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);
    if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
    if (secondsTimerRef.current) clearInterval(secondsTimerRef.current);
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
  }, []);

  // --------------------------------------------------------- test upload --

  const submitTestEvidence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testFile) return;
    setTestSubmitting(true);
    const key = `test-${Date.now()}`;
    setSegmentLog((log) => [{ key, index: -1, status: "uploading", isRoot: true }, ...log]);
    const form = new FormData();
    form.append("case_id", caseId);
    form.append("camera_id", `${cameraId}-TEST-UPLOAD`);
    form.append("file", testFile);
    try {
      const { data } = await api.post<EvidenceRecord>("/evidence/ingest", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setSegmentLog((log) => log.map((it) => (it.key === key ? { ...it, status: "done", segment: data } : it)));
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
      setSegmentLog((log) => log.map((it) => (it.key === key ? { ...it, status: "error", error: message ?? "Upload failed" } : it)));
    } finally {
      setTestSubmitting(false);
      setTestFile(null);
    }
  };

  const obstructed = frameResult?.status === "OBSTRUCTED";

  return (
    <div className="p-8 max-w-6xl mx-auto fade-up">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500">Capture layer / {cameraId}</div>
          <h1 className="text-2xl font-bold text-white tracking-tight mt-2">Live Camera</h1>
          <p className="text-sm text-slate-500 mt-1">Real webcam, real obstruction detection, real segmented evidence pipeline</p>
        </div>
        <div className="flex items-center gap-2 mono text-[11px] px-3 py-1.5 rounded-full bg-accent-500/10 text-accent-500">
          <ShieldCheck size={12} /> CAM-SOURCE: WEB
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Video + controls */}
        <div className="lg:col-span-2 space-y-4">
          <div className={`relative rounded-2xl overflow-hidden border ${obstructed ? "border-danger-500 pulse-danger" : "border-ink-700"} bg-black aspect-video`}>
            <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
            <canvas ref={canvasRef} className="hidden" />

            {cameraStatus === "IDLE" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900/90">
                <VideoOff className="text-slate-600" size={32} />
                <p className="text-sm text-slate-400 text-center max-w-xs px-4">
                  Camera not started. Click "Start Camera" and grant browser permission.
                </p>
                <button
                  onClick={startWebcam}
                  className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  <Video size={14} /> Start Camera
                </button>
              </div>
            )}

            {cameraStatus === "REQUESTING" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900/90">
                <Loader2 className="text-accent-500 animate-spin" size={28} />
                <p className="text-sm text-slate-400 text-center max-w-xs px-4">
                  Requesting camera permission... check for a browser permission prompt.
                </p>
              </div>
            )}

            {cameraStatus === "ERROR" && cameraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900/90 px-6">
                <AlertTriangle className="text-danger-500" size={32} />
                <p className="text-sm font-semibold text-danger-500 text-center tracking-wide">
                  {CAMERA_ERROR_LABELS[cameraError.code]}
                </p>
                <p className="text-xs text-slate-400 text-center max-w-sm">{cameraError.message}</p>
                <button
                  onClick={startWebcam}
                  className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  <RefreshCw size={14} /> Retry
                </button>
              </div>
            )}

            {live && (
              <div className="absolute top-3 left-3 flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full bg-black/60 text-accent-500 border border-accent-500/30">
                  <Circle size={8} className="fill-accent-500 text-accent-500" /> LIVE
                </span>
                {recording && (
                  <span className="flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full bg-black/60 text-danger-500 border border-danger-500/30">
                    <Circle size={8} className="fill-danger-500 text-danger-500 animate-rec-blink" /> REC {formatDuration(recordingSeconds)}
                  </span>
                )}
                {obstructed && (
                  <span className="flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full bg-black/60 text-danger-500 border border-danger-500/30">
                    <AlertTriangle size={11} /> OBSTRUCTION DETECTED
                  </span>
                )}
              </div>
            )}

            {live && (
              <div className="absolute bottom-3 right-3 text-[10px] font-mono px-2 py-1 rounded bg-black/60 text-slate-300">
                {videoInfo?.width}×{videoInfo?.height} {videoInfo?.frameRate ? `· ${Math.round(videoInfo.frameRate)}fps` : ""}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {live ? (
              <button onClick={stopWebcam} className="flex items-center gap-2 text-sm border border-ink-700 rounded-xl px-3 py-2 text-slate-300 hover:border-danger-500/50 hover:text-danger-500 transition-colors">
                <VideoOff size={14} /> Stop Camera
              </button>
            ) : (
              <button onClick={startWebcam} className="flex items-center gap-2 text-sm bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold rounded-xl px-3 py-2 transition-colors">
                <Video size={14} /> Start Camera
              </button>
            )}

            {!monitoring ? (
              <button disabled={!live} onClick={startMonitoring} className="flex items-center gap-2 text-sm border border-ink-700 rounded-xl px-3 py-2 text-slate-300 hover:border-accent-500/50 hover:text-accent-500 disabled:opacity-40 transition-colors">
                <Activity size={14} /> Start Monitoring
              </button>
            ) : (
              <button onClick={stopMonitoring} className="flex items-center gap-2 text-sm border border-warn-500/40 text-warn-500 rounded-xl px-3 py-2 transition-colors">
                <Activity size={14} /> Stop Monitoring
              </button>
            )}

            {!recording ? (
              <button disabled={!live} onClick={startRecording} className="flex items-center gap-2 text-sm bg-danger-500 hover:bg-danger-500/80 text-white font-bold rounded-xl px-3 py-2 disabled:opacity-40 transition-colors">
                <Circle size={14} className="fill-white" /> Start Recording
              </button>
            ) : (
              <button onClick={stopRecording} className="flex items-center gap-2 text-sm border border-danger-500 text-danger-500 rounded-xl px-3 py-2 transition-colors">
                <Square size={14} /> Stop Recording
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Camera ID</label>
              <input value={cameraId} onChange={(e) => setCameraId(e.target.value)} disabled={monitoring || recording}
                className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60 disabled:opacity-50 mono" />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Case ID</label>
              <input value={caseId} onChange={(e) => setCaseId(e.target.value)} disabled={recording}
                className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60 disabled:opacity-50 mono" />
            </div>
          </div>

          {(rootEvidence || chainStatus) && (
            <div className="glass-panel rounded-2xl p-4">
              <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                <Link2 size={13} className="text-accent-500" /> Segment hash chain
              </div>
              {rootEvidence && (
                <Link to={`/evidence/${rootEvidence.evidence_id}`} className="text-xs mono text-accent-500 hover:underline block mb-2">
                  {rootEvidence.evidence_id}
                </Link>
              )}
              {rootEvidence && !recording && (
                <Link
                  to={`/evidence/${rootEvidence.evidence_id}`}
                  className="flex items-center justify-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-xs rounded-xl px-3 py-2.5 mb-2 transition-colors"
                >
                  View Evidence Detail →
                </Link>
              )}
              {chainStatus ? (
                <div className={`text-xs flex items-center gap-2 ${chainStatus.intact ? "text-accent-500" : "text-danger-500"}`}>
                  {chainStatus.intact ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
                  {chainStatus.segment_count} segment{chainStatus.segment_count === 1 ? "" : "s"} · chain {chainStatus.intact ? "intact" : "broken"}
                </div>
              ) : (
                <p className="text-xs text-slate-600">First chunk creates the evidence record; later chunks chain onto it.</p>
              )}
            </div>
          )}

          {/* Test evidence fallback -- explicitly distinguished from live camera */}
          <div className="border border-warn-500/30 bg-warn-500/5 rounded-xl p-4">
            <button onClick={() => setTestMode((v) => !v)} className="flex items-center gap-2 text-xs font-medium text-warn-500">
              <FlaskConical size={13} /> TEST EVIDENCE (not live camera) {testMode ? "▲" : "▼"}
            </button>
            {testMode && (
              <form onSubmit={submitTestEvidence} className="mt-3 flex items-center gap-3">
                <input type="file" accept="video/*,image/*" onChange={(e) => setTestFile(e.target.files?.[0] ?? null)}
                  className="text-xs text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-ink-800 file:text-slate-300" />
                <button disabled={!testFile || testSubmitting} className="flex items-center gap-2 text-xs bg-warn-500/20 text-warn-500 border border-warn-500/40 rounded-lg px-3 py-1.5 disabled:opacity-40">
                  {testSubmitting && <Loader2 size={12} className="animate-spin" />} Upload as TEST EVIDENCE
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Status sidebar */}
        <div className="space-y-4">
          <div className="glass-panel rounded-2xl p-4">
            <p className="text-xs text-slate-500 mb-3">Obstruction Detection {monitoring && `(${analysisFps} fps)`}</p>
            {!monitoring ? (
              <p className="text-xs text-slate-600">Not monitoring. Start the camera and click "Start Monitoring".</p>
            ) : (
              <div className={`rounded-lg p-3 border ${obstructed ? "border-danger-500/40 bg-danger-500/10" : "border-accent-500/30 bg-accent-500/5"}`}>
                <div className={`flex items-center gap-2 text-sm font-medium ${obstructed ? "text-danger-500" : "text-accent-500"}`}>
                  {obstructed ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
                  {obstructed ? "OBSTRUCTION DETECTED" : "SECURE"}
                </div>
                {obstructed && (
                  <p className="text-[11px] text-slate-500 mt-2">Visual feed appears blocked or obstructed.</p>
                )}
                {!obstructed && restoredAt && (
                  <p className="text-[11px] text-accent-500 mt-2 font-semibold">CAMERA FEED RESTORED</p>
                )}
                <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-400 mono">
                  <div><dt className="text-slate-600">Time</dt><dd>{new Date().toLocaleTimeString()}</dd></div>
                  <div><dt className="text-slate-600">Frames affected</dt><dd>{obstructed ? frameResult?.consecutive_obstructed ?? 0 : 0}</dd></div>
                  {frameResult?.last_analysis && (
                    <>
                      <div><dt className="text-slate-600">Brightness</dt><dd>{frameResult.last_analysis.brightness}</dd></div>
                      <div><dt className="text-slate-600">Blur variance</dt><dd>{frameResult.last_analysis.laplacian_variance}</dd></div>
                    </>
                  )}
                </dl>
                {obstructed && frameResult?.event?.confidence !== undefined && (
                  <p className="text-[11px] text-danger-500 mt-2">Confidence: {frameResult.event.confidence}%</p>
                )}
                <p className="text-[10px] text-slate-600 mt-2">Status: {obstructed ? "ALERT" : "NORMAL"}</p>
              </div>
            )}
          </div>

          <div className="glass-panel rounded-2xl p-4">
            <p className="text-xs text-slate-500 mb-3">Recent Camera Events</p>
            {cameraEvents.length === 0 ? (
              <p className="text-xs text-slate-600">No incidents recorded yet.</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                {cameraEvents.map((ev) => (
                  <div key={ev.id} className="text-xs bg-ink-800 rounded-lg p-2.5">
                    <div className="flex items-center justify-between">
                      <span className={ev.event_type === "OBSTRUCTION_DETECTED" ? "text-danger-500" : "text-accent-500"}>
                        {ev.event_type.replace(/_/g, " ")}
                      </span>
                      <span className="text-slate-600">{ev.status}</span>
                    </div>
                    <div className="text-slate-500 mt-1">
                      {new Date(ev.started_at).toLocaleTimeString()}
                      {ev.confidence !== null && ` · ${ev.confidence}% confidence`}
                      {ev.downtime_seconds !== null && ` · ${ev.downtime_seconds}s downtime`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="glass-panel rounded-2xl p-4">
            <p className="text-xs text-slate-500 mb-3">Evidence Pipeline</p>
            {segmentLog.length === 0 ? (
              <p className="text-xs text-slate-600">No evidence created yet this session.</p>
            ) : (
              <div className="space-y-3 max-h-96 overflow-y-auto scrollbar-thin">
                {segmentLog.map((entry) => (
                  <SegmentLogCard key={entry.key} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function SegmentLogCard({ entry }: { entry: SegmentLogEntry }) {
  if (entry.status === "uploading") {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400 bg-ink-800 rounded-lg p-3">
        <Loader2 size={13} className="animate-spin text-purple-500" />
        {entry.isRoot ? "Creating evidence + hashing..." : `Hashing segment ${entry.index}...`}
      </div>
    );
  }
  if (entry.status === "error") {
    return (
      <div className="text-xs bg-danger-500/10 border border-danger-500/30 rounded-lg p-3 text-danger-500">
        {entry.error}
      </div>
    );
  }

  if (entry.isRoot) {
    const ev = entry.segment as EvidenceRecord;
    return (
      <div className="bg-ink-800 rounded-lg p-3">
        <Link to={`/evidence/${ev.evidence_id}`} className="text-[11px] mono text-accent-500 hover:underline block mb-2">
          {ev.evidence_id}
        </Link>
        <StorageBadge status={ev.storage_status} />
        {ev.blockchain_status === "UNAVAILABLE" && (
          <p className="text-[10px] text-warn-500 mt-2">BLOCKCHAIN ANCHOR PENDING — system account unfunded/unreachable</p>
        )}
        {ev.algorand_txid && (
          <a href={`https://testnet.explorer.perawallet.app/tx/${ev.algorand_txid}`} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-purple-500 hover:underline mt-2">
            <ExternalLink size={10} /> View on Algorand Explorer
          </a>
        )}
      </div>
    );
  }

  const seg = entry.segment as EvidenceSegment;
  return (
    <div className="bg-ink-800 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-slate-300">Segment {seg.sequence}</span>
        <StorageBadge status={seg.storage_status} />
      </div>
      <div className="text-[10px] text-slate-600 mono break-all">{seg.segment_hash.slice(0, 24)}...</div>
    </div>
  );
}

function StorageBadge({ status }: { status: string | undefined }) {
  if (status === "STORED") {
    return <span className="flex items-center gap-1 text-[10px] text-accent-500"><Cloud size={11} /> Stored</span>;
  }
  return <span className="flex items-center gap-1 text-[10px] text-warn-500"><CloudOff size={11} /> Storage unavailable (hash still recorded)</span>;
}
