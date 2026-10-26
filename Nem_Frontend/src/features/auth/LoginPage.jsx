import React, { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (loading) return <main className="auth-page"><p role="status">Checking session…</p></main>;
  if (user) return <Navigate to="/" replace />;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
      const destination = location.state?.from;
      navigate(destination ? `${destination.pathname}${destination.search || ""}` : "/", { replace: true });
    } catch (loginError) {
      setError(loginError.message || "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <h1 className="page-title">Sign in to NEM Plant Monitor</h1>
        <p className="muted">Use your local NEM account to continue.</p>
        <form onSubmit={submit}>
          <label className="field">
            Username
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              maxLength={120}
              disabled={busy}
            />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={1024}
              disabled={busy}
            />
          </label>
          {error && <p className="notice error" role="alert">{error}</p>}
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
