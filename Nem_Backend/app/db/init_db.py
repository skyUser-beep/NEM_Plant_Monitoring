from sqlalchemy import inspect, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
import app.models
from app.db.base import Base
from app.models import (
    FrontendConfig,
    MachineMonitoringState,
    MonitoringRule,
    MonitoringRuleTemplate,
    RuleCounterState,
    Variable,
)

#creates tables defined in SQLAlchemy models if they do not exist
def _migrate_auth_roles(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE auth_users
                SET role = CASE role
                    WHEN 'Admin' THEN 'Administrator'
                    WHEN 'Viewer' THEN 'Supervisor'
                    ELSE role
                END
                WHERE role IN ('Admin', 'Viewer')
                """
            )
        )
        invalid_role = connection.execute(
            text(
                """
                SELECT id, role
                FROM auth_users
                WHERE role NOT IN ('Administrator', 'Supervisor', 'Operator')
                LIMIT 1
                """
            )
        ).first()
        if invalid_role is not None:
            raise RuntimeError(
                "Unsupported user role in auth_users "
                f"(user id {invalid_role.id}, role {invalid_role.role!r}); "
                "correct the role before starting the application"
            )

        if engine.dialect.name == "postgresql":
            check_constraints = inspect(connection).get_check_constraints("auth_users")
            if not any(
                constraint["name"] == "ck_auth_users_role"
                for constraint in check_constraints
            ):
                connection.execute(
                    text(
                        "ALTER TABLE auth_users "
                        "ADD CONSTRAINT ck_auth_users_role "
                        "CHECK (role IN "
                        "('Administrator', 'Supervisor', 'Operator'))"
                    )
                )
        elif engine.dialect.name == "sqlite":
            connection.execute(
                text(
                    """
                    CREATE TRIGGER IF NOT EXISTS auth_users_role_insert_guard
                    BEFORE INSERT ON auth_users
                    FOR EACH ROW
                    WHEN NEW.role NOT IN ('Administrator', 'Supervisor', 'Operator')
                    BEGIN
                        SELECT RAISE(ABORT, 'invalid user role');
                    END
                    """
                )
            )
            connection.execute(
                text(
                    """
                    CREATE TRIGGER IF NOT EXISTS auth_users_role_update_guard
                    BEFORE UPDATE OF role ON auth_users
                    FOR EACH ROW
                    WHEN NEW.role NOT IN ('Administrator', 'Supervisor', 'Operator')
                    BEGIN
                        SELECT RAISE(ABORT, 'invalid user role');
                    END
                    """
                )
            )
        else:
            raise RuntimeError("User role migration is not implemented for "f"{engine.dialect.name}")


def initialize_database(engine: Engine) -> None:
    Base.metadata.create_all(bind=engine)
    _migrate_auth_roles(engine)
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "nem_monitoring_rule_templates" in table_names:
        template_columns = {
            column["name"]
            for column in inspector.get_columns("nem_monitoring_rule_templates")
        }
        if "collection_id" not in template_columns:
            with engine.begin() as connection:
                if engine.dialect.name == "postgresql":
                    connection.execute(text(
                        "ALTER TABLE nem_monitoring_rule_templates "
                        "ADD COLUMN IF NOT EXISTS collection_id INTEGER "
                        "REFERENCES rule_collections(id) ON DELETE SET NULL"
                    ))
                else:
                    connection.execute(text(
                        "ALTER TABLE nem_monitoring_rule_templates "
                        "ADD COLUMN collection_id INTEGER "
                        "REFERENCES rule_collections(id) ON DELETE SET NULL"
                    ))
        with engine.begin() as connection:
            connection.execute(text(
                "CREATE INDEX IF NOT EXISTS "
                "ix_nem_monitoring_rule_templates_collection_id "
                "ON nem_monitoring_rule_templates (collection_id)"
            ))
    if "instruction_documents" in table_names:
        document_columns = {
            column["name"]
            for column in inspector.get_columns("instruction_documents")
        }
        with engine.begin() as connection:
            if "labels" not in document_columns:
                connection.execute(
                    text(
                        "ALTER TABLE instruction_documents "
                        "ADD COLUMN labels JSON NOT NULL DEFAULT '[]'"
                    )
                )
            if "duration_minutes" not in document_columns:
                connection.execute(
                    text(
                        "ALTER TABLE instruction_documents "
                        "ADD COLUMN duration_minutes INTEGER"
                    )
                )

    if "variables" in table_names:
        variable_columns = {column["name"] for column in inspector.get_columns("variables")
        }
        if "opcua_node_id" not in variable_columns:
            with engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE variables "
                        "ADD COLUMN opcua_node_id VARCHAR(512)"
                    )
                )
        if "signal_role" not in variable_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE variables ADD COLUMN signal_role VARCHAR(20)"))
        with engine.begin() as connection:
            connection.execute(text("DROP INDEX IF EXISTS uq_variables_opcua_node_id"))
            connection.execute(text("DROP INDEX IF EXISTS ix_variables_opcua_node_id"))
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_variables_opcua_node_id "
                    "ON variables (opcua_node_id)"
                )
            )
    if "nem_monitoring_rules" in table_names:
        rule_columns = {
            column["name"]
            for column in inspector.get_columns("nem_monitoring_rules")
        }
        with engine.begin() as connection:
            if "lifecycle_status" not in rule_columns:
                if engine.dialect.name == "postgresql":
                    connection.execute(
                        text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS lifecycle_status "
                            "VARCHAR(20) NOT NULL DEFAULT 'deactivated'"
                        )
                    )
                else:
                    connection.execute(
                        text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN lifecycle_status "
                            "VARCHAR(20) NOT NULL DEFAULT 'deactivated'"
                        )
                    )
                connection.execute(
                    text(
                        "UPDATE nem_monitoring_rules SET lifecycle_status = "
                        "CASE WHEN is_enabled = TRUE "
                        "THEN 'in_progress' ELSE 'deactivated' END"
                    )
                )
            if "completed_at" not in rule_columns:
                column_type = ("TIMESTAMP WITH TIME ZONE"
                    if engine.dialect.name == "postgresql"
                    else "DATETIME"
                )
                if engine.dialect.name == "postgresql":
                    connection.execute(
                        text("ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS completed_at "
                            + column_type
                        )
                    )
                else:
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN completed_at " + column_type
                        )
                    )
            if "is_archived" not in rule_columns:
                if engine.dialect.name == "postgresql":
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS is_archived "
                            "BOOLEAN NOT NULL DEFAULT FALSE"
                        )
                    )
                else:
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN is_archived "
                            "BOOLEAN NOT NULL DEFAULT FALSE"
                        )
                    )
            if "source_template_id" not in rule_columns:
                if engine.dialect.name == "postgresql":
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN IF NOT EXISTS source_template_id INTEGER "
                            "REFERENCES nem_monitoring_rule_templates(id) "
                            "ON DELETE RESTRICT"
                        )
                    )
                else:
                    connection.execute(text(
                            "ALTER TABLE nem_monitoring_rules "
                            "ADD COLUMN source_template_id INTEGER "
                            "REFERENCES nem_monitoring_rule_templates(id) "
                            "ON DELETE RESTRICT"
                        )
                    )
            connection.execute(text(
                    "CREATE INDEX IF NOT EXISTS "
                    "ix_nem_monitoring_rules_source_template_id "
                    "ON nem_monitoring_rules (source_template_id)"
                )
            )
    _migrate_legacy_rule_templates(engine)
    _migrate_boolean_duration_templates(engine)
    _migrate_existing_rule_counters(engine)

    if "nem_maintenance_schedules" in table_names:
        schedule_columns = {column["name"]
            for column in inspect(engine).get_columns(
                "nem_maintenance_schedules"
            )
        }
        if "instruction_document_ids" not in schedule_columns:
            with engine.begin() as connection:
                connection.execute(text(
                    "ALTER TABLE nem_maintenance_schedules "
                    "ADD COLUMN instruction_document_ids JSON NOT NULL DEFAULT '[]'"
                ))
        if "current_period_start_date" not in schedule_columns:
            with engine.begin() as connection:
                connection.execute(text(
                        "ALTER TABLE nem_maintenance_schedules "
                        "ADD COLUMN current_period_start_date DATE"
                    )
                )
                connection.execute(text(
                        "UPDATE nem_maintenance_schedules "
                        "SET current_period_start_date = schedule_start_date "
                        "WHERE current_period_start_date IS NULL"
                    )
                )
                if engine.dialect.name == "postgresql":
                    connection.execute(text(
                            "ALTER TABLE nem_maintenance_schedules "
                            "ALTER COLUMN current_period_start_date SET NOT NULL"
                        )
                    )
    if "nem_maintenance_records" in table_names:
        record_columns = {
            column["name"]
            for column in inspect(engine).get_columns(
                "nem_maintenance_records"
            )
        }
        record_column_definitions = {
            "maintenance_type": "VARCHAR(30) NOT NULL DEFAULT 'inspection'",
            "status": "VARCHAR(20) NOT NULL DEFAULT 'completed'",
            "planned_start_at": "TIMESTAMP",
            "planned_end_at": "TIMESTAMP",
            "actual_started_at": "TIMESTAMP",
            "actual_completed_at": "TIMESTAMP",
            "priority": "VARCHAR(20) NOT NULL DEFAULT 'medium'",
            "assigned_technician": "VARCHAR(200)",
            "completion_notes": "TEXT",
            "parts_used": "TEXT",
            "checklist": "JSON",
            "schedule_id": (
                "INTEGER REFERENCES nem_maintenance_schedules(id) "
                "ON DELETE RESTRICT"
            ),
            "planned_due_date": "DATE",
            "archived_at": "TIMESTAMP",
        }
        with engine.begin() as connection:
            for name, definition in record_column_definitions.items():
                if name not in record_columns:
                    connection.execute(text("ALTER TABLE nem_maintenance_records "
                            f"ADD COLUMN {name} {definition}"
                        )
                    )
            connection.execute(text(
                    "UPDATE nem_maintenance_records "
                    "SET actual_completed_at = performed_at "
                    "WHERE status = 'completed' AND actual_completed_at IS NULL"
                )
            )
            connection.execute(text(
                    "UPDATE nem_maintenance_records "
                    "SET archived_at = COALESCE(actual_completed_at, performed_at, CURRENT_TIMESTAMP) "
                    "WHERE status = 'completed' AND archived_at IS NULL"
                )
            )

    if "nem_alerts" in table_names and "nem_maintenance_schedules" in table_names:
        alert_columns = {column["name"]
            for column in inspect(engine).get_columns("nem_alerts")
        }

        with engine.begin() as connection:
            if "maintenance_schedule_id" not in alert_columns:
                connection.execute(text("ALTER TABLE nem_alerts "
                        "ADD COLUMN maintenance_schedule_id INTEGER"
                    )
                )
            if "maintenance_due_date" not in alert_columns:
                connection.execute(text("ALTER TABLE nem_alerts "
                        "ADD COLUMN maintenance_due_date DATE"
                    )
                )

            if engine.dialect.name == "postgresql":
                connection.execute(text(
                        "DO $$ BEGIN "
                        "IF NOT EXISTS (SELECT 1 FROM pg_constraint "
                        "WHERE conname = 'fk_nem_alerts_maintenance_schedule') "
                        "THEN ALTER TABLE nem_alerts "
                        "ADD CONSTRAINT fk_nem_alerts_maintenance_schedule "
                        "FOREIGN KEY (maintenance_schedule_id) "
                        "REFERENCES nem_maintenance_schedules(id) "
                        "ON DELETE RESTRICT; END IF; END $$"
                    )
                )
                connection.execute(text(
                        "CREATE INDEX IF NOT EXISTS "
                        "ix_nem_alerts_maintenance_schedule_id "
                        "ON nem_alerts (maintenance_schedule_id)"
                    )
                )
                connection.execute(text(
                        "CREATE UNIQUE INDEX IF NOT EXISTS "
                        "uq_nem_alerts_active_maintenance_due "
                        "ON nem_alerts (maintenance_schedule_id, maintenance_due_date) "
                        "WHERE status = 'active' "
                        "AND maintenance_schedule_id IS NOT NULL"
                    )
                )
                connection.execute(text(
                        "DO $$ BEGIN "
                        "IF NOT EXISTS (SELECT 1 FROM pg_constraint "
                        "WHERE conname = 'ck_nem_alerts_source') "
                        "THEN ALTER TABLE nem_alerts "
                        "ADD CONSTRAINT ck_nem_alerts_source CHECK ("
                        "(rule_id IS NOT NULL AND maintenance_schedule_id IS NULL) "
                        "OR (rule_id IS NULL AND maintenance_schedule_id IS NOT NULL "
                        "AND maintenance_due_date IS NOT NULL)); "
                        "END IF; END $$"
                    )
                )
#converts qualifying older rules into resuable templates
def _migrate_legacy_rule_templates(engine: Engine) -> None:
    supported_types = {
        "parameter_threshold",
        "runtime_duration",
        "duration",
        "boolean_count_threshold",
    }
    type_map = {
        "number": ["number"],
        "integer": ["integer"],
        "boolean": ["boolean"],
        "string": ["string"],
    }
    with Session(engine) as session:
        legacy_rules = session.scalars(
            select(MonitoringRule).where(
                MonitoringRule.target_asset_id.is_(None),
                MonitoringRule.is_archived.is_(False),
                MonitoringRule.rule_type.in_(supported_types),
            )
        ).all()
        for rule in legacy_rules:
            if session.scalar(
                select(MonitoringRuleTemplate.id).where(
                    MonitoringRuleTemplate.legacy_rule_id == rule.id
                )
            ):
                continue
            variable = (
                session.get(Variable, rule.variable_id)
                if rule.variable_id is not None
                else None
            )
            required_types = (type_map.get(variable.data_type) if variable is not None else None)
            if rule.rule_type == "parameter_threshold" and required_types is None:
                required_types = ["number", "integer"]
            elif rule.rule_type == "boolean_count_threshold":
                required_types = ["boolean"]
            elif rule.rule_type == "duration" and required_types is None:
                required_types = ["number", "integer"]

            session.add(
                MonitoringRuleTemplate(
                    name=rule.name,
                    description=rule.description,
                    rule_type=rule.rule_type,
                    required_variable_types=required_types,
                    variable_key=variable.key if variable else None,
                    operator=rule.operator,
                    threshold=rule.threshold,
                    parameters=rule.parameters,
                    severity=rule.severity,
                    is_enabled=rule.is_enabled,
                    evaluation_interval_seconds=rule.evaluation_interval_seconds,
                    stale_after_seconds=rule.stale_after_seconds,
                    legacy_rule_id=rule.id,
                )
            )
            rule.is_enabled = False
            rule.is_archived = True
        session.commit()

#fixes old duration-rule templates 
def _migrate_boolean_duration_templates(engine: Engine) -> None:
    with Session(engine) as session:
        templates = session.scalars(
            select(MonitoringRuleTemplate).where(
                MonitoringRuleTemplate.rule_type == "duration"
            )
        ).all()
        for template in templates:
            parameters = dict(template.parameters or {})
            if (
                parameters.get("condition") != "threshold"
                or "boolean" not in (template.required_variable_types or [])
            ):
                continue
            parameters["condition"] = "equals"
            parameters["expected_value"] = True
            parameters.pop("operator", None)
            parameters.pop("threshold", None)
            template.parameters = parameters
        session.commit()

#intializes counter-tracking records for existing boolean count-threshold rules
def _migrate_existing_rule_counters(engine: Engine) -> None:
    migration_key = "internal_rule_counter_state_v1"
    insert_function = (pg_insert if engine.dialect.name == "postgresql" else sqlite_insert)
    with Session(engine) as session:
        statement = (
            insert_function(FrontendConfig)
            .values(key=migration_key, value={"complete": True})
            .on_conflict_do_nothing(index_elements=[FrontendConfig.key])
            .returning(FrontendConfig.key)
        )
        inserted = session.scalar(statement)
        if inserted is None:
            session.rollback()
            return
#Find existing rules that need counter state
        rules = session.scalars(
            select(MonitoringRule).where(
                MonitoringRule.rule_type == "boolean_count_threshold",
                MonitoringRule.target_asset_id.is_not(None),
                MonitoringRule.is_archived.is_(False),
            )
        ).all()
        for rule in rules:
            #Retrieve the machine`s current state`
            machine_state = session.get(MachineMonitoringState, rule.target_asset_id)
            #Create a counter-state record 
            session.add(
                RuleCounterState(
                    rule_id=rule.id,
                    asset_id=rule.target_asset_id,
                    cycle_count=machine_state.cycle_count if machine_state else 0,
                    cycle_signal=machine_state.cycle_signal if machine_state else None,
                    last_signal_at=(machine_state.last_cycle_signal_at
                        if machine_state
                        else None
                    ),
                    updated_at=(machine_state.updated_at
                        if machine_state
                        else rule.created_at
                    ),
                )
            )
        session.commit()