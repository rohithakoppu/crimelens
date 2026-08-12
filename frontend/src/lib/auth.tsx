import { createContext, useContext, useState, type ReactNode } from "react";
import { type AuthUser, clearAuth, loadAuth, saveAuth } from "./api";

interface AuthContextValue {
  user: AuthUser | null;
  login: (user: AuthUser) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(loadAuth());

  const login = (u: AuthUser) => {
    saveAuth(u);
    setUser(u);
  };

  const logout = () => {
    clearAuth();
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
