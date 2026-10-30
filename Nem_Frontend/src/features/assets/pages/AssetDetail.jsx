
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { Download, Eye, Pencil, Trash2 } from "lucide-react";
import CopyRulesModal from "../components/CopyRulesModal.jsx";
import PredefinedRulesModal from "../../rules/components/PredefinedRulesModal.jsx";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  createLiveUpdateScheduler,
  subscribeLiveUpdates,
} from "../../../services/liveUpdates.js";
import AssetSupervisors from "../components/AssetSupervisors.jsx";
import CurrentMaintenanceCards from "../components/CurrentMaintenanceCards.jsx";
import MaintenancePanel from "../components/MaintenancePanel.jsx";
import "./AssetDetail.css";
import {
  MONITORING_RULE_CHOICES,
  LEGACY_RULE_CHOICES,
  legacyRulePath,
  buildAssetMonitoringRule,
  monitoringRuleFormSelection,
} from "../rules/monitoringRuleFlow.js";
import {
  formatDuration,
  formatTime,
  formatValue,
} from "../../../utils/format.js";
import {
  CreateModal,
  EmptyState,
  FloatingMenu,
  Modal,
  StatusBadge,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import {
  GearIcon,
  AssetIcon,
  ExternalIcon,
  FilterIcon,
  RefreshIcon,
  PlusCircle,
  DotsIcon,
  ChevronDown,
  BookmarkIcon,
  FxIcon,
  EditIcon,
} from "../../../components/common/Icons.jsx";

const ORDER = { alert: 0, warning: 1, ok: 2 };

const HEALTH_LABEL = {
  alert: "Alert active",
  warning: "Warning active",
  ok: "No active alerts",
  off: "Disabled",
};

function thresholdMetrics(rule) {
  const expectedBoolean = rule.parameters?.expected_value;
  if (rule.rule_type === "parameter_threshold" && typeof expectedBoolean === "boolean") {
    return [{
      label: "Condition",
      value: `${rule.operator === "!=" || rule.operator === "ne" ? "is not" : "is"} ${expectedBoolean ? "ON" : "OFF"}`,
    }];
  }
  if (rule.rule_type === "runtime_duration") {
    const warnings = rule.parameters?.warning_thresholds_seconds;
    const alert = rule.parameters?.alert_threshold_seconds;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return [
        { label: "Warning", value: `${(Number(warnings[0]) / 3600).toFixed(2)} h` },
        { label: "Higher warning", value: `${(Number(warnings[1]) / 3600).toFixed(2)} h` },
        { label: "Alert", value: `${(Number(alert) / 3600).toFixed(2)} h` },
      ];
    }
  }
  if (rule.rule_type === "boolean_count_threshold") {
    const warnings = rule.parameters?.warning_thresholds;
    const alert = rule.parameters?.alert_threshold;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return [
        { label: "Warning", value: Number(warnings[0]).toLocaleString() },
        { label: "Higher warning", value: Number(warnings[1]).toLocaleString() },
        { label: "Alert", value: Number(alert).toLocaleString() },
      ];
    }
  }
  if (rule.threshold !== null && rule.threshold !== undefined) {
    return [
      {
        label: "Threshold",
        value: `${rule.operator || ""} ${formatValue(rule.threshold)}`.trim(),
      },
    ];
  }
  return [];
}

function thresholdSequence(rule) {
  const parameters = rule.parameters || {};
  if (
    rule.rule_type === "runtime_duration" &&
    Array.isArray(parameters.warning_thresholds_seconds) &&
    parameters.warning_thresholds_seconds.length === 2 &&
    parameters.alert_threshold_seconds != null
  ) {
    return [
      { label: "Warning", value: Number(parameters.warning_thresholds_seconds[0]) },
      { label: "Higher warning", value: Number(parameters.warning_thresholds_seconds[1]) },
      { label: "Alert", value: Number(parameters.alert_threshold_seconds) },
    ];
  }
  if (
    rule.rule_type === "boolean_count_threshold" &&
    Array.isArray(parameters.warning_thresholds) &&
    parameters.warning_thresholds.length === 2 &&
    parameters.alert_threshold != null
  ) {
    return [
      { label: "Warning", value: Number(parameters.warning_thresholds[0]) },
      { label: "Higher warning", value: Number(parameters.warning_thresholds[1]) },
      { label: "Alert", value: Number(parameters.alert_threshold) },
    ];
  }
  return [];
}

function compactRuleDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "duration not set";
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

