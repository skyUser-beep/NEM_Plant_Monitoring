import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  useNavigate,
  useParams,
  useLocation,
} from "react-router-dom";

import { api } from "../../../services/api.js";
import {
  rememberNavigationOrigin,
  returnToNavigationOrigin,
} from "../../../utils/navigation.js";
import { useAuth } from "../../auth/AuthContext.jsx";
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
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
    options: [],
  },
  {
    key: "cycle_variable_id",
    label: "Configured Boolean cycle signal",
    type: "select",
    showWhen: {
      key: "rule_type",
      equals: "boolean_count_threshold",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "boolean_count_threshold",
    },
    options: [],
  },
  {
    key: "runtime_variable_id",
    label: "OPC UA Boolean running signal",
    type: "select",
    showWhen: {
      key: "rule_type",
      equals: "runtime_duration",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "runtime_duration",
    },
    options: [],
  },
  {
    key: "operator",
    label: "Trigger when value is",
    type: "select",
    default: ">=",
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
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
    showWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "parameter_threshold",
    },
    placeholder: "e.g. 900",
  },
  {
    key: "warning_threshold_1",
    label: "Warning at cycle count",
    type: "number",
    showWhen: {
      key: "rule_type",
      equals: "boolean_count_threshold",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "boolean_count_threshold",
    },
    placeholder: "e.g. 9000",
  },
  {
    key: "warning_threshold_2",
    label: "Higher warning at cycle count",
    type: "number",
    showWhen: {
      key: "rule_type",
      equals: "boolean_count_threshold",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "boolean_count_threshold",
    },
    placeholder: "e.g. 9500",
  },
  {
    key: "alert_threshold",
    label: "Alert at cycle count",
    type: "number",
    showWhen: {
      key: "rule_type",
      equals: "boolean_count_threshold",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "boolean_count_threshold",
    },
    placeholder: "e.g. 10000",
  },
  {
    key: "runtime_warning_hours",
    label: "Warning threshold (hours)",
    type: "number",
    showWhen: {
      key: "rule_type",
      equals: "runtime_duration",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "runtime_duration",
    },
    placeholder: "e.g. 8",
  },
  {
    key: "runtime_warning_2_hours",
    label: "Higher warning threshold (hours)",
    type: "number",
    showWhen: {
      key: "rule_type",
      equals: "runtime_duration",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "runtime_duration",
    },
    placeholder: "e.g. 9",
  },
  {
    key: "runtime_alert_hours",
    label: "Alert threshold (hours)",
    type: "number",
    showWhen: {
      key: "rule_type",
      equals: "runtime_duration",
    },
    requiredWhen: {
      key: "rule_type",
      equals: "runtime_duration",
    },
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
  const { user } = useAuth();
  const { id, choiceId, ruleId } = useParams();
  const assetId = Number(id);

  const navigate = useNavigate();
  const location = useLocation();
  const returnFallback = {
    pathname: `/assets/${id}`,
    state: { activeTab: "status" },
  };
  const returnToAsset = (notice = null) =>
    returnToNavigationOrigin(
      navigate,
      location.state?.from,
      returnFallback,
      { notice: notice ? { text: notice } : null }
    );

  useEffect(() => {
    rememberNavigationOrigin(location.state?.from);
  }, [location.state?.from]);

  const editingRule = location.state?.editingRule ?? null;

  const isEdit = Boolean(ruleId || editingRule?.id);
  const activeRuleId = ruleId || editingRule?.id;

  const isRestrictedRole = ["Supervisor", "Operator"].includes(user?.role);


  const canManageRules = ["Administrator", "Supervisor"].includes(user?.role);

  const canSubmitRule =
  canManageRules ||
  (isEdit && isRestrictedRole);

  const isFieldDisabled = (field) => {
    if (isRestrictedRole && isEdit) {
      return field.key !== "threshold";
    }
    if (!canManageRules) return true;
    return Boolean(field.disabled);
  };


  const selection = useMemo(() => {
    try {
      const existingRuleType =
      location.state?.editingRule?.rule_type;
      const selectedChoiceId = isEdit
      ? (
        existingRuleType === "boolean_count_threshold"
        ? "motor_rotation"
        : existingRuleType === "runtime_duration"
        ? "running_time"
        : existingRuleType
      )
      : choiceId;
      return monitoringRuleFormSelection(selectedChoiceId);
    } catch {
      return null;
    }
  }, [choiceId, isEdit, location.state]);

  const [assetName, setAssetName] = useState("");
  const [variables, setVariables] = useState([]);
  const [cycleVariableIds, setCycleVariableIds] = useState([]);
  const [runtimeVariableIds, setRuntimeVariableIds] = useState([]);
  const [values, setValues] = useState({});

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (
      !selection ||
      !Number.isSafeInteger(assetId) ||
      assetId <= 0
    ) {
      setLoading(false);
      setError(
        "Invalid monitoring rule selection or asset."
      );
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const [assetResult, variableResult, plcResult] =
          await Promise.all([
            api.get(`/assets/${assetId}`),
            api.getAll(
              `/assets/${assetId}/variables?is_active=true`
            ),
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

        setAssetName(
          assetResult?.name || `Asset ${assetId}`
        );

        setVariables(activeVariables);

        setCycleVariableIds(
          cycleMappings.map((mapping) =>
            Number(mapping.variable_id)
          )
        );

        setRuntimeVariableIds(
          runningMappings.map((mapping) =>
            Number(mapping.variable_id)
          )
        );

        // Prefill form fields when editing an existing rule.
        const existing = editingRule;

        setValues({
          ...selection.initialValues,
          ...(existing || {}),

          rule_type:
            existing?.rule_type ?? selection.ruleType,

          name:
            existing?.name ??
            selection.initialValues.name ??
            "",

          description: existing?.description ?? "",

          variable_id:
            existing?.variable_id != null
              ? String(existing.variable_id)
              : "",

          cycle_variable_id:
            existing?.variable_id != null
              ? String(existing.variable_id)
              : "",

          runtime_variable_id:
            existing?.variable_id != null
              ? String(existing.variable_id)
              : "",

          operator: existing?.operator ?? ">=",

          threshold:
            existing?.threshold != null
              ? String(existing.threshold)
              : "",

          severity: existing?.severity ?? "warning",

          warning_threshold_1:
            existing?.parameters?.warning_threshold_1 ?? "",

          warning_threshold_2:
            existing?.parameters?.warning_threshold_2 ?? "",

          alert_threshold:
            existing?.parameters?.alert_threshold ?? "",

          runtime_warning_hours:
            existing?.parameters?.runtime_warning_hours ?? "",

          runtime_warning_2_hours:
            existing?.parameters?.runtime_warning_2_hours ?? "",

          runtime_alert_hours:
            existing?.parameters?.runtime_alert_hours ?? "",
        });
      } catch (err) {
        if (!cancelled) {
          setError(
            err.message ||
              "Unable to load asset monitoring details."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [assetId, selection, editingRule]);

  const fields = useMemo(() => {
    const numericVariables = variables
      .filter(
        (variable) =>
          variable.data_type === "number" ||
          variable.data_type === "integer"
      )
      .map((variable) => [
        variable.id,
        `${variable.name}${
          variable.unit ? ` (${variable.unit})` : ""
        }`,
      ]);

    const cycleVariables = variables
      .filter((variable) =>
        cycleVariableIds.includes(Number(variable.id))
      )
      .map((variable) => [
        variable.id,
        `${variable.name} (#${variable.id})`,
      ]);

    const runningVariables = variables
      .filter(
        (variable) =>
          variable.data_type === "boolean" &&
          runtimeVariableIds.includes(Number(variable.id))
      )
      .map((variable) => [
        variable.id,
        variable.name,
      ]);

    return RULE_FIELDS.map((field) => {
      if (field.key === "rule_type") {
        return {
          ...field,
          default: selection?.ruleType,
          disabled: true,
          options: field.options.filter(
            ([type]) => type === selection?.ruleType
          ),
        };
      }

      if (field.key === "variable_id") {
        return {
          ...field,
          options: numericVariables,
        };
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
  }, [
    variables,
    cycleVariableIds,
    runtimeVariableIds,
    selection,
  ]);

  const visibleFields = fields.filter((field) => {
    if (!field.showWhen) return true;

    return (
      values[field.showWhen.key] === field.showWhen.equals
    );
  });

  const updateValue = useCallback((key, value) => {
    setValues((current) => ({
      ...current,
      [key]: value,
    }));
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (!canSubmitRule) return;

    if (saving || !selection) return;

    setSaving(true);
    setError("");

    try {
      const rule = buildAssetMonitoringRule(
        {
          ...values,
          rule_type: selection.ruleType,
        },
        assetId,
        {
          variables,
          cycleVariableIds,
          runtimeVariableIds,
        }
      );

      // Edit existing rule or create a new rule.
      if (isEdit) {
        if (!activeRuleId) {
          throw new Error(
            "Unable to identify the rule to update."
          );
        }
        const updatedRule = {
          ...editingRule,
          ...rule,
          name: editingRule.name,
          description: editingRule.description,
          severity: editingRule.severity,
          rule_type: editingRule.rule_type,
          variable_id: editingRule.variable_id,
        };
        await api.patch(
          `/rules/${activeRuleId}`,
          updatedRule
        );
      } else {
        await api.post(
          `/assets/${assetId}/rules`,
          rule
        );
      }

      returnToAsset(
        isEdit
          ? `Rule "${rule.name}" updated successfully.`
          : `Rule "${rule.name}" created successfully.`
      );
    } catch (err) {
      setError(
        err.message ||
          `Unable to ${isEdit ? "update" : "create"} monitoring rule.`
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="loading">
        Loading monitoring rule form…
      </div>
    );
  }

  if (!selection) {
    return (
      <main className="monitoring-rule-page">
        <p role="alert">
          {error || "Invalid monitoring rule selection."}
        </p>

        <button
          type="button"
          className="btn-outline"
          onClick={() => returnToAsset()}
        >
          ← Back to asset
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
            onClick={() => returnToAsset()}
          >
            ← Back to {assetName}
          </button>

          <span className="monitoring-rule-kicker">
            {isEdit ? "EDIT MONITORING RULE" : "MONITORING RULE"}
          </span>

          <h1>
            {isEdit
              ? "Edit monitoring rule"
              : selection.title}
          </h1>

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
      {!canManageRules && (
        <div className="banner" role="status">
          You do not have permission to create or edit monitoring rules.
        </div>
      )}

      {variables.length === 0 && (
        <div className="banner" role="status">
          This asset has no active variables yet. Add one under
          Variables, then return to create a rule.
        </div>
      )}

      <form
        className="monitoring-rule-card"
        onSubmit={submit}
      >
        <div className="monitoring-rule-card-header">
          <span>RULE CONFIGURATION</span>

          <h2>
            {isEdit
              ? "Update your monitoring rule"
              : "Set up your monitoring rule"}
          </h2>

          <p>
            Choose the signal and thresholds this rule should
            monitor.
          </p>
        </div>

        <div className="monitoring-rule-fields">
          {visibleFields.map((field) => {
            const required =
              field.required ||
              (field.requiredWhen &&
                values[field.requiredWhen.key] ===
                  field.requiredWhen.equals);

            return (
              <label
                className="monitoring-rule-field"
                key={field.key}
              >
                <span>
                  {field.label}
                  {required ? " *" : ""}
                </span>
                {field.type === "textarea" ? (
                  <textarea
                  value={values[field.key] ?? ""}
                  required={required}
                  placeholder={field.placeholder || ""}
                  onChange={(event) =>
                  updateValue(field.key, event.target.value)
                }
                rows={4}
                disabled={isFieldDisabled(field)}
                title={
                  isFieldDisabled(field)
                  ? "Only Threshold can be edited in Edit Rule mode."
                  : undefined
                }
                />
              ) : field.type === "select" ? (
              <select
              value={values[field.key] ?? field.default ?? ""}
              required={required}
              disabled={isFieldDisabled(field)}
              title={
                isFieldDisabled(field)
                ? "Only Threshold can be edited in Edit Rule mode."
                : undefined
              }
              onChange={(event) =>
                updateValue(field.key, event.target.value)
              }
              >
                <option value="">
                  Select {field.label.toLowerCase()}
                  </option>
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
                    disabled={isFieldDisabled(field)}
                    title={
                      isFieldDisabled(field)
                      ? "Only Threshold can be edited in Edit Rule mode."
                      : undefined
                    }
                    onChange={(event) =>
                      updateValue(field.key, event.target.value)
                    }
                    />
                    )}

                {field.key === "cycle_variable_id" &&
                  cycleVariableIds.length === 0 && (
                    <small>
                      No Boolean OPC UA variable is available
                      for this asset. Add one with an OPC UA
                      NodeId in the asset's Variables dialog
                      or configure OPCUA_MACHINE_MAPPINGS.
                    </small>
                  )}

                {field.key === "runtime_variable_id" &&
                  runtimeVariableIds.length === 0 && (
                    <small>
                      No Boolean OPC UA variable is available
                      for this asset. Add one with an OPC UA
                      NodeId in the asset's Variables dialog.
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
            onClick={() => returnToAsset()}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="btn-primary"
            disabled={saving || variables.length === 0 || !canSubmitRule}
            title={
              !canSubmitRule
              ? "You do not have permission to create or edit monitoring rules."
              : undefined
            }
          >
            {saving
              ? isEdit
                ? "Saving changes…"
                : "Creating…"
              : isEdit
                ? "Save changes"
                : "Create rule"}
          </button>
        </footer>
      </form>
    </main>
  );
}