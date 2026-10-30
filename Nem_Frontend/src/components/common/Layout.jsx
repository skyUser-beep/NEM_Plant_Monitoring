
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, matchPath } from "react-router-dom";
import { LogOut, Users } from "lucide-react";
import { api } from "../../services/api.js";
import { subscribeLiveUpdates } from "../../services/liveUpdates.js";
import { APP_TITLE } from "../../utils/config.js";
import Brand from "./Brand.jsx";
import AssetTree from "../../features/assets/components/AssetTree.jsx";
import { useAuth } from "../../features/auth/AuthContext.jsx";
import { useConfirmation } from "./UI.jsx";
import {
  HomeIcon,
  TreeIcon,
  ShapesIcon,
  GearIcon,
  DoubleChevron,
  PanelIcon,
  PlugIcon,
  SunIcon,
  MoonIcon,
} from "./Icons.jsx";

const TITLES = {
  rules: "Monitoring rules",
  collections: "Rule collections",
  documents: "Instructions and documents",
  import: "Import configuration",
  user: "User information",
  email: "Email server",
  analytics: "Analytics extensions",
  usage: "Usage",
  backup: "Backup and restore",
};

function crumbs(path, assets) {
  if (path === "/") return [{ label: "Overview" }];

  let m;
  if ((m = matchPath("/rules/:kind", path))) {
    const lifecycleLabels = {
      activated: "Activated rules",
      suspended: "Suspended rules",
      deactivated: "Deactivated rules",
      completed: "Completed rules",
    };
    return [
      { label: "Overview", to: "/" },
      {
        label:
          lifecycleLabels[m.params.kind] ||
          `Rules in ${m.params.kind} status`,
      },
    ];
  }

  if ((m = matchPath("/assets/:id", path))) {
    const asset = assets.find((x) => x.id === Number(m.params.id));
    return [
      { label: "Assets", to: "/assets" },
      { label: asset ? asset.name : `Asset ${m.params.id}` },
    ];
  }

  if (path === "/assets") return [{ label: "Assets" }];
  if (path === "/plc") return [{ label: "PLC / OPC UA" }];

  if ((m = matchPath("/configuration/:sub", path))) {
    return [
      { label: "Configuration", to: "/configuration" },
      { label: TITLES[m.params.sub] || m.params.sub },
    ];
  }

  if ((m = matchPath("/settings/:sub", path))) {
    return [
      { label: "Settings", to: "/settings" },
      { label: TITLES[m.params.sub] || m.params.sub },
    ];
  }

  if (path.startsWith("/configuration")) return [{ label: "Configuration" }];
  if (path.startsWith("/settings")) return [{ label: "Settings" }];

  return [{ label: "Overview" }];
}

const RANK = { off: 0, ok: 1, warning: 2, alert: 3 };

function computeHealth(assets, alerts) {
  const own = new Map();

  for (const alert of alerts) {
    if (alert.maintenance_schedule_id != null) continue;
    const current = own.get(alert.target_asset_id) || "ok";
    if (RANK[alert.severity] > RANK[current]) {
      own.set(alert.target_asset_id, alert.severity);
    }
  }

  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const health = new Map();

  const raise = (id, level) => {
    if ((RANK[level] ?? 0) > (RANK[health.get(id)] ?? -1)) {
      health.set(id, level);
    }
  };

  for (const asset of assets) {
    const level = own.get(asset.id) || (asset.is_active ? "ok" : "off");
    raise(asset.id, level);

    if (level !== "warning" && level !== "alert") continue;

    let cursor =
      asset.parent_asset_id != null
        ? byId.get(asset.parent_asset_id)
        : null;

    const seen = new Set([asset.id]);

    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      raise(cursor.id, level);

      cursor =
        cursor.parent_asset_id != null
          ? byId.get(cursor.parent_asset_id)
          : null;
    }
  }

  return health;
}