function eventActionLabel(eventType) {
  if (!eventType) return "Event";
  if (eventType === "alert_acknowledged") return "Alert Acknowledged";
  if (eventType === "rule_completed") return "Rule Completed";
  return eventType
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function eventAuditSummary(event) {
  const metadata = event?.metadata || {};
  const parts = [];
  if (metadata.acknowledged_by) {
    parts.push(`Acknowledged by ${metadata.acknowledged_by}`);
  }
  if (metadata.acknowledged_at) {
    parts.push(`at ${formatTime(metadata.acknowledged_at)}`);
  }
  if (metadata.completed_by) {
    parts.push(`Completed by ${metadata.completed_by}`);
  }
  if (metadata.completed_at) {
    parts.push(`at ${formatTime(metadata.completed_at)}`);
  }
  return parts.join(" · ");
}

function ruleConditionSummary(rule) {
  const parameters = rule.parameters || {};
  if (rule.rule_type === "duration") {
    const duration = compactRuleDuration(parameters.duration_seconds);
    if (parameters.condition === "threshold") {
      if (rule.variable_data_type === "boolean") {
        return `Invalid condition: Boolean signal cannot be compared with ${parameters.operator || ""} ${parameters.threshold}; expected ON/OFF for ${duration}.`;
      }
      return `Value ${parameters.operator || ""} ${parameters.threshold} for ${duration}`.trim();
    }
    if (typeof parameters.expected_value === "boolean") {
      return `Signal ${parameters.expected_value ? "ON" : "OFF"} continuously for ${duration}`;
    }
  }
  if (rule.rule_type === "runtime_duration") {
    const warnings = parameters.warning_thresholds_seconds;
    const alert = parameters.alert_threshold_seconds;
    if (Array.isArray(warnings) && warnings.length === 2 && alert != null) {
      return `Running time · warnings at ${compactRuleDuration(warnings[0])} / ${compactRuleDuration(warnings[1])}, alert at ${compactRuleDuration(alert)}`;
    }
  }
  if (rule.rule_type === "boolean_count_threshold") {
    const warnings = parameters.warning_thresholds;
    if (Array.isArray(warnings) && warnings.length === 2 && parameters.alert_threshold != null) {
      return `Cycle count · warnings at ${warnings[0]} / ${warnings[1]}, alert at ${parameters.alert_threshold}`;
    }
  }
  if (
    rule.rule_type === "parameter_threshold" &&
    typeof parameters.expected_value === "boolean"
  ) {
    return `Signal ${rule.operator === "!=" || rule.operator === "ne" ? "is not" : "is"} ${parameters.expected_value ? "ON" : "OFF"}`;
  }
  if (rule.rule_type === "parameter_threshold" && rule.threshold != null) {
    return `Value ${rule.operator || ""} ${rule.threshold}`.trim();
  }
  return null;
}

function formatTimeUntilStart(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Starting now";
  let remaining = Math.ceil(milliseconds / 1000);
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

const isBlank = (value) =>
  value === undefined || value === null || String(value).trim() === "";

const sameNumber = (a, b) =>
  !isBlank(a) && !isBlank(b) && Number(a) === Number(b);

// Builds the rule-specific threshold/interval part of a PATCH payload from
// the edit form. Only values the user actually changed are included.
function buildRuleThresholdChanges(ruleType, values, initial) {
  const changes = {};

  if (ruleType === "runtime_duration") {
    const keys = [
      "runtime_warning_hours",
      "runtime_warning_2_hours",
      "runtime_alert_hours",
    ];
    if (!keys.every((key) => sameNumber(values[key], initial[key]))) {
      const [warning1, warning2, alert] = keys.map((key) => Number(values[key]));
      if (
        keys.some((key) => isBlank(values[key])) ||
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
      changes.parameters = {
        warning_thresholds_seconds: [
          Math.round(warning1 * 3600),
          Math.round(warning2 * 3600),
        ],
        alert_threshold_seconds: Math.round(alert * 3600),
      };
    }
  } else if (ruleType === "boolean_count_threshold") {
    const keys = ["warning_threshold_1", "warning_threshold_2", "alert_threshold"];
    if (!keys.every((key) => sameNumber(values[key], initial[key]))) {
      const [warning1, warning2, alert] = keys.map((key) => Number(values[key]));
      if (
        keys.some((key) => isBlank(values[key])) ||
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
      changes.parameters = {
        warning_thresholds: [warning1, warning2],
        alert_threshold: alert,
      };
    }
  } else if (
    ruleType === "parameter_threshold" &&
    !sameNumber(values.threshold, initial.threshold) &&
    !isBlank(values.threshold)
  ) {
    const threshold = Number(values.threshold);
    if (!Number.isFinite(threshold)) {
      throw new Error("Enter a valid numeric threshold.");
    }
    changes.threshold = threshold;
  }

  if (
    !isBlank(values.evaluation_interval_seconds) &&
    !sameNumber(values.evaluation_interval_seconds, initial.evaluation_interval_seconds)
  ) {
    const interval = Number(values.evaluation_interval_seconds);
    if (!Number.isInteger(interval) || interval < 1) {
      throw new Error("Evaluation interval must be a whole number of seconds (1 or more).");
    }
    changes.evaluation_interval_seconds = interval;
  }

  return changes;
}

const ruleFields = (
  variables,
  cycleVariableIds,
  runtimeVariableIds,
  mappingBypassEnabled
) => [
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
    default: "parameter_threshold",
    options: [
      ["parameter_threshold", "Numeric value threshold (e.g. temperature)"],
      ["boolean_count_threshold", "Cycle Clock (Boolean ON/OFF count)"],
      ["runtime_duration", "Motor Running Time"],
    ],
    hint: mappingBypassEnabled
      ? "Choose a Boolean variable marked for the signal's actual purpose."
      : "Cycle counts come from this asset's configured PLC cycle signal.",
  },
  {
    key: "variable_id",
    label: "Numeric variable",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    options: variables
      .filter((v) => v.data_type === "number" || v.data_type === "integer")
      .map((v) => [
      v.id,
      `${v.name}${v.unit ? ` (${v.unit})` : ""}`,
    ]),
  },
  {
    key: "cycle_variable_id",
    label: mappingBypassEnabled
      ? "Boolean cycle signal"
      : "Configured Boolean cycle signal",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    options: variables
      .filter((v) => cycleVariableIds.includes(v.id))
      .map((v) => [v.id, `${v.name} (#${v.id})`]),
    hint: cycleVariableIds.length
      ? mappingBypassEnabled
        ? "Only variables marked as Cycle signal are available."
        : "Only Boolean variables configured as this asset's OPC UA cycle signal are available."
      : mappingBypassEnabled
        ? "Edit a Boolean variable in the asset's Variables panel and set its purpose to Cycle signal."
        : "No OPC UA cycle signal is configured for this asset. Configure it in backend OPCUA_MACHINE_MAPPINGS first.",
  },
  {
    key: "runtime_variable_id",
    label: "OPC UA Boolean running signal",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "runtime_duration" },
    options: variables
      .filter((variable) =>
        variable.data_type === "boolean" &&
        runtimeVariableIds.includes(variable.id)
      )
      .map((variable) => [variable.id, variable.name]),
    hint: mappingBypassEnabled
      ? runtimeVariableIds.length
        ? "Only variables marked as Machine running state are available."
        : "Edit a Boolean variable in the asset's Variables panel and set its purpose to Machine running state."
      : "Select a mapped Boolean OPC UA variable that is true while the machine runs.",
  },
  {
    key: "operator",
    label: "Trigger when value is",
    type: "select",
    showWhen: { key: "rule_type", equals: "parameter_threshold" },
    requiredWhen: { key: "rule_type", equals: "parameter_threshold" },
    default: ">=",
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
  {
    key: "evaluation_interval_seconds",
    label: "Evaluation interval (seconds)",
    type: "number",
    placeholder: "Leave blank to keep the current interval",
  },
];

const LOG_FIELDS = [
  {
    key: "text",
    label: "Entry",
    type: "textarea",
    required: true,
    placeholder: "What was done or noticed?",
  },
];

const VARIABLE_FIELDS = [
  {
    key: "name",
    label: "Name",
    required: true,
    placeholder: "e.g. Rotation count",
  },
  {
    key: "key",
    label: "Key",
    required: true,
    placeholder: "e.g. rotation_count",
    hint: "A short identifier that is unique within this asset.",
  },
  {
    key: "data_type",
    label: "Data type",
    type: "select",
    default: "number",
    options: [
      ["number", "Number"],
      ["integer", "Whole number"],
      ["boolean", "On / off"],
      ["string", "Text"],
    ],
  },
  {
    key: "signal_role",
    label: "Boolean purpose",
    type: "select",
    showWhen: { key: "data_type", equals: "boolean" },
    options: [
      ["running", "Machine running state (ON while running)"],
      ["cycle", "Cycle signal (OFF-to-ON means one cycle)"],
    ],
    hint: "Used when OPC UA mapping bypass is enabled. Choose the signal's actual meaning.",
  },
  {
    key: "unit",
    label: "Unit",
    placeholder: "e.g. °C, rpm, cycles",
  },
  {
    key: "opcua_node_id",
    label: "OPC UA NodeId",
    placeholder: "e.g. ns=2;s=Machine.Cycle",
    hint: "Optional. Enter the exact NodeId from the PLC. Restart the backend after changing it so the collector can subscribe.",
  },
    {
  key: "data_source",
  label: "Data source",
  type: "select",
  default: "none",
  options: [
    ["none", "No source"],
    ["connector", "Connector"],
  ],
},
  {
  key: "connector_id",
  label: "Select connector",
  type: "select",
  default: "",
  options: [
    ["opcua", "OPC UA Connector"],
    ["mqtt", "MQTT Connector"],
    ["modbus_tcp", "Modbus TCP Connector"],
    ["http", "HTTP / REST API Connector"],
    ["database", "Database Connector"],
  ],
  showWhen: {
    key: "data_source",
    equals: "connector",
  },
  hint: "Choose the connector that provides this variable's data.",
},
];

export default function AssetDetail() {
  const confirm = useConfirmation();
  const { user } = useAuth();
  const isAdministrator = user?.role === "Administrator";
  const isSupervisor = user?.role === "Supervisor";
  const isOperator = user?.role === "Operator";
  const canManageRules = isAdministrator || isSupervisor;
  const canManageLogbook = canManageRules;
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const { assets, assetsLoaded, alerts = [], reload, refreshStatus } =
    useOutletContext();

  const assetId = Number(id);
  const asset = assets.find((a) => a.id === assetId);
  const hasChildren = asset
    ? assets.some((candidate) => candidate.parent_asset_id === asset.id)
    : false;

  const [tab, setTab] = useState(
    location.state?.activeTab === "logbook" ? "logbook" : "status"
  );
  const [list, setList] = useState("activated");
  const [rules, setRules] = useState([]);
  const [completedMaintenanceCount, setCompletedMaintenanceCount] = useState(0);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const [variables, setVariables] = useState([]);
  const [allVariables, setAllVariables] = useState([]);
  const [runtimeReadings, setRuntimeReadings] = useState(new Map());
  const [clockNow, setClockNow] = useState(Date.now());
  const [cycleVariableIds, setCycleVariableIds] = useState([]);
  const [runtimeVariableIds, setRuntimeVariableIds] = useState([]);
  const [mappingBypassEnabled, setMappingBypassEnabled] = useState(false);
  const [editingVariable, setEditingVariable] = useState(null);
  const [ruleStates, setRuleStates] = useState(new Map());
  const [children, setChildren] = useState(false);
  const [sort, setSort] = useState("severity");
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [menu, setMenu] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState(null);
  const [ruleActionMenuId, setRuleActionMenuId] = useState(null);
  const [lifecycleAction, setLifecycleAction] = useState(null);
  const [viewRule, setViewRule] = useState(null);
  const [completionDetails, setCompletionDetails] = useState(null);
  const [completionDetailsError, setCompletionDetailsError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [sortMenu, setSortMenu] = useState(false);
  const [modal, setModal] = useState(null);
  const [monitoringRuleSelection, setMonitoringRuleSelection] = useState(null);
  const [showPredefinedRules, setShowPredefinedRules] = useState(false);
  const [addRuleMenu, setAddRuleMenu] = useState(false);
  const [logs, setLogs] = useState([]);
  const [maintenanceTypeFilter, setMaintenanceTypeFilter] = useState("");
  const [maintenanceStartDateTime, setMaintenanceStartDateTime] = useState("");
  const [maintenanceEndDateTime, setMaintenanceEndDateTime] = useState("");
  const [events, setEvents] = useState([]);
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [eventStartDateTime, setEventStartDateTime] = useState("");
  const [eventEndDateTime, setEventEndDateTime] = useState("");
  const [loadError, setLoadError] = useState("");
  const [deletingAsset, setDeletingAsset] = useState(false);
  const [deletingVariableId, setDeletingVariableId] = useState(null);
  const [variableDeleteError, setVariableDeleteError] = useState("");
  const [variableDataSource, setVariableDataSource] = useState("none");
  const [variableConnector, setVariableConnector] = useState("");
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [showEventDetails, setShowEventDetails] = useState(false);
  const [deletingEventId, setDeletingEventId] = useState(null);
  const [eventDeleteError, setEventDeleteError] = useState("");
  const [deletingLogId, setDeletingLogId] = useState(null);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);

  const seq = useRef(0);
  const ruleListSeq = useRef(0);
  const ruleStatusSeq = useRef(0);
  const plcStatusSeq = useRef(0);
  const bulkRequest = useRef(false);
  const permanentDeleteRequest = useRef(false);

  useEffect(() => {
    if (!menu && !sortMenu && ruleActionMenuId === null) return undefined;

    const closeMenus = () => {
      setMenu(false);
      setSortMenu(false);
      setRuleActionMenuId(null);
    };
    const handlePointerDown = (event) => {
      if (!(event.target instanceof Element)) return;
      const openDropdowns = document.querySelectorAll(
        ".asset-page .dropdown[data-menu-open='true']"
      );
      if (event.target.closest(".floating-menu")) return;
      if (event.target.closest(".logbook-action-menu-trigger")) return;
      if (![...openDropdowns].some((dropdown) => dropdown.contains(event.target))) {
        closeMenus();
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeMenus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu, ruleActionMenuId, sortMenu]);

  
  const loadLive = useCallback(async ({
    includeRuleList = true,
    includePlcStatus = true,
  } = {}) => {
    const generation = seq.current;
    const ruleRequest = includeRuleList ? ++ruleListSeq.current : null;
    const statusRequest = ++ruleStatusSeq.current;
    const plcRequest = includePlcStatus ? ++plcStatusSeq.current : null;

    try {
      const [r, st, plc] = await Promise.allSettled([
        includeRuleList
          ? api.get(`/assets/${assetId}/rules?include_children=${children}`)
          : Promise.resolve(null),
        api.getAll("/monitoring/status", 500),
        includePlcStatus ? api.get("/plc/status") : Promise.resolve(null),
      ]);

      if (generation !== seq.current) return;

      if (
        includeRuleList &&
        ruleRequest === ruleListSeq.current &&
        r.status === "fulfilled"
      ) {
        const loadedRules = Array.isArray(r.value) ? r.value : [];
        setRules(loadedRules);
        const runtimeRules = loadedRules.filter((rule) =>
          rule.rule_type === "runtime_duration"
        );
        const signalReadings = await Promise.all(
          runtimeRules.map(async (rule) => {
            try {
              return [
                rule.variable_id,
                await api.get(`/readings/variables/${rule.variable_id}/latest`),
              ];
            } catch (error) {
              if (error.status === 404) return [rule.variable_id, null];
              throw error;
            }
          })
        );
        if (
          generation === seq.current &&
          ruleRequest === ruleListSeq.current
        ) {
          setRuntimeReadings(new Map(signalReadings));
          setLoadError("");
        }
      } else if (
        includeRuleList &&
        ruleRequest === ruleListSeq.current &&
        r.status === "rejected"
      ) {
        setLoadError(
          r.reason?.message || "Unable to load rules."
        );
      }

      if (
        statusRequest === ruleStatusSeq.current &&
        st.status === "fulfilled"
      ) {
        setRuleStates(
          new Map(
            (Array.isArray(st.value) ? st.value : []).map(
              (s) => [s.rule_id, s]
            )
          )
        );
      }

      if (
        includePlcStatus &&
        plcRequest === plcStatusSeq.current &&
        plc.status === "fulfilled"
      ) {
        const mappings = Array.isArray(plc.value?.mappings)
          ? plc.value.mappings
          : [];
        const bypassEnabled = plc.value?.mapping_bypass_enabled === true;
        setMappingBypassEnabled(bypassEnabled);
        setCycleVariableIds(
          mappings
            .filter(
              (mapping) =>
                Number(mapping.asset_id) === assetId &&
                mapping.role === "cycle_signal" &&
                mapping.mapping_valid
            )
            .map((mapping) => Number(mapping.variable_id))
        );
        setRuntimeVariableIds(
          mappings
            .filter(
              (mapping) =>
                Number(mapping.asset_id) === assetId &&
                mapping.mapping_valid &&
                mapping.data_type === "boolean" &&
                mapping.role === "running_signal"
            )
            .map((mapping) => Number(mapping.variable_id))
        );
      }
    } catch (error) {
      if (generation === seq.current) {
        setLoadError(error.message || "Unable to refresh asset monitoring.");
      }
    }
  }, [assetId, children]);

  const liveScheduler = useMemo(
    () => createLiveUpdateScheduler(() => loadLive(), 200),
    [loadLive]
  );
  const statusScheduler = useMemo(
    () =>
      createLiveUpdateScheduler(
        () => loadLive({ includeRuleList: false, includePlcStatus: false }),
        250
      ),
    [loadLive]
  );
  const connectionScheduler = useMemo(
    () =>
      createLiveUpdateScheduler(
        () => loadLive({ includeRuleList: false }),
        250
      ),
    [loadLive]
  );

  const loadVariables = useCallback(async () => {
    try {
      const items = await api.getAll(
        `/assets/${assetId}/variables`
      );

      const loadedVariables = Array.isArray(items) ? items : [];
      setAllVariables(loadedVariables);
      setVariables(
        loadedVariables.filter((variable) => variable.is_active)
      );
    } catch (error) {
      setVariables([]);
      setAllVariables([]);
      setLoadError(
        error.message || "Unable to load variables."
      );
    }
  }, [assetId]);

  const loadLogs = useCallback(() => {
    return api
      .get(`/assets/${assetId}/logbook`)
      .then((items) => {
        setLogs(Array.isArray(items) ? items : []);
      })
      .catch((error) => {
        setLoadError(
          error.message || "Unable to load logbook."
        );
      });
  }, [assetId]);

  const loadEvents = useCallback(async () => {
    try {
      const items = await api.get(`/assets/${assetId}/events`);
      setEvents(Array.isArray(items) ? items : []);
    } catch (error) {
      setLoadError(error.message || "Unable to load events.");
    }
  }, [assetId]);

  const eventsScheduler = useMemo(
    () => createLiveUpdateScheduler(loadEvents, 250),
    [loadEvents]
  );

  const refreshMaintenanceData = useCallback(async () => {
    await Promise.all([refreshStatus?.(), loadLogs()]);
  }, [loadLogs, refreshStatus]);

  const deleteEvent = async (event) => {
    if (!isAdministrator || deletingEventId !== null) return;
    if (
      !(await confirm("Permanently delete this event? This cannot be undone.", {
        title: "Delete event",
        confirmLabel: "Delete permanently",
        destructive: true,
      }))
    ) {
      return;
    }
    setActionNotice("");
    setDeletingEventId(event.id);
    setEventDeleteError("");
    try {
      await api.del(`/events/${event.id}`);
      await loadEvents();
      setShowEventDetails(false);
      setSelectedEvent(null);
      setActionNotice("Event was permanently deleted.");
    } catch (error) {
      setEventDeleteError(error.message || "Could not delete this event.");
    } finally {
      setDeletingEventId(null);
    }
  };

  
  useEffect(() => {
    setTab("status");
    setList("activated");
    setFilter("");
    setRules([]);
    setAllVariables([]);
    setRuntimeReadings(new Map());
    setVariables([]);
    setLogs([]);
    setMaintenanceTypeFilter("");
    setMaintenanceStartDateTime("");
    setMaintenanceEndDateTime("");
    setEvents([]);
    setEventTypeFilter("");
    setEventStartDateTime("");
    setEventEndDateTime("");
    setSelectedEvent(null);
    setShowEventDetails(false);
    setLoadError("");

  loadVariables();
  loadLogs();
  loadLive();

    return () => {
      seq.current += 1;
    };
  }, [assetId, loadVariables, loadLogs, loadLive]);

  const hasRuntimeRules = rules.some(
    (rule) => rule.rule_type === "runtime_duration"
  );

  useEffect(() => {
    if (!hasRuntimeRules) return;

    let timer;
    const updateClock = () => {
      setClockNow(Date.now());
      timer = window.setTimeout(
        updateClock,
        1000 - (Date.now() % 1000)
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      updateClock();
    };

    updateClock();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
    };
  }, [hasRuntimeRules]);


  useEffect(() => {
    const navigationState = location.state;

    if (navigationState?.activeTab === "logbook") {
      setTab("status");
    }

    if (navigationState?.createdNotice) {
      setActionNotice(navigationState.createdNotice);
    }

    if (
      navigationState?.activeTab ||
      navigationState?.createdNotice
    ) {
      navigate(location.pathname, {
        replace: true,
        state: null,
      });
    }
  }, [location.pathname, location.state, navigate]);


  useEffect(() => {
    return subscribeLiveUpdates((update) => {
      if (update.resync_required) {
        liveScheduler();
        loadVariables();
        loadLogs();
        if (tab === "events") eventsScheduler();
        return;
      }
      if (update.type === "disconnected") return;
      const changedTables = new Set(update.changed_tables || []);
      const relevantTables = [
        "assets",
        "variables",
        "readings",
        "nem_readings",
        "nem_monitoring_rules",
        "nem_rule_states",
        "nem_rule_counter_states",
        "machine_monitoring_states",
        "nem_alerts",
        "nem_maintenance_records",
        "nem_maintenance_schedules",
        "nem_monitoring_events",
      ];
      if (
        update.type !== "opcua_status" &&
        !relevantTables.some((table) => changedTables.has(table))
      ) {
        return;
      }
      const affectedAssets = update.asset_ids || [];
      const displayedAssetIds = new Set([assetId]);
      if (children) {
        let expanded = true;
        while (expanded) {
          expanded = false;
          for (const candidate of assets) {
            if (
              candidate.parent_asset_id != null &&
              displayedAssetIds.has(candidate.parent_asset_id) &&
              !displayedAssetIds.has(candidate.id)
            ) {
              displayedAssetIds.add(candidate.id);
              expanded = true;
            }
          }
        }
      }
      if (
        affectedAssets.length > 0 &&
        !affectedAssets.some((id) => displayedAssetIds.has(id))
      ) {
        return;
      }
      if (update.type === "opcua_status") {
        connectionScheduler();
        return;
      }
      if (["assets", "variables", "nem_monitoring_rules"].some((table) =>
        changedTables.has(table)
      )) {
        liveScheduler();
      } else if (
        [
          "readings",
          "nem_readings",
          "nem_rule_states",
          "nem_rule_counter_states",
          "machine_monitoring_states",
          "nem_alerts",
        ].some((table) => changedTables.has(table))
      ) {
        statusScheduler();
      }
      if (changedTables.has("variables") || changedTables.has("assets")) {
        loadVariables();
      }
      if (
        changedTables.has("nem_maintenance_records") ||
        changedTables.has("nem_maintenance_schedules")
      ) {
        loadLogs();
      }
      if (changedTables.has("nem_monitoring_events") && tab === "events") {
        eventsScheduler();
      }
    });
  }, [assetId, assets, children, loadLive, loadLogs, loadVariables]);

 
useEffect(() => {
  if (tab !== "events") return;

    let cancelled = false;

    api
      .get(`/assets/${assetId}/events`)
      .then((items) => {
        if (!cancelled) {
          setEvents(Array.isArray(items) ? items : []);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(
            error.message || "Unable to load events."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tab, assetId]);

  const availableVariables = variables;
  const ruleFormFields = useMemo(
    () =>
      ruleFields(
        availableVariables,
        cycleVariableIds,
        runtimeVariableIds,
        mappingBypassEnabled
      ),
    [
      availableVariables,
      cycleVariableIds,
      runtimeVariableIds,
      mappingBypassEnabled,
    ]
  );

  const isAct = (rule) => rule.state === "activated";
  const nAct = rules.filter(isAct).length;
  const nNot = rules.length - nAct + completedMaintenanceCount;

  let shown = rules
    .filter((rule) =>
      list === "activated"
        ? isAct(rule)
        : !isAct(rule)
    )
    .filter((rule) =>
      (rule.name || "")
        .toLowerCase()
        .includes(filter.toLowerCase())
    );

  shown = [...shown].sort((a, b) =>
    sort === "name"
      ? (a.name || "").localeCompare(b.name || "")
      : (ORDER[a.status] ?? 3) -
        (ORDER[b.status] ?? 3)
  );

  
const maintenanceTypes = [...new Set(
  logs.map((entry) => entry.maintenance_type).filter(Boolean)
)].sort((a, b) => a.localeCompare(b));
const filteredLogs = [...logs]
  .filter((entry) => {
    if (
      maintenanceTypeFilter &&
      entry.maintenance_type !== maintenanceTypeFilter
    ) {
      return false;
    }
    const timestamp = new Date(entry.time || entry.created_at || "").getTime();
    const start = maintenanceStartDateTime
      ? new Date(maintenanceStartDateTime).getTime()
      : Number.NaN;
    const end = maintenanceEndDateTime
      ? new Date(maintenanceEndDateTime).getTime()
      : Number.NaN;
    if (Number.isFinite(start) && (!Number.isFinite(timestamp) || timestamp < start)) {
      return false;
    }
    if (Number.isFinite(end) && (!Number.isFinite(timestamp) || timestamp > end)) {
      return false;
    }
    return true;
  })
  .sort(
    (a, b) =>
      new Date(b.time || b.created_at || 0).getTime() -
      new Date(a.time || a.created_at || 0).getTime()
  );

const eventTypes = [...new Set(events.map((event) => event.event_type).filter(Boolean))]
  .sort((a, b) => eventActionLabel(a).localeCompare(eventActionLabel(b)));
const filteredEvents = [...events]
  .filter((event) => {
    if (eventTypeFilter && event.event_type !== eventTypeFilter) return false;
    const timestamp = new Date(event.time || event.occurred_at || "").getTime();
    const start = eventStartDateTime
      ? new Date(eventStartDateTime).getTime()
      : Number.NaN;
    const end = eventEndDateTime
      ? new Date(eventEndDateTime).getTime()
      : Number.NaN;
    if (Number.isFinite(start) && (!Number.isFinite(timestamp) || timestamp < start)) {
      return false;
    }
    if (Number.isFinite(end) && (!Number.isFinite(timestamp) || timestamp > end)) {
      return false;
    }
    return true;
  })
  .sort(
    (a, b) =>
      new Date(b.time || b.occurred_at || 0).getTime() -
      new Date(a.time || a.occurred_at || 0).getTime()
  );
 
  const exportExcel = async ({
    rows,
    headers,
    sheetName,
    fileName,
    confirmMessage,
  }) => {
    if (
      !(await confirm(confirmMessage, {
        title: "Export Excel file",
        confirmLabel: "Download",
      }))
    ) return;
    setExportError("");
    setExporting(true);
    try {
      const XLSX = await import("@e965/xlsx");
      const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      XLSX.writeFile(workbook, fileName);
    } catch (error) {
      setExportError(error.message || "Could not export the Excel file.");
    } finally {
      setExporting(false);
    }
  };

  const exportFileDate = new Date().toISOString().slice(0, 10);
  const assetFileName =
    (asset?.name || `asset-${assetId}`)
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || `asset-${assetId}`;

  const refreshAll = async () => {
    await Promise.all([
      loadLive(),
      refreshStatus?.(),
    ]);
  };

  const confirmLifecycleChange = async () => {
    if (!canManageRules || !lifecycleAction || deletingRuleId !== null) return;
    const { rule, action } = lifecycleAction;
    setDeletingRuleId(rule.id);
    setLoadError("");
    try {
      await api.post(`/rules/${rule.id}/${action}`);
      await refreshAll();
      setLifecycleAction(null);
      setRuleActionMenuId(null);
    } catch (error) {
      setLoadError(error.message || `Could not ${action} this rule.`);
    } finally {
      setDeletingRuleId(null);
    }
  };

  const lifecycleStatus = (rule) =>
    rule.lifecycle_status ||
    (rule.is_enabled ? "in_progress" : "deactivated");

  const lifecycleLabel = (rule) => {
    const status = lifecycleStatus(rule);
    if (status === "in_progress") return "Activated · In progress";
    if (status === "suspended") return "Suspended";
    if (status === "completed") return "Completed";
    return "Deactivated";
  };

  const openRuleDetails = async (rule) => {
    setViewRule(rule);
    setCompletionDetails(null);
    setCompletionDetailsError("");

    try {
      const response = await api.get(`/events?rule_id=${rule.id}&limit=100`);
      const ruleEvents = response.items || [];
      const acknowledgement = ruleEvents.find(
        (item) => item.event_type === "alert_acknowledged"
      );
      const completion = ruleEvents.find(
        (item) => item.event_type === "rule_completed"
      );
      setCompletionDetails({
        acknowledged_by:
          completion?.metadata?.acknowledged_by ||
          acknowledgement?.metadata?.acknowledged_by,
        acknowledged_at:
          completion?.metadata?.acknowledged_at ||
          acknowledgement?.metadata?.acknowledged_at ||
          acknowledgement?.occurred_at,
        completed_by: completion?.metadata?.completed_by,
        completed_at:
          completion?.metadata?.completed_at || completion?.occurred_at,
      });
    } catch (error) {
      setCompletionDetailsError(
        error.message || "Could not load completion details."
      );
    }
  };

  const remove = async (rule) => {
    if (!isAdministrator) return;
    if (
      !(await confirm(
        `Archive the rule “${rule.name}”? It will be hidden from the rule list, and its alert and evaluation history will be retained.`,
        {
          title: "Archive rule",
          confirmLabel: "Archive",
          destructive: true,
        }
      ))
    ) {
      return;
    }

    try {
      await api.del(`/rules/${rule.id}`);
      await refreshAll();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const permanentlyDeleteRule = async (rule) => {
    if (!isAdministrator || permanentDeleteRequest.current) return;
    permanentDeleteRequest.current = true;
    setDeletingRuleId(rule.id);
    setLoadError("");
    setActionNotice("");
    try {
      if (!(await confirm(
        `Permanently delete “${rule.name}”? This irreversibly removes the rule, its alerts, and its evaluation history. Maintenance records linked to its alerts must be removed first.`,
        {
          title: "Permanently delete rule",
          confirmLabel: "Delete permanently",
          destructive: true,
        }
      ))) return;
      await api.del(`/rules/${rule.id}/permanent`);
      await refreshAll();
      setActionNotice(`Rule “${rule.name}” was permanently deleted.`);
    } catch (error) {
      setLoadError(error.message || "Could not permanently delete the rule.");
    } finally {
      permanentDeleteRequest.current = false;
      setDeletingRuleId(null);
    }
  };

  const addRule = async (values) => {
    if (!canManageRules) return;

    const editId = monitoringRuleSelection?.ruleId;
    if (editId && isSupervisor) {
      // Supervisors may only change thresholds and intervals; send just those.
      const payload = buildRuleThresholdChanges(
        monitoringRuleSelection?.initialValues?.rule_type,
        values,
        monitoringRuleSelection?.initialValues || {}
      );
      if (Object.keys(payload).length === 0) {
        setModal(null);
        setMonitoringRuleSelection(null);
        setActionNotice("No changes were made to the rule.");
        return;
      }
      await api.patch(`/rules/${editId}`, payload);
    } else {
      const rule = buildAssetMonitoringRule(values, assetId, {
        variables: availableVariables,
        cycleVariableIds,
        runtimeVariableIds,
      });

      if (editId) {
        // Editing must not change activation state or the stale timeout.
        delete rule.is_enabled;
        delete rule.stale_after_seconds;
        if (!isBlank(values.evaluation_interval_seconds)) {
          rule.evaluation_interval_seconds = Number(
            values.evaluation_interval_seconds
          );
        }
        await api.patch(`/rules/${editId}`, rule);
      } else {
        await api.post(`/assets/${assetId}/rules`, rule);
      }
    }

    setModal(null);
    setMonitoringRuleSelection(null);
    setList("activated");
    await refreshAll();
  };

  const openMonitoringRuleForm = (choiceId) => {
    setModal(null);
    setMonitoringRuleSelection(null);

    navigate(`/assets/${assetId}/monitoring-rules/new/${choiceId}`);
  };

  const openEditRuleForm = (rule) => {
    if (!canManageRules) return;

    const parameters = rule.parameters || {};
    const initialValues = {
      name: rule.name || "",
      description: rule.description || "",
      rule_type: rule.rule_type || "parameter_threshold",
      severity: rule.severity || "warning",
      evaluation_interval_seconds:
        rule.evaluation_interval_seconds ?? null,
    };

    if (rule.rule_type === "parameter_threshold") {
      initialValues.variable_id = rule.variable_id;
      initialValues.operator = rule.operator || ">=";
      initialValues.threshold = rule.threshold;
    } else if (rule.rule_type === "boolean_count_threshold") {
      initialValues.cycle_variable_id = rule.variable_id;
      const countWarnings = parameters.warning_thresholds;
      initialValues.warning_threshold_1 = Array.isArray(countWarnings)
        ? countWarnings[0] ?? null
        : null;
      initialValues.warning_threshold_2 = Array.isArray(countWarnings)
        ? countWarnings[1] ?? null
        : null;
      initialValues.alert_threshold = parameters.alert_threshold ?? null;
    } else if (rule.rule_type === "runtime_duration") {
      initialValues.runtime_variable_id = rule.variable_id;
      const warnings = parameters.warning_thresholds_seconds;
      const alert = parameters.alert_threshold_seconds;
      initialValues.runtime_warning_hours =
        Array.isArray(warnings) && warnings.length >= 1
          ? warnings[0] / 3600
          : null;
      initialValues.runtime_warning_2_hours =
        Array.isArray(warnings) && warnings.length >= 2
          ? warnings[1] / 3600
          : null;
      initialValues.runtime_alert_hours =
        alert != null ? alert / 3600 : null;
    }

    setMonitoringRuleSelection({
      title: "Edit rule",
      initialValues,
      ruleId: rule.id,
    });
    setModal("add");
  };

  const monitoringRuleFormFields = useMemo(
    () => {
      const isEditing = Boolean(monitoringRuleSelection?.ruleId);
      const editingRuleType =
        monitoringRuleSelection?.initialValues?.rule_type;

      return ruleFormFields
        .filter(
          (field) =>
            field.key !== "evaluation_interval_seconds" || isEditing
        )
        .map((field) => {
        let disabled = false;
        let options = field.options;

        if (field.key === "rule_type") {
          if (isEditing) {
            disabled = true;
          }
          if (options && editingRuleType) {
            options = field.options.filter(
              ([ruleType]) => ruleType === editingRuleType
            );
          }
        }

        if (isSupervisor && isEditing) {
          const allowedFields = [
            "threshold",
            "evaluation_interval_seconds",
            "warning_threshold_1",
            "warning_threshold_2",
            "alert_threshold",
            "runtime_warning_hours",
            "runtime_warning_2_hours",
            "runtime_alert_hours",
          ];
          if (!allowedFields.includes(field.key)) {
            disabled = true;
          }
        }

        return {
          ...field,
          disabled,
          options,
        };
      });
    },
    [ruleFormFields, monitoringRuleSelection, isSupervisor]
  );

  const bulk = async (state) => {
    if (!canManageRules || bulkRequest.current || bulkSaving) return;
    const affected = rules.filter((rule) =>
      state === "activated" ? !isAct(rule) : isAct(rule)
    ).length;
    if (state === "not_activated" && affected > 0) {
      const scope = children
        ? "this asset and its included child assets"
        : "this asset only";
      if (!(await confirm(
        `Deactivate ${affected} active rule(s) on ${scope}? Active alerts for those rules will be resolved.`,
        {
          title: "Deactivate rules",
          confirmLabel: "Deactivate",
          destructive: true,
        }
      ))) {
        return;
      }
    }
    bulkRequest.current = true;
    setBulkSaving(true);
    setLoadError("");
    setActionNotice("");
    setMenu(false);
    try {
      const result = await api.post(
        `/assets/${assetId}/rules/bulk?include_children=${children}`,
        { state }
      );
      await refreshAll();
      const action = state === "activated" ? "activated" : "deactivated";
      const skipped = result.skipped || [];
      setActionNotice(
        `${result.updated} rule(s) ${action}.` +
          (skipped.length
            ? ` ${skipped.length} rule(s) were skipped because they are not eligible: ${skipped.map((item) => item.name).join(", ")}.`
            : "")
      );
    } catch (error) {
      setLoadError(error.message || "Could not update rule states.");
    } finally {
      bulkRequest.current = false;
      setBulkSaving(false);
    }
  };

  const addLog = async (values) => {
    if (!canManageLogbook) return;
    if (!values.text?.trim()) {
      throw new Error("Enter a logbook entry.");
    }

    await api.post(`/assets/${assetId}/logbook`, {
      text: values.text.trim(),
    });

    setModal(null);
    loadLogs();
  };

  const deleteLogEntry = async (entry) => {
    if (!isAdministrator || deletingLogId !== null) return;
    if (
      !(await confirm(
        "Permanently delete this maintenance log entry? This cannot be undone.",
        {
          title: "Delete maintenance entry",
          confirmLabel: "Delete permanently",
          destructive: true,
        }
      ))
    ) {
      return;
    }

    setActionNotice("");
    setDeletingLogId(entry.id);
    setLoadError("");
    try {
      await api.del(`/maintenance/${entry.id}/permanent`);
      await loadLogs();
      await refreshStatus?.();
      setActionNotice("Maintenance log entry was permanently deleted.");
    } catch (error) {
      setLoadError(error.message || "Could not permanently delete this maintenance entry.");
    } finally {
      setDeletingLogId(null);
    }
  };

  const saveAsset = async (values) => {
    if (!isAdministrator) return;
    await api.patch(`/assets/${assetId}`, {
      name: values.name.trim(),
      asset_type: values.asset_type.trim(),
      description: values.description?.trim() || null,
      is_active: String(values.is_active) === "true",
    });

    setModal(null);
    await reload();
  };

  const addVariable = async (values) => {
    if (!isAdministrator) return;
    await api.post(`/assets/${assetId}/variables`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      signal_role:
        values.data_type === "boolean" && values.signal_role
          ? values.signal_role
          : null,
      unit: values.unit?.trim() || null,
      opcua_node_id: values.opcua_node_id?.trim() || null,
    // Data source and connector
    data_source: values.data_source || "none",
    connector_id:
      values.data_source === "connector"
        ? values.connector_id || null
        : null,
  });

  setEditingVariable(null);
  setModal("variables");
  await loadVariables();
};

  const updateVariable = async (values) => {
    if (!isAdministrator || !editingVariable) return;
    await api.patch(`/variables/${editingVariable.id}`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      signal_role:
        values.data_type === "boolean" && values.signal_role
          ? values.signal_role
          : null,
      unit: values.unit?.trim() || null,
      opcua_node_id: values.opcua_node_id?.trim() || null,
    });

    setEditingVariable(null);
    setModal("variables");
    await loadVariables();
  };

  const deleteAsset = async () => {
    if (!isAdministrator || deletingAsset) return;
    const confirmed = await confirm(
      `Permanently delete asset "${asset.name}" and its asset-scoped event history? This cannot be undone. Deletion is blocked if it still has child assets, variables, readings, rules, alerts, or maintenance records.`,
      {
        title: "Permanently delete asset",
        confirmLabel: "Delete permanently",
        destructive: true,
      }
    );
    if (!confirmed) return;

    setDeletingAsset(true);
    setLoadError("");
    try {
      await api.del(`/assets/${assetId}`);
      await reload();
      navigate("/assets", { replace: true });
    } catch (error) {
      setLoadError(error.message || "Could not delete the asset.");
    } finally {
      setDeletingAsset(false);
    }
  };

  const deleteVariable = async (variable) => {
    if (!isAdministrator || deletingVariableId !== null) return;
    const confirmed = await confirm(
      `Permanently delete variable "${variable.name}"? Variables with readings, monitoring rules, alerts, or an OPC UA mapping cannot be deleted.`,
      {
        title: "Permanently delete variable",
        confirmLabel: "Delete permanently",
        destructive: true,
      }
    );
    if (!confirmed) return;

    setDeletingVariableId(variable.id);
    setVariableDeleteError("");
    try {
      await api.del(`/variables/${variable.id}`);
      await loadVariables();
    } catch (error) {
      setVariableDeleteError(
        error.message || "Could not delete this variable."
      );
    } finally {
      setDeletingVariableId(null);
    }
  };

  if (!asset) {
    return assetsLoaded ? (
      <div className="panel">
        <EmptyState
          title="This asset was not found"
          lines={[
            "It may have been removed. Pick another asset from the panel.",
          ]}
        />
      </div>
    ) : (
      <div className="loading" role="status">
        Loading…
      </div>
    );
  }

  const health = asset.health || "ok";

  return (
    <div className="asset-page">
      {loadError && (
        <div className="banner error" role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              setLoadError("");
              refreshAll();
            }}
          >
            Dismiss and retry
          </button>
        </div>
      )}
      {actionNotice && (
        <div className="banner success" role="status">
          <p>{actionNotice}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => setActionNotice("")}
          >
            Dismiss
          </button>
        </div>
      )}
      {bulkSaving && (
        <div className="banner" role="status" aria-live="polite">
          <p>Updating rule states and resolving alerts where required…</p>
        </div>
      )}

      <div className="asset-head">
        <div>
          <h1 className="page-title">{asset.name}</h1>

          <div className="asset-sub">
            <span className={"health-chip " + health}>
              <i className={"lamp " + health} />
              {HEALTH_LABEL[health]}
            </span>

            <span className="muted">{asset.asset_type}</span>

            {asset.description && (
              <span className="muted">
                {asset.description}
              </span>
            )}
          </div>
          {isAdministrator && hasChildren && (
            <AssetSupervisors assetId={asset.id} />
          )}
        </div>

        <div className="asset-links">
          <button
            className="link-btn"
            onClick={() => setModal("settings")}
            disabled={!isAdministrator}
            title={!isAdministrator ? "Administrator access required to manage assets." : undefined}
          >
            <GearIcon size={17} /> Asset settings
          </button>

          <button
            className="link-btn danger-link"
            onClick={deleteAsset}
            disabled={deletingAsset || !isAdministrator}
            title={!isAdministrator ? "Administrator access required to manage assets." : "Permanently delete this asset if it has no related records"}
          >
            {deletingAsset ? "Deleting asset…" : "Delete asset"}
          </button>
          <button
          type="button"
          className="link-btn"
          disabled={isSupervisor || isOperator}
          title={
            isSupervisor || isOperator
            ? "Supervisors and Operators cannot manage variables."
            : "View configured variables; only Administrators can change them."
          }
          onClick={() => {
            if (isSupervisor || isOperator) return;
            setModal("variables");
            }}
            >
              <AssetIcon size={17} /> Variables
            </button>
          <button
            className="icon-outline"
            title="Open in new tab"
            aria-label="Open in new tab"
            onClick={() =>
              window.open(window.location.href, "_blank")
            }
          >
            <ExternalIcon size={18} />
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {[
          ["status", "Current status"],
          ["logbook", "Maintenance logbook"],
          ["events", "Event log"],
        ].map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "status" && (
        <>
          <div className="toolbar rule-toolbar">
            <button
              className={
                "icon-outline sm" +
                (showFilter ? " on" : "")
              }
              onClick={() => setShowFilter(!showFilter)}
              title="Filter rules"
              aria-label="Filter rules"
            >
              <FilterIcon size={17} />
            </button>

            {showFilter && (
              <input
                className="mini-input"
                placeholder="Filter rules"
                aria-label="Filter rules"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}

            <div className="segment">
              <button
                className={
                  list === "activated" ? "active" : ""
                }
                onClick={() => setList("activated")}
              >
                Activated <span>({nAct})</span>
              </button>

              <button
                className={
                  list === "not_activated" ? "active" : ""
                }
                onClick={() => setList("not_activated")}
              >
                Not activated <span>({nNot})</span>
              </button>
            </div>

            <button
              className="icon-outline sm logbook-action-menu-trigger"
              onClick={refreshAll}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshIcon size={17} />
            </button>

            <label className="switch-label">
              <input
                type="checkbox"
                className="sr-only"
                checked={children}
                onChange={() => setChildren(!children)}
              />

              <span
                className={
                  "switch" + (children ? " on" : "")
                }
                aria-hidden="true"
              >
                <i />
              </span>

              Include child assets
            </label>

            <div className="spacer" />

            <div className="dropdown" data-menu-open={sortMenu}>
              <button
                className="link-btn"
                onClick={() => setSortMenu(!sortMenu)}
                aria-haspopup="menu"
                aria-expanded={sortMenu}
              >
                Sort by {sort === "name" ? "name" : "severity"}{" "}
                <ChevronDown size={14} />
              </button>

              {sortMenu && (
                <FloatingMenu role="menu">
                  <div
                    role="menuitem"
                    onClick={() => {
                      setSort("severity");
                      setSortMenu(false);
                    }}
                  >
                    Severity
                  </div>

                  <div
                    role="menuitem"
                    onClick={() => {
                      setSort("name");
                      setSortMenu(false);
                    }}
                  >
                    Name
                  </div>
                </FloatingMenu>
              )}
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={isSupervisor || !canManageRules}
              title={
                isSupervisor
                  ? "Supervisors cannot add monitoring rules."
                  : !canManageRules
                    ? "You do not have permission to manage monitoring rules."
                    : "Add rule"
              }
              onClick={() => {
                if (isSupervisor || !canManageRules) return;
                setModal("addRuleOptions");
              }}
            >
              <PlusCircle size={17} /> Add Rule
            </button>

            <div className="dropdown" data-menu-open={menu}>
              <button
                className="icon-outline sm logbook-action-menu-trigger"
                onClick={() => setMenu(!menu)}
                title="Rule actions"
                aria-label="Rule actions"
                aria-haspopup="menu"
                aria-expanded={menu}
              >
                <DotsIcon size={17} />
              </button>
                {menu && (
                  <FloatingMenu align="right" role="menu">
                      <button
                      type="button"
                      disabled={bulkSaving || !canManageRules}
                      title={!canManageRules ? "You do not have permission to manage monitoring rules." : undefined}
                      role="menuitem"
                      onClick={() => bulk("activated")}
                      >
                        {bulkSaving ? "Updating rules…" : "Activate all rules"}
                      </button>
                        <button
                        type="button"
                        disabled={bulkSaving || !canManageRules}
                        title={!canManageRules ? "You do not have permission to manage monitoring rules." : undefined}
                      role="menuitem"
                        onClick={() => bulk("not_activated")}
                        >Deactivate all rules</button>
                        </FloatingMenu>
                      )}
                    </div>
                    </div>

          {shown.length === 0 && list === "activated" ? (
            <div className="panel">
              <EmptyState
                art={false}
                title={
                  list === "activated"
                    ? "No activated rules"
                    : "No rules are switched off"
                }
                lines={[
                  list === "activated"
                    ? "Select “Add rule” to watch a variable on this asset."
                    : "Rules you deactivate are kept here and can be activated again.",
                ]}
              />
            </div>
          ) : (
            <div className="rule-list">
              {shown.map((rule) => {
                const state = ruleStates.get(rule.id);

                const currentValue =
                  state?.latest_value ?? rule.latest_value;
                const runtimeReading = runtimeReadings.get(rule.variable_id);
                const evaluatedAt = state?.last_evaluated_at
                  ? new Date(state.last_evaluated_at).getTime()
                  : Number.NaN;
                const signalAt = runtimeReading?.recorded_at
                  ? new Date(runtimeReading.recorded_at).getTime()
                  : Number.NaN;
                const signalIsFresh =
                  Number.isFinite(signalAt) &&
                  clockNow - signalAt <=
                    (Number(rule.stale_after_seconds) || 300) * 1000;
                const runtimeIsRunning =
                  rule.rule_type === "runtime_duration" &&
                  state?.status !== "unknown" &&
                  runtimeReading?.value === true &&
                  signalIsFresh;
                const displayedValue =
                  runtimeIsRunning &&
                  Number.isFinite(currentValue) &&
                  Number.isFinite(evaluatedAt)
                    ? currentValue +
                      Math.max(0, clockNow - evaluatedAt) / 1000
                    : currentValue;
                const numericCurrentValue =
                  displayedValue === null || displayedValue === undefined
                    ? Number.NaN
                    : Number(displayedValue);
                const runtimeCurrentSeconds =
                  rule.rule_type === "runtime_duration" &&
                  !Number.isFinite(numericCurrentValue)
                    ? 0
                    : numericCurrentValue;
                const canShowNextThreshold =
                  rule.rule_type === "boolean_count_threshold" &&
                  lifecycleStatus(rule) === "in_progress" &&
                  ["ok", "warning"].includes(rule.status) &&
                  Number.isFinite(numericCurrentValue);
                const nextThreshold = canShowNextThreshold
                  ? thresholdSequence(rule).find(
                      (threshold) => threshold.value > numericCurrentValue
                    )
                  : null;
                const formattedCurrentValue =
                  rule.rule_type === "runtime_duration"
                    ? formatDuration(displayedValue)
                    : rule.rule_type === "boolean_count_threshold" &&
                        Number.isFinite(numericCurrentValue)
                      ? numericCurrentValue.toLocaleString()
                      : formatValue(displayedValue);
                const formattedNextThreshold = nextThreshold
                  ? rule.rule_type === "runtime_duration"
                    ? formatDuration(nextThreshold.value)
                    : nextThreshold.value.toLocaleString()
                  : null;
                const scheduledActivationAt =
                  rule.rule_type === "runtime_duration"
                    ? Date.parse(rule.parameters?.activation_at)
                    : Number.NaN;
                const scheduledStartCountdown =
                  lifecycleStatus(rule) === "in_progress" &&
                  Number.isFinite(scheduledActivationAt) &&
                  scheduledActivationAt > clockNow
                    ? scheduledActivationAt - clockNow
                    : null;
                const runtimeThresholds = thresholdSequence(rule);
                const runtimeNextThreshold =
                  rule.rule_type === "runtime_duration" &&
                  Number.isFinite(runtimeCurrentSeconds)
                    ? runtimeThresholds.find(
                        (threshold) => threshold.value > runtimeCurrentSeconds
                      )
                    : null;
                const runtimeAlertReached =
                  rule.rule_type === "runtime_duration" &&
                  Number.isFinite(runtimeCurrentSeconds) &&
                  runtimeCurrentSeconds >=
                    Number(rule.parameters?.alert_threshold_seconds);
                const runtimeAlert =
                  rule.rule_type === "runtime_duration"
                    ? alerts.find(
                        (alert) =>
                          alert.rule_id === rule.id &&
                          alert.target_asset_id ===
                            (state?.target_asset_id ?? rule.target_asset_id) &&
                          alert.severity === "alert" &&
                          alert.status === "active"
                      )
                    : null;
                const runtimeAlertPending =
                  runtimeAlertReached &&
                  lifecycleStatus(rule) === "in_progress" &&
                  state?.status === "alert" &&
                  runtimeAlert &&
                  !runtimeAlert.acknowledged_at;
                const runtimeAlertStartedAt = Date.parse(
                  state?.last_transition_at || ""
                );
                const runtimeOvertimeSeconds = runtimeAlertPending
                  ? Number.isFinite(runtimeAlertStartedAt)
                    ? Math.max(0, (clockNow - runtimeAlertStartedAt) / 1000)
                    : Math.max(
                        0,
                        runtimeCurrentSeconds -
                          Number(rule.parameters?.alert_threshold_seconds)
                      )
                  : 0;
                const parameters = rule.parameters || {};
                const isTimedBooleanRule =
                  rule.rule_type === "duration" &&
                  typeof parameters.expected_value === "boolean" &&
                  Number.isFinite(Number(parameters.duration_seconds));
                const conditionStartedAt = state?.condition_started_at
                  ? new Date(state.condition_started_at).getTime()
                  : Number.NaN;
                const conditionMatches =
                  isTimedBooleanRule &&
                  displayedValue === parameters.expected_value;
                const conditionElapsedSeconds =
                  conditionMatches && Number.isFinite(conditionStartedAt)
                      ? Math.max(0, (clockNow - conditionStartedAt) / 1000)
                      : 0;

                return (
                  <article
                    key={rule.id}
                    className={`rule-row rule-card ${rule.status || "unknown"}${ruleActionMenuId === rule.id ? " rule-card-menu-open" : ""}`}
                  >
                    <span className={"sev " + rule.status} />

                    <div className="rule-name rule-card-main">
                      <strong>{rule.name}</strong>
                      {rule.description && (
                        <small className="rule-description">{rule.description}</small>
                      )}
                      {ruleConditionSummary(rule) && (
                        <small
                          className={`rule-description${rule.evaluation_error === "invalid_rule_or_reading" ? " error-message" : ""}`}
                        >
                          {ruleConditionSummary(rule)}
                        </small>
                      )}
                    </div>

                    <div className="rule-evaluation">
                      <StatusBadge status={rule.status} />
                      <span className="rule-lifecycle-label">
                        {lifecycleLabel(rule)}
                      </span>
                    </div>

                    <div className="rule-card-metrics">
                      <div className="rule-current-next-value">
                        <span>
                          {list === "not_activated"
                            ? "Last evaluated"
                            : scheduledStartCountdown !== null
                                ? "Due in"
                                : isTimedBooleanRule
                                  ? "Signal / Hold time"
                                : rule.rule_type === "boolean_count_threshold"
                                  ? "Current / Target"
                                : rule.rule_type === "runtime_duration"
                                  ? runtimeAlertPending
                                    ? "Take action"
                                    : "Current / Next"
                                : "Current / Next"}
                        </span>
                        <b>
                          {list === "not_activated"
                            ? rule.last_evaluated_at
                              ? formatTime(rule.last_evaluated_at)
                              : "Not evaluated yet"
                            : scheduledStartCountdown !== null
                              ? formatTimeUntilStart(scheduledStartCountdown)
                              : isTimedBooleanRule
                                ? `${formatValue(displayedValue)} · ${formatDuration(conditionElapsedSeconds)} / ${formatDuration(parameters.duration_seconds)}`
                            : rule.rule_type === "runtime_duration"
                              ? runtimeAlertPending
                                ? `Required time complete · ${formatDuration(runtimeOvertimeSeconds)} over`
                                : `${formatDuration(runtimeCurrentSeconds)} / ${runtimeNextThreshold ? `Next warning in ${formatDuration(runtimeNextThreshold.value - runtimeCurrentSeconds)}` : "—"}`
                            : <>
                                {displayedValue !== null && displayedValue !== undefined
                                  ? formattedCurrentValue
                                  : "—"}
                                {" / "}
                                {nextThreshold
                                  ? rule.rule_type === "boolean_count_threshold"
                                    ? formattedNextThreshold
                                    : `${nextThreshold.label} at ${formattedNextThreshold}`
                                  : "—"}
                              </>}
                        </b>
                      </div>
                    </div>

                    <div className="rule-card-actions">
                      <div
                        className="dropdown rule-actions-menu"
                        data-menu-open={ruleActionMenuId === rule.id}
                      >
                        <button
                          type="button"
                          className="icon-outline sm"
                          title={`More actions for ${rule.name}`}
                          aria-label={`More actions for ${rule.name}`}
                          aria-haspopup="menu"
                          aria-expanded={ruleActionMenuId === rule.id}
                          onClick={() =>
                            setRuleActionMenuId((current) =>
                              current === rule.id ? null : rule.id
                            )
                          }
                        >
                          <DotsIcon size={17} />
                     
</button>
{ruleActionMenuId === rule.id && (
  <FloatingMenu align="right" role="menu">
    <button
      type="button"
      className="rule-action-menu-item rule-action-menu-item--view"
      role="menuitem"
      onClick={() => {
        setRuleActionMenuId(null);
        openRuleDetails(rule);
      }}
    >
      <Eye size={16} aria-hidden="true" />
      <span>View rule</span>
    </button>

    <button
      type="button"
      className="rule-action-menu-item rule-action-menu-item--edit"
      role="menuitem"
      onClick={() => {
        setRuleActionMenuId(null);
        openEditRuleForm(rule);
      }}
      disabled={!canManageRules && !isSupervisor}
      title={
        !canManageRules
          ? "You do not have permission to manage monitoring rules."
          : undefined
      }
    >
      <Pencil size={16} aria-hidden="true" />
      <span>Edit rule</span>
    </button>

    {/* Suspend rule */}
    {lifecycleStatus(rule) === "in_progress" && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--lifecycle"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          setLifecycleAction({ rule, action: "suspend" });
        }}
        disabled={isSupervisor ||deletingRuleId !== null ||!canManageRules}
        title={
          !canManageRules
            ? "You do not have permission to manage monitoring rules."
            : undefined
        }
      >
        Suspend rule
      </button>
    )}

    {/* Activate rule: suspended */}
    {lifecycleStatus(rule) === "suspended" && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--lifecycle"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          setLifecycleAction({ rule, action: "resume" });
        }}
        disabled={deletingRuleId !== null || !isAdministrator}
        title={
          !isAdministrator
            ? "Only Administrators can archive rules."
            : undefined
        }
      >
        Activate rule
      </button>
    )}

    {/* Activate rule: deactivated */}
    {lifecycleStatus(rule) === "deactivated" && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--lifecycle"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          setLifecycleAction({ rule, action: "activate" });
        }}
        disabled={deletingRuleId !== null || !canManageRules}
        title={
          !canManageRules
            ? "You do not have permission to manage monitoring rules."
            : undefined
        }
      >
        Activate rule
      </button>
    )}

    {/* Deactivate rule */}
    {["in_progress", "suspended"].includes(lifecycleStatus(rule)) && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--lifecycle"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          setLifecycleAction({ rule, action: "deactivate" });
        }}
        disabled={isSupervisor ||deletingRuleId !== null ||!canManageRules}
        title={
          !canManageRules
            ? "You do not have permission to manage monitoring rules."
            : undefined
        }
      >
        Deactivate rule
      </button>
    )}

    {/* Archive */}
    {lifecycleStatus(rule) !== "in_progress" &&
      lifecycleStatus(rule) !== "completed" && (
        <button
          type="button"
          className="rule-action-menu-item rule-action-menu-item--lifecycle"
          role="menuitem"
          onClick={() => {
            setRuleActionMenuId(null);
            remove(rule);
          }}
          disabled={deletingRuleId !== null || !canManageRules}
          title={
            !canManageRules
              ? "You do not have permission to manage monitoring rules."
              : undefined
          }
        >
          Archive
        </button>
      )}

    {lifecycleStatus(rule) !== "in_progress" && (
      <button
        type="button"
        className="rule-action-menu-item rule-action-menu-item--delete"
        role="menuitem"
        onClick={() => {
          setRuleActionMenuId(null);
          permanentlyDeleteRule(rule);
        }}
        disabled={!isAdministrator || deletingRuleId !== null}
        title={!isAdministrator ? "Only Administrators can permanently delete rules." : "Permanently delete rule"}
      >
        <Trash2 size={16} aria-hidden="true" />
        <span>{deletingRuleId === rule.id ? "Deleting…" : "Delete rule"}</span>
      </button>
    )}
                          </FloatingMenu>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          <CurrentMaintenanceCards
            assetId={assetId}
            onChanged={refreshMaintenanceData}
            onCompletedRecordsCount={setCompletedMaintenanceCount}
            onCompleted={() => setList("not_activated")}
            showCompleted={list === "not_activated"}
          />
        </>
      )}

{tab === "logbook" && (
  <>
    <MaintenancePanel
      assetId={assetId}
      onChanged={refreshMaintenanceData}
    />

   
<div className="panel maintenance-log-notes-panel">
  <div className="panel-head maintenance-log-notes-head">
    <div>
      <h2>Maintenance Logbook</h2>
      <span className="muted">
        {filteredLogs.length} maintenance entries
      </span>
    </div>
    <button
      type="button"
      className="icon-outline sm export-icon"
      title={exporting ? "Preparing Excel export" : "Export filtered maintenance logbook entries to Excel"}
      aria-label="Export maintenance logbook entries to Excel"
      disabled={filteredLogs.length === 0 || exporting}
      onClick={() =>
        exportExcel({
          headers: ["Date and time", "Entry", "Entry type", "Technician"],
          rows: filteredLogs.map((entry) => [
            entry.time || entry.created_at
              ? formatTime(entry.time || entry.created_at)
              : "",
            entry.text || entry.title || entry.summary || "",
            entry.maintenance_type || "Note",
            entry.assigned_technician || "",
          ]),
          sheetName: "Maintenance logbook",
          fileName: `${assetFileName}-maintenance-logbook-${exportFileDate}.xlsx`,
          confirmMessage: `Download ${filteredLogs.length} filtered maintenance logbook entries as an Excel file?`,
        })
      }
    >
      <Download size={17} aria-hidden="true" />
    </button>
  </div>
  {exportError && <p className="notice error" role="alert">{exportError}</p>}

  <div className="maintenance-log-filters" aria-label="Filter maintenance logbook">
    <label>
      <span>Entry type</span>
      <select
        value={maintenanceTypeFilter}
        onChange={(event) => setMaintenanceTypeFilter(event.target.value)}
      >
        <option value="">All types</option>
        {maintenanceTypes.map((type) => (
          <option key={type} value={type}>
            {type.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>

    <label>
      <span>From</span>
      <input
        type="datetime-local"
        value={maintenanceStartDateTime}
        onChange={(event) => setMaintenanceStartDateTime(event.target.value)}
      />
    </label>

    <label>
      <span>To</span>
      <input
        type="datetime-local"
        value={maintenanceEndDateTime}
        onChange={(event) => setMaintenanceEndDateTime(event.target.value)}
      />
    </label>

    <button
      type="button"
      className="btn-outline"
      onClick={() => {
        setMaintenanceTypeFilter("");
        setMaintenanceStartDateTime("");
        setMaintenanceEndDateTime("");
      }}
      disabled={
        !maintenanceTypeFilter &&
        !maintenanceStartDateTime &&
        !maintenanceEndDateTime
      }
    >
      Clear filters
    </button>
    <span className="maintenance-log-filter-count">
      Showing {filteredLogs.length} of {logs.length} entries
    </span>
  </div>

  {filteredLogs.length === 0 ? (
    <EmptyState
      art={false}
      title={logs.length === 0 ? "No maintenance entries" : "No entries match these filters"}
      lines={logs.length === 0 ? ["Maintenance records and notes will appear here."] : []}
    />
  ) : (
    <div className="maintenance-table-wrap">
      <table className="table maintenance-notes-table">
        <thead>
          <tr>
            <th className="col-time">Date and time</th>
            <th>Entry</th>
            <th>Entry type</th>
            <th>Technician</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          {filteredLogs.map((entry) => {
            const timestamp = entry.time || entry.created_at;

            return (
              <tr key={entry.id}>
                <td className="col-time">
                  {timestamp ? formatTime(timestamp) : "—"}
                </td>

                <td className="maintenance-note-text">
                  {entry.text || entry.title || entry.summary || "—"}
                </td>

                <td>
                  {entry.maintenance_type || "Note"}
                </td>

                <td>
                  {entry.assigned_technician || "—"}
                </td>

                <td>
                  <div className="maintenance-actions">
                    <button
                      type="button"
                      className="icon-outline sm"
                      aria-label={`Maintenance logbook actions for ${entry.title || entry.summary || entry.id}`}
                      aria-haspopup="menu"
                      aria-expanded={ruleActionMenuId === `maintenance-log-${entry.id}`}
                      onClick={() => {
                        const menuId = `maintenance-log-${entry.id}`;
                        setRuleActionMenuId((current) =>
                          current === menuId ? null : menuId
                        );
                      }}
                      disabled={deletingLogId !== null}
                    >
                      <DotsIcon size={17} />
                    </button>
                    {ruleActionMenuId === `maintenance-log-${entry.id}` && (
                      <FloatingMenu align="right" role="menu">
                        <button
                          type="button"
                          className="rule-action-menu-item rule-action-menu-item--view"
                          role="menuitem"
                          onClick={() => {
                            setRuleActionMenuId(null);
                            setSelectedEntry(entry);
                            setModal("view");
                          }}
                        >
                          <Eye size={16} aria-hidden="true" />
                          <span>View</span>
                        </button>
                        {isAdministrator && (
                          <button
                            type="button"
                            className="rule-action-menu-item rule-action-menu-item--delete"
                            role="menuitem"
                            title="Permanently delete maintenance log entry"
                            onClick={() => {
                              setRuleActionMenuId(null);
                              deleteLogEntry(entry);
                            }}
                            disabled={deletingLogId !== null}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            <span>Delete</span>
                          </button>
                        )}
                      </FloatingMenu>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  )}
</div>
  </>
)}


      

{/* Event Log */}
{tab === "events" && (
  <div className="event-log-section">
    <div className="event-log-heading">
      <div>
        <h2>Event log</h2>
        <span className="muted">{filteredEvents.length} events</span>
      </div>
      <button
        type="button"
        className="icon-outline sm export-icon"
        title={exporting ? "Preparing Excel export" : "Export filtered events to Excel"}
        aria-label="Export event log to Excel"
        disabled={filteredEvents.length === 0 || exporting}
        onClick={() =>
          exportExcel({
            headers: ["Date and time", "Event", "Details", "Asset", "Assigned rule"],
            rows: filteredEvents.map((event) => [
              event.time || event.occurred_at
                ? new Date(event.time || event.occurred_at).toLocaleString()
                : "",
              eventActionLabel(event.event_type),
              [event.text || event.message || "", eventAuditSummary(event)]
                .filter(Boolean)
                .join(" · "),
              event.asset_name ||
                (event.asset_id != null ? `Asset ${event.asset_id}` : "System"),
              event.rule_name ||
                event.assigned_rule ||
                event.rule?.name ||
                (event.event_type === "maintenance_completed"
                  ? "Maintenance"
                  : event.rule_id != null
                    ? `Rule #${event.rule_id}`
                    : "Not assigned"),
            ]),
            sheetName: "Event log",
            fileName: `${assetFileName}-event-log-${exportFileDate}.xlsx`,
            confirmMessage: `Download ${filteredEvents.length} filtered events as an Excel file?`,
          })
        }
      >
        <Download size={17} aria-hidden="true" />
      </button>
    </div>
    {exportError && <p className="notice error" role="alert">{exportError}</p>}
    {eventDeleteError && (
      <div className="event-log-error" role="alert">
        {eventDeleteError}
      </div>
    )}
    <div className="event-log-filters" aria-label="Filter event log">
      <label>
        <span>Event</span>
        <select
          value={eventTypeFilter}
          onChange={(event) => setEventTypeFilter(event.target.value)}
        >
          <option value="">All events</option>
          {eventTypes.map((eventType) => (
            <option key={eventType} value={eventType}>
              {eventActionLabel(eventType)}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>From</span>
        <input
          type="datetime-local"
          value={eventStartDateTime}
          onChange={(event) => setEventStartDateTime(event.target.value)}
        />
      </label>

      <label>
        <span>To</span>
        <input
          type="datetime-local"
          value={eventEndDateTime}
          onChange={(event) => setEventEndDateTime(event.target.value)}
        />
      </label>

      <button
        type="button"
        className="btn-outline"
        onClick={() => {
          setEventTypeFilter("");
          setEventStartDateTime("");
          setEventEndDateTime("");
        }}
        disabled={
          !eventTypeFilter &&
          !eventStartDateTime &&
          !eventEndDateTime
        }
      >
        Clear filters
      </button>
      <span className="event-filter-count">
        Showing {filteredEvents.length} of {events.length} events
      </span>
    </div>

    <div className="table-responsive">
      <table className="data-table event-log-table">
        <thead>
          <tr>
            <th>Date &amp; Time</th>
            <th>Event</th>
            <th>Asset</th>
            <th>Assigned Rule</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          {filteredEvents.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty-state">
                {events.length === 0
                  ? "No events found."
                  : "No events match these filters."}
              </td>
            </tr>
          ) : (
            filteredEvents.map((event) => {
              const assignedRule =
                event.rule_name ||
                event.assigned_rule ||
                event.rule?.name ||
                (event.event_type === "maintenance_completed"
                  ? "Maintenance"
                  : null) ||
                (event.rule_id != null
                  ? `Rule #${event.rule_id}`
                  : "Not assigned");

              const eventTime = (event.time || event.occurred_at)
                ? new Date(event.time || event.occurred_at).toLocaleString()
                : "—";

              return (
                <tr key={event.id}>
                  <td>{eventTime}</td>

                  <td>
                    <strong>{eventActionLabel(event.event_type)}</strong>
                    <div>{event.text || event.message || "—"}</div>
                    {eventAuditSummary(event) && (
                      <small className="muted">{eventAuditSummary(event)}</small>
                    )}
                  </td>

                  <td>
                    {event.asset_name ||
                      (event.asset_id != null ? `Asset ${event.asset_id}` : "System")}
                  </td>

                  <td>{assignedRule}</td>

                  <td>
                    <div className="event-row-actions">
                      <button
                        type="button"
                        className="icon-outline sm"
                        aria-label={`Event log actions for ${eventActionLabel(event.event_type)}`}
                        aria-haspopup="menu"
                        aria-expanded={ruleActionMenuId === `event-log-${event.id}`}
                        onClick={() => {
                          const menuId = `event-log-${event.id}`;
                          setRuleActionMenuId((current) =>
                            current === menuId ? null : menuId
                          );
                        }}
                      >
                        <DotsIcon size={17} />
                      </button>
                      {ruleActionMenuId === `event-log-${event.id}` && (
                        <FloatingMenu align="right" role="menu">
                          <button
                            type="button"
                            className="rule-action-menu-item rule-action-menu-item--view"
                            role="menuitem"
                            onClick={() => {
                              setRuleActionMenuId(null);
                              setEventDeleteError("");
                              setSelectedEvent(event);
                              setShowEventDetails(true);
                            }}
                          >
                            <Eye size={16} aria-hidden="true" />
                            <span>View</span>
                          </button>
                          {isAdministrator && (
                            <button
                              type="button"
                              className="rule-action-menu-item rule-action-menu-item--delete"
                              role="menuitem"
                              title="Permanently delete event"
                              aria-label={`Permanently delete ${eventActionLabel(event.event_type)} event`}
                              disabled={deletingEventId !== null}
                              onClick={() => {
                                setRuleActionMenuId(null);
                                deleteEvent(event);
                              }}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                              <span>Delete</span>
                            </button>
                          )}
                        </FloatingMenu>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  </div>
)}


{showEventDetails && selectedEvent && (
  <Modal
    title="Event Details"
    onClose={() => {
      setShowEventDetails(false);
      setSelectedEvent(null);
    }}
  >
      <div className="event-details-content">
        {eventDeleteError && (
          <p className="event-log-error" role="alert">{eventDeleteError}</p>
        )}
        <p>
          <strong>Date &amp; Time:</strong>{" "}
          {(selectedEvent.time || selectedEvent.occurred_at)
            ? new Date(selectedEvent.time || selectedEvent.occurred_at).toLocaleString()
            : "—"}
        </p>

        <p>
          <strong>Action:</strong>{" "}
          {eventActionLabel(selectedEvent.event_type)}
        </p>

        <p>
          <strong>Event details:</strong>{" "}
          {selectedEvent.text || selectedEvent.message || "—"}
        </p>
        {selectedEvent.metadata?.acknowledged_by && (
          <>
            <p>
              <strong>Acknowledged by:</strong>{" "}
              {selectedEvent.metadata.acknowledged_by}
            </p>
            <p>
              <strong>Acknowledged at:</strong>{" "}
              {selectedEvent.metadata.acknowledged_at
                ? formatTime(selectedEvent.metadata.acknowledged_at)
                : (selectedEvent.time || selectedEvent.occurred_at)
                  ? formatTime(selectedEvent.time || selectedEvent.occurred_at)
                  : "—"}
            </p>
          </>
        )}
        {selectedEvent.metadata?.completed_by && (
          <>
            <p>
              <strong>Completed by:</strong>{" "}
              {selectedEvent.metadata.completed_by}
            </p>
            <p>
              <strong>Completed at:</strong>{" "}
              {selectedEvent.metadata.completed_at
                ? formatTime(selectedEvent.metadata.completed_at)
                : (selectedEvent.time || selectedEvent.occurred_at)
                  ? formatTime(selectedEvent.time || selectedEvent.occurred_at)
                  : "—"}
            </p>
            <p><strong>Result:</strong> Rule successfully completed.</p>
          </>
        )}

        <p>
          <strong>Asset:</strong>{" "}
          {selectedEvent.asset_name ||
            (selectedEvent.asset_id != null
              ? `Asset ${selectedEvent.asset_id}`
              : "System")}
        </p>

        <p>
          <strong>Assigned Rule:</strong>{" "}
          {selectedEvent.rule_name ||
            selectedEvent.assigned_rule ||
            selectedEvent.rule?.name ||
            (selectedEvent.rule_id != null
              ? `Rule #${selectedEvent.rule_id}`
              : "Not assigned")}
        </p>
        <div className="event-details-actions">
          <button
            type="button"
            className="event-delete-icon"
            title={!isAdministrator ? "Administrator access required to delete events." : "Permanently delete event"}
            aria-label="Permanently delete event"
            disabled={deletingEventId === selectedEvent.id || !isAdministrator}
            onClick={() => deleteEvent(selectedEvent)}
          >
            <Trash2 size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              setShowEventDetails(false);
              setSelectedEvent(null);
            }}
          >
            Close
          </button>
        </div>
      </div>
  </Modal>
)}
  
{modal === "addRuleOptions" && (
  <Modal
    title="Add Rule"
    onClose={() => setModal(null)}
  >
    <div className="rule-type-options">
      <button
        type="button"
        className="rule-type-option"
        onClick={() => setModal("ruleTypeOptions")}
      >
        <strong>Create a Rule</strong>
        <small>Create an interval, time, or usage-based rule.</small>
      </button>

      <button
        type="button"
        className="rule-type-option"
        onClick={() => {
          setModal(null);
          setShowPredefinedRules(true);
        }}
      >
        <strong>Assign Predefined Monitoring Rules</strong>
        <small>Assign predefined rules to this asset.</small>
      </button>

      <button
        type="button"
        className="rule-type-option"
        onClick={() => setModal("copyRules")}
      >
        <strong>Copy from Another Asset</strong>
        <small>Copy rules from another asset.</small>
      </button>
    </div>
  </Modal>
)}

{modal === "ruleTypeOptions" && (
  <Modal
    title="Create a Rule"
    onClose={() => setModal(null)}
  >
    <div className="rule-type-options">
      {LEGACY_RULE_CHOICES.map((choice) => (
        <button
          key={choice.kind}
          type="button"
          className="rule-type-option"
          onClick={() => {
            setModal(null);
            navigate(legacyRulePath(assetId, choice.kind));
          }}
        >
          <strong>{choice.label}</strong>
          <small>{choice.description}</small>
        </button>
      ))}
    </div>
  </Modal>
)}

{lifecycleAction && (
  <Modal
    title={
      lifecycleAction.action === "suspend"
        ? "Suspend monitoring rule"
        : lifecycleAction.action === "deactivate"
          ? "Deactivate monitoring rule"
          : lifecycleAction.action === "resume"
            ? "Resume monitoring rule"
            : "Activate monitoring rule"
    }
    onClose={() => {
      if (deletingRuleId === null) {
        setLifecycleAction(null);
        setLoadError("");
      }
    }}
  >
    <p>
      {lifecycleAction.action === "suspend"
        ? "Suspending pauses rule evaluation and prevents new alerts. The rule configuration and history will be retained."
        : lifecycleAction.action === "deactivate"
          ? "Are you sure you want to deactivate this monitoring rule? This disables monitoring but does not mark the rule completed. Its configuration and history will be retained."
          : lifecycleAction.action === "resume"
            ? "Resume monitoring using this rule's saved configuration?"
            : "Activate monitoring using this rule's saved configuration?"}
    </p>
    {loadError && <p className="notice error" role="alert">{loadError}</p>}
    <div className="modal-actions">
      <button
        type="button"
        className="btn-outline"
        disabled={deletingRuleId !== null}
        onClick={() => {
          setLifecycleAction(null);
          setLoadError("");
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn-primary"
        disabled={deletingRuleId !== null}
        onClick={confirmLifecycleChange}
      >
        {deletingRuleId === lifecycleAction.rule.id
          ? "Saving…"
          : lifecycleAction.action === "suspend"
            ? "Confirm suspension"
            : lifecycleAction.action === "deactivate"
              ? "Deactivate"
              : lifecycleAction.action === "resume"
                ? "Resume rule"
                : "Activate rule"}
      </button>
    </div>
  </Modal>
)}

{viewRule && (
  <Modal
    title={viewRule.name || "Monitoring rule"}
    onClose={() => {
      setViewRule(null);
      setCompletionDetails(null);
      setCompletionDetailsError("");
    }}
    wide
  >
    <dl className="rule-detail-grid">
      <div>
        <dt>Rule type</dt>
        <dd>
          {viewRule.rule_type === "runtime_duration"
            ? "Running time"
            : viewRule.rule_type === "boolean_count_threshold"
              ? "Cycle count"
              : viewRule.rule_type === "parameter_threshold"
                ? "Parameter threshold"
                : viewRule.rule_type === "duration" &&
                    viewRule.parameters?.condition === "interval_elapsed"
                  ? "Interval based"
                  : viewRule.rule_type?.replaceAll("_", " ") || "—"}
        </dd>
      </div>
      <div>
        <dt>Lifecycle</dt>
        <dd>{lifecycleLabel(viewRule)}</dd>
      </div>
      <div>
        <dt>Evaluation status</dt>
        <dd><StatusBadge status={viewRule.status || "unknown"} /></dd>
      </div>
      <div>
        <dt>Variable</dt>
        <dd>{viewRule.variable_name || "Asset-level rule"}</dd>
      </div>
      <div>
        <dt>Condition</dt>
        <dd>{ruleConditionSummary(viewRule) || "No condition summary available."}</dd>
      </div>
      {viewRule.description && (
        <div>
          <dt>Description</dt>
          <dd>{viewRule.description}</dd>
        </div>
      )}
      {thresholdMetrics(viewRule).map((metric) => (
        <div key={metric.label}>
          <dt>{metric.label} threshold</dt>
          <dd>{metric.value}</dd>
        </div>
      ))}
      <div>
        <dt>Latest value</dt>
        <dd>{formatValue(viewRule.latest_value)}</dd>
      </div>
      <div>
        <dt>Last evaluated</dt>
        <dd>{viewRule.last_evaluated_at ? formatTime(viewRule.last_evaluated_at) : "Not evaluated yet"}</dd>
      </div>
      {viewRule.evaluation_message && (
        <div>
          <dt>Evaluation detail</dt>
          <dd>{viewRule.evaluation_message}</dd>
        </div>
      )}
      {completionDetailsError ? (
        <div>
          <dt>Action history</dt>
          <dd className="error-message">{completionDetailsError}</dd>
        </div>
      ) : completionDetails === null ? (
        <div>
          <dt>Action history</dt>
          <dd>Loading acknowledgement and completion details…</dd>
        </div>
      ) : (
        <>
          {completionDetails.acknowledged_by && (
            <>
              <div>
                <dt>Acknowledged by</dt>
                <dd>{completionDetails.acknowledged_by}</dd>
              </div>
              <div>
                <dt>Acknowledged at</dt>
                <dd>{completionDetails.acknowledged_at
                  ? formatTime(completionDetails.acknowledged_at)
                  : "—"}</dd>
              </div>
            </>
          )}
          {lifecycleStatus(viewRule) === "completed" && (
            <>
              <div>
                <dt>Completion</dt>
                <dd>Rule successfully completed and deactivated.</dd>
              </div>
              <div>
                <dt>Completed by</dt>
                <dd>{completionDetails.completed_by || "—"}</dd>
              </div>
              <div>
                <dt>Completed at</dt>
                <dd>{completionDetails.completed_at
                  ? formatTime(completionDetails.completed_at)
                  : viewRule.completed_at
                    ? formatTime(viewRule.completed_at)
                    : "—"}</dd>
              </div>
            </>
          )}
        </>
      )}
    </dl>
    <div className="modal-actions">
      <button type="button" className="btn-primary" onClick={() => {
        setViewRule(null);
        setCompletionDetails(null);
        setCompletionDetailsError("");
      }}>
        Close
      </button>
    </div>
  </Modal>
)}

{tab === "logbook" && modal === "view" && selectedEntry && (
  <Modal
    title="Maintenance Logbook Entry"
    onClose={() => {
      setModal(null);
      setSelectedEntry(null);
    }}
    wide
  >
    <dl className="rule-detail-grid">
      <div>
        <dt>Date and time</dt>
        <dd>
          {selectedEntry.time || selectedEntry.created_at
            ? formatTime(selectedEntry.time || selectedEntry.created_at)
            : "—"}
        </dd>
      </div>

      <div>
        <dt>Entry</dt>
        <dd>
          {selectedEntry.text ||
            selectedEntry.title ||
            selectedEntry.summary ||
            "—"}
        </dd>
      </div>

      <div>
        <dt>Entry type</dt>
        <dd>{selectedEntry.maintenance_type || "Note"}</dd>
      </div>

      <div>
        <dt>Technician</dt>
        <dd>{selectedEntry.assigned_technician || "—"}</dd>
      </div>

      <div>
        <dt>Priority</dt>
        <dd>{selectedEntry.priority || "—"}</dd>
      </div>

      <div>
        <dt>Actual start</dt>
        <dd>{selectedEntry.actual_started_at ? formatTime(selectedEntry.actual_started_at) : "—"}</dd>
      </div>

      <div>
        <dt>Actual completion</dt>
        <dd>{selectedEntry.actual_completed_at ? formatTime(selectedEntry.actual_completed_at) : "—"}</dd>
      </div>

      <div>
        <dt>Actual duration</dt>
        <dd>
          {Number.isFinite(selectedEntry.actual_duration_seconds)
            ? formatDuration(selectedEntry.actual_duration_seconds)
            : "—"}
        </dd>
      </div>

      {selectedEntry.notes && (
        <div>
          <dt>Notes</dt>
          <dd>{selectedEntry.notes}</dd>
        </div>
      )}

      {selectedEntry.completion_notes && (
        <div>
          <dt>Completion notes</dt>
          <dd>{selectedEntry.completion_notes}</dd>
        </div>
      )}

      {selectedEntry.parts_used && (
        <div>
          <dt>Parts used</dt>
          <dd>{selectedEntry.parts_used}</dd>
        </div>
      )}

      {Array.isArray(selectedEntry.checklist) && selectedEntry.checklist.length > 0 && (
        <div>
          <dt>Checklist</dt>
          <dd>
            {selectedEntry.checklist
              .map((item) => `${item.completed ? "Complete" : "Incomplete"}: ${item.item}`)
              .join(", ")}
          </dd>
        </div>
      )}

      {selectedEntry.id != null && (
        <div>
          <dt>Entry ID</dt>
          <dd>{selectedEntry.id}</dd>
        </div>
      )}
    </dl>

    <div className="modal-actions">
      <button
        type="button"
        className="btn-primary"
        onClick={() => {
          setModal(null);
          setSelectedEntry(null);
        }}
      >
        Close
      </button>
    </div>
  </Modal>
)}

      
{modal === "copyRules" && (
  <CopyRulesModal
    assetId={assetId}
    assets={assets}
    cycleVariableIds={cycleVariableIds}
    runtimeVariableIds={runtimeVariableIds}
    onClose={() => setModal(null)}
    onCopied={async (result) => {
      setModal(null);
      await refreshAll();
      setActionNotice(
        `${result.created.length} rule(s) copied to this asset and created inactive.` +
          (result.already_copied?.length
            ? ` ${result.already_copied.length} matching rule(s) were already present.`
            : "")
      );
    }}
  />
)}


      {modal === "add" && (
        <CreateModal
          title={monitoringRuleSelection?.title || "Create monitoring rule"}
          submitLabel={
            monitoringRuleSelection?.ruleId ? "Save rule" : "Create rule"
          }
          intro={
            !canManageRules
              ? "You do not have permission to create or edit monitoring rules."
              : availableVariables.length
                ? undefined
                : "This asset has no active variables yet. Add one under Variables, then come back to create a rule."
          }
          fields={monitoringRuleFormFields}
          initialValues={monitoringRuleSelection?.initialValues}
          onSubmit={addRule}
          disabled={!canManageRules}
          onClose={() => {
            setModal(null);
            setMonitoringRuleSelection(null);
          }}
        />
      )}

      {modal === "log" && (
        <CreateModal
          title="New logbook entry"
          submitLabel="Add entry"
          fields={LOG_FIELDS}
          onSubmit={addLog}
          disabled={!canManageLogbook}
          intro={!canManageLogbook ? "You do not have permission to add logbook entries." : undefined}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "settings" && (
        <CreateModal
          title="Asset settings"
          submitLabel="Save changes"
          onSubmit={saveAsset}
          disabled={!isAdministrator}
          intro={!isAdministrator ? "Administrator access required to change asset settings." : undefined}
          onClose={() => setModal(null)}
          fields={[
            {
              key: "name",
              label: "Name",
              required: true,
              default: asset.name,
            },
            {
              key: "asset_type",
              label: "Type",
              required: true,
              default: asset.asset_type,
            },
            {
              key: "description",
              label: "Description",
              type: "textarea",
              default: asset.description || "",
            },
            {
              key: "is_active",
              label: "Monitoring",
              type: "select",
              default: String(asset.is_active),
              options: [
                ["true", "Enabled"],
                ["false", "Disabled"],
              ],
              hint:
                "Disabled assets stay in the hierarchy but are greyed out.",
            },
          ]}
        />
      )}

      {(modal === "addVariable" || modal === "editVariable") && (
        <CreateModal
          title={editingVariable ? "Edit variable" : "Add variable"}
          submitLabel={editingVariable ? "Save variable" : "Add variable"}
          fields={VARIABLE_FIELDS}
          initialValues={editingVariable || {}}
          onSubmit={editingVariable ? updateVariable : addVariable}
          disabled={!isAdministrator}
          intro={!isAdministrator ? "Administrator access required to manage variables and OPC UA mappings." : undefined}
          onClose={() => {
            setEditingVariable(null);
            setModal("variables");
          }}
        />
      )}

      {modal === "variables" && (
        <Modal
          title="Variables"
          onClose={() => {
            if (deletingVariableId === null) {
              setModal(null);
              setVariableDeleteError("");
            }
          }}
        >
          {variableDeleteError && (
            <p className="notice error" role="alert">
              {variableDeleteError}
            </p>
          )}
          {allVariables.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Key</th>
                  <th>Type</th>
                  <th>Boolean purpose</th>
                  <th>Unit</th>
                  <th>OPC UA NodeId</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {allVariables.map((variable) => (
                  <tr key={variable.id}>
                    <td>{variable.name}</td>
                    <td>{variable.key}</td>
                    <td>{variable.data_type}</td>
                    <td>
                      {variable.signal_role === "running"
                        ? "Machine running"
                        : variable.signal_role === "cycle"
                          ? "Cycle signal"
                          : "—"}
                    </td>
                    <td>{variable.unit || "—"}</td>
                    <td
                      title={variable.opcua_node_id || undefined}
                      style={{ maxWidth: 180, overflowWrap: "anywhere" }}
                    >
                      {variable.opcua_node_id || "—"}
                    </td>
                    <td>{variable.is_active ? "Active" : "Inactive"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => {
                          setEditingVariable(variable);
                          setModal("editVariable");
                        }}
                        disabled={deletingVariableId !== null || !isAdministrator}
                        title={!isAdministrator ? "Administrator access required to manage variables." : undefined}
                      >
                        Edit
                      </button>
                     <button
                     type="button"
                     className="btn-outline danger"
                     onClick={() => deleteEvent(event)}
                    disabled={!isAdministrator || deletingEventId !== null}
                    title="Delete event permanently"
                    aria-label="Delete event permanently"
                    >
                      <Trash2 size={16} />
                      {deletingEventId === event.id ? "Deleting..." : ""}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              No variables are configured for this asset.
            </p>
          )}

          <div className="modal-actions">
            <button
              className="btn-outline"
              onClick={() => {
                setEditingVariable(null);
                setModal("addVariable");
              }}
              disabled={deletingVariableId !== null || !isAdministrator}
              title={!isAdministrator ? "Administrator access required to manage variables." : undefined}
            >
              Add variable
            </button>

            <button
              className="btn-primary"
              onClick={() => setModal(null)}
              disabled={deletingVariableId !== null}
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {showPredefinedRules && (
        <PredefinedRulesModal
          assetId={assetId}
          onClose={() => setShowPredefinedRules(false)}
          onAssigned={async (result) => {
            setShowPredefinedRules(false);
            setList("not_activated");
            await refreshAll();
            const assigned = result.created?.length || 0;
            const existing = result.already_assigned?.length || 0;
            setActionNotice(
              `${assigned} predefined rule(s) assigned and created inactive.` +
                (existing ? ` ${existing} rule(s) were already assigned.` : "")
            );
          }}
        />
      )}
    </div>
  );
}