import os
from datetime import datetime, timedelta, timezone
from app.db.init_db import initialize_database
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.config import get_settings
from app.db.session import create_database_engine, create_session_factory
from app.models import Asset, Reading, Variable

DEMO_ASSETS = (
    ("asset-01", "Demo Asset 01", "equipment", None),
    ("asset-02", "Demo Asset 02", "equipment", "asset-01"),
    ("asset-03", "Demo Asset 03", "equipment", "asset-01"),
    ("asset-04", "Demo Asset 04", "equipment", None),
    ("asset-05", "Demo Asset 05", "equipment", "asset-04"),
)
DEMO_VARIABLES = (
    ("temperature", "Temperature", "number", "°C"),
    ("operating_status", "Operating Status", "string", None),
)
DEMO_READINGS = (
    ("asset-01", "temperature", 42.5, timedelta(minutes=5)),
    ("asset-01", "operating_status", "running", timedelta(minutes=4)),
    ("asset-02", "temperature", 38.0, timedelta(minutes=10)),
    ("asset-02", "operating_status", "stopped", timedelta(minutes=9)),
    ("asset-03", "temperature", 40.25, timedelta(minutes=15)),
    ("asset-04", "temperature", 44.0, timedelta(minutes=20)),
    ("asset-04", "operating_status", "running", timedelta(minutes=19)),
    ("asset-05", "temperature", 36.5, timedelta(minutes=25)),
    ("asset-05", "operating_status", "stopped", timedelta(minutes=24)),
)

def seed_demo_data(session: Session) -> None:
    configured_root_name = os.getenv("DEMO_ROOT_NAME", "Demo Root Asset").strip()
    if not configured_root_name:
        raise ValueError("DEMO_ROOT_NAME cannot be empty")
    root = session.scalar(
        select(Asset).where(
            Asset.is_demo.is_(True),
            Asset.parent_asset_id.is_(None),
            Asset.name == configured_root_name,
        )
    )
    if root is None:
        root = Asset(
            name=configured_root_name,
            asset_type="demo_root",
            description="Generated development demo asset.",
            is_demo=True,
        )
        session.add(root)
        session.flush()
    assets: dict[str, Asset] = {"demo-root": root}

    for key, name, asset_type, parent_key in DEMO_ASSETS:
        parent = assets.get(parent_key) if parent_key else root
        if parent is None:
            raise RuntimeError(f"Demo parent '{parent_key}' must be seeded before '{key}'")
        asset = session.scalar(
            select(Asset).where(
                Asset.is_demo.is_(True),
                Asset.name == name,
                Asset.parent_asset_id == parent.id,
            )
        )
        if asset is None:
            asset = Asset(
                name=name,
                asset_type=asset_type,
                description="Generated sample asset; not connected to industrial equipment.",
                parent_asset_id=parent.id,
                is_demo=True,
            )
            session.add(asset)
            session.flush()
        assets[key] = asset

    variables: dict[tuple[str, str], Variable] = {}
    for asset_key, *_ in DEMO_READINGS:
        for key, name, data_type, unit in DEMO_VARIABLES:
            asset = assets[asset_key]
            variable = session.scalar(
                select(Variable).where(
                    Variable.asset_id == asset.id,
                    Variable.key == key,
                )
            )
            if variable is None:
                variable = Variable(
                    asset_id=asset.id,
                    name=name,
                    key=key,
                    data_type=data_type,
                    unit=unit,
                    description="Simulated development sample.",
                    is_active=True,
                )
                session.add(variable)
                session.flush()
            variables[(asset_key, key)] = variable
    now = datetime.now(timezone.utc)
    for asset_key, variable_key, value, age in DEMO_READINGS:
        recorded_at = now - age
        source_id = f"demo:{asset_key}:{variable_key}"
        exists = session.scalar(
            select(Reading.id).where(
                Reading.source_id == source_id,
            )
        )
        if exists is None:
            session.add(
                Reading(
                    asset_id=assets[asset_key].id,
                    variable_id=variables[(asset_key, variable_key)].id,
                    value=value,
                    recorded_at=recorded_at,
                    source_id=source_id,
                    metadata_json={"origin": "demo_seed"},
                )
            )
    session.commit()

def main() -> None:
    engine = create_database_engine(get_settings().database_url)    
    initialize_database(engine)
    with create_session_factory(engine)() as session:
        seed_demo_data(session)
    engine.dispose()
    print("Demo assets, variables, and readings are ready.")

if __name__ == "__main__":
    main()