export default function Layout() {
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const confirm = useConfirmation();

  const [rawAssets, setRawAssets] = useState([]);
  const [rules, setRules] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [assetError, setAssetError] = useState("");
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [link, setLink] = useState({
    online: null,
    reason: "",
    at: null,
  });

  const [railOpen, setRailOpen] = useState(() => {
    try {
      return localStorage.getItem("nem-nav") !== "collapsed";
    } catch {
      return true;
    }
  });

  const [compactViewport, setCompactViewport] = useState(() =>
    window.matchMedia("(max-width: 800px)").matches
  );
  const [compactRailOpen, setCompactRailOpen] = useState(false);

  const [treeOpen, setTreeOpen] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  const confirmSignOut = async () => {
    if (signingOut) return;
    const accepted = await confirm(
      "Are you sure you want to sign out of the application?",
      {
        title: "Sign out",
        confirmLabel: "Sign out",
      }
    );
    if (!accepted) return;

    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  };

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("nem-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      
    }

    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;

    try {
      localStorage.setItem("nem-theme", theme);
    } catch {
      
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem("nem-nav", railOpen ? "expanded" : "collapsed");
    } catch {
      
    }
  }, [railOpen]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const updateViewport = () => {
      setCompactViewport(query.matches);
      if (!query.matches) setCompactRailOpen(false);
    };

    query.addEventListener("change", updateViewport);
    return () => query.removeEventListener("change", updateViewport);
  }, []);

  const loadAssets = useCallback(async () => {
    try {
      const items = await api.getAll("/assets");
      setRawAssets(items);
      setAssetError("");
      return items;
    } catch (error) {
      setAssetError(error.message || "Unexpected error while loading assets.");
      throw error;
    } finally {
      setAssetsLoaded(true);
    }
  }, []);

  const refreshRules = useCallback(async () => {
    const result = await api.getAll("/rules");
    setRules(result);
  }, []);

  const refreshAlerts = useCallback(async () => {
    const result = await api.getAll("/alerts/active", 500);
    setAlerts(result);
  }, []);

  const refreshStatus = useCallback(async () => {
    const [ruleList, alertList] = await Promise.allSettled([
      api.getAll("/rules"),
      api.getAll("/alerts/active", 500),
    ]);

    if (ruleList.status === "fulfilled" || alertList.status === "fulfilled") {
      setLink({ online: true, reason: "", at: new Date() });
    } else {
      const status = ruleList.reason?.status || alertList.reason?.status;
      setLink({
        online: false,
        reason: status === 503 ? "Database unavailable" : "API unreachable",
        at: new Date(),
      });
    }

    if (ruleList.status === "fulfilled") {
      setRules(ruleList.value);
    }

    if (alertList.status === "fulfilled") {
      setAlerts(alertList.value);
    }
  }, []);

  const reload = useCallback(async () => {
    const [items] = await Promise.all([
      loadAssets(),
      refreshStatus(),
    ]);

    return items;
  }, [loadAssets, refreshStatus]);

 
  useEffect(() => {
    reload().catch((error) => {
      console.error("Initial application data refresh failed.", error);
    });
  }, [reload]);

  useEffect(() => {
    return subscribeLiveUpdates((update) => {
      const changedTables = new Set(update.changed_tables || []);
      if (update.resync_required) {
        reload().catch((error) => {
          console.error("Live update resynchronization failed.", error);
        });
        return;
      }
      if (update.type === "disconnected") {
        setLink({
          online: false,
          reason: "Live updates disconnected",
          at: new Date(),
        });
        return;
      }
      if (changedTables.has("assets") || changedTables.has("variables")) {
        loadAssets().catch((error) => {
          console.error("Asset refresh after live update failed.", error);
        });
      }
      if (changedTables.has("nem_monitoring_rules")) {
        refreshRules().catch((error) => {
          console.error("Rule refresh after live update failed.", error);
        });
      }
      if (
        changedTables.has("nem_alerts") ||
        changedTables.has("nem_maintenance_schedules")
      ) {
        refreshAlerts().catch((error) => {
          console.error("Alert refresh after live update failed.", error);
        });
      }
    });
  }, [loadAssets, refreshAlerts, refreshRules, reload]);

  const health = useMemo(
    () => computeHealth(rawAssets, alerts),
    [rawAssets, alerts]
  );

  const assets = useMemo(() => {
    const ruleCount = new Map();
    const assetsById = new Map(rawAssets.map((asset) => [asset.id, asset]));

    for (const rule of rules) {
      if (!rule.is_enabled || rule.target_asset_id == null) continue;

      let currentAssetId = rule.target_asset_id;
      const visited = new Set();
      while (currentAssetId != null && !visited.has(currentAssetId)) {
        visited.add(currentAssetId);
        const currentAsset = assetsById.get(currentAssetId);
        if (!currentAsset) break;

        ruleCount.set(
          currentAssetId,
          (ruleCount.get(currentAssetId) || 0) + 1
        );
        currentAssetId = currentAsset.parent_asset_id;
      }
    }

    return rawAssets.map((asset) => ({
      ...asset,
      parent: asset.parent_asset_id ?? null,
      status: asset.is_active ? "enabled" : "disabled",
      health: health.get(asset.id) || (asset.is_active ? "ok" : "off"),
      rule_count: ruleCount.get(asset.id) || 0,
      has_rules: (ruleCount.get(asset.id) || 0) > 0,
    }));
  }, [rawAssets, rules, health]);

  const showTree =
    pathname === "/" ||
    pathname.startsWith("/rules") ||
    pathname.startsWith("/assets");

  const selectedId = Number(
    matchPath("/assets/:id", pathname)?.params.id
  );

  const breadcrumbs = crumbs(pathname, assets);
  const pageTitle = breadcrumbs[breadcrumbs.length - 1].label;

  useEffect(() => {
    document.title = `${pageTitle} - NEM Plant Monitor`;
  }, [pageTitle]);

  const navItem = (to, Icon, label, end) => (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      className={({ isActive }) =>
        "rail-item" + (isActive ? " active" : "")
      }
      title={label}
      onClick={() => {
        if (compactViewport) setCompactRailOpen(false);
      }}
    >
      <Icon size={20} />
      <span className="rail-label">{label}</span>
    </NavLink>
  );

  const linkText =
    link.online === null
      ? "Connecting"
      : link.online
        ? "Backend connected"
        : link.reason;
  const navigationExpanded = compactViewport
    ? compactRailOpen
    : railOpen;

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <div className="app-title">{APP_TITLE}</div>
        <div className="spacer" />
        <span className="auth-user-label">{user.username} · {user.role}</span>
        {user.role === "Administrator" && (
          <Link
            to="/settings/users"
            className="auth-user-link"
            title="Manage users and machine access"
          >
            <Users size={17} /> User access
          </Link>
        )}
        <button
          className="btn-outline auth-logout"
          onClick={confirmSignOut}
          type="button"
          disabled={signingOut}
        >
          <LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}
        </button>

        <div
          className={
            "link-state " +
            (link.online === null ? "wait" : link.online ? "up" : "down")
          }
          role="status"
          title={
            link.at
              ? `Checked ${link.at.toLocaleTimeString()}`
              : "Checking backend"
          }
        >
          <i />
          {linkText}
        </div>

        <button
          className="icon-btn"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <SunIcon size={19} /> : <MoonIcon size={19} />}
        </button>
      </header>

      <div className="body">
        <nav
          className={"rail" + (navigationExpanded ? " open" : "")}
          aria-label="Main"
        >
          <div className="rail-main">
            {navItem("/", HomeIcon, "Overview", true)}
            {navItem("/assets", TreeIcon, "Assets")}
            {navItem("/plc", PlugIcon, "PLC / OPC UA")}
            {navItem("/configuration", ShapesIcon, "Configuration")}
            {navItem("/settings", GearIcon, "Settings")}
          </div>

          <button
            className="rail-item rail-toggle"
            onClick={() => {
              if (compactViewport) {
                setCompactRailOpen((open) => !open);
              } else {
                setRailOpen((open) => !open);
              }
            }}
            title={navigationExpanded ? "Collapse navigation" : "Expand navigation"}
            aria-label={navigationExpanded ? "Collapse navigation" : "Expand navigation"}
            aria-expanded={navigationExpanded}
          >
            <DoubleChevron size={18} />
            <span className="rail-label">Collapse</span>
          </button>
        </nav>

        <div className="main-col">
          <div className="crumbs">
            <nav aria-label="Breadcrumb">
              {breadcrumbs.map((crumb, index) => (
                <span key={index}>
                  {index > 0 && <span className="sep">/</span>}
                  {crumb.to ? (
                    <Link to={crumb.to}>{crumb.label}</Link>
                  ) : (
                    <span className="cur">{crumb.label}</span>
                  )}
                </span>
              ))}
            </nav>

            {showTree && (
              <button
                className="icon-btn"
                onClick={() => setTreeOpen((open) => !open)}
                title={treeOpen ? "Hide asset panel" : "Show asset panel"}
                aria-label={treeOpen ? "Hide asset panel" : "Show asset panel"}
                aria-expanded={treeOpen}
              >
                <PanelIcon size={20} />
              </button>
            )}
          </div>

          <div className="content-row">
            {showTree && treeOpen && (
              <AssetTree
                assets={assets}
                selectedId={selectedId}
                onRefresh={reload}
              />
            )}

            <main className="content">
              {assetError && (
                <div className="banner error" role="alert">
                  <p>Could not load assets: {assetError}</p>
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => reload().catch(() => {})}
                  >
                    Retry
                  </button>
                </div>
              )}

              <Outlet
                context={{
                  assets,
                  assetsLoaded,
                  rules,
                  alerts,
                  reload,
                  refreshStatus,
                  link,
                }}
              />
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
