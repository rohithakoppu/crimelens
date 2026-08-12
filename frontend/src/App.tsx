import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import Layout from "./components/Layout";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import { useAuth } from "./lib/auth";

// Route-level code splitting: each page's JS is only downloaded when the
// user actually navigates to it, instead of one ~540KB bundle upfront for
// every page (camera, blockchain, admin, etc. all at once) -- this was
// flagged by Vite's own build warning and is a real, measurable contributor
// to slow initial load / page-to-page navigation. Landing and Login stay
// eager since they're the first thing almost every visit renders.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const LiveCamera = lazy(() => import("./pages/LiveCamera"));
const PrototypeEvidence = lazy(() => import("./pages/PrototypeEvidence"));
const EvidenceLibrary = lazy(() => import("./pages/EvidenceLibrary"));
const CaseDetail = lazy(() => import("./pages/CaseDetail"));
const EvidenceDetail = lazy(() => import("./pages/EvidenceDetail"));
const VerifyPublic = lazy(() => import("./pages/VerifyPublic"));
const Incidents = lazy(() => import("./pages/Incidents"));
const Blockchain = lazy(() => import("./pages/Blockchain"));
const Certificates = lazy(() => import("./pages/Certificates"));
const Settings = lazy(() => import("./pages/Settings"));
const ApiAccess = lazy(() => import("./pages/ApiAccess"));
const Admin = lazy(() => import("./pages/Admin"));

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PageLoading() {
  return (
    <div className="flex items-center justify-center min-h-[60vh] text-slate-500">
      <Loader2 size={22} className="animate-spin text-accent-500" />
    </div>
  );
}

function App() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/verify" element={<VerifyPublic />} />
        <Route path="/verify/:evidenceId" element={<VerifyPublic />} />

        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/camera" element={<LiveCamera />} />
          <Route path="/prototype-video" element={<PrototypeEvidence />} />
          <Route path="/evidence" element={<EvidenceLibrary />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/blockchain" element={<Blockchain />} />
          <Route path="/certificates" element={<Certificates />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/case/:caseId" element={<CaseDetail />} />
          <Route path="/evidence/:evidenceId" element={<EvidenceDetail />} />
          <Route path="/api-access" element={<ApiAccess />} />
          <Route path="/admin" element={<Admin />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default App;
