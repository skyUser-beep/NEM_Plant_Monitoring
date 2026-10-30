import React, { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../../../services/api.js";
import { CreateModal } from "../../../components/common/UI.jsx";
import { captureNavigationOrigin } from "../../../utils/navigation.js";
import {
  AssetIcon,
  ChevronDown,
  ChevronRight,
  FxIcon,
  AlertDiamond,
  WarnTriangle,
  RefreshIcon,
  PlusIcon,
} from "../../../components/common/Icons.jsx";

const HEALTH_TEXT = {
  alert: "Alert active",
  warning: "Warning active",
  ok: "No active alerts",
  off: "Disabled",
};

export default function AssetTree({ assets = [], selectedId, onRefresh }) {
  const nav = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState({});
  const [onlyRules, setOnlyRules] = useState(false);
  const [adding, setAdding] = useState(false);

  const ancestorsOfSelected = useMemo(() => {
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const result = new Set();
    let cursor = byId.get(selectedId);

    while (
      cursor &&
      cursor.parent_asset_id != null &&
      !result.has(cursor.parent_asset_id)
    ) {
      result.add(cursor.parent_asset_id);
      cursor = byId.get(cursor.parent_asset_id);
    }

    return result;
  }, [assets, selectedId]);

  const tree = useMemo(() => {
    const childrenByParent = new Map();

    for (const asset of assets) {
      const key = asset.parent_asset_id ?? null;

      if (!childrenByParent.has(key)) {
        childrenByParent.set(key, []);
      }

      childrenByParent.get(key).push(asset);
    }

    const query = q.trim().toLowerCase();

    function build(asset, ancestors = new Set()) {
      if (ancestors.has(asset.id)) return null;

      const next = new Set(ancestors).add(asset.id);

      const children = (childrenByParent.get(asset.id) ?? [])
        .map((child) => build(child, next))
        .filter(Boolean);

      const matchesName =
        !query ||
        String(asset.name ?? "").toLowerCase().includes(query);

      const matchesRules = !onlyRules || asset.has_rules === true;

      if ((matchesName && matchesRules) || children.length) {
        return { asset, children };
      }

      return null;
    }

    return (childrenByParent.get(null) ?? [])
      .map((asset) => build(asset))
      .filter(Boolean);
  }, [assets, q, onlyRules]);

  const isOpen = (id, depth) =>
    open[id] ?? (depth < 1 || ancestorsOfSelected.has(id));

  const toggle = (id, depth) =>
    setOpen((prev) => ({ ...prev, [id]: !isOpen(id, depth) }));

  const renderNode = ({ asset, children }, depth = 0) => {
    const expanded = Boolean(q.trim()) || isOpen(asset.id, depth);
    const health = asset.health || (asset.is_active ? "ok" : "off");
    const label = HEALTH_TEXT[health];
    const go = () => nav(`/assets/${asset.id}`);

    return (
      <div key={asset.id}>
        <div
          className={
            "tree-row" + (selectedId === asset.id ? " selected" : "")
          }
          style={{ paddingLeft: 10 + depth * 18 }}
          role="button"
          tabIndex={0}
          onClick={go}
          onKeyDown={(event) => {
            if (event.key === "Enter") go();
          }}
          title={`${asset.name}: ${label}`}
        >
          {children.length > 0 ? (
            <span
              className="tree-toggle"
              role="button"
              tabIndex={0}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${asset.name}`}
              onClick={(event) => {
                event.stopPropagation();
                toggle(asset.id, depth);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  toggle(asset.id, depth);
                }
              }}
            >
              {expanded ? (
                <ChevronDown size={15} />
              ) : (
                <ChevronRight size={15} />
              )}
            </span>
          ) : (
            <span className="tree-toggle" />
          )}

          <i className={"lamp " + health} aria-label={label} />

          <span className="tree-name">
            {asset.name || `Asset ${asset.id}`}
          </span>

          {asset.rule_count > 0 && (
            <span
              className="tree-count"
              title={`${asset.rule_count} active monitoring rule${
                asset.rule_count === 1 ? "" : "s"
              } in this asset and its child assets`}
            >
              {asset.rule_count}
            </span>
          )}
        </div>

        {expanded && children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const parentOptions = [
    ["", "No parent (top level)"],
    ...assets.map((a) => [a.id, a.name]),
  ];

  const createAsset = async (values) => {
    const created = await api.post("/assets", {
      name: values.name.trim(),
      asset_type: values.asset_type.trim(),
      description: values.description?.trim() || null,
      parent_asset_id:
        values.parent_asset_id === ""
          ? null
          : Number(values.parent_asset_id),
    });

    setAdding(false);
    await onRefresh?.();
    nav(`/assets/${created.id}`);
  };

  return (
    <aside className="tree" aria-label="Assets">
      <div className="tree-tools">
        <input
          type="search"
          placeholder="Search assets"
          aria-label="Search assets"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />

        <div className="btn-group">
          <button
            type="button"
            title="Only assets with monitoring rules"
            aria-label="Only assets with monitoring rules"
            aria-pressed={onlyRules}
            className={onlyRules ? "on" : ""}
            onClick={() => setOnlyRules((value) => !value)}
          >
            <FxIcon size={17} />
          </button>

          <button
            type="button"
            title="Rules with alert status"
            aria-label="Rules with alert status"
            onClick={() =>
              nav("/rules/alert", {
                state: { from: captureNavigationOrigin(location) },
              })
            }
          >
            <AlertDiamond size={17} />
          </button>

          <button
            type="button"
            title="Rules with warning status"
            aria-label="Rules with warning status"
            onClick={() =>
              nav("/rules/warning", {
                state: { from: captureNavigationOrigin(location) },
              })
            }
          >
            <WarnTriangle size={17} />
          </button>

          <button
            type="button"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => onRefresh?.().catch?.(() => {})}
          >
            <RefreshIcon size={17} />
          </button>
        </div>
      </div>

      <div className="tree-body">
        {tree.length > 0 ? (
          tree.map((node) => renderNode(node))
        ) : (
          <p className="tree-empty">
            {assets.length === 0
              ? "No assets yet. Add the first machine below."
              : onlyRules
                ? "No matching assets have monitoring rules."
                : "No assets match your search."}
          </p>
        )}
      </div>

      <div className="tree-foot">
        <button
          type="button"
          className="btn-outline wide-btn"
          onClick={() => setAdding(true)}
        >
          <PlusIcon size={16} /> Add asset
        </button>
      </div>

      {adding && (
        <CreateModal
          title="Add asset"
          submitLabel="Add asset"
          onClose={() => setAdding(false)}
          onSubmit={createAsset}
          fields={[
            {
              key: "name",
              label: "Name",
              required: true,
              placeholder: "e.g. Mixer 2",
            },
            {
              key: "asset_type",
              label: "Type",
              required: true,
              default: "machine",
              placeholder: "e.g. machine, line, plant",
            },
            {
              key: "parent_asset_id",
              label: "Belongs to",
              type: "select",
              options: parentOptions,
            },
            {
              key: "description",
              label: "Description",
              type: "textarea",
            },
          ]}
        />
      )}
    </aside>
  );
}