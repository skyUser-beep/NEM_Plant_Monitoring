
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../../services/api.js";
import {
  buildAssetMonitoringRule,
  monitoringRuleFormSelection,
} from "../rules/monitoringRuleFlow.js";
import "./CreateMonitoringRulePage.css";

const RULE_FIELDS = [
  {
    key: "name",
    label: "Rule name",
    required: true,
    placeholder: "e.g. Motor temperature limit",
  },
  {
    key: "description",
    label: "Description",
    type: "textarea",
    placeholder: "What should this rule watch?",
  },
  {
    key: "rule_type",
    label: "Rule type",
    type: "select",
    options: [
      ["parameter_threshold", "Numeric value threshold (e.g. temperature)"],
      ["boolean_count_threshold", "Cycle Clock (Boolean ON/OFF count)"],
      ["runtime_duration", "Motor Running Time"],
    ],
  },
  {
    key: "variable_id",
    label: "Numeric variable",
    type: "select",
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    options: [],
  },
  {
    key: "cycle_variable_id",
    label: "Configured Boolean cycle signal",
    type: "select",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    options: [],
  },
  {
    key: "runtime_variable_id",
    label: "OPC UA Boolean running signal",
    type: "select",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    options: [],
  },
  {
    key: "operator",
    label: "Trigger when value is",
    type: "select",
    default: ">=",
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    options: [
      [">=", "Greater than or equal to"],
      [">", "Greater than"],
      ["<=", "Less than or equal to"],
      ["<", "Less than"],
      ["==", "Equal to"],
      ["!=", "Not equal to"],
    ],
  },
  {
    key: "threshold",
    label: "Threshold",
    type: "number",
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    placeholder: "e.g. 900",
  },
  {
    key: "warning_threshold_1",
    label: "Warning at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 9000",
  },
  {
    key: "warning_threshold_2",
    label: "Higher warning at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 9500",
  },
  {
    key: "alert_threshold",
    label: "Alert at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 10000",
  },
  {
    key: "runtime_warning_hours",
    label: "Warning threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 8",
  },
  {
    key: "runtime_warning_2_hours",
    label: "Higher warning threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 9",
  },
  {
    key: "runtime_alert_hours",
    label: "Alert threshold (hours)",
    type: "number",
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    requiredWhen: { key: "rule_type", equals: "runtime_duration" },
    placeholder: "e.g. 10",
  },
  {
    key: "severity",
    label: "Severity",
    type: "select",
    default: "warning",
    options: [
      ["warning", "Warning"],
      ["alert", "Alert"],
    ],
  },
];

