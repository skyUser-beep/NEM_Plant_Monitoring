# connecting your FASTAPI backend to PostgreSQL, managing db sessions, and handling timestamps consistently in UTC
from datetime import datetime, timezone
from typing import Generator # describes a function that yields values.

from fastapi import Request
from sqlalchemy import DateTime, Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from app.core.config import get_settings, validate_postgresql_database_url

#this class customizes how SQLAlchemy converts timestamps between Python and the database.
class UTCDateTime(TypeDecorator[datetime]):
    """Expose aware UTC datetimes while storing UTC-naive timestamps."""

    impl = DateTime
    cache_ok = True
# sends datetime value to the db
    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        else:
            value = value.astimezone(timezone.utc)
        return value.replace(tzinfo=None)
# reads a datetime from the database and converts it into a py value
    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

# engine that your backend uses to communicate with PostgreSQL 
def create_database_engine(database_url: str | None = None) -> Engine:
    url = get_settings().database_url if database_url is None else database_url
    validate_postgresql_database_url(url)
    return create_engine(url, pool_pre_ping=True)

# manage db connectivity. A session is the object through which your application queries and modifies db records
def create_session_factory(
    engine: Engine,
    *,
    info: dict[str, object] | None = None,
) -> sessionmaker[Session]:
    return sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
        info=info,
    )

# this function provides a db session to FastAPI endpoints
def get_db(request: Request) -> Generator[Session, None, None]:
    with request.app.state.session_factory() as session:
        user_id = getattr(request.state, "auth_user_id", None)
        if user_id is not None:
            session.info["auth_user_id"] = user_id
        yield session
