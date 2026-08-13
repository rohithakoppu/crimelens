/**
 * CameraSource: the ingestion-layer abstraction the whole evidence pipeline
 * is built against. The hackathon prototype has no physical CCTV/NVR, so
 * WebCameraSource (the browser's real getUserMedia + MediaRecorder APIs) is
 * the only implementation that exists today -- but nothing downstream (frame
 * analysis, recording, segment hashing, evidence ingest) talks to
 * getUserMedia directly. It talks to this interface, so a future
 * RtspCameraSource / OnvifCameraSource (fed by an actual NVR feed on a
 * backend media gateway) can be dropped in without touching the evidence
 * pipeline at all.
 */
export interface CameraFrameCapture {
  blob: Blob;
  width: number;
  height: number;
}

export interface CameraSourceInfo {
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface CameraSource {
  readonly sourceType: "web" | "rtsp" | "onvif";

  /**
   * Starts the underlying stream and attaches it to the given <video> element.
   * `onStreamEnded`, if given, fires if the track ends for a reason OUTSIDE
   * the app's own control (device unplugged, OS camera permission revoked,
   * another application taking exclusive access, driver reset) -- this is a
   * genuinely different browser event than calling stop() ourselves, which
   * never fires it. Without a listener for this, a real webcam that gets cut
   * off externally leaves the UI stuck claiming LIVE while the preview goes
   * blank, with no way to detect or recover from it.
   */
  start(videoEl: HTMLVideoElement, onStreamEnded?: () => void): Promise<CameraSourceInfo>;

  /** Stops the underlying stream and releases the device/connection. */
  stop(): void;

  /** True while a stream is actively attached. */
  isLive(): boolean;

  /** Captures a single still frame as a JPEG blob, for obstruction analysis. */
  captureFrame(videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement): Promise<CameraFrameCapture | null>;

  /** Creates a MediaRecorder-compatible recorder over the live stream. */
  createRecorder(mimeType?: string): MediaRecorder;

  /** Picks a MediaRecorder MIME type the current browser actually supports. */
  pickMimeType(): string;
}

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm",
];

// ---------------------------------------------------------------- errors --

/** Every real, distinguishable reason camera access can fail. Never a
 * catch-all "something went wrong" -- each code maps to a condition that was
 * actually detected, not guessed. */
export type CameraErrorCode =
  | "API_UNAVAILABLE" // navigator.mediaDevices.getUserMedia doesn't exist in this browser
  | "INSECURE_CONTEXT" // page isn't served over HTTPS/localhost, so the API is withheld
  | "PERMISSION_DENIED" // user or browser policy blocked the permission prompt
  | "NO_DEVICE" // no camera hardware found
  | "DEVICE_BUSY" // camera exists but another app/tab has it locked
  | "SECURITY_ERROR" // blocked by a permissions-policy / cross-origin restriction
  | "OVERCONSTRAINED" // no camera satisfies the requested constraints
  | "VALIDATION_FAILED" // getUserMedia succeeded but the resulting stream/video never actually produced frames
  | "UNKNOWN";

export class CameraAccessError extends Error {
  readonly code: CameraErrorCode;
  constructor(code: CameraErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CameraAccessError";
    this.code = code;
  }
}

/** Checks the two preconditions getUserMedia has before any permission
 * prompt can even appear: the API must exist, and the page must be in a
 * secure context (HTTPS, or http://localhost / http://127.0.0.1). Call this
 * BEFORE invoking getUserMedia so a blocked origin gets an exact, honest
 * reason instead of a generic browser TypeError. */
export function checkCameraSupport(): { ok: true } | { ok: false; error: CameraAccessError } {
  if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // A missing API on an otherwise-secure origin usually still means the
    // browser doesn't support it; but on an insecure origin, browsers
    // withhold the API entirely, so check that first for a more specific
    // message when it applies.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      return {
        ok: false,
        error: new CameraAccessError(
          "INSECURE_CONTEXT",
          "Camera access requires HTTPS or localhost. This page is being served from a non-secure origin, so the browser withholds camera access entirely."
        ),
      };
    }
    return {
      ok: false,
      error: new CameraAccessError(
        "API_UNAVAILABLE",
        "This browser does not support camera access (navigator.mediaDevices.getUserMedia is unavailable)."
      ),
    };
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return {
      ok: false,
      error: new CameraAccessError(
        "INSECURE_CONTEXT",
        "Camera access requires HTTPS or localhost. This page is being served from a non-secure origin."
      ),
    };
  }
  return { ok: true };
}

