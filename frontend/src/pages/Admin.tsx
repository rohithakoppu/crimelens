import { useEffect, useState } from "react";
import { Users, UserPlus, Loader2 } from "lucide-react";
import { api } from "../lib/api";

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  mfa_enabled: boolean;
}

export default function Admin() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("viewer");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = () => {
    api
      .get<UserRow[]>("/admin/roles")
      .then(({ data }) => setUsers(data))
      .catch(() => setError("Admin role required to view this page."));
  };

  useEffect(load, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await api.post("/auth/register", { name, email, password, role });
      setName(""); setEmail(""); setPassword("");
      load();
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
      setCreateError(message ?? "Could not create user.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto fade-up">
      <div className="mono text-[10px] uppercase tracking-[.2em] text-accent-500 mb-2">Workspace control</div>
      <div className="flex items-center gap-2 mb-6">
        <Users className="text-accent-500" size={20} />
        <h1 className="text-2xl font-bold text-white tracking-tight">Role Management</h1>
      </div>

      {error && <p className="text-sm text-danger-500">{error}</p>}

      {!error && (
        <>
          <form onSubmit={handleCreate} className="glass-panel rounded-2xl p-5 mb-6 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div className="md:col-span-1">
              <label className="text-xs text-slate-400 block mb-1.5">Name</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60" />
            </div>
            <div className="md:col-span-1">
              <label className="text-xs text-slate-400 block mb-1.5">Email</label>
              <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60" />
            </div>
            <div className="md:col-span-1">
              <label className="text-xs text-slate-400 block mb-1.5">Password</label>
              <input required type="password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60" />
            </div>
            <div className="md:col-span-1">
              <label className="text-xs text-slate-400 block mb-1.5">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full bg-ink-900 border border-ink-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500/60">
                <option value="viewer">Viewer</option>
                <option value="investigator">Investigator</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button disabled={creating} className="md:col-span-1 flex items-center justify-center gap-2 bg-accent-500 hover:bg-accent-600 text-ink-950 font-bold text-sm rounded-xl px-4 py-2 transition-colors disabled:opacity-60">
              {creating ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} Create user
            </button>
            {createError && <p className="md:col-span-5 text-xs text-danger-500">{createError}</p>}
          </form>

          <div className="glass-panel rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ink-800 text-slate-400 text-xs">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Name</th>
                  <th className="text-left px-4 py-3 font-medium">Email</th>
                  <th className="text-left px-4 py-3 font-medium">Role</th>
                  <th className="text-left px-4 py-3 font-medium">MFA</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-ink-700">
                    <td className="px-4 py-3 text-slate-200">{u.name}</td>
                    <td className="px-4 py-3 text-slate-400">{u.email}</td>
                    <td className="px-4 py-3 capitalize text-slate-400">{u.role}</td>
                    <td className="px-4 py-3 text-slate-500">{u.mfa_enabled ? "Enabled" : "Disabled"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
