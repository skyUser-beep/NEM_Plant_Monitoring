import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  Copy,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../../../services/api.js";
import { CreateModal, EmptyState } from "../../../components/common/UI.jsx";
import "./RuleLibrary.css";

const RULE_TYPES = [
  ["interval_based", "Interval based"],
  ["parameter_threshold", "Parameter threshold"],
];

const COMPARISON_OPTIONS = [
  [">=", "Greater than or equal"],
  [">", "Greater than"],
  ["<=", "Less than or equal"],
  ["<", "Less than"],
  ["==", "Equal"],
  ["!=", "Not equal"],
];

const BOOLEAN_COMPARISON_OPTIONS = [
  ["==", "Is"],
  ["!=", "Is not"],
];

const FIELDS = [
  { key: "name", label: "Rule name", required: true, placeholder: "e.g. High motor temperature" },
  { key: "description", label: "Description", type: "textarea" },
  { key: "rule_type", label: "Rule type", type: "select", required: true, default: "interval_based", options: RULE_TYPES },
  {
    key: "variable_type",
    label: "Variable type",
    type: "select",
    default: "number",
    options: [
      ["number", "Number"],
      ["integer", "Integer"],
      ["boolean", "Boolean"],
    ],
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    hint: "Assigned assets must have an active variable with this data type.",
    onChange: (value, _values, setValues) => {
      setValues((current) => ({
        ...current,
        operator: value === "boolean" ? "==" : ">=",
      }));
    },
  },
  {
    key: "variable_key",
    label: "Preferred variable key (optional)",
    placeholder: "e.g. motor_temperature",
    hint: "Used to suggest a mapping when assigning this rule.",
    showWhen: (values) =>
      values.rule_type === "parameter_threshold" ||
      values.rule_type === "interval_based",
  },
  { key: "runtime_variable_type", label: "Running signal type", type: "select", default: "boolean", options: [["boolean", "Boolean"]], disabled: true, showWhen: { key: "rule_type", equals: "interval_based" }, hint: "Choose the actual running signal for each asset during assignment." },
  { key: "boolean_behavior", label: "Boolean rule behavior", type: "select", default: "running_time", options: [["running_time", "Accumulate running time while ON"], ["cycle_count", "Count OFF-to-ON cycles"], ["state", "Check the current ON/OFF state"]], showWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type === "boolean", hint: "Cycle counting increments once for each OFF-to-ON transition." },
  { key: "runtime_warning_hours", label: "Warning after running (hours)", type: "number", required: true, default: 1, showWhen: (values) => values.rule_type === "interval_based" || (values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "running_time"), hint: "Runtime accumulates only while the selected Boolean signal is ON." },
  { key: "runtime_warning_2_hours", label: "Higher warning (hours)", type: "number", required: true, default: 1.5, showWhen: (values) => values.rule_type === "interval_based" || (values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "running_time") },
  { key: "runtime_alert_hours", label: "Alert after running (hours)", type: "number", required: true, default: 2, showWhen: (values) => values.rule_type === "interval_based" || (values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "running_time") },
  { key: "cycle_warning_threshold_1", label: "Warning at cycle count", type: "number", requiredWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "cycle_count", placeholder: "e.g. 9000", showWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "cycle_count" },
  { key: "cycle_warning_threshold_2", label: "Higher warning at cycle count", type: "number", requiredWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "cycle_count", placeholder: "e.g. 9500", showWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "cycle_count" },
  { key: "cycle_alert_threshold", label: "Alert at cycle count", type: "number", requiredWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "cycle_count", placeholder: "e.g. 10000", showWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "cycle_count" },
  { key: "operator", label: "Condition", type: "select", required: true, default: ">=", options: (values) => values.variable_type === "boolean" ? BOOLEAN_COMPARISON_OPTIONS : COMPARISON_OPTIONS, showWhen: (values) => values.rule_type === "parameter_threshold" && (values.variable_type !== "boolean" || values.boolean_behavior === "state") },
  { key: "threshold", label: "Threshold", type: "number", requiredWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type !== "boolean", showWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type !== "boolean" },
  { key: "expected_boolean", label: "Boolean value", type: "select", requiredWhen: { key: "rule_type", equals: "parameter_threshold" }, options: [["true", "ON"], ["false", "OFF"]], default: "true", showWhen: (values) => values.rule_type === "parameter_threshold" && values.variable_type === "boolean" && values.boolean_behavior === "state" },
  { key: "severity", label: "Severity", type: "select", required: true, default: "warning", options: [["warning", "Warning"], ["alert", "Alert"]] },
  { key: "is_enabled", label: "Rule status", type: "select", required: true, default: "true", options: [["true", "Available"], ["false", "Disabled"]] },
  { key: "evaluation_interval_seconds", label: "Check interval (seconds)", type: "number", showWhen: (values) => values.rule_type === "parameter_threshold" && (values.variable_type !== "boolean" || values.boolean_behavior === "state") },
  { key: "stale_after_seconds", label: "Stale reading timeout (seconds)", type: "number", showWhen: (values) => values.rule_type === "parameter_threshold" && (values.variable_type !== "boolean" || values.boolean_behavior === "state") },
];