/** Turns whatever getUserMedia actually threw into one of our real error
 * codes. Every branch corresponds to a documented DOMException name -- none
 * of this is guessed. */
function classifyGetUserMediaError(err: unknown): CameraAccessError {
  if (err instanceof CameraAccessError) return err;

  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return new CameraAccessError(
          "PERMISSION_DENIED",
          "Camera permission was denied. Allow camera access for this site in your browser's settings and retry.",
          { cause: err }
        );
      case "NotFoundError":
      case "DevicesNotFoundError":
        return new CameraAccessError("NO_DEVICE", "No camera device was found on this system.", { cause: err });
      case "NotReadableError":
      case "TrackStartError":
        return new CameraAccessError(
          "DEVICE_BUSY",
          "The camera is busy or unavailable -- another application or browser tab may already be using it.",
          { cause: err }
        );
      case "SecurityError":
        return new CameraAccessError(
          "SECURITY_ERROR",
          "Camera access was blocked for security reasons (insecure origin or a permissions-policy restriction).",
          { cause: err }
        );
      case "OverconstrainedError":
      case "ConstraintNotSatisfiedError":
        return new CameraAccessError(
          "OVERCONSTRAINED",
          "No available camera satisfies the requested video constraints.",
          { cause: err }
        );
      default:
        return new CameraAccessError("UNKNOWN", `Camera error: ${err.name}.`, { cause: err });
    }
  }

  if (err instanceof TypeError) {
    // getUserMedia threw synchronously rather than returning a rejected
    // promise -- this shape is what you get calling a method that doesn't
    // exist, which checkCameraSupport() should normally have already caught.
    const support = checkCameraSupport();
    if (!support.ok) return support.error;
    return new CameraAccessError("API_UNAVAILABLE", "This browser does not support camera access.", { cause: err });
  }

  return new CameraAccessError("UNKNOWN", "Could not access the webcam.", { cause: err });
}

/** Human-facing short label for each error code, per the required states. */
export const CAMERA_ERROR_LABELS: Record<CameraErrorCode, string> = {
  API_UNAVAILABLE: "BROWSER CAMERA API UNAVAILABLE",
  INSECURE_CONTEXT: "CAMERA REQUIRES HTTPS OR LOCALHOST",
  PERMISSION_DENIED: "CAMERA PERMISSION DENIED",
  NO_DEVICE: "NO CAMERA DEVICE FOUND",
  DEVICE_BUSY: "CAMERA IS BUSY OR UNAVAILABLE",
  SECURITY_ERROR: "CAMERA ACCESS BLOCKED (SECURITY)",
  OVERCONSTRAINED: "REQUESTED CAMERA MODE UNSUPPORTED",
  VALIDATION_FAILED: "CAMERA STREAM PRODUCED NO VIDEO",
  UNKNOWN: "CAMERA ERROR",
};

/** Real implementation: browser webcam via getUserMedia + MediaRecorder.
 * This is the ONLY CameraSource wired up today -- the prototype's "CCTV
 * camera" is genuinely the laptop's webcam, not a simulation. */
export class WebCameraSource implements CameraSource {
  readonly sourceType = "web" as const;
  private stream: MediaStream | null = null;

  async start(videoEl: HTMLVideoElement, onStreamEnded?: () => void): Promise<CameraSourceInfo> {
    const support = checkCameraSupport();
    if (!support.ok) throw support.error;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      throw classifyGetUserMediaError(err);
    }

    this.stream = stream;
    videoEl.srcObject = stream;
    try {
      await videoEl.play();
    } catch (err) {
      this.stop();
      throw new CameraAccessError(
        "VALIDATION_FAILED",
        "The video element could not start playback of the camera stream.",
        { cause: err }
      );
    }

