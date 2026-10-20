
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import CopyRulesModal from "../components/CopyRulesModal.jsx";
import PredefinedRulesModal from "../../rules/components/PredefinedRulesModal.jsx";
import { api } from "../../../services/api.js";
import MaintenancePanel from "../components/MaintenancePanel.jsx";
import {
  conditionText,
  formatDuration,
  formatTime,
  formatValue,
  timeAgo,
} from "../../../utils/format.js";
import {
  CreateModal,
  EmptyState,
  Modal,
  StatusBadge,
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
} from "../../../components/common/Icons.jsx";

const ORDER = { alert: 0, warning: 1, ok: 2 };

const HEALTH_LABEL = {
  alert: "Alert active",
  warning: "Warning active",
  ok: "No active alerts",
  off: "Disabled",
};

const ruleFields = (variables, cycleVariableIds) => [
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
      ["parameter_threshold", "Numeric value threshold"],
      ["boolean_count_threshold", "Boolean cycle-count thresholds"],
    ],
    hint: "Cycle counts come from this asset's configured PLC cycle signal.",
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
    label: "Configured Boolean cycle signal",
    type: "select",
    required: true,
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    options: variables
      .filter((v) => cycleVariableIds.includes(v.id))
      .map((v) => [v.id, `${v.name} (#${v.id})`]),
    hint: cycleVariableIds.length
      ? "Only Boolean variables configured as this asset's OPC UA cycle signal are available."
      : "No OPC UA cycle signal is configured for this asset. Configure it in backend OPCUA_MACHINE_MAPPINGS first.",
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
    label: "First warning at cycle count",
    type: "number",
    showWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    requiredWhen: { key: "rule_type", equals: "boolean_count_threshold" },
    placeholder: "e.g. 9000",
  },
  {
    key: "warning_threshold_2",
    label: "Second warning at cycle count",
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
    key: "unit",
    label: "Unit",
    placeholder: "e.g. °C, rpm, cycles",
  },
];

