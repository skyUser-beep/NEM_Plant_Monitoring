import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, AUTH_TOKEN_KEY, getAuthToken } from "../../services/api.js";

const AuthContext = createContext(null);

function storeToken(token) {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch (error) {
    throw new Error("Could not store the login session in this browser.");
  }
}

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const token = getAuthToken();
    if (!token) {
      setLoading(false);
      return undefined;
    }
    api.get("/auth/me")
      .then((currentUser) => active && setUser(currentUser))
      .catch((error) => {
        if (!active) return;
        if (error.status === 401) storeToken(null);
        setUser(null);
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const expire = () => {
      storeToken(null);
      setUser(null);
      navigate("/login", { replace: true });
    };
    window.addEventListener("nem-auth-expired", expire);
    return () => window.removeEventListener("nem-auth-expired", expire);
  }, [navigate]);

  const refreshUser = useCallback(async () => {
    const currentUser = await api.get("/auth/me");
    setUser(currentUser);
    return currentUser;
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    login: async (username, password) => {
      const response = await api.post("/auth/login", { username, password });
      storeToken(response.access_token);
      setUser(response.user);
      return response.user;
    },
    logout: async () => {
      try {
        await api.post("/auth/logout");
      } finally {
        storeToken(null);
        setUser(null);
        navigate("/login", { replace: true });
      }
    },
    refreshUser,
  }), [loading, navigate, refreshUser, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