const LEGACY_EDIT_FIELDS = [
  { key: "name", label: "Rule name", required: true },
  { key: "description", label: "Description", type: "textarea" },
  { key: "severity", label: "Severity", type: "select", required: true, options: [["warning", "Warning"], ["alert", "Alert"]] },
  { key: "is_enabled", label: "Rule status", type: "select", required: true, options: [["true", "Available"], ["false", "Disabled"]] },
];

function formatInterval(seconds) {
  for (const [unit, divisor] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ]) {
    if (seconds % divisor === 0) {
      const value = seconds / divisor;
      return `${value} ${unit}${value === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function templateSummary(template) {
  const parameters = template.parameters || {};
  if (
    template.rule_type === "parameter_threshold" &&
    template.required_variable_types?.includes("boolean") &&
    parameters.expected_value === true &&
    parameters.evaluation_mode !== "state"
  ) {
    return "Always-ON signal · Edit and set running-time thresholds";
  }
  if (
    template.rule_type === "runtime_duration" &&
    Array.isArray(parameters.warning_thresholds_seconds) &&
    parameters.alert_threshold_seconds != null
  ) {
    return `Running Boolean · warnings at ${formatInterval(parameters.warning_thresholds_seconds[0])} / ${formatInterval(parameters.warning_thresholds_seconds[1])} · alert at ${formatInterval(parameters.alert_threshold_seconds)}`;
  }
  if (
    template.rule_type === "boolean_count_threshold" &&
    Array.isArray(parameters.warning_thresholds) &&
    parameters.warning_thresholds.length === 2 &&
    parameters.alert_threshold != null
  ) {
    return `Cycle count · warnings at ${parameters.warning_thresholds[0]} / ${parameters.warning_thresholds[1]} · alert at ${parameters.alert_threshold}`;
  }
  if (
    template.rule_type === "parameter_threshold" &&
    typeof parameters.expected_value === "boolean" &&
    parameters.evaluation_mode === "state"
  ) {
    return `Boolean signal ${template.operator === "!=" || template.operator === "ne" ? "is not" : "is"} ${parameters.expected_value ? "ON" : "OFF"}`;
  }
  if (template.rule_type === "parameter_threshold" && template.threshold != null) {
    return `Value ${template.operator || ""} ${template.threshold}`.trim();
  }
  if (template.required_variable_types?.length) {
    return `Requires ${template.required_variable_types.join(" / ")} variable${template.variable_key ? ` · prefers ${template.variable_key}` : ""}`;
  }
  if (
    template.rule_type === "duration" &&
    template.parameters?.condition === "interval_elapsed"
  ) {
    return `Every ${formatInterval(parameters.interval_seconds)}`;
  }
  return "Asset-level configuration";
}

const needsRuntimeThresholdConfiguration = (template) =>
  template.rule_type === "parameter_threshold" &&
  template.required_variable_types?.includes("boolean") &&
  template.parameters?.expected_value === true &&
  template.parameters?.evaluation_mode !== "state";

const displayType = (rule) =>
  rule.rule_type === "duration" &&
  rule.parameters?.condition === "interval_elapsed"
    ? "Interval based"
    : rule.rule_type === "runtime_duration"
      ? "Interval based"
    : rule.rule_type === "boolean_count_threshold"
      ? "Parameter threshold"
    : RULE_TYPES.find(([value]) => value === rule.rule_type)?.[1] ||
      rule.rule_type?.replaceAll("_", " ") ||
      "Monitoring rule";

const supportsCurrentRuleEditor = (rule) =>
  rule.rule_type === "parameter_threshold" ||
  rule.rule_type === "runtime_duration" ||
  rule.rule_type === "boolean_count_threshold";

function legacyTemplatePayload(values, template) {
  return {
    name: values.name,
    description: values.description || null,
    rule_type: template.rule_type,
    required_variable_types: template.required_variable_types,
    variable_key: template.variable_key,
    operator: template.operator,
    threshold: template.threshold,
    parameters: template.parameters,
    severity: values.severity,
    is_enabled: values.is_enabled !== "false",
    evaluation_interval_seconds: template.evaluation_interval_seconds,
    stale_after_seconds: template.stale_after_seconds,
  };
}

function initialTemplate(template) {
  if (!template) return {};
  const params = template.parameters || {};
  const required = template.required_variable_types || [];
  const variableType = required.length === 2 && required.includes("number") && required.includes("integer")
    ? "number"
    : required[0] || "number";
  const isInterval =
    template.rule_type === "duration" &&
    params.condition === "interval_elapsed";
  const intervalSeconds = params.interval_seconds;
  const intervalUnits = [
    ["days", 86400],
    ["hours", 3600],
    ["minutes", 60],
    ["seconds", 1],
  ];
  const intervalUnit =
    intervalUnits.find(([, seconds]) =>
      Number.isInteger(intervalSeconds / seconds)
    )?.[0] || "seconds";
  const isRuntime = template.rule_type === "runtime_duration";
  const isCycleCount = template.rule_type === "boolean_count_threshold";
  const isBooleanRunningTemplate =
    template.rule_type === "parameter_threshold" &&
    required.includes("boolean") &&
    params.expected_value === true &&
    params.evaluation_mode !== "state";
  return {
    ...template,
    rule_type: isInterval || isRuntime
      ? "interval_based"
      : isCycleCount
        ? "parameter_threshold"
        : template.rule_type,
    variable_type: variableType,
    boolean_behavior: isCycleCount
      ? "cycle_count"
      : isBooleanRunningTemplate
        ? "running_time"
        : "state",
    runtime_warning_hours: isRuntime
      ? Number(params.warning_thresholds_seconds?.[0] || 0) / 3600
      : isBooleanRunningTemplate
        ? 1
        : "",
    runtime_warning_2_hours: isRuntime
      ? Number(params.warning_thresholds_seconds?.[1] || 0) / 3600
      : isBooleanRunningTemplate
        ? 1.5
        : "",
    runtime_alert_hours: isRuntime
      ? Number(params.alert_threshold_seconds || 0) / 3600
      : isBooleanRunningTemplate
        ? 2
        : "",
    cycle_warning_threshold_1: isCycleCount
      ? params.warning_thresholds?.[0] ?? ""
      : "",
    cycle_warning_threshold_2: isCycleCount
      ? params.warning_thresholds?.[1] ?? ""
      : "",
    cycle_alert_threshold: isCycleCount
      ? params.alert_threshold ?? ""
      : "",
    expected_boolean: String(params.expected_value ?? true),
    threshold: template.threshold ?? "",
    operator: template.operator || (variableType === "boolean" ? "==" : ">="),
    interval_unit: intervalUnit,
    is_enabled: String(template.is_enabled),
  };
}

function templatePayload(values) {
  const isBooleanRunning =
    values.rule_type === "parameter_threshold" &&
    values.variable_type === "boolean" &&
    values.boolean_behavior === "running_time";
  const isBooleanCycleCount =
    values.rule_type === "parameter_threshold" &&
    values.variable_type === "boolean" &&
    values.boolean_behavior === "cycle_count";
  const isInterval = values.rule_type === "interval_based" || isBooleanRunning;
  const type = isBooleanCycleCount
    ? "boolean_count_threshold"
    : isInterval
      ? "runtime_duration"
      : values.rule_type;
  let required_variable_types = null;
  let parameters = null;
  let operator = null;
  let threshold = null;
  let variable_key = null;
  if (isInterval) {
    const warning1 = Number(values.runtime_warning_hours) * 3600;
    const warning2 = Number(values.runtime_warning_2_hours) * 3600;
    const alert = Number(values.runtime_alert_hours) * 3600;
    if (
      ![warning1, warning2, alert].every((value) => Number.isFinite(value) && value > 0) ||
      warning1 >= warning2 ||
      warning2 >= alert
    ) {
      throw new Error("Running-time thresholds must be positive and strictly increasing.");
    }
    required_variable_types = ["boolean"];
    variable_key = values.variable_key || null;
    parameters = {
      warning_thresholds_seconds: [warning1, warning2],
      alert_threshold_seconds: alert,
    };
  } else if (type === "parameter_threshold") {
    required_variable_types = values.variable_type === "boolean"
      ? ["boolean"]
      : values.variable_type === "integer"
        ? ["integer"]
        : ["number", "integer"];
    variable_key = values.variable_key || null;
    operator = values.operator;
    if (values.variable_type === "boolean") {
      parameters = {
        expected_value: values.expected_boolean === "true",
        evaluation_mode: "state",
      };
    } else {
      threshold = values.threshold;
    }
  } else if (type === "boolean_count_threshold") {
    const warning1 = Number(values.cycle_warning_threshold_1);
    const warning2 = Number(values.cycle_warning_threshold_2);
    const alert = Number(values.cycle_alert_threshold);
    if (
      ![warning1, warning2, alert].every(
        (value) => Number.isSafeInteger(value) && value > 0
      ) ||
      warning1 >= warning2 ||
      warning2 >= alert
    ) {
      throw new Error(
        "Cycle thresholds must be positive whole numbers in increasing order."
      );
    }
    required_variable_types = ["boolean"];
    variable_key = values.variable_key || null;
    parameters = {
      warning_thresholds: [warning1, warning2],
      alert_threshold: alert,
    };
  }
  return {
    name: values.name,
    description: values.description || null,
    rule_type: type,
    required_variable_types,
    variable_key,
    operator,
    threshold,
    parameters,
    severity: values.severity,
    is_enabled: values.is_enabled !== "false",
    evaluation_interval_seconds: values.evaluation_interval_seconds || null,
    stale_after_seconds: values.stale_after_seconds || null,
  };
}

function AssignmentModal({ template, onClose, onComplete }) {
  const [assets, setAssets] = useState([]);
  const [variables, setVariables] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [mapping, setMapping] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState(false);
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
    api.getAll("/assets")
      .then((items) => alive && setAssets(items))
      .catch((err) => alive && setError(err.message || "Could not load assets."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const chosen = assets.filter((asset) => selected.has(asset.id));
    Promise.all(chosen.map(async (asset) => {
      const result = await api.get(`/assets/${asset.id}/rules/predefined`);
      const compatibleTemplate = Array.isArray(result)
        ? result.find((item) => Number(item.id) === Number(template.id))
        : null;
      return [asset.id, compatibleTemplate?.compatible_variables || []];
    }))
      .then((entries) => {
        if (!alive) return;
        const next = Object.fromEntries(entries);
        setVariables((current) => ({ ...current, ...next }));
        setMapping((current) => {
          const updated = { ...current };
          for (const [assetId, list] of entries) {
            const matches = list;
            const preferred = matches.filter((variable) =>
              template.variable_key &&
              variable.key.toLowerCase() === template.variable_key.toLowerCase()
            );
            if (!updated[assetId] && preferred.length === 1) updated[assetId] = String(preferred[0].id);
            else if (!updated[assetId] && matches.length === 1) updated[assetId] = String(matches[0].id);
          }
          return updated;
        });
      })
      .catch((err) => alive && setError(err.message || "Could not load asset variables."))
      .finally(() => {});
    return () => { alive = false; };
  }, [assets, selected, template]);

  const toggleAsset = (assetId) => {
    setReview(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  };

  const submit = async () => {
    if (saving || !selected.size) return;
    setSaving(true);
    setError("");
    try {
      const variable_mappings = {};
      for (const assetId of selected) {
        if (template.required_variable_types?.length) {
          if (!mapping[assetId]) throw new Error("Choose a compatible variable for every selected asset.");
          variable_mappings[assetId] = Number(mapping[assetId]);
        }
      }
      const result = await api.post(`/rule-templates/${template.id}/assign`, {
        asset_ids: [...selected],
        variable_mappings,
      });
      await onComplete(result);
      onClose();
    } catch (err) {
      setError(err.message || "Could not assign this rule.");
      setReview(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rule-library-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="rule-library-modal" role="dialog" aria-modal="true" aria-labelledby="template-assign-title">
        <header>
          <div><h2 id="template-assign-title">Assign “{template.name}”</h2><p>Selected rules are added inactive. Existing assignments are left unchanged.</p></div>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={saving}><X size={19} /></button>
        </header>
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="rule-library-asset-list">
          {loading ? <p className="muted">Loading assets…</p> : assets.length === 0 ? <p className="muted">No assets are available.</p> : assets.map((asset) => {
            const chosen = selected.has(asset.id);
            const compatible = variables[asset.id] || [];
            return (
              <div className="rule-library-asset-option" key={asset.id}>
                <label>
                  <input type="checkbox" checked={chosen} onChange={() => toggleAsset(asset.id)} disabled={saving} />
                  <span>{asset.name}</span>
                </label>
                {chosen && template.required_variable_types?.length > 0 && (
                  <select
                    aria-label={`Variable for ${asset.name}`}
                    value={mapping[asset.id] || ""}
                    onChange={(event) => setMapping((current) => ({ ...current, [asset.id]: event.target.value }))}
                    disabled={saving}
                  >
                    <option value="">Choose compatible variable</option>
                    {compatible.map((variable) => <option key={variable.id} value={variable.id}>{variable.name} · {variable.key} ({variable.data_type})</option>)}
                  </select>
                )}
                {chosen && template.required_variable_types?.length > 0 && compatible.length === 0 && <small className="rule-library-error">No compatible active variable on this asset.</small>}
              </div>
            );
          })}
        </div>
        {review && <p className="rule-library-review" role="status">Assign this rule to {selected.size} selected asset(s)? Each new asset rule will be created inactive.</p>}
        <footer>
          <button className="btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          {review && <button className="btn-outline" onClick={() => setReview(false)} disabled={saving}>Back</button>}
          <button className="btn-primary" onClick={() => review ? submit() : setReview(true)} disabled={saving || loading || selected.size === 0}>
            {saving ? "Assigning…" : review ? "Confirm assignment" : "Review assignment"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function RuleLibrary() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState({ text: "", error: false });
  const load = async () => {
    const result = await api.get("/rule-templates");
    setTemplates(Array.isArray(result) ? result : []);
  };

  useEffect(() => {
    let alive = true;
    api.get("/rule-templates")
      .then((items) => alive && setTemplates(Array.isArray(items) ? items : []))
      .catch((error) => alive && setMessage({ text: error.message || "Could not load the monitoring rule library.", error: true }))
      .finally(() => {});
    return () => { alive = false; };
  }, []);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (templates || []).filter((template) => {
      const matchesText = !query || `${template.name} ${template.description || ""} ${template.rule_type}`.toLowerCase().includes(query);
      const matchesStatus = status === "all" || String(template.is_enabled) === status;
      return matchesText && matchesStatus;
    });
  }, [templates, search, status]);

  const save = async (values) => {
    const payload =
      editing && !supportsCurrentRuleEditor(editing)
        ? legacyTemplatePayload(values, editing)
        : templatePayload(values);
    if (editing) await api.put(`/rule-templates/${editing.id}`, payload);
    else await api.post("/rule-templates", payload);
    setModalOpen(false);
    setEditing(null);
    setMessage({ text: `Rule ${editing ? "updated" : "created"} successfully.`, error: false });
    await load();
  };

  const remove = async (template) => {
    if (!window.confirm(`Delete the reusable rule “${template.name}”? Assigned asset rules will not be changed.`)) return;
    setBusyId(template.id);
    setMessage({ text: "", error: false });
    try {
      await api.del(`/rule-templates/${template.id}`);
      setMessage({ text: "Rule deleted.", error: false });
      await load();
    } catch (error) {
      setMessage({ text: error.message || "Could not delete this rule.", error: true });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="rule-library-page">
      <button className="link-btn" onClick={() => navigate("/configuration")}>‹ Back to Configuration</button>
      <div className="rule-library-heading">
        <div>
          <h1 className="page-title">Monitoring Rule Library</h1>
          <p className="muted">Create reusable monitoring rules, then assign them to assets. Assigned rules start inactive.</p>
        </div>
        <button className="btn-primary" onClick={() => { setEditing(null); setModalOpen(true); }}><Plus size={17} /> New rule</button>
      </div>

      {message.text && <p className={"notice" + (message.error ? " error" : "")} role={message.error ? "alert" : "status"}>{message.text}</p>}

      <section className="rule-library-panel">
        <div className="rule-library-tools">
          <label className="rule-library-search"><Search size={17} /><input aria-label="Search rules" placeholder="Search rules…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <select aria-label="Filter rule availability" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All rules</option>
            <option value="true">Available</option>
            <option value="false">Disabled</option>
          </select>
        </div>
        {templates === null ? <div className="loading" role="status">Loading rules…</div> : visible.length === 0 ? (
          <EmptyState art={false} title={templates.length === 0 ? "The rule library is empty" : "No rules match"} lines={[templates.length === 0 ? "Create a reusable rule here. Asset-specific rules do not appear in this library." : "Try a different search or availability filter."]} />
        ) : (
          <div className="rule-library-list">
            {visible.map((template) => (
              <article className="rule-library-card" key={template.id}>
                <div className="rule-library-card-icon"><Activity size={19} /></div>
                <div className="rule-library-card-main">
                  <div className="rule-library-card-title"><h2>{template.name}</h2><span className={`rule-library-status ${template.is_enabled ? "available" : "disabled"}`}>{template.is_enabled ? "Available" : "Disabled"}</span></div>
                  <p>{template.description || "No description provided."}</p>
                  <small>{displayType(template)} · {templateSummary(template)}</small>
                </div>
                <div className="rule-library-actions">
                  <button className="btn-outline" onClick={() => setAssigning(template)} disabled={!template.is_enabled || needsRuntimeThresholdConfiguration(template)} title={needsRuntimeThresholdConfiguration(template) ? "Edit this rule and configure running-time thresholds before assigning it." : undefined}><Copy size={15} /> Assign rule</button>
                  <button className="btn-outline" onClick={() => { setEditing(template); setModalOpen(true); }}><Pencil size={15} /> Edit</button>
                  <button className="btn-outline danger" onClick={() => remove(template)} disabled={busyId === template.id}>{busyId === template.id ? "Deleting…" : <><Trash2 size={15} /> Delete</>}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {modalOpen && <CreateModal
        title={editing ? "Edit rule" : "Create reusable rule"}
        intro={
          editing && !supportsCurrentRuleEditor(editing)
            ? `${displayType(editing)} is a legacy rule type. Its evaluation settings will be preserved while you edit its name, description, severity, and availability.`
            : "Create a reusable rule, then assign it to one or more assets."
        }
        fields={
          editing && !supportsCurrentRuleEditor(editing)
            ? LEGACY_EDIT_FIELDS
            : FIELDS
        }
        initialValues={initialTemplate(editing)}
        submitLabel={editing ? "Save rule" : "Create rule"}
        onSubmit={save}
        onClose={() => { setModalOpen(false); setEditing(null); }}
      />}
      {assigning && <AssignmentModal
        template={assigning}
        onClose={() => setAssigning(null)}
        onComplete={async (result) => {
          const made = result.created?.length || 0;
          const duplicates = result.already_assigned?.length || 0;
          setMessage({ text: `Assigned to ${made} asset(s); ${duplicates} already had the same rule.`, error: false });
        }}
      />}
    </main>
  );
}
