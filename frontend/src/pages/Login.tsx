import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ShieldCheck, Loader2, ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { signInWithGoogle, FirebaseNotConfiguredError } from "../lib/firebase";

const DEMO_ACCOUNTS = [
  { label: "Admin", email: "admin@evidencechain.demo", password: "Admin#12345" },
  { label: "Investigator", email: "investigator@evidencechain.demo", password: "Investigator#12345" },
  { label: "Viewer", email: "viewer@evidencechain.demo", password: "Viewer#12345" },
];

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.95v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.05z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .95 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const applySession = async (idToken: string) => {
    const { data: profile } = await api.post("/auth/session", null, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    login({ name: profile.name, role: profile.role, token: idToken });
    navigate("/dashboard");
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError(null);
    try {
      const idToken = await signInWithGoogle();
      await applySession(idToken);
    } catch (err: unknown) {
      if (err instanceof FirebaseNotConfiguredError) {
        setError(err.message);
      } else if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code: string }).code;
        if (code === "auth/operation-not-allowed") {
          setError("Google Sign-In is not enabled for this Firebase project yet (enable it in Firebase Console -> Authentication -> Sign-in method).");
        } else if (code === "auth/popup-closed-by-user") {
          setError("Google sign-in was cancelled.");
        } else {
          setError(`Google sign-in failed (${code}).`);
        }
      } else {
        setError("Google sign-in failed.");
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.post("/auth/login", { email, password });
      login({ name: data.name, role: data.role, token: data.access_token });
      navigate("/dashboard");
    } catch (err: unknown) {
      const status =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { status?: number; data?: { detail?: string } } }).response?.status
          : undefined;
      const detail =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;

      if (status === 503) {
        setError(`Server setup issue: ${detail ?? "a required backend service is not configured"}. This is not a wrong password -- contact your administrator.`);
      } else if (status === 401) {
        setError("Invalid email or password.");
      } else {
        setError(detail ?? "Could not reach the server. Check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md relative fade-up">
        <Link to="/" className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 mb-6 transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>

        <div className="glass-panel rounded-3xl p-8 sm:p-10">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-xl bg-accent-500/10 p-2.5 text-accent-500">
              <ShieldCheck size={22} />
            </div>
            <span className="font-bold tracking-[.24em]">CRIMELENS</span>
          </div>
          <p className="mono mb-3 text-xs uppercase tracking-[.18em] text-accent-500">Secure access to your evidence</p>
          <h1 className="mb-8 text-2xl font-bold tracking-tight text-white">Enter the evidence room.</h1>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={googleLoading}
            className="w-full flex items-center justify-center gap-3 bg-slate-100 hover:bg-white text-slate-900 font-semibold text-sm rounded-xl py-3.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {googleLoading ? <Loader2 size={16} className="animate-spin" /> : <GoogleIcon />}
            Continue with Google
          </button>

          {error && <p className="text-xs text-danger-500 mt-3 leading-relaxed">{error}</p>}

          <div className="flex items-center gap-3 my-6">
            <div className="h-px bg-ink-700 flex-1" />
            <span className="mono text-[10px] uppercase tracking-widest text-slate-600">or</span>
            <div className="h-px bg-ink-700 flex-1" />
          </div>

          {!showEmailForm ? (
            <button
              type="button"
              onClick={() => setShowEmailForm(true)}
              className="w-full text-xs text-slate-400 hover:text-slate-200 transition-colors py-2"
            >
              Sign in with email &amp; password
            </button>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-accent-500/60 focus:ring-1 focus:ring-accent-500/30"
                placeholder="you@example.com"
              />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-accent-500/60 focus:ring-1 focus:ring-accent-500/30"
                placeholder="Password"
              />
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-sm rounded-xl py-3 flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                Sign in
              </button>
            </form>
          )}

          {showEmailForm && (
            <div className="mt-6 border-t border-ink-800 pt-5">
              <p className="text-xs text-slate-500 mb-2 text-center">Demo accounts (seeded via seed.py)</p>
              <div className="grid grid-cols-3 gap-2">
                {DEMO_ACCOUNTS.map((acct) => (
                  <button
                    key={acct.email}
                    type="button"
                    onClick={() => {
                      setEmail(acct.email);
                      setPassword(acct.password);
                    }}
                    className="text-xs border border-ink-700 rounded-lg py-2 text-slate-400 hover:border-accent-500/40 hover:text-accent-500 transition-colors"
                  >
                    {acct.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
