import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../../../services/api.js";
import { captureNavigationOrigin } from "../../../utils/navigation.js";
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

function formatRuleDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

function ruleConditionSummary(rule) {
  const parameters = rule.parameters || {};
  if (rule.rule_type === "runtime_duration") {
    const warningThresholds = parameters.warning_thresholds_seconds || [];
    const alertThreshold = parameters.alert_threshold_seconds;
    if (warningThresholds.length === 2 && alertThreshold != null) {
      return `Running time · warning at ${formatRuleDuration(warningThresholds[0])} / ${formatRuleDuration(warningThresholds[1])}, alert at ${formatRuleDuration(alertThreshold)}`;
    }
  }
  if (rule.rule_type === "boolean_count_threshold") {
    const warningThresholds = parameters.warning_thresholds || [];
    if (warningThresholds.length === 2 && parameters.alert_threshold != null) {
      return `Cycle count · warning at ${warningThresholds[0]} / ${warningThresholds[1]}, alert at ${parameters.alert_threshold}`;
    }
  }
  if (
    rule.rule_type === "runtime_duration" &&
    Array.isArray(parameters.warning_thresholds_seconds) &&
    parameters.warning_thresholds_seconds.length === 2 &&
    parameters.alert_threshold_seconds != null
  ) {
    return `Running time · warnings at ${formatRuleDuration(parameters.warning_thresholds_seconds[0])} / ${formatRuleDuration(parameters.warning_thresholds_seconds[1])} · alert at ${formatRuleDuration(parameters.alert_threshold_seconds)}`;
  }
  if (
    rule.rule_type === "parameter_threshold" &&
    typeof parameters.expected_value === "boolean"
  ) {
    return `Boolean signal ${rule.operator === "!=" || rule.operator === "ne" ? "is not" : "is"} ${parameters.expected_value ? "ON" : "OFF"}`;
  }
  if (rule.rule_type === "duration") {
    if (parameters.condition === "interval_elapsed") {
      return `Every ${formatRuleDuration(parameters.interval_seconds)}`;
    }
    const duration = formatRuleDuration(parameters.duration_seconds);
    if (parameters.condition === "threshold") {
      if ((rule.required_variable_types || []).includes("boolean")) {
        return `Invalid definition: Boolean signals cannot be compared with ${parameters.operator || ""} ${parameters.threshold}; the signal should stay ON for ${duration || "the configured duration"}`;
      }
      return `Value ${parameters.operator || ""} ${parameters.threshold} for ${duration || "configured duration"}`;
    }
    if (typeof parameters.expected_value === "boolean") {
      return `Signal ${parameters.expected_value ? "ON" : "OFF"} continuously for ${duration || "configured duration"}`;
    }
  }
  if (rule.rule_type === "parameter_threshold" && rule.threshold != null) {
    return `Value ${rule.operator || ""} ${rule.threshold}`.trim();
  }
  return rule.description || "Asset-level monitoring rule";
}

export default function PredefinedRulesModal({
  assetId,
  onClose,
  onAssigned,
  navigationState,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [rules, setRules] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [variableMappings, setVariableMappings] = useState({});
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
        variable_mappings: Object.fromEntries(
          [...selected]
            .filter((id) => variableMappings[id])
            .map((id) => [id, Number(variableMappings[id])])
        ),
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
  const mappingsComplete = [...selected].every((id) => {
    const rule = rules.find((item) => item.id === id);
    return !rule?.variable_mapping_required || Boolean(variableMappings[id]);
  });

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
                : (
                  <>
                    No reusable templates are available.
                    {" "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        onClose();
                        navigate("/configuration/rules", {
                          state: {
                            from: captureNavigationOrigin(
                              location,
                              navigationState || location.state
                            ),
                          },
                        });
                      }}
                    >
                      Open the Monitoring Rule Library
                    </button>
                  </>
                )}
            </p>
          ) : visibleRules.map((rule) => {
            const unavailable = Boolean(rule.unavailable_reason);
            const disabled = saving || rule.assigned || unavailable;
            const mappingRequired = rule.variable_mapping_required;
            return (
              <div
                className={`prm-rule${disabled ? " prm-rule-disabled" : ""}`}
                key={rule.id}
              >
                <label className="prm-rule-select">
                  <input
                    type="checkbox"
                    checked={selected.has(rule.id)}
                    disabled={disabled}
                    onChange={() => toggle(rule.id)}
                  />
                </label>
                <Activity size={19} className="prm-rule-icon" />
                <span className="prm-rule-copy">
                  <strong>{rule.name}</strong>
                  <small>
                    {rule.description || (rule.rule_type || "Monitoring rule").replaceAll("_", " ")}
                    {rule.mapped_variable_name ? ` · ${rule.mapped_variable_name}` : ""}
                  </small>
                  <small className="prm-condition-summary">
                    {ruleConditionSummary(rule)}
                  </small>
                  {unavailable && <small className="prm-unavailable">{rule.unavailable_reason}</small>}
                </span>
                {mappingRequired && (
                  <select
                    aria-label={`Variable mapping for ${rule.name}`}
                    value={variableMappings[rule.id] || ""}
                    disabled={disabled}
                    onChange={(event) => {
                      setVariableMappings((current) => ({
                        ...current,
                        [rule.id]: event.target.value,
                      }));
                      setSelected((current) => new Set(current).add(rule.id));
                    }}
                  >
                    <option value="">Choose variable</option>
                    {(rule.compatible_variables || []).map((variable) => (
                      <option value={variable.id} key={variable.id}>
                        {variable.name} · {variable.key} ({variable.data_type})
                      </option>
                    ))}
                  </select>
                )}
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
              </div>
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
            disabled={saving || loading || selected.size === 0 || !mappingsComplete}
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