export default function CreateMonitoringRulePage() {
  const { id, choiceId } = useParams();
  const assetId = Number(id);
  const navigate = useNavigate();

  const selection = useMemo(() => {
    try {
      return monitoringRuleFormSelection(choiceId);
    } catch {
      return null;
    }
  }, [choiceId]);

  const [assetName, setAssetName] = useState("");
  const [variables, setVariables] = useState([]);
  const [cycleVariableIds, setCycleVariableIds] = useState([]);
  const [runtimeVariableIds, setRuntimeVariableIds] = useState([]);
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selection || !Number.isSafeInteger(assetId) || assetId <= 0) {
      setLoading(false);
      setError("Invalid monitoring rule selection or asset.");
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const [assetResult, variableResult, plcResult] = await Promise.all([
          api.get(`/assets/${assetId}`),
          api.getAll(`/assets/${assetId}/variables?is_active=true`),
          api.get("/plc/status"),
        ]);

        if (cancelled) return;

        const activeVariables = Array.isArray(variableResult)
          ? variableResult
          : [];

        const mappings = Array.isArray(plcResult?.mappings)
          ? plcResult.mappings
          : [];

        const booleanMappings = mappings.filter(
          (mapping) =>
            Number(mapping.asset_id) === assetId &&
            mapping.mapping_valid &&
            mapping.data_type === "boolean"
        );
        const cycleMappings = booleanMappings.filter(
          (mapping) => mapping.role === "cycle_signal"
        );
        const runningMappings = booleanMappings.filter(
          (mapping) => mapping.role === "running_signal"
        );

        setAssetName(assetResult?.name || `Asset ${assetId}`);
        setVariables(activeVariables);
        setCycleVariableIds(cycleMappings.map((mapping) => Number(mapping.variable_id)));
        setRuntimeVariableIds(
          runningMappings.map((mapping) => Number(mapping.variable_id))
        );

        setValues({
          ...selection.initialValues,
          ...(selection.ruleType === "boolean_count_threshold"
            ? { cycle_variable_id: "" }
            : {}),
          ...(selection.ruleType === "runtime_duration"
            ? { runtime_variable_id: "" }
            : {}),
          severity: "warning",
        });
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Unable to load asset monitoring details.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [assetId, selection]);

  const fields = useMemo(() => {
    const numericVariables = variables
      .filter((v) => v.data_type === "number" || v.data_type === "integer")
      .map((v) => [v.id, `${v.name}${v.unit ? ` (${v.unit})` : ""}`]);

    const cycleVariables = variables
      .filter((v) => cycleVariableIds.includes(Number(v.id)))
      .map((v) => [v.id, `${v.name} (#${v.id})`]);

    const runningVariables = variables
      .filter(
        (v) =>
          v.data_type === "boolean" &&
          runtimeVariableIds.includes(Number(v.id))
      )
      .map((v) => [v.id, v.name]);

    return RULE_FIELDS.map((field) => {
      if (field.key === "rule_type") {
        return {
          ...field,
          default: selection?.ruleType,
          disabled: true,
          options: field.options.filter(([type]) => type === selection?.ruleType),
        };
      }

      if (field.key === "variable_id") {
        return { ...field, options: numericVariables };
      }

      if (field.key === "cycle_variable_id") {
        return {
          ...field,
          options: cycleVariables,
          hint: cycleVariables.length
            ? field.hint
            : "Set a Boolean variable's purpose to Cycle signal in the asset's Variables panel.",
        };
      }

      if (field.key === "runtime_variable_id") {
        return {
          ...field,
          options: runningVariables,
          hint: runningVariables.length
            ? field.hint
            : "Set a Boolean variable's purpose to Machine running state in the asset's Variables panel.",
        };
      }

      return field;
    });
  }, [variables, cycleVariableIds, runtimeVariableIds, selection]);

  const visibleFields = fields.filter((field) => {
    if (!field.showWhen) return true;
    return values[field.showWhen.key] === field.showWhen.equals;
  });

  const updateValue = useCallback((key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (saving || !selection) return;

    setSaving(true);
    setError("");

    try {
      const rule = buildAssetMonitoringRule(
        { ...values, rule_type: selection.ruleType },
        assetId,
        { variables, cycleVariableIds, runtimeVariableIds }
      );

      await api.post(`/assets/${assetId}/rules`, rule);

      navigate(`/assets/${assetId}`, {
        state: { createdNotice: `Rule "${rule.name}" created successfully.` },
      });
    } catch (err) {
      setError(err.message || "Unable to create monitoring rule.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="loading">Loading monitoring rule form…</div>;
  }

  if (!selection) {
    return (
      <main className="monitoring-rule-page">
        <p role="alert">{error || "Invalid monitoring rule selection."}</p>
        <button type="button" className="btn-outline" onClick={() => navigate(`/assets/${id}`)}>
          Back to Maintenance log 
        </button>
      </main>
    );
  }

  return (
    <main className="monitoring-rule-page">
      <header className="monitoring-rule-header">
        <div>
          <button
            type="button"
            className="link-btn"
            onClick={() => navigate(`/assets/${assetId}`)}
          >
            ← Back to {assetName}
          </button>
          <span className="monitoring-rule-kicker">MONITORING RULE</span>
          <h1>{selection.title}</h1>
          <p className="monitoring-rule-asset">
            <span>Asset</span>
            <strong>{assetName}</strong>
          </p>
        </div>
      </header>

      {error && (
        <div className="banner error" role="alert">
          <p>{error}</p>
        </div>
      )}

      {variables.length === 0 && (
        <div className="banner" role="status">
          This asset has no active variables yet. Add one under Variables,
          then return to create a rule.
        </div>
      )}

      <form className="monitoring-rule-card" onSubmit={submit}>
        <div className="monitoring-rule-card-header">
          <span>RULE CONFIGURATION</span>
          <h2>Set up your monitoring rule</h2>
          <p>Choose the signal and thresholds this rule should monitor.</p>
        </div>
        <div className="monitoring-rule-fields">
          {visibleFields.map((field) => {
            const required =
              field.required ||
              (field.requiredWhen &&
                values[field.requiredWhen.key] === field.requiredWhen.equals);

            return (
              <label className="monitoring-rule-field" key={field.key}>
                <span>
                  {field.label}
                  {required ? " *" : ""}
                </span>

                {field.type === "textarea" ? (
                  <textarea
                    value={values[field.key] ?? ""}
                    required={required}
                    placeholder={field.placeholder || ""}
                    onChange={(event) => updateValue(field.key, event.target.value)}
                    rows={4}
                  />
                ) : field.type === "select" ? (
                  <select
                    value={values[field.key] ?? field.default ?? ""}
                    required={required}
                    disabled={field.disabled}
                    onChange={(event) => updateValue(field.key, event.target.value)}
                  >
                    <option value="">Select {field.label.toLowerCase()}</option>
                    {(field.options || []).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type === "number" ? "number" : "text"}
                    value={values[field.key] ?? ""}
                    required={required}
                    placeholder={field.placeholder || ""}
                    onChange={(event) => updateValue(field.key, event.target.value)}
                  />
                )}

                {field.key === "cycle_variable_id" && cycleVariableIds.length === 0 && (
                  <small>
                    No Boolean OPC UA variable is available for this asset.
                    Add one with an OPC UA NodeId in the asset's Variables
                    dialog (or configure OPCUA_MACHINE_MAPPINGS).
                  </small>
                )}

                {field.key === "runtime_variable_id" && runtimeVariableIds.length === 0 && (
                  <small>
                    No Boolean OPC UA variable is available for this asset.
                    Add one with an OPC UA NodeId in the asset's Variables dialog.
                  </small>
                )}
              </label>
            );
          })}
        </div>

        <footer className="monitoring-rule-actions">
          <button
            type="button"
            className="btn-outline"
            disabled={saving}
            onClick={() => navigate(`/assets/${assetId}`)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={saving || variables.length === 0}
          >
            {saving ? "Creating…" : "Create rule"}
          </button>
        </footer>
      </form>
    </main>
  );
}