export default function AssetDetail() {
  const { id } = useParams();
  const { assets, assetsLoaded, reload, refreshStatus } =
    useOutletContext();

  const assetId = Number(id);
  const asset = assets.find((a) => a.id === assetId);

  const [tab, setTab] = useState("status");
  const [list, setList] = useState("activated");
  const [rules, setRules] = useState([]);
  const [variables, setVariables] = useState([]);
  const [cycleVariableIds, setCycleVariableIds] = useState([]);
  const [readings, setReadings] = useState([]);
  const [ruleStates, setRuleStates] = useState(new Map());
  const [varNames, setVarNames] = useState(new Map());
  const [machine, setMachine] = useState(null);
  const [plcConnection, setPlcConnection] = useState(null);
  const [cycleMapping, setCycleMapping] = useState(null);
  const [children, setChildren] = useState(false);
  const [sort, setSort] = useState("severity");
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [menu, setMenu] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState(null);
  const [actionNotice, setActionNotice] = useState("");
  const [sortMenu, setSortMenu] = useState(false);
  const [modal, setModal] = useState(null);
  const [showPredefinedRules, setShowPredefinedRules] = useState(false);
  const [addRuleMenu, setAddRuleMenu] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logSearch, setLogSearch] = useState("");
  const [logSort, setLogSort] = useState("newest");
  const [logTypeFilter, setLogTypeFilter] = useState("all");
  const [showLogFilter, setShowLogFilter] = useState(false);
  const [logStartDate, setLogStartDate] = useState("");
  const [logEndDate, setLogEndDate] = useState("");
  const [events, setEvents] = useState([]);
  const [loadError, setLoadError] = useState("");
  const navigate = useNavigate();
  const location = useLocation();

  
  const seq = useRef(0);
  const readingRequest = useRef(null);
  const bulkRequest = useRef(false);
  const permanentDeleteRequest = useRef(false);

  
  const loadLive = useCallback(async () => {
    const mine = ++seq.current;

    try {
      const [r, st, plc] = await Promise.allSettled([
        api.get(
          `/assets/${assetId}/rules?include_children=${children}`
        ),
        api.getAll("/monitoring/status", 500),
        api.get("/plc/status"),
      ]);

      if (mine !== seq.current) return;

      if (r.status === "fulfilled") {
        setRules(Array.isArray(r.value) ? r.value : []);
        setLoadError("");
      } else {
        setRules([]);
        setLoadError(
          r.reason?.message || "Unable to load rules."
        );
      }

      if (st.status === "fulfilled") {
        setRuleStates(
          new Map(
            (Array.isArray(st.value) ? st.value : []).map(
              (s) => [s.rule_id, s]
            )
          )
        );
      }

      if (plc.status === "fulfilled") {
        const mappings = Array.isArray(plc.value?.mappings)
          ? plc.value.mappings
          : [];
        const activeCycleMapping = mappings.find(
          (mapping) =>
            mapping.asset_id === assetId &&
            mapping.role === "cycle_signal" &&
            mapping.mapping_valid
        );
        setCycleVariableIds(
          activeCycleMapping ? [activeCycleMapping.variable_id] : []
        );
        setCycleMapping(activeCycleMapping || null);
        setPlcConnection(plc.value?.connection || null);
        setMachine(
          plc.value?.machines?.find(
            (m) => m.asset_id === assetId
          ) || null
        );
      }
    } catch (error) {
      setLoadError(error.message || "Unable to refresh asset monitoring.");
    }
  }, [assetId, children]);

  const loadLatestReadings = useCallback(async () => {
    if (readingRequest.current) return readingRequest.current;

    let request;
    request = (async () => {
      try {
        const result = await api.get(`/readings/assets/${assetId}/latest`);
        setReadings(Array.isArray(result) ? result : []);
      } catch (error) {
        setLoadError(
          error.message || "Unable to refresh latest readings."
        );
      } finally {
        if (readingRequest.current === request) {
          readingRequest.current = null;
        }
      }
    })();
    readingRequest.current = request;
    return request;
  }, [assetId]);

  const loadVariables = useCallback(async () => {
    try {
      const items = await api.getAll(
        `/assets/${assetId}/variables?is_active=true`
      );

      setVariables(Array.isArray(items) ? items : []);

      setVarNames((prev) => {
        const next = new Map(prev);

        (Array.isArray(items) ? items : []).forEach((v) => {
          next.set(v.id, v.name);
        });

        return next;
      });
    } catch (error) {
      setVariables([]);
      setLoadError(
        error.message || "Unable to load variables."
      );
    }
  }, [assetId]);

  const loadLogs = useCallback(() => {
    api
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

  
  useEffect(() => {
    setTab("status");
    setList("activated");
    setFilter("");
    setReadings([]);
    setRules([]);
    setMachine(null);
    setPlcConnection(null);
    setCycleMapping(null);
    setLogs([]);
    setEvents([]);
    setLoadError("");

    loadVariables();
    loadLogs();
    loadLive();
    loadLatestReadings();

    return () => {
      seq.current += 1;
    };
  }, [assetId, loadVariables, loadLogs, loadLive, loadLatestReadings]);

  useEffect(() => {
    const notice = location.state?.createdNotice;
    if (!notice) return;
    setActionNotice(notice);
    setTab("logbook");
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);


  useEffect(() => {
    let active = true;
    let timeoutId;

    const pollReadings = async () => {
      await loadLatestReadings();
      if (active) {
        timeoutId = window.setTimeout(pollReadings, 500);
      }
    };

    timeoutId = window.setTimeout(pollReadings, 500);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [loadLatestReadings]);

  
  useEffect(() => {
    let active = true;
    let timeoutId;

    const poll = async () => {
      await loadLive();
      if (active) {
        timeoutId = window.setTimeout(poll, 1500);
      }
    };

    timeoutId = window.setTimeout(poll, 1500);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [loadLive]);

 
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

  useEffect(() => {
    const missing = [
      ...new Set(
        rules
          .map((r) => r.variable_id)
          .filter((v) => v != null && !varNames.has(v))
      ),
    ];

    if (!missing.length) return;

    let cancelled = false;

    Promise.allSettled(
      missing.map((vid) => api.get(`/variables/${vid}`))
    ).then((results) => {
      if (cancelled) return;

      setVarNames((prev) => {
        const next = new Map(prev);

        results.forEach((res, i) => {
          next.set(
            missing[i],
            res.status === "fulfilled"
              ? res.value.name
              : "Value"
          );
        });

        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [rules, varNames]);

  const availableVariables = variables;
  const ruleFormFields = useMemo(
    () => ruleFields(availableVariables, cycleVariableIds),
    [availableVariables, cycleVariableIds]
  );

  const readingByVariable = new Map(
    readings.map((r) => [r.variable_id, r])
  );

  const isAct = (rule) => rule.state === "activated";
  const nAct = rules.filter(isAct).length;
  const nNot = rules.length - nAct;

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

  
const filteredLogs = [...logs]
  .filter((entry) => {
    const search = logSearch.trim().toLowerCase();

    const matchesSearch =
      !search ||
      String(entry.text || "").toLowerCase().includes(search) ||
      String(entry.maintenance_type || "unknown")
        .toLowerCase()
        .includes(search);

    const matchesType =
      logTypeFilter === "all" ||
      (entry.maintenance_type || "unknown") === logTypeFilter;

    const rawDate = entry.time || entry.created_at;
    const date = new Date(rawDate);

    const matchesStart =
      !logStartDate ||
      (Number.isFinite(date.getTime()) &&
        date >= new Date(`${logStartDate}T00:00:00`));

    const matchesEnd =
      !logEndDate ||
      (Number.isFinite(date.getTime()) &&
        date <= new Date(`${logEndDate}T23:59:59.999`));

    return (
      matchesSearch &&
      matchesType &&
      matchesStart &&
      matchesEnd
    );
  })
  .sort((a, b) => {
    const dateA =
      new Date(a.time || a.created_at).getTime() || 0;
    const dateB =
      new Date(b.time || b.created_at).getTime() || 0;

    return logSort === "newest"
      ? dateB - dateA
      : dateA - dateB;
  });

 
  const refreshAll = async () => {
    await Promise.all([
      loadLive(),
      loadLatestReadings(),
      refreshStatus?.(),
    ]);
  };

  const setState = async (rule, state) => {
    try {
      await api.patch(`/rules/${rule.id}`, {
        is_enabled: state === "activated",
      });

      await refreshAll();
    } catch (error) {
      setLoadError(error.message);
    }
  };

  const remove = async (rule) => {
    if (
      !window.confirm(
        `Archive the rule “${rule.name}”? It will be hidden from the rule list, and its alert and evaluation history will be retained.`
      )
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
    if (permanentDeleteRequest.current) return;
    if (
      !window.confirm(
        `Permanently delete “${rule.name}”? This irreversibly removes the rule, its alerts, and its evaluation history. Maintenance records linked to its alerts must be removed first.`
      )
    ) {
      return;
    }

    permanentDeleteRequest.current = true;
    setDeletingRuleId(rule.id);
    setLoadError("");
    setActionNotice("");
    try {
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
    if (!availableVariables.length) {
      throw new Error(
        "Add an active variable to this asset before creating a rule."
      );
    }

    const rule = {
      name: values.name.trim(),
      description: values.description?.trim() || null,
      target_asset_id: assetId,
      severity: values.severity,
      is_enabled: true,
      rule_type: values.rule_type,
    };

    if (values.rule_type === "boolean_count_threshold") {
      rule.variable_id = Number(values.cycle_variable_id);
      const warning1 = Number(values.warning_threshold_1);
      const warning2 = Number(values.warning_threshold_2);
      const alert = Number(values.alert_threshold);
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
      rule.parameters = {
        warning_thresholds: [warning1, warning2],
        alert_threshold: alert,
      };
    } else {
      rule.variable_id = Number(values.variable_id);
      const threshold = Number(values.threshold);
      if (!Number.isFinite(threshold)) {
        throw new Error("Enter a valid numeric threshold.");
      }
      rule.operator = values.operator;
      rule.threshold = threshold;
    }

    await api.post(`/assets/${assetId}/rules`, rule);

    setModal(null);
    setList("activated");
    await refreshAll();
  };

  const bulk = async (state) => {
    if (bulkRequest.current || bulkSaving) return;
    const affected = rules.filter((rule) =>
      state === "activated" ? !isAct(rule) : isAct(rule)
    ).length;
    if (state === "not_activated" && affected > 0) {
      const scope = children
        ? "this asset and its included child assets"
        : "this asset only";
      if (!window.confirm(
        `Deactivate ${affected} active rule(s) on ${scope}? Active alerts for those rules will be resolved.`
      )) {
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
    if (!values.text?.trim()) {
      throw new Error("Enter a logbook entry.");
    }

    await api.post(`/assets/${assetId}/logbook`, {
      text: values.text.trim(),
    });

    setModal(null);
    loadLogs();
  };

  const saveAsset = async (values) => {
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
    await api.post(`/assets/${assetId}/variables`, {
      name: values.name.trim(),
      key: values.key.trim(),
      data_type: values.data_type,
      unit: values.unit?.trim() || null,
    });

    setModal("variables");
    await loadVariables();
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
        </div>

        <div className="asset-links">
          <button
            className="link-btn"
            onClick={() => setModal("settings")}
          >
            <GearIcon size={17} /> Asset settings
          </button>

          <button
            className="link-btn"
            onClick={() => setModal("variables")}
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
          {machine && (
            <p className="muted">
              Cycle count and enabled cycle-threshold rule status refresh
              automatically every 1.5 seconds. Counts and threshold evaluation
              are maintained by the backend.
            </p>
          )}

          {machine && (
            <section
              className="machine-strip"
              aria-label="Live machine monitoring"
            >
              <div className={"machine-state " + machine.status}>
                <i
                  className={
                    "lamp " +
                    (machine.status === "running"
                      ? "ok"
                      : machine.status === "stopped"
                        ? "off"
                        : "warning")
                  }
                />
                <span className="cap">{machine.status}</span>
                {machine.stale && <em>stale data</em>}
              </div>

              <div className="machine-fig">
                <span>Cycles</span>
                <b>
                  {machine.cycle_count}
                  {machine.cycle_limit ? (
                    <small> / {machine.cycle_limit}</small>
                  ) : null}
                </b>
              </div>

              <div className="machine-fig">
                <span>Running time</span>
                <b>
                  {formatDuration(machine.running_seconds)}
                  {machine.runtime_limit_seconds ? (
                    <small>
                      {" / "}
                      {formatDuration(
                        machine.runtime_limit_seconds
                      )}
                    </small>
                  ) : null}
                </b>
              </div>

              <div className="machine-fig">
                <span>Last signal</span>
                <b className="plain">
                  {machine.last_seen_at
                    ? timeAgo(machine.last_seen_at)
                    : "Not received"}
                </b>
              </div>

              <div className="machine-fig">
                <span>OPC UA</span>
                <b className="plain">
                  {plcConnection?.connected
                    ? "Connected"
                    : plcConnection?.state === "standby"
                      ? "Standby"
                      : "Disconnected"}
                </b>
              </div>

              {cycleMapping && (
                <div className="machine-fig">
                  <span>Cycle signal</span>
                  <b className="plain">
                    {cycleMapping.variable_name} · {cycleMapping.node_id}
                  </b>
                </div>
              )}
            </section>
          )}

          <section className="panel values-panel">
            <div className="panel-head">
              <h2>Live values</h2>
              <span className="muted">
                Latest reading for each active variable · refreshes twice per second
              </span>
            </div>

            {variables.length === 0 ? (
              <p className="muted">
                No variables are configured yet.{" "}
                <button
                  className="link-btn inline"
                  onClick={() => setModal("variables")}
                >
                  Add a variable
                </button>{" "}
                to start recording readings.
              </p>
            ) : (
              <div className="values-grid">
                {variables.map((variable) => {
                  const reading = readingByVariable.get(
                    variable.id
                  );
                  const isCycleSignal =
                    cycleMapping?.variable_id === variable.id;
                  const cycleRule = isCycleSignal
                    ? rules.find(
                        (rule) =>
                          rule.rule_type === "boolean_count_threshold" &&
                          rule.variable_id === variable.id &&
                          rule.state === "activated"
                      )
                    : null;
                  const cycleRuleState = cycleRule
                    ? ruleStates.get(cycleRule.id)
                    : null;

                  return (
                    <div
                      className={
                        "value-cell" +
                        (reading ? "" : " no-data")
                      }
                      key={variable.id}
                    >
                      <span className="value-name">
                        {variable.name}
                      </span>

                      <span className="value-num">
                        {reading
                          ? formatValue(reading.value)
                          : "No data"}
                        {reading && variable.unit ? (
                          <small>{variable.unit}</small>
                        ) : null}
                      </span>

                      <span
                        className="value-age"
                        title={
                          reading
                            ? new Date(
                                reading.recorded_at
                              ).toLocaleString()
                            : ""
                        }
                      >
                        {reading
                          ? timeAgo(reading.recorded_at)
                          : "Waiting for first reading"}
                        {reading?.recorded_at
                          ? ` · ${new Date(
                              reading.recorded_at
                            ).toLocaleTimeString()}`
                          : ""}
                      </span>
                      {isCycleSignal && machine && (
                        <span className="value-age">
                            Backend cycle count:{" "}
                            {machine.cycle_count.toLocaleString()}
                            {cycleRule
                              ? ` · ${cycleRule.name}: ${
                                  cycleRuleState?.status ||
                                  cycleRule.status ||
                                  "unknown"
                                }`
                              : ""}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="toolbar">
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
              className="icon-outline sm"
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

            <div className="dropdown">
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
                <div className="menu" role="menu">
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
                </div>
              )}
            </div>

            <button
              className="btn-primary"
              onClick={() => setModal("ruleTypeOptions")}
            >
              <PlusCircle size={17} /> Add rule
            </button>

            <div className="dropdown">
              <button
                className="icon-outline sm"
                onClick={() => setMenu(!menu)}
                title="Rule actions"
                aria-label="Rule actions"
                aria-haspopup="menu"
                aria-expanded={menu}
              >
                <DotsIcon size={17} />
              </button>
                {menu && (
                  <div className="menu right" role="menu">
                      <button
                      type="button"
                      disabled={bulkSaving}
                      role="menuitem"
                      onClick={() => bulk("activated")}
                      >
                        {bulkSaving ? "Updating rules…" : "Activate all rules"}
                      </button>
                        <button
                        type="button"
                        disabled={bulkSaving}
                      role="menuitem"
                        onClick={() => bulk("not_activated")}
                        >Deactivate all rules</button>
                        <button
                        type="button"
                        disabled={bulkSaving}
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                          setShowPredefinedRules(true);
                        }}>Assign predefined monitoring rules</button>
                        <button
                        type="button"
                        disabled={bulkSaving}
                        role="menuitem"
                        onClick={() => {
                          setMenu(false);
                          setModal("copyRules");
                        }}
                        >Copy from another asset</button>
                        </div>
                      )}
                    </div>
                    </div>

          {shown.length === 0 ? (
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

                const condition = conditionText(
                  rule,
                  varNames.get(rule.variable_id)
                );

                return (
                  <div key={rule.id} className="rule-row">
                    <span className={"sev " + rule.status} />

                    <div className="rule-name">
                      {rule.name}

                      <small>
                        {condition ||
                          rule.rule_type.replace("_", " ")}

                        {rule.asset_id !== assetId &&
                        rule.asset_name
                          ? `, on ${rule.asset_name}`
                          : ""}
                      </small>

                      {rule.description && (
                        <small>{rule.description}</small>
                      )}
                    </div>

                    {isAct(rule) &&
                      state &&
                      state.latest_value !== null &&
                      state.latest_value !== undefined && (
                        <span
                          className="rule-now"
                          title={state.message}
                        >
                          Now{" "}
                          <b>
                            {formatValue(state.latest_value)}
                          </b>
                        </span>
                      )}

                    <StatusBadge status={rule.status} />

                    {isAct(rule) ? (
                      <button
                        className="btn-outline"
                        onClick={() =>
                          setState(rule, "not_activated")
                        }
                        disabled={deletingRuleId !== null}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        className="btn-outline"
                        onClick={() =>
                          setState(rule, "activated")
                        }
                        disabled={deletingRuleId !== null}
                      >
                        Activate
                      </button>
                    )}

                    {!isAct(rule) && (
                      <>
                        <button
                          className="btn-danger"
                          onClick={() => remove(rule)}
                          title="Remove from the rule list while preserving its alert and evaluation history"
                          disabled={deletingRuleId !== null}
                        >
                          Archive
                        </button>
                        <button
                          className="btn-danger"
                          onClick={() => permanentlyDeleteRule(rule)}
                          title="Permanently delete this rule, alerts, and evaluation history"
                          disabled={deletingRuleId !== null}
                        >
                          {deletingRuleId === rule.id
                            ? "Deleting…"
                            : "Delete permanently"}
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "logbook" && (
        <>
          <MaintenancePanel assetId={assetId} onChanged={refreshStatus} />
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Maintenance log notes</h2>
                <span className="muted">
                  {logs.length} {logs.length === 1 ? "entry" : "entries"}
                </span>
              </div>
              <button
                className="btn-primary"
                onClick={() => setModal("log")}
              >
                <PlusCircle size={17} /> Add note
              </button>
            </div>

            {logs.length === 0 ? (
              <EmptyState
                art={false}
                title="No logbook notes"
                lines={[
                  "Record brief observations separately from maintenance jobs.",
                ]}
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="col-time">Time</th>
                    <th>Entry</th>
                  </tr>
                </thead>

                <tbody>
                  {logs.map((entry) => (
                    <tr key={entry.id}>
                      <td className="col-time">
                        {formatTime(entry.time)}
                      </td>
                      <td>{entry.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === "events" && (
        <div className="panel">
          {events.length === 0 ? (
            <EmptyState
              art={false}
              title="No events yet"
              lines={[
                "Alerts, acknowledgements and rule changes for this asset are recorded here.",
              ]}
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th className="col-time">Time</th>
                  <th>Event</th>
                </tr>
              </thead>

              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="col-time">
                      {formatTime(event.time)}
                    </td>
                    <td>{event.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      




{modal === "ruleTypeOptions" && (
  <Modal
    title="Create new rule"
    onClose={() => setModal(null)}
  >
    <div className="rule-type-options">
    <button
        type="button"
        className="rule-type-option"
        onClick={() =>
          navigate(`/assets/${assetId}/rules/new/interval`)
        }
      >
        <strong>Interval-based</strong>
        <small>Create a recurring maintenance schedule with due dates</small>
      </button>

      <button
        type="button"
        className="rule-type-option"
        onClick={() =>
          navigate(`/assets/${assetId}/rules/new/usage`)
        }
      >
        <strong>Usage-based</strong>
        <small>Alert when a numeric usage metric reaches a threshold</small>
      </button>

      <button
        type="button"
        className="rule-type-option"
        onClick={() =>
          navigate(`/assets/${assetId}/rules/new/time`)
        }
      >
        <strong>Time-based</strong>
        <small>Schedule a maintenance job for a start and end date/time</small>
      </button>
    </div>
  </Modal>
)}


      
{modal === "copyRules" && (
  <CopyRulesModal
    assetId={assetId}
    assets={assets}
    cycleVariableIds={cycleVariableIds}
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
          title="Add rule"
          submitLabel="Add rule"
          intro={
            availableVariables.length
              ? undefined
              : "This asset has no active variables yet. Add one under Variables, then come back to create a rule."
          }
          fields={ruleFormFields}
          onSubmit={addRule}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "log" && (
        <CreateModal
          title="New logbook entry"
          submitLabel="Add entry"
          fields={LOG_FIELDS}
          onSubmit={addLog}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "settings" && (
        <CreateModal
          title="Asset settings"
          submitLabel="Save changes"
          onSubmit={saveAsset}
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

      {modal === "addVariable" && (
        <CreateModal
          title="Add variable"
          submitLabel="Add variable"
          fields={VARIABLE_FIELDS}
          onSubmit={addVariable}
          onClose={() => setModal("variables")}
        />
      )}

      {modal === "variables" && (
        <Modal
          title="Variables"
          onClose={() => setModal(null)}
        >
          {variables.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Key</th>
                  <th>Type</th>
                  <th>Unit</th>
                </tr>
              </thead>

              <tbody>
                {variables.map((variable) => (
                  <tr key={variable.id}>
                    <td>{variable.name}</td>
                    <td>{variable.key}</td>
                    <td>{variable.data_type}</td>
                    <td>{variable.unit || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              No active variables are configured for this asset.
            </p>
          )}

          <div className="modal-actions">
            <button
              className="btn-outline"
              onClick={() => setModal("addVariable")}
            >
              Add variable
            </button>

            <button
              className="btn-primary"
              onClick={() => setModal(null)}
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