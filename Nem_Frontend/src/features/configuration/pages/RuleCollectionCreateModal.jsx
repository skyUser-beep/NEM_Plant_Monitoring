import React, { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { CreateModal, Modal } from "../../../components/common/UI.jsx";
import {
  FIELDS,
  initialTemplate,
  templatePayload,
} from "./RuleLibrary.jsx";

const MAX_RULES = 5;

export default function RuleCollectionCreateModal({
  onClose,
  onCreate,
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState([]);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addRule = (values) => {
    setRules((current) => [...current, templatePayload(values)]);
    setRuleModalOpen(false);
    setError("");
  };

  const save = async (event) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Collection name is required.");
      return;
    }
    if (rules.length === 0) {
      setError("Add at least one monitoring rule to the collection.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || null,
        rules,
      });
    } catch (requestError) {
      setError(requestError.message || "Could not create the rule collection.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {!ruleModalOpen && (
      <Modal title="Create rule collection" onClose={saving ? undefined : onClose} wide>
        <form onSubmit={save}>
          <p className="muted modal-intro">
            Name the collection, then add between one and five reusable monitoring rules.
          </p>
          <label className="field">
            Collection name <span className="req">*</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
              disabled={saving}
              placeholder="e.g. Mixer machine checks"
            />
          </label>
          <label className="field">
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              disabled={saving}
            />
          </label>

          <section aria-label="Collection rules">
            <div className="panel-head">
              <h4>Monitoring rules ({rules.length}/{MAX_RULES})</h4>
              <button
                type="button"
                className="btn-outline"
                onClick={() => setRuleModalOpen(true)}
                disabled={saving || rules.length >= MAX_RULES}
              >
                <Plus size={16} /> Add rule
              </button>
            </div>
            {rules.length === 0 ? (
              <p className="muted">No rules added yet.</p>
            ) : (
              <ol>
                {rules.map((rule, index) => (
                  <li key={`${rule.name}-${index}`}>
                    <span>{rule.name}</span>
                    <button
                      type="button"
                      className="btn-outline"
                      aria-label={`Remove ${rule.name}`}
                      onClick={() =>
                        setRules((current) =>
                          current.filter((_, ruleIndex) => ruleIndex !== index)
                        )
                      }
                      disabled={saving}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {error && <p className="notice error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Creating…" : "Create collection"}
            </button>
          </div>
        </form>
      </Modal>
      )}

      {ruleModalOpen && (
        <CreateModal
          title="Add monitoring rule"
          intro="Configure this reusable rule using the same settings as the Monitoring Rule Library."
          fields={FIELDS}
          initialValues={initialTemplate(null)}
          submitLabel="Add rule to collection"
          onSubmit={addRule}
          onClose={() => setRuleModalOpen(false)}
        />
      )}
    </>
  );
}
