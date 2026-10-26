import React, { useEffect, useState } from "react";
import { api } from "../../../services/api.js";
import GroupedMenu from "../../../components/common/GroupedMenu.jsx";

const ITEMS = [
  { to: "/settings/user", icon: "user", group: "Account", title: "User information", desc: "Show user profile." },
  { to: "/settings/email", icon: "email", group: "Account", title: "Email server settings", desc: "Set up the address and credentials for an outgoing email service to send notifications." },
  { to: "/settings/analytics", icon: "analytics", group: "System", title: "Analytics extensions", desc: "Set up Databus connection and detect analytics extensions" },
  { to: "/settings/connectivity", icon: "analytics", group: "System", title: "Connectivity configuration", desc: "Configure IE Databus address, authentication and discovery topic." },
  { to: "/settings/usage", icon: "usage", group: "System", title: "Usage information", desc: "Information on resources in use." },
  { to: "/settings/backup", icon: "backup", group: "System", title: "Backup and restore", desc: "Backup or restore the app." },
];

export default function Settings() {
  const [badges, setBadges] = useState({});

  
  useEffect(() => {
    const safe = (promise, fn) => promise.then(fn).catch(() => "");
    Promise.all([
      safe(api.get("/auth/me"), (u) => u?.username || ""),
      safe(api.get("/settings/email"), (s) => (s?.host ? "Set up" : "Not set up")),
      safe(api.get("/settings/analytics"), (s) => (s?.databus_host ? "Configured" : "Not set up")),
      safe(api.get("/settings/connectivity"), (s) => (s?.databus_host ? "Configured" : "Not set up")),
      safe(api.get("/backups"), (list) =>
        Array.isArray(list) ? (list.length === 0 ? "No backups" : `${list.length} ${list.length === 1 ? "backup" : "backups"}`) : ""
      ),
    ]).then(([user, email, analytics, connectivity, backup]) =>
      setBadges({
        "/settings/user": user,
        "/settings/email": email,
        "/settings/analytics": analytics,
        "/settings/connectivity": connectivity,
        "/settings/backup": backup,
      })
    );
  }, []);

  return <GroupedMenu title="Settings" items={ITEMS} badges={badges} />;
}
