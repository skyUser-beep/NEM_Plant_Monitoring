#responsible for creating database tables and updating older db schemas when your application starts
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
import app.models  
from app.db.base import Base
#SQLAlchemy`s connection interface to your db -> engine 
#application starts,create missing table,inspect existing tables and columns , apply required sql changes
def initialize_database(engine: Engine) -> None:
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "variables" in table_names:
        variable_columns = {
            column["name"]
            for column in inspector.get_columns("variables")
        }
        if "opcua_node_id" not in variable_columns:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE variables "
                        "ADD COLUMN opcua_node_id VARCHAR(512)"
                    )
                )

    if "nem_monitoring_rules" in table_names:
        rule_columns = {
            column["name"]
            for column in inspector.get_columns("nem_monitoring_rules")
        }
        if "is_archived" not in rule_columns:
            with engine.begin() as connection:
                if engine.dialect.name == "postgresql":
                    add_column = (
                        "ALTER TABLE nem_monitoring_rules "
                        "ADD COLUMN IF NOT EXISTS is_archived "
                        "BOOLEAN NOT NULL DEFAULT FALSE"
                    )
                else:
                    add_column = (
                        "ALTER TABLE nem_monitoring_rules "
                        "ADD COLUMN is_archived "
                        "BOOLEAN NOT NULL DEFAULT FALSE"
                    )

                connection.execute(text(add_column))

    if "nem_maintenance_schedules" in table_names:
        schedule_columns = {
            column["name"]
            for column in inspect(engine).get_columns("nem_maintenance_schedules")
        }
        if "current_period_start_date" not in schedule_columns:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE nem_maintenance_schedules "
                        "ADD COLUMN current_period_start_date DATE"
                    )
                )
                connection.execute(
                    text(
                        "UPDATE nem_maintenance_schedules "
                        "SET current_period_start_date = schedule_start_date "
                        "WHERE current_period_start_date IS NULL"
                    )
                )
                if engine.dialect.name == "postgresql":
                    connection.execute(
                        text(
                            "ALTER TABLE nem_maintenance_schedules "
                            "ALTER COLUMN current_period_start_date SET NOT NULL"
                        )
                    )

    if "nem_maintenance_records" in table_names:
        record_columns = {
            column["name"]
            for column in inspect(engine).get_columns("nem_maintenance_records")
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
                    connection.execute(
                        text(
                            "ALTER TABLE nem_maintenance_records "
                            f"ADD COLUMN {name} {definition}"
                        )
                    )
            connection.execute(
                text(
                    "UPDATE nem_maintenance_records "
                    "SET actual_completed_at = performed_at "
                    "WHERE status = 'completed' AND actual_completed_at IS NULL"
                )
            )