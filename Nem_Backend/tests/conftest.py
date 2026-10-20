from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from app.core.config import get_settings
from app.db.base import Base
from app.db.init_db import initialize_database
from app.db.session import create_database_engine
from app.main import create_app
from app import models  # noqa: F401


@pytest.fixture(scope="session")
def test_database_engine() -> Iterator[Engine]:
    settings = get_settings()
    if settings.test_database_url is None:
        pytest.fail(
            "Set TEST_DATABASE_URL to a dedicated PostgreSQL database before running API tests",
            pytrace=False,
        )
    engine = create_database_engine(settings.test_database_url)
    initialize_database(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def client(test_database_engine: Engine) -> Iterator[TestClient]:
    settings = get_settings()
    database_url = settings.test_database_url
    if database_url is None:
        pytest.fail("TEST_DATABASE_URL is required", pytrace=False)
    application = create_app(
        settings.model_copy(
            update={
                "database_url": database_url,
                "monitoring_scheduler_enabled": False,
                "maintenance_due_alerts_enabled": False,
                "opcua_machine_mappings": "",
            }
        )
    )
    with test_database_engine.connect() as connection:
        transaction = connection.begin()
        application.state.session_factory = sessionmaker(
            bind=connection,
            autoflush=False,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        try:
            with TestClient(application) as test_client:
                yield test_client
        finally:
            if transaction.is_active:
                transaction.rollback()
            application.state.engine.dispose()
