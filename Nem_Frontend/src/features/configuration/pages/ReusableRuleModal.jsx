
import React, { useState } from "react";
import { api } from "../../../services/api.js";
import { CreateModal } from "../../../components/common/UI.jsx";
import {
  FIELDS,
  initialTemplate,
  templatePayload,
} from "./RuleLibrary.jsx";

export default function ReusableRuleModal({
  collection,
  onClose,
  onCreated,
}) {
  const [saving, setSaving] = useState(false);

  const save = async (values) => {
    setSaving(true);

    try {
      const payload = templatePayload(values);
      const result = await api.post("/rule-templates", payload);

      await onCreated?.(result, collection);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <CreateModal
      title="Create reusable rule"
      intro={`Create a reusable rule for collection "${collection.name}", then assign it to assets.`}
      fields={FIELDS}
      initialValues={initialTemplate(null)}
      submitLabel={saving ? "Creating..." : "Create rule"}
      onSubmit={save}
      onClose={onClose}
    />
  );
}
