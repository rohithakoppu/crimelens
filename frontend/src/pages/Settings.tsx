import { useEffect, useState } from "react";
import { Settings as SettingsIcon, CheckCircle2, XCircle, User } from "lucide-react";
import { api, type HealthStatus } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Settings() {
  const { user } = useAuth();
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    api.get<HealthStatus>("/health").then(({ data }) => setHealth(data));
  }, []);

  return (
    <div className="p-8 max-w-3xl mx-auto fade-up">
      <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500 mb-2">Workspace control</div>
      <div className="flex items-center gap-2 mb-8">
        <SettingsIcon className="text-accent-500" size={20} />
        <h1 className="text-2xl font-bold text-white tracking-tight">Settings</h1>
      </div>

      <section className="glass-panel rounded-2xl p-5 mb-6">
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-4">Profile</p>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-accent-500/10 border border-accent-500/30 flex items-center justify-center">
            <User size={16} className="text-accent-500" />
          </div>
          <div>
            <div className="text-sm text-slate-200">{user?.name}</div>
            <div className="text-xs text-slate-500 capitalize">{user?.role}</div>
          </div>
        </div>
      </section>

      <section className="glass-panel rounded-2xl p-5">
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-4">System Status</p>
        <div className="space-y-3">
          <StatusRow label="Firebase (Firestore + Auth)" ok={health?.services.firebase.status === "ONLINE"} detail={health?.services.firebase.error ?? undefined} />
          <StatusRow label="Algorand Testnet node" ok={health?.services.algorand.status === "ONLINE"} detail={health?.services.algorand.error ?? undefined} />
          <StatusRow
            label="Algorand anchor account funded"
            ok={(health?.services.algorand.balance_microalgos ?? 0) > 0}
            detail={(health?.services.algorand.balance_microalgos ?? 0) > 0 ? undefined : "0 ALGO -- fund via the Testnet dispenser to enable real anchoring"}
          />
        </div>
        <p className="text-[11px] text-slate-600 mt-4">
          No private keys or service-account credentials are ever exposed to the frontend.
        </p>
      </section>
    </div>
  );
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-sm text-slate-300">{label}</div>
        {detail && <div className="text-xs text-slate-500 mt-0.5">{detail}</div>}
      </div>
      {ok ? <CheckCircle2 size={16} className="text-accent-500 shrink-0" /> : <XCircle size={16} className="text-warn-500 shrink-0" />}
    </div>
  );
}
