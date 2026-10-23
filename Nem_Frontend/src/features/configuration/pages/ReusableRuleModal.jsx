
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
      const payload = {
        ...templatePayload(values),
        collection_id: collection.id,
      };
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
      intro={`Add a reusable rule to "${collection.name}" (${collection.ruleCount || 0} of 5 rules). It can then be assigned to assets.`}
      fields={FIELDS}
      initialValues={initialTemplate(null)}
      submitLabel={saving ? "Creating..." : "Create rule"}
      onSubmit={save}
      onClose={onClose}
    />
  );
}
