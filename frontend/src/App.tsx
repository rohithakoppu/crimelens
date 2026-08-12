import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import LiveCamera from "./pages/LiveCamera";
import PrototypeEvidence from "./pages/PrototypeEvidence";
import EvidenceLibrary from "./pages/EvidenceLibrary";
import CaseDetail from "./pages/CaseDetail";
import EvidenceDetail from "./pages/EvidenceDetail";
import VerifyPublic from "./pages/VerifyPublic";
import Incidents from "./pages/Incidents";
import Blockchain from "./pages/Blockchain";
import Certificates from "./pages/Certificates";
import Settings from "./pages/Settings";
import ApiAccess from "./pages/ApiAccess";
import Admin from "./pages/Admin";
import { useAuth } from "./lib/auth";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function App() {
  return (
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
  );
}

export default App;