    // Do not report LIVE just because getUserMedia() resolved -- a stream
    // object existing doesn't guarantee frames are actually flowing. Verify
    // the track is genuinely live and the video element has real dimensions
    // before this promise resolves successfully. Real cameras can take a
    // little longer than a synthetic test device to deliver their first
    // frame (autofocus/exposure warm-up), so this waits generously before
    // concluding the stream never came up.
    const validation = await this._validatePlayback(videoEl, stream);
    if (!validation.ok) {
      this.stop();
      throw new CameraAccessError("VALIDATION_FAILED", validation.reason);
    }

    const track = stream.getVideoTracks()[0];

    // A track can end for reasons entirely outside this app's control --
    // the device is unplugged, the OS revokes camera access, or another
    // application takes it over exclusively. track.stop() (called by our
    // own stop() below) never fires this event, so it's a reliable signal
    // that the stream died externally rather than because we ended it.
    if (track) {
      track.onended = () => {
        if (this.stream === stream) {
          this.stream = null;
          onStreamEnded?.();
        }
      };
    }

    const settings = track?.getSettings?.() ?? {};
    return { width: settings.width, height: settings.height, frameRate: settings.frameRate };
  }

  private async _validatePlayback(
    videoEl: HTMLVideoElement,
    stream: MediaStream
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const track = stream.getVideoTracks()[0];
    if (!track) return { ok: false, reason: "The camera stream has no video track." };
    if (track.readyState !== "live") {
      return { ok: false, reason: `The camera video track is not live (state: ${track.readyState}).` };
    }

    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
      await new Promise<void>((resolve) => {
        const onLoaded = () => {
          videoEl.removeEventListener("loadedmetadata", onLoaded);
          resolve();
        };
        videoEl.addEventListener("loadedmetadata", onLoaded);
        // Don't hang forever if metadata never arrives -- fail the
        // dimension check below instead of leaving the UI stuck loading.
        setTimeout(resolve, 1500);
      });
    }

    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
      return { ok: false, reason: "The camera stream produced no video frames (zero-dimension output)." };
    }
    if (videoEl.paused) {
      return { ok: false, reason: "The video element is not playing." };
    }
    return { ok: true };
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  isLive(): boolean {
    return this.stream !== null && this.stream.active;
  }

  captureFrame(videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement): Promise<CameraFrameCapture | null> {
    return new Promise((resolve) => {
      if (videoEl.videoWidth === 0) return resolve(null);
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
      const ctx = canvasEl.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
      canvasEl.toBlob(
        (blob) => resolve(blob ? { blob, width: canvasEl.width, height: canvasEl.height } : null),
        "image/jpeg",
        0.75
      );
    });
  }

  createRecorder(mimeType?: string): MediaRecorder {
    if (!this.stream) throw new Error("WebCameraSource: cannot record before start()");
    return new MediaRecorder(this.stream, { mimeType: mimeType ?? this.pickMimeType() });
  }

  pickMimeType(): string {
    for (const c of MIME_CANDIDATES) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "video/webm";
  }
}

/** Not implemented in this prototype -- documents the intended future
 * architecture (an NVR/DVR feeding RTSP to a backend media gateway that
 * republishes frames/clips over the same evidence pipeline). Constructing
 * this throws rather than silently behaving like a webcam. */
export class FutureRtspCameraSource implements CameraSource {
  readonly sourceType = "rtsp" as const;
  constructor(_rtspUrl: string) {
    throw new Error("RTSP camera ingestion is not implemented in this prototype -- see CameraSource docs.");
  }
  start(): Promise<CameraSourceInfo> { throw new Error("not implemented"); }
  stop(): void { throw new Error("not implemented"); }
  isLive(): boolean { return false; }
  captureFrame(): Promise<CameraFrameCapture | null> { throw new Error("not implemented"); }
  createRecorder(): MediaRecorder { throw new Error("not implemented"); }
  pickMimeType(): string { throw new Error("not implemented"); }
}
