# Assests API router through which the frontend can work with assets
#API Router for group related endpoints into one router
#Depends- tell fastapi to provide dependencies, such as a database session.
# HTTP Exception - Returns HTTP errors such as 404,409,422 etc
#Query - Validates query parameters such as limits and offsets

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status 
#Build SQL queries using SQLAlchemy, func provide sql functions such as count, session represents a database session

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session
#get_db supplies the database session to an endpoint
from app.db.session import get_db
from app.models import (
    Alert,
    Asset,
    MachineMonitoringState,
    MaintenanceRecord,
    MaintenanceSchedule,
    MonitoringEvent,
    MonitoringRule,
    Reading,
    RuleCounterState,
    RuleState,
    Variable,
)
from app.schemas.asset import AssetCreate, AssetRead, AssetTree, AssetUpdate # pydantic schema for input validation and output formatting

router = APIRouter(prefix="/assets", tags=["assets"]) 

#check if an asset exists in the database, if not raise a 404 error
def asset_or_404(session: Session, asset_id: int) -> Asset:
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    return asset

#Protecting the asset heirarchy
def validate_parent(session: Session, parent_id: int | None, asset_id: int | None = None) -> None:
    if parent_id is None:
        return
    parent = session.get(Asset, parent_id)
    if parent is None:
        raise HTTPException(status_code=404, detail=f"Parent asset {parent_id} was not found")
    if asset_id is None:
        return
    if parent_id == asset_id:
        raise HTTPException(status_code=409, detail="An asset cannot be its own parent")
    ancestor = parent
    visited: set[int] = set()
    while ancestor is not None:
        if ancestor.id == asset_id:
            raise HTTPException(status_code=409, detail="Move would create a circular asset hierarchy")
        if ancestor.id in visited:
            raise HTTPException(status_code=409, detail="Existing parent hierarchy contains a cycle")
        visited.add(ancestor.id)
        ancestor = session.get(Asset, ancestor.parent_asset_id) if ancestor.parent_asset_id else None

# Building a nested hierarchy of assets, starting from a given asset and recursively adding its children. It also checks for cycles in the hierarchy to prevent infinite loops.
def to_tree(session: Session, asset: Asset, ancestors: frozenset[int] = frozenset()) -> AssetTree:
    if asset.id in ancestors:
        raise HTTPException(status_code=409, detail="Existing asset hierarchy contains a cycle")
    next_ancestors = ancestors | {asset.id}
    children = session.scalars(select(Asset).where(Asset.parent_asset_id == asset.id).order_by(Asset.id)).all()
    return AssetTree(**AssetRead.model_validate(asset).model_dump(),
        children=[to_tree(session, child, next_ancestors) for child in children],
    )

# Creating an assest, validating the parent asset if provided, and returning the created asset with a 201 status code.
@router.post("", response_model=AssetRead, status_code=status.HTTP_201_CREATED)
def create_asset(payload: AssetCreate, session: Session = Depends(get_db)) -> Asset:
    validate_parent(session, payload.parent_asset_id)
    asset = Asset(**payload.model_dump())
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset

