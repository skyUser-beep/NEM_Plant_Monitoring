from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, inspect, text

from app.core.config import Settings
from app.db.init_db import initialize_database
from app.db.session import UTCDateTime, create_database_engine
from app.models import (
    Alert,
    MaintenanceRecord,
    MonitoringEvent,
    MonitoringRule,
    Reading,
    RuleState,
)

POSTGRES_URL = "postgresql+psycopg://localhost/nem_test"


def test_utc_datetime_bind_and_result_use_aware_utc_in_python():
    utc_type = UTCDateTime()
    local_time = datetime(
        2026,
        10,
        16,
        14,
        42,
        tzinfo=timezone(timedelta(hours=5, minutes=30)),
    )

    assert utc_type.process_bind_param(local_time, None) == datetime(
        2026, 10, 16, 9, 12
    )
    assert utc_type.process_bind_param(datetime(2026, 10, 16, 9, 12), None) == (
        datetime(2026, 10, 16, 9, 12)
    )
    assert utc_type.process_result_value(datetime(2026, 10, 16, 9, 12), None) == (
        datetime(2026, 10, 16, 9, 12, tzinfo=timezone.utc)
    )
    assert utc_type.process_result_value(local_time, None) == datetime(
        2026, 10, 16, 9, 12, tzinfo=timezone.utc
    )


def test_settings_accept_sync_psycopg_postgresql_url():
    settings = Settings(_env_file=None, database_url=POSTGRES_URL)
    assert settings.database_url == POSTGRES_URL


def test_settings_require_database_url(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(ValidationError, match="database_url"):
        Settings(_env_file=None)


@pytest.mark.parametrize(
    "database_url",
    [
        "sqlite:///./machine_monitor.db",
        "mysql+pymysql://localhost/nem_test",
        "postgresql+asyncpg://localhost/nem_test",
    ],
)
def test_settings_reject_non_sync_postgresql_database_urls(database_url):
    with pytest.raises(ValidationError, match="postgresql\\+psycopg"):
        Settings(_env_file=None, database_url=database_url)


def test_engine_factory_rejects_non_postgresql_urls():
    with pytest.raises(ValueError, match="postgresql\\+psycopg"):
        create_database_engine("sqlite:///./machine_monitor.db")


def test_test_database_must_be_distinct_from_application_database():
    with pytest.raises(ValidationError, match="must not point"):
        Settings(
            _env_file=None,
            database_url="postgresql+psycopg://localhost/plc_monitoring",
            test_database_url="postgresql+psycopg://localhost/plc_monitoring",
        )


def test_test_database_must_not_be_a_postgresql_system_database():
    with pytest.raises(ValidationError, match="dedicated, non-system"):
        Settings(
            _env_file=None,
            database_url="postgresql+psycopg://localhost/plc_monitoring",
            test_database_url="postgresql+psycopg://localhost/postgres",
        )


def test_nem_models_use_separate_tables_and_foreign_keys():
    assert Reading.__tablename__ == "nem_readings"
    assert MonitoringRule.__tablename__ == "nem_monitoring_rules"
    assert RuleState.__tablename__ == "nem_rule_states"
    assert Alert.__tablename__ == "nem_alerts"
    assert MonitoringEvent.__tablename__ == "nem_monitoring_events"
    assert MaintenanceRecord.__tablename__ == "nem_maintenance_records"

    assert next(iter(RuleState.__table__.c.rule_id.foreign_keys)).target_fullname == (
        "nem_monitoring_rules.id"
    )
    assert next(iter(Alert.__table__.c.rule_id.foreign_keys)).target_fullname == (
        "nem_monitoring_rules.id"
    )
    assert next(iter(MonitoringEvent.__table__.c.alert_id.foreign_keys)).target_fullname == (
        "nem_alerts.id"
    )
    assert next(
        iter(MaintenanceRecord.__table__.c.alert_id.foreign_keys)
    ).target_fullname == "nem_alerts.id"


def test_maintenance_schema_upgrade_preserves_legacy_records():
    engine = create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE nem_maintenance_records ("
                    "id INTEGER PRIMARY KEY, "
                    "asset_id INTEGER NOT NULL, "
                    "alert_id INTEGER, "
                    "summary VARCHAR(200) NOT NULL, "
                    "notes TEXT, "
                    "performed_by VARCHAR(200) NOT NULL, "
                    "performed_at TIMESTAMP NOT NULL, "
                    "next_due_at TIMESTAMP, "
                    "created_at TIMESTAMP NOT NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO nem_maintenance_records "
                    "(id, asset_id, summary, performed_by, performed_at, created_at) "
                    "VALUES (1, 7, 'Legacy inspection', 'Operator', "
                    "'2026-10-16 09:12:00', '2026-10-16 09:12:00')"
                )
            )

        initialize_database(engine)
        initialize_database(engine)

        with engine.connect() as connection:
            maintenance_columns = {
                column["name"]
                for column in inspect(engine).get_columns("nem_maintenance_records")
            }
            assert "schedule_id" in maintenance_columns
            assert "planned_due_date" in maintenance_columns
            assert "nem_maintenance_schedules" in inspect(engine).get_table_names()
            alert_columns = {
                column["name"]: column
                for column in inspect(engine).get_columns("nem_alerts")
            }
            assert alert_columns["rule_id"]["nullable"] is True
            assert "maintenance_schedule_id" in alert_columns
            assert "maintenance_due_date" in alert_columns
            legacy = connection.execute(
                text(
                    "SELECT summary, status, maintenance_type, priority, "
                    "performed_at, actual_completed_at "
                    "FROM nem_maintenance_records WHERE id = 1"
                )
            ).one()
            assert legacy.summary == "Legacy inspection"
            assert legacy.status == "completed"
            assert legacy.maintenance_type == "inspection"
            assert legacy.priority == "medium"
            assert legacy.performed_at == "2026-10-16 09:12:00"
            assert legacy.actual_completed_at == legacy.performed_at
    finally:
        engine.dispose()


def test_schedule_period_start_column_upgrade_backfills_and_is_idempotent():
    engine = create_engine("sqlite://")
    legacy_start = "2026-10-19"
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE nem_maintenance_schedules ("
                    "id INTEGER PRIMARY KEY, schedule_start_date DATE NOT NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO nem_maintenance_schedules "
                    "(id, schedule_start_date) VALUES (1, :start_date)"
                ),
                {"start_date": legacy_start},
            )

        initialize_database(engine)
        initialize_database(engine)

        columns = {
            column["name"]
            for column in inspect(engine).get_columns("nem_maintenance_schedules")
        }
        assert "current_period_start_date" in columns
        with engine.connect() as connection:
            stored_start = connection.scalar(
                text(
                    "SELECT current_period_start_date "
                    "FROM nem_maintenance_schedules WHERE id = 1"
                )
            )
        assert str(stored_start) == legacy_start
    finally:
        engine.dispose()
