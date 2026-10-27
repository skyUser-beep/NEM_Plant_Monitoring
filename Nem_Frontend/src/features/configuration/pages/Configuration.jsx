
import React, { useEffect, useState } from "react";
import { api } from "../../../services/api.js";
import GroupedMenu from "../../../components/common/GroupedMenu.jsx";

const ITEMS = [
  {
    to: "/configuration/rules",
    icon: "rules",
    group: "Rules",
    title: "Monitoring Rule Library",
    desc: "Create reusable monitoring rules and assign them to assets.",
  },
  {
    to: "/configuration/collections",
    icon: "collections",
    group: "Rules",
    title: "Monitoring Rule collections",
    desc: "Group the individual monitoring rules, e.g. by machine type.",
  },
  {
    to: "/configuration/documents",
    icon: "documents",
    group: "Content",
    title: "Instructions and documents",
    desc: "Create and manage your task descriptions for Monitoring Rules and upload supplementary documents.",
  },
  {
    to: "/configuration/import",
    icon: "import",
    group: "Content",
    title: "Import configuration",
    desc: "Import monitoring rules and monitoring rule collections.",
  },
  {
    to: "/configuration/export",
    icon: "export",
    group: "Content",
    title: "Export configuration",
    desc: "Export monitoring rules and monitoring rule collections as a JSON file.",
  },
];

const plural = (n, one, many) =>
  `${n} ${n === 1 ? one : many}`;

export default function Configuration() {
  const [badges, setBadges] = useState({});

  useEffect(() => {
    const count = (path, one, many) =>
      api
        .get(path)
        .then((list) =>
          Array.isArray(list) ? plural(list.length, one, many) : ""
        )
        .catch(() => "");

    Promise.all([
      count("/rule-templates", "rule", "rules"),
      count("/collections", "collection", "collections"),
      count("/documents", "document", "documents"),
    ]).then(([rules, collections, documents]) =>
      setBadges({
        "/configuration/rules": rules,
        "/configuration/collections": collections,
        "/configuration/documents": documents,
        "/configuration/import": "JSON file",
        "/configuration/export": "JSON file",
      })
    );
  }, []);

  return (
    <GroupedMenu
      title="Configuration"
      items={ITEMS}
      badges={badges}
    />
  );
}