# Listing assets
@router.get("")
def list_assets(
    parent_asset_id: int | None = Query(default=None, gt=0),
    asset_type: str | None = None,
    is_active: bool | None = None,
    root_only: bool = False,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    
    query = select(Asset)
    count_query = select(func.count()).select_from(Asset)
    if parent_asset_id is not None:
        query = query.where(Asset.parent_asset_id == parent_asset_id)
        count_query = count_query.where(Asset.parent_asset_id == parent_asset_id)
    if root_only:
        query = query.where(Asset.parent_asset_id.is_(None))
        count_query = count_query.where(Asset.parent_asset_id.is_(None))
    if asset_type is not None:
        query = query.where(Asset.asset_type == asset_type)
        count_query = count_query.where(Asset.asset_type == asset_type)
    if is_active is not None:
        query = query.where(Asset.is_active == is_active)
        count_query = count_query.where(Asset.is_active == is_active)
    rows = session.scalars(query.order_by(Asset.id).offset(offset).limit(limit)).all()
    return {
        "items": [AssetRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

#Getting one asset 
@router.get("/{asset_id}", response_model=AssetRead)
def get_asset(asset_id: int, session: Session = Depends(get_db)) -> Asset:
    return asset_or_404(session, asset_id)

#Updating the assets
@router.patch("/{asset_id}", response_model=AssetRead)
def update_asset(asset_id: int, payload: AssetUpdate, session: Session = Depends(get_db)) -> Asset:
    asset = asset_or_404(session, asset_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="Provide at least one field to update")
    for required in ("name", "asset_type", "is_active"):
        if required in changes and changes[required] is None:
            raise HTTPException(status_code=422, detail=f"Asset {required} cannot be null")
    if "parent_asset_id" in changes:
        validate_parent(session, changes["parent_asset_id"], asset.id)
    for field, value in changes.items():
        setattr(asset, field, value)
    session.commit()
    session.refresh(asset)
    return asset

# Getting the children of a specific asset
@router.get("/{asset_id}/children")
def list_children(
    asset_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    asset_or_404(session, asset_id)
    query = select(Asset).where(Asset.parent_asset_id == asset_id)
    total = session.scalar(select(func.count()).select_from(Asset).where(Asset.parent_asset_id == asset_id)) or 0
    items = session.scalars(query.order_by(Asset.id).offset(offset).limit(limit)).all()
    return {
        "items": [AssetRead.model_validate(item) for item in items],
        "total": total,
        "limit": limit,
        "offset": offset,
    }

# Getting the entire hierarchy of a specific asset, including all its descendants, and returning it as a nested tree structure. It also checks for cycles in the hierarchy to prevent infinite loops.
@router.get("/{asset_id}/hierarchy", response_model=AssetTree)
def asset_hierarchy(asset_id: int, session: Session = Depends(get_db)) -> AssetTree:
    asset = asset_or_404(session, asset_id)
    seen: set[int] = set()
    while asset.parent_asset_id is not None:
        if asset.id in seen:
            raise HTTPException(status_code=409, detail="Existing asset hierarchy contains a cycle")
        seen.add(asset.id)
        asset = asset_or_404(session, asset.parent_asset_id)
    if asset.id in seen:
        raise HTTPException(status_code=409, detail="Existing asset hierarchy contains a cycle")
    return to_tree(session, asset)

# Moving an asset to a new parent asset, validating the new parent to ensure it doesn't create a circular hierarchy, and returning the updated asset.
@router.post("/{asset_id}/move", response_model=AssetRead)
def move_asset(asset_id: int,
    parent_asset_id: int | None = None,
    session: Session = Depends(get_db),
) -> Asset:
    asset = asset_or_404(session, asset_id)
    validate_parent(session, parent_asset_id, asset.id)
    asset.parent_asset_id = parent_asset_id
    session.commit()
    session.refresh(asset)
    return asset

# Deleting an asset, ensuring it has no children, variables, readings, or rules associated with it before deletion. If any of these exist, a 409 conflict error is raised, suggesting deactivation instead of deletion.
@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(asset_id: int, session: Session = Depends(get_db)) -> Response:
    asset = asset_or_404(session, asset_id)
    references = (
        (Asset, Asset.parent_asset_id),
        (Variable, Variable.asset_id),
        (Reading, Reading.asset_id),
        (MonitoringRule, MonitoringRule.target_asset_id),
        (RuleState, RuleState.target_asset_id),
        (Alert, Alert.target_asset_id),
        (MaintenanceRecord, MaintenanceRecord.asset_id),
        (MaintenanceSchedule, MaintenanceSchedule.asset_id),
        (MachineMonitoringState, MachineMonitoringState.asset_id),
        (RuleCounterState, RuleCounterState.asset_id),
    )
    if any(session.scalar(select(column).where(column == asset.id).limit(1))
        for model, column in references
    ):
        raise HTTPException(status_code=409,
            detail=(
                "Cannot delete an asset while it has child assets, variables, "
                "monitoring data, rules, alerts, maintenance records, or history. "
                "Deactivate it instead."
            ),
        )
    session.execute(delete(MonitoringEvent).where(MonitoringEvent.asset_id == asset.id))
    session.delete(asset)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)