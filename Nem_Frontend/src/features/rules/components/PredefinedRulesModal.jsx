import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../../services/api.js";
import "./PredefinedRulesModal.css";
import {
  ShieldCheck,
  Search,
  X,
  Check,
  Activity,
  AlertTriangle,
  CircleAlert,
} from "lucide-react";

export default function PredefinedRulesModal({ assetId, onClose, onAssigned }) {
  const [rules, setRules] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    let alive = true;
    api.get(`/assets/${assetId}/rules/predefined`)
      .then((items) => {
        if (alive) setRules(Array.isArray(items) ? items : []);
      })
      .catch((err) => alive && setError(err.message || "Could not load predefined rules."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [assetId]);

  const visibleRules = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rules.filter((rule) => {
      const matchesText = !query ||
        `${rule.name || ""} ${rule.description || ""} ${rule.rule_type || ""}`
          .toLowerCase().includes(query);
      const matchesSeverity = severity === "all" ||
        (rule.severity || "warning").toLowerCase() === severity;
      return matchesText && matchesSeverity;
    });
  }, [rules, search, severity]);

  const toggle = (id) => {
    setReviewing(false);
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const assign = async () => {
    if (!selected.size || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.post(`/assets/${assetId}/rules/assign`, {
        rule_ids: [...selected],
      });
      await onAssigned?.(result);
      onClose();
    } catch (err) {
      setError(err.message || "Could not assign the selected monitoring rules.");
    } finally {
      setSaving(false);
    }
  };

  const availableCount = rules.filter((rule) =>
    !rule.assigned && !rule.unavailable_reason
  ).length;

  return (
    <div
      className="prm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section className="prm-dialog" role="dialog" aria-modal="true" aria-labelledby="prm-title">
        <header className="prm-header">
          <h2 id="prm-title" className="prm-title">
            <ShieldCheck size={22} />
            Assign Monitoring Rules
          </h2>
          <button
            type="button"
            className="prm-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={22} />
          </button>
        </header>

        <div className="prm-tools">
          <div className="prm-search">
            <Search size={18} aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search monitoring rules…"
              aria-label="Search monitoring rules"
            />
          </div>
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
            aria-label="Filter by severity"
          >
            <option value="all">All severities</option>
            <option value="warning">Warning</option>
            <option value="alert">Alert</option>
          </select>
          <span>{selected.size} selected</span>
        </div>

        {error && <div className="prm-error" role="alert">{error}</div>}

        <div className="prm-list">
          {loading ? (
            <p className="prm-empty" role="status">Loading rules…</p>
          ) : visibleRules.length === 0 ? (
            <p className="prm-empty">
              {rules.length
                ? "No rules match your search and filters."
                : "No predefined rules are available. Create unassigned rules in Configuration first."}
            </p>
          ) : visibleRules.map((rule) => {
            const unavailable = Boolean(rule.unavailable_reason);
            const disabled = saving || rule.assigned || unavailable;
            return (
              <label
                className={`prm-rule${disabled ? " prm-rule-disabled" : ""}`}
                key={rule.id}
              >
                <input
                  type="checkbox"
                  checked={selected.has(rule.id)}
                  disabled={disabled}
                  onChange={() => toggle(rule.id)}
                />
                <Activity size={19} className="prm-rule-icon" />
                <span className="prm-rule-copy">
                  <strong>{rule.name}</strong>
                  <small>
                    {rule.description || (rule.rule_type || "Monitoring rule").replaceAll("_", " ")}
                    {rule.mapped_variable_name ? ` · ${rule.mapped_variable_name}` : ""}
                  </small>
                  {unavailable && <small className="prm-unavailable">{rule.unavailable_reason}</small>}
                </span>
                <span className={`prm-severity prm-severity-${(rule.severity || "warning").toLowerCase()}`}>
                  {(rule.severity || "warning").toLowerCase() === "critical"
                    ? <CircleAlert size={15} />
                    : <AlertTriangle size={15} />}
                  {rule.assigned
                    ? "Already assigned"
                    : unavailable
                      ? "Unavailable"
                      : rule.severity || "warning"}
                </span>
              </label>
            );
          })}
        </div>

        {reviewing && (
          <div className="prm-confirmation" role="status">
            Assign {selected.size} selected rule(s) to this asset? They will be created inactive and the original predefined rules will remain unchanged.
          </div>
        )}

        <footer className="prm-footer">
          <span className="prm-note">
            {availableCount
              ? "Assigned rules are created inactive; activate them from the asset rules list."
              : "Rules requiring missing variables or unsupported evaluators cannot be assigned."}
          </span>
          {reviewing && (
            <button
              type="button"
              className="btn-outline"
              onClick={() => setReviewing(false)}
              disabled={saving}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="btn-primary prm-assign-btn"
            onClick={() => {
              if (reviewing) assign();
              else setReviewing(true);
            }}
            disabled={saving || loading || selected.size === 0}
          >
            {!saving && <Check size={17} />}
            {saving
              ? "Assigning…"
              : reviewing
                ? `Confirm assignment (${selected.size})`
                : `Review assignment${selected.size ? ` (${selected.size})` : ""}`}
          </button>
        </footer>
      </section>
    </div>
  );
}
