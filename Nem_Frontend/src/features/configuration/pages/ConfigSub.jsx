import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { api } from "../../../services/api.js";
import { useAuth } from "../../auth/AuthContext.jsx";
import {
  createLiveUpdateScheduler,
  subscribeLiveUpdates,
} from "../../../services/liveUpdates.js";
import { conditionText } from "../../../utils/format.js";
import {
  CreateModal,
  EmptyState,
  useConfirmation,
} from "../../../components/common/UI.jsx";
import {
  BackIcon,
  PlusCircle,
} from "../../../components/common/Icons.jsx";
import {
  Pencil,
  Trash2,
  Copy,
  Power,
} from "lucide-react";
import ReusableRuleModal from "./ReusableRuleModal.jsx";
import RuleCollectionCreateModal from "./RuleCollectionCreateModal.jsx";

const DOC_TYPES = [
  ["Instruction", "Instruction"],
  ["Manual", "Manual"],
  ["Checklist", "Checklist"],
  ["Other", "Other"],
];

const PAGE_SIZE = 10;

const CRUD = {
  rules: {
    title: "Monitoring rules",
    endpoint: "rules",
    button: "Create rule",
    noun: "Rule",
    cols: [
      ["name", "Name"],
      ["asset_name", "Machine"],
      ["condition", "Condition"],
      ["severity", "Severity"],
      ["state", "State"],
    ],
  },
  collections: {
    title: "Rule collections",
    endpoint: "collections",
    button: "Create collection",
    noun: "Collection",
    cols: [
      ["name", "Name"],
      ["description", "Description"],
      ["rules", "Rules"],
    ],
  },
  documents: {
    title: "Instructions and documents",
    endpoint: "documents",
    button: "Create document",
    noun: "Document",
    cols: [
      ["title", "Title"],
      ["kind", "Type"],
      ["labels", "Labels"],
      ["duration_minutes", "Duration (minutes)"],
      ["description", "Description"],
      ["files", "Attachments"],
    ],
  },
};

function fieldsFor(sub, variables) {
  if (sub === "rules") {
    return [
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
        key: "variable_id",
        label: "Machine / numeric variable",
        type: "select",
        required: true,
        options: variables.map((variable) => [
          variable.id,
          `${variable.asset_name}: ${variable.name}`,
        ]),
      },
      {
        key: "operator",
        label: "Trigger when value is",
        type: "select",
        required: true,
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
        required: true,
      },
      {
        key: "severity",
        label: "Severity",
        type: "select",
        required: true,
        default: "warning",
        options: [
          ["warning", "Warning"],
          ["alert", "Alert"],
        ],
      },
    ];
  }

  if (sub === "collections") {
    return [
      {
        key: "name",
        label: "Collection name",
        required: true,
        placeholder: "e.g. Mixer machines",
      },
      {
        key: "description",
        label: "Description",
        type: "textarea",
      },
    ];
  }

  return [
    {
      key: "title",
      label: "Title",
      required: true,
      placeholder: "e.g. Mixer inspection steps",
    },
    {
      key: "kind",
      label: "Type",
      type: "select",
      options: DOC_TYPES,
      default: "Instruction",
    },
    {
      key: "description",
      label: "Description",
      type: "textarea",
    },
    {
      key: "files",
      label: "Attach files (optional)",
      type: "files",
      hint: "PDF, DOC, DOCX or TXT. Up to 10 files; 10 MB each.",
    },
  ];
}

function cell(key, row, variableNames) {
  if (key === "condition") {
    const text = conditionText(
      row,
      variableNames.get(row.variable_id)
    );

    return text || <span className="muted">-</span>;
  }

  if (key === "files") {
    const files = row.files || [];

    if (!files.length) {
      return <span className="muted">No files</span>;
    }

    return (
      <span>
        {files.map((file, index) => (
          <React.Fragment key={file.id}>
            {index > 0 ? ", " : ""}
            <Link
              to={`/configuration/documents/${row.id}/files/${file.id}/view`}
            >
              {file.name}
            </Link>
          </React.Fragment>
        ))}
      </span>
    );
  }

  if (key === "rules") {
    return row.rules?.length
      ? row.rules.map((rule) => rule.name).join(", ")
      : <span className="muted">No rules</span>;
  }

  const value = row[key];

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return <span className="muted">-</span>;
  }

  if (key === "labels") {
    return Array.isArray(value) && value.length ? (
      value.join(", ")
    ) : (
      <span className="muted">-</span>
    );
  }

  if (key === "severity") {
    return (
      <span className={"badge " + value}>
        {value}
      </span>
    );
  }

  if (key === "state") {
    return (
      <span className={"state-text " + value}>
        {String(value).replace("_", " ")}
      </span>
    );
  }

  return value;
}

