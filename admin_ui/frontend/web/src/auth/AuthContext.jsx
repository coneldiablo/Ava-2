import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, clearStoredToken, getStoredToken, storeToken } from "@/lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      const token = getStoredToken();
      if (!token) {
        if (mounted) {
          setLoading(false);
        }
        return;
      }

      try {
        const response = await api.get("/api/auth/me");
        if (mounted) {
          setUser(response.data);
        }
      } catch {
        clearStoredToken();
        if (mounted) {
          setUser(null);
          setMustChangePassword(false);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    hydrate();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const interceptor = api.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error?.response?.status === 401) {
          clearStoredToken();
          setUser(null);
          setMustChangePassword(false);
        }
        return Promise.reject(error);
      },
    );

    return () => {
      api.interceptors.response.eject(interceptor);
    };
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      mustChangePassword,
      async login(username, password) {
        const formData = new FormData();
        formData.append("username", username);
        formData.append("password", password);

        const response = await api.post("/api/auth/login", formData);
        const token = response.data?.access_token;
        if (token) {
          storeToken(token);
        }
        setMustChangePassword(Boolean(response.data?.must_change_password));
        const me = await api.get("/api/auth/me");
        setUser(me.data);
      },
      logout() {
        clearStoredToken();
        setUser(null);
        setMustChangePassword(false);
      },
      async changePassword(oldPassword, newPassword) {
        await api.post("/api/auth/change-password", {
          old_password: oldPassword,
          new_password: newPassword,
        });
        setMustChangePassword(false);
      },
    }),
    [loading, mustChangePassword, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
