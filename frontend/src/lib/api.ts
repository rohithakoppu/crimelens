import axios from "axios";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

export const api = axios.create({ baseURL: API_BASE_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("ec_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface AuthUser {
  name: string;
  role: "admin" | "investigator" | "viewer";
  token: string;
}

export function saveAuth(user: AuthUser) {
  localStorage.setItem("ec_token", user.token);
  localStorage.setItem("ec_user", JSON.stringify(user));
}

export function loadAuth(): AuthUser | null {
  const raw = localStorage.getItem("ec_user");
  return raw ? (JSON.parse(raw) as AuthUser) : null;
}

export function clearAuth() {
  localStorage.removeItem("ec_token");
  localStorage.removeItem("ec_user");
}

export interface CaseSummary {
  case_id: string;
  title: string;
  status: string;
  evidence_count: number;
}

export interface TimelineEvent {
  type: "capture" | "tamper" | "detection" | "custody";
  evidence_id: string;
  timestamp: string;
  [key: string]: unknown;
}

export type BlockchainStatus = "PENDING" | "CONFIRMED" | "UNAVAILABLE" | "FAILED" | "NOT_APPLICABLE";

export interface EvidenceRecord {
  evidence_id: string;
  case_id: string;
  camera_id: string;
  file_name: string | null;
  file_size: number | null;
  sha256: string;
  signature: string | null;
  blockchain_status: BlockchainStatus;
  algorand_txid: string | null;
  storage_status: "STORED" | "UNAVAILABLE" | "PENDING";
  storage_error: string | null;
  captured_at: string | null;
  ingested_at: string;
  revoked: boolean;
  is_derived?: boolean;
  original_evidence_id?: string | null;
  edit_description?: string | null;
}

export interface CustodyChainStatus {
  intact: boolean;
  event_count: number;
  broken_at: { event_id: string; event_type: string; reason: string } | null;
}

export interface CustodyEvent {
  id: string;
  event_type: string;
  actor_name: string | null;
  actor_role: string | null;
  prev_event_hash: string;
  event_hash: string;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

export type BlockchainVerificationStatus = "CONFIRMED" | "HASH_MISMATCH" | "UNAVAILABLE" | "NOT_CONFIGURED";

export interface BlockchainVerifyResult {
  checked: boolean;
  verified: boolean;
  status?: BlockchainVerificationStatus;
  reason?: string;
  confirmed?: boolean;
  confirmed_round?: number | null;
  anchored_hash?: string;
  expected_hash?: string;
  hash_match?: boolean;
  evidence_id_match?: boolean;
  explorer_url?: string;
  note?: Record<string, unknown>;
  // Phase 3: real smart-contract readback fields (present when
  // blockchain_status is contract-based, i.e. algorand_app_id is set)
  app_id?: number;
  anchored_root_hash?: string;
  expected_root_hash?: string;
  registered_at?: number;
  registrant?: string;
}

export type VerificationVerdict = "AUTHENTIC" | "TAMPERED" | "INTEGRITY_FAILURE";

export interface VerifyResult {
  evidence_id: string;
  original_hash: string;
  current_hash: string;
  hash_match: boolean;
  signature_valid: boolean;
  blockchain: BlockchainVerifyResult;
  blockchain_status: string;
  blockchain_txid: string | null;
  custody_chain: CustodyChainStatus;
  custody_chain_intact: boolean;
  segment_chain: SegmentChainStatus;
  segment_chain_intact: boolean;
  segment_count: number;
  root_hash: string | null;
  root_hash_checked: boolean;
  root_hash_match: boolean | null;
  // Phase 3: real blockchain proof fields, always UNAVAILABLE (literal
  // string) rather than null/omitted when genuinely not available
  network: string;
  application_id: number | "UNAVAILABLE";
  transaction_id: string | "UNAVAILABLE";
  anchored_root_hash: string | "UNAVAILABLE";
  anchor_timestamp: number | "UNAVAILABLE";
  verification_status: BlockchainVerificationStatus | "NOT_CONFIGURED";
  verdict: VerificationVerdict;
  final_verdict: VerificationVerdict;
  failure_reason: string | null;
  failed_segment: number | null;
}

export interface BlockchainProofResult {
  evidence_id: string;
  root_hash: string;
  blockchain_status: string;
  network: string;
  application_id: number | "UNAVAILABLE";
  transaction_id: string | "UNAVAILABLE";
  anchored_root_hash: string | "UNAVAILABLE";
  anchor_timestamp: number | "UNAVAILABLE";
  verification_status: BlockchainVerificationStatus | "NOT_CONFIGURED";
  detail: BlockchainVerifyResult;
}

export interface HealthStatus {
  status: string;
  app: string;
  services: {
    firebase: { status: string; configured: boolean; project_id: string; error: string | null };
    algorand: {
      status: string; configured: boolean; network: string; address: string | null;
      connected: boolean; balance_microalgos: number | null; error: string | null;
    };
    smart_contract: { status: "DEPLOYED" | "NOT_CONFIGURED"; app_id: number | null; network: string };
  };
}

export interface CameraFrameAnalysis {
  brightness: number;
  laplacian_variance: number;
  brightness_threshold: number;
  laplacian_threshold: number;
  obstructed_frame: boolean;
  confidence: number;
}

export interface CameraFrameResult {
  camera_id: string;
  status: "ACTIVE" | "OBSTRUCTED";
  consecutive_obstructed: number;
  consecutive_clear: number;
  active_event_id: string | null;
  last_analysis: CameraFrameAnalysis | null;
  event: { type: "OBSTRUCTION_DETECTED" | "CAMERA_RECOVERED"; confidence?: number; downtime_seconds?: number; event_id: string | null; persist_error?: string } | null;
}

export interface CameraEvent {
  id: string;
  camera_id: string;
  event_type: string;
  status: "OPEN" | "CLOSED";
  confidence: number | null;
  started_at: string;
  ended_at: string | null;
  downtime_seconds: number | null;
  metadata: Record<string, unknown>;
}

export type StorageStatus = "STORED" | "UNAVAILABLE" | "PENDING";

export interface EvidenceSegment {
  id: string;
  evidence_id: string;
  sequence: number;
  sha256: string;
  duration_seconds: number;
  file_size: number | null;
  mime_type: string | null;
  storage_status: StorageStatus;
  storage_path: string | null;
  storage_error: string | null;
  prev_segment_hash: string;
  segment_hash: string;
  created_at: string;
}

export interface SegmentChainStatus {
  intact: boolean;
  segment_count: number;
  broken_at: { sequence: number; reason: string } | null;
}

export interface Incident {
  id: string;
  camera_id: string;
  case_id: string | null;
  incident_type: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  camera_event_id: string | null;
  status: "OPEN" | "RESOLVED";
  metadata: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
}

export interface CameraRecord {
  camera_id: string;
  name: string;
  source_type: "web" | "rtsp" | "onvif";
  case_id: string | null;
  owner_id: string | null;
  status: string;
  created_at: string;
}