function ImportPage() {
  const { user } = useAuth();
  const canManageConfiguration = user?.role === "Administrator";
  const [msg, setMsg] = useState({
    text: "",
    error: false,
  });

  const onFile = async (event) => {
    if (!canManageConfiguration) return;
    const file = event.target.files?.[0];

    if (!file) return;

    try {
      const data = JSON.parse(await file.text());
      const result = await api.post("/import", data);

      setMsg({
        text: `Imported ${result.rules} rule(s) and ${result.collections} new collection(s).`,
        error: false,
      });
    } catch (error) {
      const text =
        error instanceof SyntaxError
          ? "That file is not valid JSON."
          : error.message;

      setMsg({
        text: `Import failed: ${text}`,
        error: true,
      });
    } finally {
      event.target.value = "";
    }
  };

  return (
    <div className="panel">
      <p className="muted">
        Choose a JSON file with a <code>collections</code> list
        (name, description) and a <code>rules</code> list.
        Each rule needs the same fields as a rule created in
        the app, including its asset and variable IDs.
      </p>

      {!canManageConfiguration && (
        <p className="notice" role="status">
          Configuration import is restricted to Administrators.
        </p>
      )}
      <input
        type="file"
        accept=".json,application/json"
        disabled={!canManageConfiguration}
        title={!canManageConfiguration ? "Only Administrators can import configuration." : undefined}
        onChange={onFile}
      />

      {msg.text && (
        <p
          className={
            "notice" + (msg.error ? " error" : "")
          }
          role="status"
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

export default function ConfigSub() {
  const { user } = useAuth();
  const canManageConfiguration = user?.role === "Administrator";
  const canCreateRulesAndDocuments =
    canManageConfiguration || user?.role === "Supervisor";
  const confirm = useConfirmation();
  const { sub } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const cfg = CRUD[sub];

  const [rows, setRows] = useState(null);
  const [variables, setVariables] = useState([]);
  const [open, setOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [msg, setMsg] = useState({
    text: "",
    error: false,
  });
  const [activeCollection, setActiveCollection] = useState(null);
  const [busyRuleId, setBusyRuleId] = useState(null);

  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [sortKey, setSortKey] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    if (!cfg) return;

    if (sub === "rules") {
      const [rules, currentAssets, statuses] =
        await Promise.all([
          api.getAll("/rules"),
          api.getAll("/assets"),
          api.getAll("/monitoring/status", 500),
        ]);

      const assetNames = new Map(
        currentAssets.map((asset) => [
          asset.id,
          asset.name,
        ])
      );

      const stateByRule = new Map(
        statuses.map((status) => [
          status.rule_id,
          status.status,
        ])
      );

      setRows(
        rules.map((rule) => {
          const status = stateByRule.get(rule.id);

          return {
            ...rule,
            asset_name:
              assetNames.get(rule.target_asset_id) ||
              "Unassigned",
            state: rule.is_enabled
              ? "activated"
              : "not_activated",
            status:
              status === "normal"
                ? "ok"
                : status || "unknown",
          };
        })
      );

      return;
    }

    const items = await api.get(`/${cfg.endpoint}`);

    setRows(Array.isArray(items) ? items : []);
  }, [cfg, sub]);

  const loadVariables = useCallback(async () => {
    if (sub !== "rules") return;

    const assets = await api.getAll("/assets");

    const perAsset = await Promise.all(
      assets.map((asset) =>
        api.getAll(
          `/assets/${asset.id}/variables?is_active=true`
        )
      )
    );

    const names = new Map(
      assets.map((asset) => [asset.id, asset.name])
    );

    setVariables(
      perAsset
        .flat()
        .filter((variable) =>
          ["integer", "number"].includes(variable.data_type)
        )
        .map((variable) => ({
          ...variable,
          asset_name:
            names.get(variable.asset_id) ||
            `Asset ${variable.asset_id}`,
        }))
    );
  }, [sub]);

  const rulesScheduler = useMemo(
    () =>
      createLiveUpdateScheduler(async () => {
        try {
          await load();
        } catch (error) {
          setMsg({
            text: error.message,
            error: true,
          });
        }
      }, 250),
    [load]
  );

  useEffect(() => {
    let alive = true;

    setOpen(false);
    setEditingRule(null);
    setMsg({ text: "", error: false });
    setRows(null);
    setPage(1);

    load().catch((error) => {
      if (!alive) return;

      setRows([]);
      setMsg({
        text: error.message,
        error: true,
      });
    });

    if (sub === "rules") {
      loadVariables().catch((error) => {
        if (alive) {
          setMsg({
            text: error.message,
            error: true,
          });
        }
      });
    } else {
      setVariables([]);
    }

    return () => {
      alive = false;
    };
  }, [sub, load, loadVariables]);

  useEffect(() => {
    if (sub !== "rules") return undefined;

    return subscribeLiveUpdates((update) => {
      if (update.resync_required) {
        rulesScheduler();

        loadVariables().catch((error) =>
          setMsg({
            text: error.message,
            error: true,
          })
        );

        return;
      }

      const changedTables = new Set(
        update.changed_tables || []
      );

      if (
        [
          "nem_monitoring_rules",
          "nem_rule_states",
        ].some((table) => changedTables.has(table))
      ) {
        rulesScheduler();
      }

      if (
        ["assets", "variables"].some((table) =>
          changedTables.has(table)
        )
      ) {
        rulesScheduler();

        loadVariables().catch((error) =>
          setMsg({
            text: error.message,
            error: true,
          })
        );
      }
    });
  }, [loadVariables, rulesScheduler, sub]);

  useEffect(
    () => () => rulesScheduler.dispose(),
    [rulesScheduler]
  );

  const numericVariables = useMemo(
    () =>
      variables.filter((variable) =>
        ["integer", "number"].includes(variable.data_type)
      ),
    [variables]
  );

  const variableNames = useMemo(
    () =>
      new Map(
        variables.map((variable) => [
          variable.id,
          variable.name,
        ])
      ),
    [variables]
  );

  const ruleFields = useMemo(
    () => fieldsFor("rules", numericVariables),
    [numericVariables]
  );

  const visibleRows = useMemo(() => {
    if (sub !== "rules" || !Array.isArray(rows)) {
      return rows || [];
    }

    const query = search.trim().toLowerCase();

    const filtered = rows.filter((row) => {
      const matchesSearch =
        !query ||
        [
          row.name,
          row.description,
          row.asset_name,
          row.severity,
          row.rule_type,
          row.status,
        ].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(query)
        );

      const matchesSeverity =
        severityFilter === "all" ||
        row.severity === severityFilter;

      const matchesState =
        stateFilter === "all" ||
        (stateFilter === "enabled" && row.is_enabled) ||
        (stateFilter === "disabled" && !row.is_enabled);

      return matchesSearch && matchesSeverity && matchesState;
    });

    const direction = sortDirection === "asc" ? 1 : -1;

    return filtered.sort((a, b) => {
      let left = a[sortKey];
      let right = b[sortKey];

      if (sortKey === "state") {
        left = a.is_enabled ? "Enabled" : "Disabled";
        right = b.is_enabled ? "Enabled" : "Disabled";
      }

      if (left == null) left = "";
      if (right == null) right = "";

      if (
        typeof left === "number" &&
        typeof right === "number"
      ) {
        return (left - right) * direction;
      }

      return (
        String(left).localeCompare(
          String(right),
          undefined,
          {
            numeric: true,
            sensitivity: "base",
          }
        ) * direction
      );
    });
  }, [
    rows,
    sub,
    search,
    severityFilter,
    stateFilter,
    sortKey,
    sortDirection,
  ]);

  const totalPages = Math.max(
    1,
    Math.ceil(visibleRows.length / PAGE_SIZE)
  );

  const currentPage = Math.min(page, totalPages);

  const pagedRows =
    sub === "rules"
      ? visibleRows.slice(
          (currentPage - 1) * PAGE_SIZE,
          currentPage * PAGE_SIZE
        )
      : visibleRows;

  const changeSort = (key) => {
    if (sortKey === key) {
      setSortDirection((direction) =>
        direction === "asc" ? "desc" : "asc"
      );
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }

    setPage(1);
  };

  const create = async (values) => {
    if (
      !canManageConfiguration &&
      !(canCreateRulesAndDocuments && ["rules", "documents"].includes(sub))
    ) return;
    if (sub === "rules") {
      const variable = numericVariables.find(
        (item) => item.id === Number(values.variable_id)
      );

      if (!variable) {
        throw new Error(
          "Select an active numeric variable. Add one on an asset first if the list is empty."
        );
      }

      const threshold = Number(values.threshold);

      if (!Number.isFinite(threshold)) {
        throw new Error("Enter a valid numeric threshold.");
      }

      await api.post("/rules", {
        name: values.name.trim(),
        description: values.description?.trim() || null,
        target_asset_id: variable.asset_id,
        variable_id: variable.id,
        rule_type: "parameter_threshold",
        operator: values.operator,
        threshold,
        severity: values.severity,
        is_enabled: true,
      });
    } else if (sub === "documents") {
      const files = values.files || [];

      if (files.length) {
        const form = new FormData();

        form.append("title", values.title);
        form.append("kind", values.kind);
        form.append("description", values.description || "");

        files.forEach((file) =>
          form.append("files", file)
        );

        await api.postForm("/documents/with-files", form);
      } else {
        await api.post("/documents", {
          title: values.title,
          kind: values.kind,
          description: values.description || null,
        });
      }
    } else {
      await api.post(`/${cfg.endpoint}`, values);
    }

    setOpen(false);
    setEditingRule(null);
    setMsg({
      text: `${cfg.noun} created.`,
      error: false,
    });

    await load();
  };

  const edit = async (values) => {
    if (!canManageConfiguration) return;
    const original = editingRule;

    if (!original) return;

    const variable = numericVariables.find(
      (item) => item.id === Number(values.variable_id)
    );

    if (!variable) {
      throw new Error("Select an active numeric variable.");
    }

    const threshold = Number(values.threshold);

    if (!Number.isFinite(threshold)) {
      throw new Error("Enter a valid numeric threshold.");
    }

    await api.patch(`/rules/${original.id}`, {
      name: values.name.trim(),
      description: values.description?.trim() || null,
      target_asset_id: variable.asset_id,
      variable_id: variable.id,
      rule_type: original.rule_type,
      operator: values.operator,
      threshold,
      parameters: original.parameters ?? null,
      severity: values.severity,
    });

    setOpen(false);
    setEditingRule(null);
    setMsg({
      text: "Rule updated successfully.",
      error: false,
    });

    await load();
  };

  const duplicate = async (rule) => {
    if (!canManageConfiguration) return;
    const confirmed = await confirm(
      `Create a duplicate of "${rule.name}"? The copy will be disabled initially.`,
      {
        title: "Duplicate rule",
        confirmLabel: "Create duplicate",
      }
    );

    if (!confirmed) return;

    setBusyRuleId(rule.id);
    setMsg({ text: "", error: false });

    try {
      const payload = {
        name: `${rule.name} (Copy)`,
        description: rule.description || null,
        rule_type: rule.rule_type,
        target_asset_id: rule.target_asset_id,
        variable_id: rule.variable_id,
        operator: rule.operator,
        threshold: rule.threshold,
        parameters: rule.parameters,
        severity: rule.severity,
        is_enabled: false,
        evaluation_interval_seconds:
          rule.evaluation_interval_seconds,
        stale_after_seconds: rule.stale_after_seconds,
      };

      Object.keys(payload).forEach((key) => {
        if (payload[key] === undefined) {
          delete payload[key];
        }
      });

      await api.post("/rules", payload);

      setMsg({
        text: "Duplicate rule created (disabled).",
        error: false,
      });

      await load();
    } catch (error) {
      setMsg({
        text: error.message,
        error: true,
      });
    } finally {
      setBusyRuleId(null);
    }
  };

  const toggleRule = async (rule) => {
    if (!canManageConfiguration) return;
    setBusyRuleId(rule.id);
    setMsg({ text: "", error: false });

    try {
      await api.patch(`/rules/${rule.id}`, {
        is_enabled: !rule.is_enabled,
      });

      setMsg({
        text: `Rule ${
          rule.is_enabled ? "disabled" : "enabled"
        } successfully.`,
        error: false,
      });

      await load();
    } catch (error) {
      setMsg({
        text: error.message,
        error: true,
      });
    } finally {
      setBusyRuleId(null);
    }
  };

  const remove = async (row) => {
    if (!canManageConfiguration) return;
    const isRule = sub === "rules";

    const confirmed = await confirm(
      isRule
        ? `Delete rule "${row.name}"? This action may be rejected if the rule has alert history.`
        : `Delete this ${cfg.noun.toLowerCase()}?`,
      {
        title: `Delete ${isRule ? "rule" : cfg.noun.toLowerCase()}`,
        confirmLabel: "Delete",
        destructive: true,
      }
    );

    if (!confirmed) return;

    setBusyRuleId(row.id);
    setMsg({ text: "", error: false });

    try {
      if (isRule && row.is_enabled) {
        await api.patch(`/rules/${row.id}`, {
          is_enabled: false,
        });
      }

      await api.del(`/${cfg.endpoint}/${row.id}`);

      setMsg({
        text: `${cfg.noun} deleted.`,
        error: false,
      });

      await load();
    } catch (error) {
      setMsg({
        text: error.message,
        error: true,
      });

      if (isRule) {
        await load().catch(() => {});
      }
    } finally {
      setBusyRuleId(null);
    }
  };

  const auditText = (value) => {
    if (!value) return "-";

    const date = new Date(value);

    return Number.isNaN(date.getTime())
      ? String(value)
      : date.toLocaleString();
  };

  if (!cfg) {
    return (
      <div>
        <button
          className="link-btn"
          onClick={() => nav("/configuration")}
        >
          <BackIcon size={14} /> Back
        </button>

        <h1 className="page-title">
          Import configuration
        </h1>

        <ImportPage />
      </div>
    );
  }

  return (
    <div>
      <button
        className="link-btn"
        onClick={() => nav("/configuration")}
      >
        <BackIcon size={14} /> Back
      </button>

      <div className="page-head">
        <h1 className="page-title">{cfg.title}</h1>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
          }}
        >
          {sub === "documents" && (
            <button
              type="button"
              className="btn-secondary"
              disabled={!canCreateRulesAndDocuments}
              title={!canCreateRulesAndDocuments ? "Only Administrators and Supervisors can create instructions." : undefined}
              onClick={() =>
                nav("/configuration/instructions/new")
              }
            >
              <PlusCircle size={17} />
              Create New Instruction
            </button>
          )}

          <button
            type="button"
            className="btn-primary"
            disabled={
              !canManageConfiguration &&
              !(canCreateRulesAndDocuments && ["rules", "documents"].includes(sub))
            }
            title={
              !canManageConfiguration && !canCreateRulesAndDocuments
                ? "Only Administrators and Supervisors can create rules and documents."
                : undefined
            }
            onClick={() => {
              setEditingRule(null);
              setMsg({ text: "", error: false });

              if (sub === "documents") {
                nav("/configuration/documents/new");
                return;
              }

              setOpen(true);
            }}
          >
            <PlusCircle size={17} />
            {cfg.button}
          </button>
        </div>
      </div>
      {!canManageConfiguration && (
        <p className="notice" role="status">
          {["rules", "documents"].includes(sub)
            ? "Administrators and Supervisors can create rules and documents. Editing, deleting, and other global configuration changes are restricted to Administrators."
            : "Global configuration changes are restricted to Administrators. Assigned-asset rule and maintenance actions remain available from their respective pages."}
        </p>
      )}

      <div className="panel">
        {msg.text && (
          <p
            className={
              "notice flush" + (msg.error ? " error" : "")
            }
            role="status"
          >
            {msg.text}
          </p>
        )}

        {sub === "rules" && (
          <div
            className="rule-toolbar"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <input
              aria-label="Search monitoring rules"
              placeholder="Search name, machine, type..."
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              style={{
                flex: "1 1 220px",
                minWidth: 180,
              }}
            />

            <select
              aria-label="Filter by severity"
              value={severityFilter}
              onChange={(event) => {
                setSeverityFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All severities</option>
              <option value="warning">Warning</option>
              <option value="alert">Alert</option>
            </select>

            <select
              aria-label="Filter by enabled status"
              value={stateFilter}
              onChange={(event) => {
                setStateFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All states</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
        )}

        {rows === null ? (
          <div className="loading" role="status">
            Loading...
          </div>
        ) : visibleRows.length === 0 ? (
          <EmptyState
            art={false}
            title={
              rows.length === 0
                ? "Nothing here yet"
                : "No matching rules"
            }
            lines={[
              rows.length === 0
                ? `Select "${cfg.button}" to add the first one.`
                : "Try changing your search or filters.",
            ]}
          />
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    {cfg.cols.map(([key, label]) => (
                      <th key={label}>
                        {sub === "rules" ? (
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => changeSort(key)}
                            title={`Sort by ${label}`}
                          >
                            {label}
                            {sortKey === key
                              ? sortDirection === "asc"
                                ? " ↑"
                                : " ↓"
                              : ""}
                          </button>
                        ) : (
                          label
                        )}
                      </th>
                    ))}

                    {sub === "rules" && (
                      <>
                        <th>Enabled</th>
                        <th>Updated</th>
                      </>
                    )}

                    <th>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {pagedRows.map((row) => (
                    <tr key={row.id}>
                      {cfg.cols.map(([key]) => (
                        <td key={key}>
                          {cell(key, row, variableNames)}
                        </td>
                      ))}

                      {sub === "rules" && (
                        <>
                          <td>
                            <span
                              className={
                                "state-text " +
                                (row.is_enabled
                                  ? "activated"
                                  : "not_activated")
                              }
                            >
                              {row.is_enabled
                                ? "Enabled"
                                : "Disabled"}
                            </span>
                          </td>

                          <td
                            title={`Created: ${auditText(
                              row.created_at
                            )}`}
                          >
                            {auditText(
                              row.updated_at || row.created_at
                            )}
                          </td>
                        </>
                      )}

                      <td className="right">
                        {sub === "rules" ? (
                          <div className="config-action-icons">
                            <button
                              type="button"
                              className="config-icon-btn add"
                              title="Add rule"
                              aria-label="Add rule"
                              disabled={!canManageConfiguration}
                              onClick={() => {
                                // Connect this to the existing
                                // collection-to-rule assignment flow.
                              }}
                            >
                              <PlusCircle size={17} />
                            </button>

                            <button
                              type="button"
                              className="config-icon-btn edit"
                              title="Edit rule"
                              aria-label="Edit rule"
                              disabled={!canManageConfiguration || busyRuleId === row.id}
                              onClick={() =>
                                nav(
                                  `/assets/${row.target_asset_id}/monitoring-rules/${row.rule_type}/edit`,
                                  {
                                    state: {
                                      editingRule: row,
                                    },
                                  }
                                )
                              }
                            >
                              <Pencil size={17} />
                            </button>

                            <button
                              type="button"
                              className="config-icon-btn toggle"
                              title={
                                row.is_enabled
                                  ? "Disable rule"
                                  : "Enable rule"
                              }
                              aria-label={
                                row.is_enabled
                                  ? "Disable rule"
                                  : "Enable rule"
                              }
                              disabled={!canManageConfiguration || busyRuleId === row.id}
                              onClick={() => toggleRule(row)}
                            >
                              <Power size={17} />
                            </button>

                            <button
                              type="button"
                              className="config-icon-btn duplicate"
                              title="Duplicate rule"
                              aria-label="Duplicate rule"
                              disabled={!canManageConfiguration || busyRuleId === row.id}
                              onClick={() => duplicate(row)}
                            >
                              <Copy size={17} />
                            </button>

                            <button
                              type="button"
                              className="config-icon-btn delete"
                              title="Delete rule"
                              aria-label="Delete rule"
                              disabled={!canManageConfiguration || busyRuleId === row.id}
                              onClick={() => remove(row)}
                            >
                              <Trash2 size={17} />
                            </button>
                          </div>
                        ) : sub === "collections" ? (
  <div className="config-action-icons">
    {/* Add Rule */}
 <button
  type="button"
  className="btn-outline"
  title="Add rule to collection"
  disabled={!canManageConfiguration || row.rule_count >= 5}
  onClick={() => {
    setActiveCollection({
      id: row.id,
      name: row.name,
      ruleCount: row.rule_count || 0,
    });
  }}
>
  <PlusCircle size={16} />
  Add Rule
</button>

    {/* Edit Rule */}
    <button
      type="button"
      className="btn-outline"
      title="Edit collection rules"
      disabled={!canManageConfiguration}
      onClick={() => {
        nav("/configuration/rules", {
          state: {
            collectionId: row.id,
            collectionName: row.name,
            action: "edit",
          },
        });
      }}
    >
      <Pencil size={16} />
      Edit Rule
    </button>

    {/* Delete Collection */}
    <button
      type="button"
      className="btn-danger"
      title="Delete collection"
      aria-label="Delete collection"
      disabled={!canManageConfiguration || busyRuleId === row.id}
      onClick={() => remove(row)}
    >
      <Trash2 size={17} />
    </button>
  </div>

                        ) : (
                          <div className="config-action-icons">
                            <button
                              type="button"
                              className="config-icon-btn delete"
                              title={`Delete ${cfg.noun.toLowerCase()}`}
                              aria-label={`Delete ${cfg.noun.toLowerCase()}`}
                              disabled={!canManageConfiguration || busyRuleId === row.id}
                              onClick={() => remove(row)}
                            >
                              <Trash2 size={17} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {sub === "rules" && (
              <div
                className="pagination"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  marginTop: 16,
                }}
              >
                <span className="muted">
                  Showing{" "}
                  {visibleRows.length === 0
                    ? 0
                    : (currentPage - 1) * PAGE_SIZE + 1}
                  {" - "}
                  {Math.min(
                    currentPage * PAGE_SIZE,
                    visibleRows.length
                  )}
                  {" of "}
                  {visibleRows.length} rules
                </span>

                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <button
                    type="button"
                    className="btn-outline"
                    disabled={currentPage <= 1}
                    onClick={() =>
                      setPage((value) =>
                        Math.max(1, value - 1)
                      )
                    }
                  >
                    Previous
                  </button>

                  <span>
                    Page {currentPage} of {totalPages}
                  </span>

                  <button
                    type="button"
                    className="btn-outline"
                    disabled={currentPage >= totalPages}
                    onClick={() =>
                      setPage((value) =>
                        Math.min(totalPages, value + 1)
                      )
                    }
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {open && sub === "collections" && (
        <RuleCollectionCreateModal
          onClose={() => setOpen(false)}
          onCreate={async (payload) => {
            await api.post("/collections", payload);
            setOpen(false);
            setMsg({
              text: "Collection and monitoring rules created.",
              error: false,
            });
            try {
              await load();
            } catch (error) {
              setMsg({
                text: `Collection created, but the list could not be refreshed: ${error.message}`,
                error: true,
              });
            }
          }}
        />
      )}
      {open && sub !== "documents" && sub !== "collections" && (
        <CreateModal
          disabled={!canManageConfiguration}
         title={
  sub === "collections" && activeCollection
    ? `Add Rule to ${activeCollection.name}`
    : sub === "rules"
      ? editingRule
        ? "Edit monitoring rule"
        : cfg.button
      : cfg.button
}
          submitLabel={
            sub === "rules" && editingRule
              ? "Save changes"
              : cfg.button
          }
          intro={
            sub === "rules"
              ? numericVariables.length === 0
                ? "No active numeric variables exist yet. Add one from an asset's Variables panel first."
                : "Selecting a variable assigns the rule to that variable's machine. Backend validation may prevent changing a rule's target after evaluation has started."
              : undefined
          }
          fields={
            sub === "rules"
              ? ruleFields
              : fieldsFor(sub, variables)
          }
          initialValues={
            sub === "rules" && editingRule
              ? {
                  name: editingRule.name,
                  description: editingRule.description || "",
                  variable_id:
                    editingRule.variable_id ?? "",
                  operator: editingRule.operator || ">=",
                  threshold: editingRule.threshold ?? "",
                  severity: editingRule.severity || "warning",
                }
              : {}
          }
          onSubmit={
            sub === "rules" && editingRule
              ? edit
              : create
          }
          onClose={() => {
            setOpen(false);
            setEditingRule(null);
          }}
        />
      )}
      {activeCollection && (
      <ReusableRuleModal
        collection={activeCollection}
        onClose={() => setActiveCollection(null)}
        onCreated={async () => {
          setMsg({
            text: "Reusable rule created successfully.",
            error: false,
          });

          await load();
        }}
      />
    )}
    </div>
  );
}
