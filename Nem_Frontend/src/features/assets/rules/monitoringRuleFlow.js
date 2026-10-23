export const MONITORING_RULE_CHOICES = [
  {
    id: "motor_rotation",
    label: "Cycle Clock",
    description: "Count each OFF-to-ON cycle and alert at the configured count thresholds.",
    ruleType: "boolean_count_threshold",
    defaultName: "Cycle Clock",
  },
  {
    id: "running_time",
    label: "Motor Running Time",
    description: "Accumulate runtime while this asset's Boolean running signal is true.",
    ruleType: "runtime_duration",
    defaultName: "Motor Running Time",
  },
];

export const LEGACY_RULE_CHOICES = [
  {
    kind: "interval",
    label: "Motor Running Time",
    description: "Accumulate time while the Boolean running signal is ON and alert at runtime thresholds.",
  },
  {
    kind: "usage",
    label: "Cycle Clock",
    description: "Count OFF-to-ON transitions and set warning and alert cycle-count thresholds.",
  },
  {
    kind: "time",
    label: "Running Time-based",
    description: "Start tracking Boolean running time at a scheduled date and time.",
  },
];

export function monitoringRuleFormSelection(choiceId) {
  const choice =
    MONITORING_RULE_CHOICES.find((item) => item.id === choiceId) ||
    (choiceId === "boolean_count_threshold"
      ? MONITORING_RULE_CHOICES.find(
          (item) => item.ruleType === "boolean_count_threshold"
        )
      : undefined);
  if (!choice) {
    throw new Error("Select a supported monitoring rule type.");
  }
  return {
    title: `Create ${choice.label} rule`,
    ruleType: choice.ruleType,
    initialValues: {
      rule_type: choice.ruleType,
      name: choice.defaultName,
    },
  };
}

export function legacyRulePath(assetId, kind) {
  if (!LEGACY_RULE_CHOICES.some((choice) => choice.kind === kind)) {
    throw new Error("Select a supported legacy rule workflow.");
  }
  return `/assets/${assetId}/rules/new/${kind}`;
}

export function buildAssetMonitoringRule(
  values,
  assetId,
  { variables, cycleVariableIds, runtimeVariableIds }
) {
  const asset = Number(assetId);
  if (!Number.isSafeInteger(asset) || asset <= 0) {
    throw new Error("A valid target asset is required.");
  }

  const variableIsActiveForAsset = (id, dataTypes) =>
    variables.some(
      (variable) =>
        Number(variable.id) === Number(id) &&
        Number(variable.asset_id) === asset &&
        variable.is_active !== false &&
        dataTypes.includes(variable.data_type)
    );

  const rule = {
    name: String(values.name || "").trim(),
    description: String(values.description || "").trim() || null,
    target_asset_id: asset,
    severity: values.severity,
    is_enabled: true,
    rule_type: values.rule_type,
  };
  if (!rule.name) {
    throw new Error("Enter a rule name.");
  }

  if (values.rule_type === "runtime_duration") {
    const warning1 = Number(values.runtime_warning_hours);
    const warning2 = Number(values.runtime_warning_2_hours);
    const alert = Number(values.runtime_alert_hours);
    const variableId = Number(values.runtime_variable_id);
    if (!runtimeVariableIds.includes(variableId) ||
        !variableIsActiveForAsset(variableId, ["boolean"])) {
      throw new Error("Select an active Boolean running signal for this asset.");
    }
    if (
      ![warning1, warning2, alert].every(
        (value) => Number.isFinite(value) && value > 0
      ) ||
      warning1 >= warning2 ||
      warning2 >= alert
    ) {
      throw new Error(
        "Running-time thresholds must be positive and strictly increasing."
      );
    }
    rule.variable_id = variableId;
    rule.parameters = {
      warning_thresholds_seconds: [warning1 * 3600, warning2 * 3600],
      alert_threshold_seconds: alert * 3600,
    };
    if (values.activation_at) {
      const activationAt = new Date(values.activation_at);
      if (Number.isNaN(activationAt.getTime())) {
        throw new Error("Select a valid scheduled activation date and time.");
      }
      rule.parameters.activation_at = activationAt.toISOString();
    }
    rule.stale_after_seconds = 300;
    return rule;
  }

  if (values.rule_type === "boolean_count_threshold") {
    const warning1 = Number(values.warning_threshold_1);
    const warning2 = Number(values.warning_threshold_2);
    const alert = Number(values.alert_threshold);
    const variableId = Number(values.cycle_variable_id);
    if (!cycleVariableIds.includes(variableId) ||
        !variableIsActiveForAsset(variableId, ["boolean"])) {
      throw new Error("Select an active Boolean cycle signal for this asset.");
    }
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
    rule.variable_id = variableId;
    rule.parameters = {
      warning_thresholds: [warning1, warning2],
      alert_threshold: alert,
    };
    return rule;
  }

const variableId = Number(values.variable_id);
const threshold = Number(values.threshold);

if (!variableIsActiveForAsset(variableId, ["number", "integer"])) {
  throw new Error("Select an active numeric variable on this asset.");
}

if (!Number.isFinite(threshold)) {
  throw new Error("Enter a valid numeric threshold.");
}

rule.variable_id = variableId;
rule.operator = values.operator;
rule.threshold = threshold;
return rule;
}
