from datetime import date, datetime, timedelta, timezone

from cryptography.fernet import Fernet
from pydantic import SecretStr

from app.models import FrontendConfig


def create_asset(client, name="Machine 1"):
    response = client.post(
        "/api/v1/assets", json={"name": name, "asset_type": "machine"}
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create_numeric_variable(client, asset_id):
    response = client.post(
        f"/api/v1/assets/{asset_id}/variables",
        json={
            "name": "Rotation count",
            "key": "rotation_count",
            "data_type": "integer",
            "unit": "cycles",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_frontend_compatibility_maps_rules_and_maintenance(client):
    asset_id = create_asset(client)
    variable_id = create_numeric_variable(client, asset_id)
    created = client.post(
        f"/api/v1/assets/{asset_id}/rules",
        json={
            "name": "Motor cycle warning",
            "description": "Warn before maintenance",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "rule_type": "parameter_threshold",
            "operator": ">=",
            "threshold": 900,
            "severity": "warning",
        },
    )
    assert created.status_code == 201, created.text
    rule_id = created.json()["id"]
    assert created.json()["state"] == "activated"

    ingested = client.post(
        "/api/v1/readings",
        json={"asset_id": asset_id, "variable_id": variable_id, "value": 900},
    )
    assert ingested.status_code == 201, ingested.text
    assert client.get(f"/api/v1/assets/{asset_id}/rules").json()[0]["status"] == "warning"

    log = client.post(
        f"/api/v1/assets/{asset_id}/logbook", json={"text": "Inspected motor"}
    )
    assert log.status_code == 201, log.text
    assert client.get(f"/api/v1/assets/{asset_id}/logbook").json()[0]["text"] == "Inspected motor"

    status_rows = client.get("/api/v1/rules/status/warning")
    assert status_rows.status_code == 200
    assert status_rows.json()[0]["id"] == rule_id
    assert status_rows.json()[0]["asset_name"] == "Machine 1"
    assert client.get("/api/v1/summary").json()["rules_warning"] == 1

    changed = client.patch(f"/api/v1/rules/{rule_id}", json={"is_enabled": False})
    assert changed.status_code == 200, changed.text
    assert changed.json()["is_enabled"] is False
    assert client.get(f"/api/v1/assets/{asset_id}/rules").json()[0]["state"] == "not_activated"


def test_frontend_compatibility_creates_usage_and_time_rules(client):
    asset_id = create_asset(client)
    variable_id = create_numeric_variable(client, asset_id)
    start_date = date.today()
    due_date = start_date + timedelta(days=14)

    interval_schedule = client.post(
        "/api/v1/maintenance/schedules",
        json={
            "asset_id": asset_id,
            "title": "Cycle interval service",
            "maintenance_type": "preventive",
            "schedule_start_date": start_date.isoformat(),
            "first_due_date": due_date.isoformat(),
            "recurrence_enabled": True,
            "recurrence_interval": 1,
            "recurrence_unit": "months",
        },
    )
    assert interval_schedule.status_code == 201, interval_schedule.text
    assert interval_schedule.json()["first_due_date"] == due_date.isoformat()
    assert interval_schedule.json()["recurrence_unit"] == "months"

    usage = client.post(
        f"/api/v1/assets/{asset_id}/rules/usage",
        json={
            "name": "Monthly usage limit",
            "description": "Track machine usage",
            "variable_id": variable_id,
            "usage_limit": 1200,
            "severity": "warning",
        },
    )
    assert usage.status_code == 201, usage.text
    assert usage.json()["rule_type"] == "parameter_threshold"
    assert usage.json()["variable_id"] == variable_id
    assert usage.json()["operator"] == ">="
    assert usage.json()["threshold"] == 1200

    invalid_usage = client.post(
        f"/api/v1/assets/{asset_id}/rules/usage",
        json={
            "name": "Invalid metric",
            "variable_id": variable_id + 500,
            "usage_limit": 1,
            "severity": "warning",
        },
    )
    assert invalid_usage.status_code == 404
    assert client.post(
        f"/api/v1/assets/{asset_id}/rules/time",
        json={"name": "Unsupported fake rule"},
    ).status_code == 410

    scheduled = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "title": "Operating window service",
            "notes": "Inspect equipment during this time window",
            "maintenance_type": "preventive",
            "status": "planned",
            "planned_start_at": "2026-11-01T08:00:00Z",
            "planned_end_at": "2026-11-01T17:00:00Z",
        },
    )
    assert scheduled.status_code == 201, scheduled.text
    assert scheduled.json()["asset_id"] == asset_id
    assert scheduled.json()["status"] == "planned"
    assert client.get(
        f"/api/v1/maintenance?asset_id={asset_id}"
    ).json()["items"][0]["title"] == "Operating window service"


def test_predefined_assignment_clones_and_prevents_duplicates(client):
    source_asset = create_asset(client, "Template source")
    source_variable = create_numeric_variable(client, source_asset)
    target_asset = create_asset(client, "Template target")
    target_variable = create_numeric_variable(client, target_asset)
    template_response = client.post(
        "/api/v1/rules",
        json={
            "name": "Cycle count limit",
            "rule_type": "parameter_threshold",
            "target_asset_id": None,
            "variable_id": source_variable,
            "operator": ">=",
            "threshold": 1000,
            "severity": "warning",
            "is_enabled": False,
        },
    )
    assert template_response.status_code == 201, template_response.text
    template_id = template_response.json()["id"]
    unsupported_template = client.post(
        "/api/v1/rules",
        json={
            "name": "Unimplemented evaluator",
            "rule_type": "generic",
            "target_asset_id": None,
            "variable_id": source_variable,
            "severity": "warning",
            "is_enabled": False,
        },
    )
    assert unsupported_template.status_code == 201, unsupported_template.text

    predefined = client.get(f"/api/v1/assets/{target_asset}/rules/predefined")
    assert predefined.status_code == 200, predefined.text
    template = next(row for row in predefined.json() if row["id"] == template_id)
    assert template["assigned"] is False
    assert template["mapped_variable_name"] == "Rotation count"
    unsupported = next(
        row for row in predefined.json()
        if row["id"] == unsupported_template.json()["id"]
    )
    assert unsupported["unavailable_reason"]

    atomic_failure = client.post(
        f"/api/v1/assets/{target_asset}/rules/assign",
        json={"rule_ids": [template_id, unsupported_template.json()["id"]]},
    )
    assert atomic_failure.status_code == 422
    assert client.get(f"/api/v1/assets/{target_asset}/rules").json() == []

    assigned = client.post(
        f"/api/v1/assets/{target_asset}/rules/assign",
        json={"rule_ids": [template_id]},
    )
    assert assigned.status_code == 201, assigned.text
    created = assigned.json()["created"]
    assert len(created) == 1
    assigned_rule = client.get(f"/api/v1/rules/{created[0]['id']}").json()
    assert assigned_rule["target_asset_id"] == target_asset
    assert assigned_rule["variable_id"] == target_variable
    assert assigned_rule["is_enabled"] is False

    repeated = client.post(
        f"/api/v1/assets/{target_asset}/rules/assign",
        json={"rule_ids": [template_id]},
    )
    assert repeated.status_code == 201, repeated.text
    assert repeated.json()["created"] == []
    assert repeated.json()["already_assigned"] == [template_id]

    assert client.get(f"/api/v1/rules/{template_id}").json()["target_asset_id"] is None


def test_copy_rules_keeps_source_and_creates_disabled_mapped_copy(client):
    source_asset = create_asset(client, "Copy source")
    source_variable = create_numeric_variable(client, source_asset)
    target_asset = create_asset(client, "Copy target")
    target_variable = create_numeric_variable(client, target_asset)
    source_rule = client.post(
        f"/api/v1/assets/{source_asset}/rules",
        json={
            "name": "Temperature limit",
            "rule_type": "parameter_threshold",
            "target_asset_id": source_asset,
            "variable_id": source_variable,
            "operator": ">=",
            "threshold": 90,
            "severity": "alert",
            "is_enabled": True,
        },
    )
    assert source_rule.status_code == 201, source_rule.text
    source_rule_id = source_rule.json()["id"]
    unmatched_variable_response = client.post(
        f"/api/v1/assets/{source_asset}/variables",
        json={
            "name": "Runtime hours",
            "key": "runtime_hours",
            "data_type": "integer",
            "unit": "hours",
        },
    )
    assert unmatched_variable_response.status_code == 201, unmatched_variable_response.text
    unmatched_rule = client.post(
        f"/api/v1/assets/{source_asset}/rules",
        json={
            "name": "Runtime limit",
            "rule_type": "parameter_threshold",
            "target_asset_id": source_asset,
            "variable_id": unmatched_variable_response.json()["id"],
            "operator": ">=",
            "threshold": 500,
            "severity": "warning",
            "is_enabled": False,
        },
    )
    assert unmatched_rule.status_code == 201, unmatched_rule.text

    invalid_batch = client.post(
        f"/api/v1/assets/{target_asset}/rules/copy",
        json={
            "source_asset_id": source_asset,
            "rule_ids": [source_rule_id, unmatched_rule.json()["id"]],
        },
    )
    assert invalid_batch.status_code == 422
    assert client.get(f"/api/v1/assets/{target_asset}/rules").json() == []

    copied = client.post(
        f"/api/v1/assets/{target_asset}/rules/copy",
        json={
            "source_asset_id": source_asset,
            "rule_ids": [source_rule_id],
            "include_disabled": True,
        },
    )
    assert copied.status_code == 201, copied.text
    created = copied.json()["created"]
    assert len(created) == 1
    copy = client.get(f"/api/v1/rules/{created[0]['id']}").json()
    assert copy["target_asset_id"] == target_asset
    assert copy["variable_id"] == target_variable
    assert copy["is_enabled"] is False
    assert client.get(f"/api/v1/rules/{source_rule_id}").json()["target_asset_id"] == source_asset

    repeated = client.post(
        f"/api/v1/assets/{target_asset}/rules/copy",
        json={
            "source_asset_id": source_asset,
            "rule_ids": [source_rule_id],
        },
    )
    assert repeated.status_code == 201, repeated.text
    assert repeated.json()["created"] == []
    assert repeated.json()["already_copied"] == [source_rule_id]


def test_bulk_rule_actions_respect_child_scope_and_skip_unsupported_rules(client):
    root_id = create_asset(client, "Bulk root")
    child_response = client.post(
        "/api/v1/assets",
        json={
            "name": "Bulk child",
            "asset_type": "machine",
            "parent_asset_id": root_id,
        },
    )
    assert child_response.status_code == 201, child_response.text
    child_id = child_response.json()["id"]
    root_variable = create_numeric_variable(client, root_id)
    child_variable = create_numeric_variable(client, child_id)

    def create_threshold(asset_id, variable_id, name):
        response = client.post(
            f"/api/v1/assets/{asset_id}/rules",
            json={
                "name": name,
                "rule_type": "parameter_threshold",
                "target_asset_id": asset_id,
                "variable_id": variable_id,
                "operator": ">=",
                "threshold": 100,
                "severity": "warning",
                "is_enabled": False,
            },
        )
        assert response.status_code == 201, response.text
        return response.json()["id"]

    root_rule = create_threshold(root_id, root_variable, "Root limit")
    child_rule = create_threshold(child_id, child_variable, "Child limit")
    generic = client.post(
        "/api/v1/rules",
        json={
            "name": "Unsupported generic",
            "rule_type": "generic",
            "target_asset_id": root_id,
            "severity": "warning",
            "is_enabled": False,
        },
    )
    assert generic.status_code == 201, generic.text

    root_only = client.post(
        f"/api/v1/assets/{root_id}/rules/bulk?include_children=false",
        json={"state": "activated"},
    )
    assert root_only.status_code == 200, root_only.text
    assert root_only.json()["updated_rule_ids"] == [root_rule]
    assert [item["rule_id"] for item in root_only.json()["skipped"]] == [generic.json()["id"]]
    assert client.get(f"/api/v1/assets/{child_id}/rules").json()[0]["state"] == "not_activated"

    with_children = client.post(
        f"/api/v1/assets/{root_id}/rules/bulk?include_children=true",
        json={"state": "activated"},
    )
    assert with_children.status_code == 200, with_children.text
    assert with_children.json()["updated_rule_ids"] == [child_rule]

    deactivated = client.post(
        f"/api/v1/assets/{root_id}/rules/bulk?include_children=true",
        json={"state": "not_activated"},
    )
    assert deactivated.status_code == 200, deactivated.text
    assert set(deactivated.json()["updated_rule_ids"]) == {root_rule, child_rule}
    assert client.get(f"/api/v1/assets/{root_id}/rules?include_children=true").json()
    assert client.get(f"/api/v1/rules/{generic.json()['id']}").json()["is_enabled"] is False


def test_permanent_rule_deletion_requires_disabled_rule_and_unlinked_alerts(client):
    asset_id = create_asset(client, "Permanent deletion target")
    variable_id = create_numeric_variable(client, asset_id)
    created = client.post(
        f"/api/v1/assets/{asset_id}/rules",
        json={
            "name": "Permanent deletion threshold",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "rule_type": "parameter_threshold",
            "operator": ">=",
            "threshold": 10,
            "severity": "alert",
        },
    )
    assert created.status_code == 201, created.text
    rule_id = created.json()["id"]
    assert client.post(
        "/api/v1/readings",
        json={"asset_id": asset_id, "variable_id": variable_id, "value": 10},
    ).status_code == 201

    active_delete = client.delete(f"/api/v1/rules/{rule_id}/permanent")
    assert active_delete.status_code == 409
    alert = client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()["items"][0]
    disabled = client.patch(
        f"/api/v1/rules/{rule_id}", json={"is_enabled": False}
    )
    assert disabled.status_code == 200, disabled.text

    maintenance = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "alert_id": alert["id"],
            "summary": "Alert-linked maintenance",
            "performed_by": "Operator",
            "performed_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    assert maintenance.status_code == 201, maintenance.text
    blocked_delete = client.delete(f"/api/v1/rules/{rule_id}/permanent")
    assert blocked_delete.status_code == 409
    assert client.get(f"/api/v1/rules/{rule_id}").status_code == 200
    assert client.get(f"/api/v1/maintenance/{maintenance.json()['id']}").status_code == 200

    assert client.delete(
        f"/api/v1/maintenance/{maintenance.json()['id']}"
    ).status_code == 204
    assert client.delete(
        f"/api/v1/maintenance/{maintenance.json()['id']}/permanent"
    ).status_code == 204
    deleted = client.delete(f"/api/v1/rules/{rule_id}/permanent")
    assert deleted.status_code == 204, deleted.text
    assert client.get(f"/api/v1/rules/{rule_id}").status_code == 404
    assert client.get(f"/api/v1/assets/{asset_id}/rules").json() == []
    assert client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()["items"] == []
    deletion_events = client.get(
        f"/api/v1/events?asset_id={asset_id}&event_type=rule_permanently_deleted"
    )
    assert deletion_events.status_code == 200
    assert deletion_events.json()["total"] == 1
    assert deletion_events.json()["items"][0]["metadata"]["deleted_rule_id"] == rule_id


def test_frontend_profile_collections_and_documents(client):
    saved_profile = client.put(
        "/api/v1/me",
        json={"name": "Plant Manager", "email": "manager@example.com", "phone": "123"},
    )
    assert saved_profile.status_code == 200
    assert saved_profile.json()["name"] == "Plant Manager"
    assert saved_profile.json()["role"] == "Administrator"

    collection = client.post(
        "/api/v1/collections",
        json={"name": "Motor rules", "description": "Motor monitoring rules"},
    )
    assert collection.status_code == 201, collection.text
    assert client.get("/api/v1/collections").json()[0]["name"] == "Motor rules"

    document = client.post(
        "/api/v1/documents",
        json={"title": "Motor checklist", "kind": "Checklist", "description": "Inspect bearings"},
    )
    assert document.status_code == 201, document.text
    assert client.get("/api/v1/documents").json()[0]["title"] == "Motor checklist"


def test_frontend_email_settings_encrypt_password_and_preserve_it(client):
    encryption_key = Fernet.generate_key()
    client.app.state.settings.settings_encryption_key = SecretStr(encryption_key.decode())

    saved = client.put(
        "/api/v1/settings/email",
        json={
            "host": "smtp.example.com",
            "port": "587",
            "username": "machine-monitor",
            "password": "example-secret",
            "sender": "monitor@example.com",
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["password"] == ""
    assert saved.json()["has_password"] is True
    assert "example-secret" not in saved.text

    with client.app.state.session_factory() as session:
        ciphertext = session.get(FrontendConfig, "email").value["password_ciphertext"]
    assert Fernet(encryption_key).decrypt(ciphertext.encode()).decode() == "example-secret"

    loaded = client.get("/api/v1/settings/email")
    assert loaded.status_code == 200
    assert loaded.json()["password"] == ""
    assert "password_ciphertext" not in loaded.json()

    preserved = client.put("/api/v1/settings/email", json=loaded.json())
    assert preserved.status_code == 200
    assert preserved.json()["has_password"] is True


def test_frontend_backup_restore_replaces_monitoring_data(client, tmp_path):
    client.app.state.settings.backup_directory = str(tmp_path / "backups")
    asset_id = create_asset(client)
    variable_id = create_numeric_variable(client, asset_id)
    backup = client.post("/api/v1/backups", json={"name": "Before change"})
    assert backup.status_code == 201, backup.text

    updated = client.patch(
        f"/api/v1/assets/{asset_id}", json={"name": "Changed machine"}
    )
    assert updated.status_code == 200
    restored = client.post(f"/api/v1/backups/{backup.json()['id']}/restore")
    assert restored.status_code == 200, restored.text

    assets = client.get("/api/v1/assets?limit=200").json()["items"]
    assert [asset["name"] for asset in assets] == ["Machine 1"]
    assert assets[0]["id"] == asset_id
    variables = client.get(f"/api/v1/assets/{asset_id}/variables?limit=200").json()["items"]
    assert variables[0]["id"] == variable_id
