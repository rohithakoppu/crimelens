import { useState, useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  ShieldCheck, Gauge, ScanSearch, Users, LogOut, Video, KeyRound, Radio, Blocks, Award, Settings as SettingsIcon, Database, Activity, RefreshCw, FlaskConical
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { api, type HealthStatus } from "../lib/api";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: Gauge },
  { to: "/camera", label: "Live Camera", icon: Video },
  { to: "/prototype-video", label: "Prototype Video", icon: FlaskConical },
  { to: "/evidence", label: "Evidence Library", icon: Database },
  { to: "/incidents", label: "Incidents", icon: Radio },
  { to: "/verify", label: "Verification Engine", icon: ScanSearch },
  { to: "/blockchain", label: "Blockchain Anchors", icon: Blocks },
  { to: "/certificates", label: "Certificates", icon: Award },
  { to: "/api-access", label: "API / x402", icon: KeyRound },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchHealth = async () => {
    try {
      setIsRefreshing(true);
      const res = await api.get<HealthStatus>("/health");
      setHealth(res.data);
    } catch {
      setHealth(null);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const firebaseStatus = health?.services?.firebase?.status || "UNAVAILABLE";
  const algorandStatus = health?.services?.algorand?.status || "UNAVAILABLE";

  return (
    <div className="min-h-screen flex grid-bg text-slate-100 font-sans selection:bg-accent-500 selection:text-ink-950">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r border-ink-700/60 bg-ink-950/90 backdrop-blur-xl flex flex-col z-20">
        <div className="px-5 py-6 flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-accent-500/10 flex items-center justify-center text-accent-500">
            <ShieldCheck size={22} />
          </div>
          <div>
            <div className="font-bold text-sm tracking-[.2em] text-white flex items-center gap-1.5">
              CRIMELENS
              <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-accent-500/15 text-accent-500 mono font-semibold tracking-normal">
                Pro
              </span>
            </div>
            <div className="mono text-[9px] uppercase tracking-[.16em] text-slate-500 mt-0.5">Evidence OS</div>
          </div>
        </div>

        <nav className="flex-1 px-3 pt-4 space-y-1 overflow-y-auto scrollbar-thin">
          <div className="px-3 pb-2 mono text-[10px] uppercase tracking-[.18em] text-slate-600">Command center</div>
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                  isActive
                    ? "bg-accent-500/10 text-accent-500"
                    : "text-slate-400 hover:bg-white/[.03] hover:text-slate-200"
                }`
              }
            >
              <Icon size={17} />
              {label}
            </NavLink>
          ))}

          <div className="pt-4 mt-4 border-t border-ink-800/80 space-y-1">
            <div className="px-3 pb-2 mono text-[10px] uppercase tracking-[.18em] text-slate-600">System</div>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                  isActive
                    ? "bg-accent-500/10 text-accent-500"
                    : "text-slate-400 hover:bg-white/[.03] hover:text-slate-200"
                }`
              }
            >
              <SettingsIcon size={17} />
              Settings
            </NavLink>
            {user?.role === "admin" && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    isActive
                      ? "bg-accent-500/10 text-accent-500"
                      : "text-slate-400 hover:bg-white/[.03] hover:text-slate-200"
                  }`
                }
              >
                <Users size={17} />
                Admin Console
              </NavLink>
            )}
          </div>
        </nav>

        {/* User Card */}
        <div className="p-4">
          {user ? (
            <div className="mb-2 rounded-xl border border-ink-700/70 bg-ink-900/60 p-3 flex items-center justify-between">
              <div className="flex items-center gap-2.5 overflow-hidden">
                <div className="w-8 h-8 rounded-full bg-accent-500/15 flex items-center justify-center font-bold text-accent-500 text-xs shrink-0">
                  {user.name ? user.name.charAt(0).toUpperCase() : "U"}
                </div>
                <div className="truncate">
                  <div className="text-xs font-semibold text-white truncate">{user.name}</div>
                  <div className="mono text-[10px] text-slate-500 capitalize">{user.role}</div>
                </div>
              </div>
              <button
                onClick={handleLogout}
                title="Sign Out"
                className="p-1.5 rounded-lg text-slate-500 hover:text-danger-500 hover:bg-danger-500/10 transition-colors shrink-0"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <NavLink to="/login" className="block text-center text-xs font-semibold text-accent-500 bg-accent-500/10 py-2 rounded-lg hover:bg-accent-500/20 transition-all">
              Sign In
            </NavLink>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header Bar */}
        <header className="h-16 border-b border-ink-700/50 bg-ink-950/60 backdrop-blur-md px-6 flex items-center justify-between shrink-0 z-10">
          <div className="flex items-center gap-2 mono text-xs text-slate-400">
            <Activity size={14} className="text-accent-500" />
            <span className="text-slate-300">Forensic gateway</span>
            <span className="mx-1 text-slate-700">/</span>
            <span className="text-accent-500">online</span>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink-900/60 border border-ink-700/60">
              <span className="mono text-[10px] text-slate-500 uppercase">Firestore</span>
              <span className={`flex items-center gap-1 mono text-[11px] ${firebaseStatus === "ONLINE" ? "text-accent-500" : "text-warn-500"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${firebaseStatus === "ONLINE" ? "bg-accent-500" : "bg-warn-500"}`}></span>
                {firebaseStatus}
              </span>
            </div>

            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink-900/60 border border-ink-700/60">
              <span className="mono text-[10px] text-slate-500 uppercase">Algorand</span>
              <span className={`flex items-center gap-1 mono text-[11px] ${algorandStatus === "ONLINE" ? "text-accent-500" : "text-slate-400"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${algorandStatus === "ONLINE" ? "bg-accent-500" : "bg-slate-500"}`}></span>
                {algorandStatus}
              </span>
            </div>

            <button
              onClick={fetchHealth}
              disabled={isRefreshing}
              className="p-2 rounded-lg bg-ink-900/60 border border-ink-700/60 text-slate-500 hover:text-slate-200 transition-colors"
              title="Refresh Status"
            >
              <RefreshCw size={13} className={isRefreshing ? "animate-spin text-accent-500" : ""} />
            </button>
          </div>
        </header>

        {/* Page Body */}
        <main className="flex-1 overflow-y-auto scrollbar-thin p-6 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: "verified" | "mismatch" | "pending" | "unavailable" }) {
  const map = {
    verified: { label: "Verified", cls: "bg-accent-500/10 text-accent-500 border-accent-500/20 mono" },
    mismatch: { label: "Tampered", cls: "bg-danger-500/10 text-danger-500 border-danger-500/30 mono animate-pulse" },
    pending: { label: "Pending", cls: "bg-warn-500/10 text-warn-500 border-warn-500/20 mono" },
    unavailable: { label: "Unavailable", cls: "bg-ink-800 text-slate-400 border-ink-700 mono" },
  };
  const { label, cls } = map[status] || map.unavailable;
  return <span className={`text-[11px] px-2.5 py-0.5 rounded-full border ${cls}`}>{label}</span>;
}

