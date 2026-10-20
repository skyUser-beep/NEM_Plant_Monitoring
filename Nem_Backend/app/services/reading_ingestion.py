#Job is to validate incoming PLC or api readings,save valid readings to PostgreSQL, and trigger the monitoring rules engine
#Incoming reading -> Validate the reading -> save to postgreSQL -> Evaluate monitoring rules -> commit the transaction
from datetime import datetime, timedelta, timezone
import math

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import Asset, Reading, Variable
from app.schemas.reading import ReadingCreate
from app.services.monitoring_engine import evaluate_reading_rules

#checking the data type
def validate_value(data_type: str, value: object) -> None:
    valid = (
        (data_type == "number" and isinstance(value, (int, float)) and not isinstance(value, bool))
        or (data_type == "integer" and isinstance(value, int) and not isinstance(value, bool))
        or (data_type == "string" and isinstance(value, str))
        or (data_type == "boolean" and isinstance(value, bool))
    )
    if not valid:
        raise HTTPException(status_code=422,detail=f"Value does not match variable data type '{data_type}'",)
    if isinstance(value, float) and not math.isfinite(value):
        raise HTTPException(status_code=422, detail="Reading value must be finite")

#Checking asset and variable relationships
def validate_reading(session: Session, payload: ReadingCreate) -> Variable:
    asset = session.get(Asset, payload.asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {payload.asset_id} was not found")
    variable = session.get(Variable, payload.variable_id)
    if variable is None:
        raise HTTPException(status_code=404, detail=f"Variable {payload.variable_id} was not found")
    if variable.asset_id != payload.asset_id:
        raise HTTPException(status_code=422, detail="Variable does not belong to the specified asset")
    if not asset.is_active or not variable.is_active:
        raise HTTPException(status_code=409, detail="Cannot ingest readings for inactive assets or variables")
    if payload.recorded_at and payload.recorded_at > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise HTTPException(status_code=422,detail="Reading timestamp cannot be more than five minutes in the future",)
    validate_value(variable.data_type, payload.value)
    return variable

#Creating a db object
def make_reading(payload: ReadingCreate) -> Reading:
    return Reading(
        asset_id=payload.asset_id,
        variable_id=payload.variable_id,
        value=payload.value,
        recorded_at=payload.recorded_at or datetime.now(timezone.utc),
        source_id=payload.source_id,
        metadata_json=payload.metadata,
    )

#Main service ,central function that brings the other functions together
def ingest_reading(
    session: Session,
    payload: ReadingCreate,
    *,
    stale_after_seconds: int,
    commit: bool = True,
) -> Reading:
    validate_reading(session, payload)
    reading = make_reading(payload)
    session.add(reading)
    session.flush()
    evaluate_reading_rules(
        session,
        asset_id=reading.asset_id,
        variable_id=reading.variable_id,
        stale_after_seconds=stale_after_seconds,
    )
    if commit:
        session.commit()
        session.refresh(reading)
    return reading
