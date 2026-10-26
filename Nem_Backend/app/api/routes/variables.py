#main purpose is to  create,view,filter and update machine variables in the db 
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Alert, Asset, MonitoringRule, Reading, RuleState, Variable
from app.schemas.variable import VariableCreate, VariableRead, VariableUpdate

router = APIRouter(tags=["variables"])

def variable_integrity_conflict(error: IntegrityError) -> HTTPException | None:
    constraint_name = getattr(
        getattr(error.orig, "diag", None),
        "constraint_name",
        None,
    )
    if constraint_name == "uq_variables_asset_key" or ("variables.asset_id, variables.key" in str(error.orig)):
        return HTTPException(status_code=409,detail="Variable key already exists for this asset",)
    if constraint_name == "uq_variables_opcua_node_id" or ("variables.opcua_node_id" in str(error.orig)):
        return HTTPException(status_code=409,detail=(
                "This OPC UA NodeId is already registered. "
                "NodeIds can be shared across different assets after the "
                "database schema has been updated."
            ),
        )
    return None


#Find a variable by its database ID
def variable_or_404(session: Session, variable_id: int) -> Variable:
    variable = session.get(Variable, variable_id)
    if variable is None:
        raise HTTPException(status_code=404,detail=f"Variable {variable_id} was not found",)
    return variable

# Create a variable, optionally linked to an OPC UA node.
@router.post("/assets/{asset_id}/variables",response_model=VariableRead,status_code=status.HTTP_201_CREATED,)
def create_variable(asset_id: int,payload: VariableCreate,session: Session = Depends(get_db),) -> Variable:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404,detail=f"Asset {asset_id} was not found",)
  #Build the variable
    variable = Variable(asset_id=asset_id, **payload.model_dump(),)
    session.add(variable)
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        conflict = variable_integrity_conflict(error)
        if conflict is None:
            raise
        raise conflict from error
    session.refresh(variable)
    return variable

# list and filter variables
@router.get("/assets/{asset_id}/variables")
def list_variables(asset_id: int,is_active: bool | None = None,opcua_linked: bool | None = None,
limit: int = Query(default=50, ge=1, le=200),offset: int = Query(default=0, ge=0),session: 
Session = Depends(get_db),
) -> dict[str, object]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404,detail=f"Asset {asset_id} was not found",)

    query = select(Variable).where(Variable.asset_id == asset_id)
    count_query = (select(func.count()).select_from(Variable)
        .where(Variable.asset_id == asset_id))
    if is_active is not None:
        query = query.where(Variable.is_active == is_active)
        count_query = count_query.where(Variable.is_active == is_active)
    if opcua_linked is True:
        query = query.where(Variable.opcua_node_id.is_not(None))
        count_query = count_query.where(Variable.opcua_node_id.is_not(None))
    elif opcua_linked is False:
        query = query.where(Variable.opcua_node_id.is_(None))
        count_query = count_query.where(Variable.opcua_node_id.is_(None))

    rows = session.scalars(query.order_by(Variable.id).offset(offset).limit(limit)).all()
    return {
        "items": [VariableRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

#View One variables
@router.get("/variables/{variable_id}", response_model=VariableRead)
def get_variable(variable_id: int,session: Session = Depends(get_db),) -> Variable:
    return variable_or_404(session, variable_id)

#Update a variables
@router.patch("/variables/{variable_id}", response_model=VariableRead)
def update_variable(variable_id: int,payload: VariableUpdate,session: Session = Depends(get_db),) -> Variable:
    #Find the variable
    variable = variable_or_404(session, variable_id)
    #Extract only fields supplied by the frontend
    changes = payload.model_dump(exclude_unset=True)

    if not changes:
        raise HTTPException(status_code=422,detail="Provide at least one field to update",)

    for required in ("name", "key", "data_type", "is_active"):
        if required in changes and changes[required] is None:
            raise HTTPException(status_code=422,detail=f"Variable {required} cannot be null", )

    resulting_data_type = changes.get("data_type", variable.data_type)
    resulting_signal_role = changes.get("signal_role", variable.signal_role)
    if resulting_data_type != "boolean" and resulting_signal_role is not None:
        raise HTTPException(status_code=422,detail="A signal purpose can only be set for Boolean variables",)
    if "signal_role" in changes or resulting_data_type != variable.data_type:
        active_signal_rule_types = set(
            session.scalars(
                select(MonitoringRule.rule_type).where(
                    MonitoringRule.variable_id == variable.id,
                    MonitoringRule.is_enabled.is_(True),
                    MonitoringRule.is_archived.is_(False),
                    MonitoringRule.rule_type.in_(
                        {"runtime_duration", "boolean_count_threshold"}
                    ),
                )
            ).all()
        )
        required_roles = {
            "running" if rule_type == "runtime_duration" else "cycle"
            for rule_type in active_signal_rule_types
        }
        if required_roles and (
            len(required_roles) > 1
            or resulting_signal_role not in required_roles
            or resulting_data_type != "boolean"
        ):
            raise HTTPException(status_code=409,detail=(
                    "Deactivate or remap the active rules using this variable "
                    "before changing its Boolean purpose."
                ),
            )

    for field, value in changes.items():
        setattr(variable, field, value)

    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        conflict = variable_integrity_conflict(error)
        if conflict is None:
            raise
        raise conflict from error

    session.refresh(variable)
    return variable

@router.delete("/variables/{variable_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_variable(
    variable_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> Response:
    variable = variable_or_404(session, variable_id)
    references = (
        (Reading, Reading.variable_id),
        (MonitoringRule, MonitoringRule.variable_id),
        (RuleState, RuleState.target_variable_id),
        (Alert, Alert.target_variable_id),
    )
    if any(
        session.scalar(
            select(column).where(column == variable.id).limit(1)
        )
        for model, column in references
    ):
        raise HTTPException( status_code=409,
            detail=(
                "Cannot delete a variable referenced by readings, monitoring "
                "rules, rule states, or alerts. Deactivate it instead."
            ),
        )

    collector = getattr(request.app.state, "opcua_collector", None)
    if collector is not None and any(
        signal.variable_id == variable.id
        for mapping in collector.mappings
        for signal in (
            mapping.cycle_signal,
            mapping.running_signal,
            *mapping.readings,
        )
        if signal is not None
    ):
        raise HTTPException(status_code=409,
            detail=(
                "Cannot delete a variable used by OPC UA_MACHINE_MAPPINGS. "
                "Remove its mapping and restart the backend first."
            ),
        )

    session.delete(variable)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)