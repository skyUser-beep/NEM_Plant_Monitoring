# Groups related API endpoints together-> APIRouter , Depends-> Lets FastAPI automatically provide dependencies 
from fastapi import APIRouter, Depends 
# func -> Provides SQL functions such as Count(),MAX(),DISTINCT(), select-> Builds SQL SELECT queries using Python
from sqlalchemy import and_, func, or_, select
#Represents a connection/session for interacting with the database
from sqlalchemy.orm import Session
 #get_db-> Supplies the database session to an endpoint
from app.db.session import get_db
# SQLAlchemy models representing database tables
from app.models import Alert, Asset, MonitoringRule, Reading, RuleState, Variable
# Defines the structure of the response returned by the endpoint
from app.schemas.dashboard import DashboardSummary

#Creating an API endpoint
router = APIRouter(prefix="/dashboard", tags=["dashboard"])

@router.get("/summary", response_model=DashboardSummary)
def dashboard_summary(session: Session = Depends(get_db)) -> DashboardSummary:
    # total assets
    total = session.scalar(select(func.count()).select_from(Asset)) or 0
    #active assest
    active = session.scalar(
        select(func.count()).select_from(Asset).where(Asset.is_active.is_(True))
    ) or 0
    #Counting Monitoring Rules
    rule_total = session.scalar(
        select(func.count())
        .select_from(MonitoringRule)
        .where(MonitoringRule.is_archived.is_(False))
    ) or 0
    enabled = session.scalar(
        select(func.count())
        .select_from(MonitoringRule)
        .where(
            MonitoringRule.is_enabled.is_(True),
            MonitoringRule.is_archived.is_(False),
        )
    ) or 0
    disabled = rule_total - enabled
    # Counting monitored assests 
    monitored = session.scalar(
        select(func.count(func.distinct(Variable.asset_id)))
        .join(Asset, Asset.id == Variable.asset_id)
        .where(Variable.is_active.is_(True), Asset.is_active.is_(True))
    ) or 0
    # Getting the latest reading timestamp
    latest = session.scalar(select(func.max(Reading.recorded_at)))
    #Counting rules by their current status (normal, warning, alert, unknown) for enabled rules. If there are any enabled rules that do not have a corresponding RuleState entry, they are counted as "unknown".
    state_counts = {
        status: session.scalar(
            select(func.count())
            .select_from(RuleState)
            .join(MonitoringRule, MonitoringRule.id == RuleState.rule_id)
            .where(
                MonitoringRule.is_enabled.is_(True),
                MonitoringRule.is_archived.is_(False),
                RuleState.status == status,
            )
        ) or 0
        for status in ("normal", "warning", "alert", "unknown")
    }
    evaluated_statuses = sum(state_counts.values())
    state_counts["unknown"] += max(0, enabled - evaluated_statuses)
    asset_alert_count = session.scalar(
        select(func.count(func.distinct(Alert.target_asset_id)))
        .outerjoin(MonitoringRule, MonitoringRule.id == Alert.rule_id)
        .where(
            Alert.status == "active",
            Alert.severity == "alert",
            or_(
                Alert.maintenance_schedule_id.is_not(None),
                and_(
                    MonitoringRule.is_enabled.is_(True),
                    MonitoringRule.is_archived.is_(False),
                ),
            ),
        )
    ) or 0
    #Counting assets currenly in alert and warning state
    asset_warning_count = session.scalar(
        select(func.count(func.distinct(Alert.target_asset_id)))
        .outerjoin(MonitoringRule, MonitoringRule.id == Alert.rule_id)
        .where(
            Alert.status == "active",
            Alert.severity == "warning",
            or_(
                Alert.maintenance_schedule_id.is_not(None),
                and_(
                    MonitoringRule.is_enabled.is_(True),
                    MonitoringRule.is_archived.is_(False),
                ),
            ),
        )
    ) or 0
    #Counting total active alerts and unacknowledged active alerts
    active_alert_count = session.scalar(
        select(func.count())
        .select_from(Alert)
        .outerjoin(MonitoringRule, MonitoringRule.id == Alert.rule_id)
        .where(
            Alert.status == "active",
            or_(
                Alert.maintenance_schedule_id.is_not(None),
                and_(
                    MonitoringRule.is_enabled.is_(True),
                    MonitoringRule.is_archived.is_(False),
                ),
            ),
        )
    ) or 0
    unacknowledged_count = session.scalar(
        select(func.count())
        .select_from(Alert)
        .outerjoin(MonitoringRule, MonitoringRule.id == Alert.rule_id)
        .where(
            Alert.status == "active",
            Alert.acknowledged_at.is_(None),
            or_(
                Alert.maintenance_schedule_id.is_not(None),
                and_(
                    MonitoringRule.is_enabled.is_(True),
                    MonitoringRule.is_archived.is_(False),
                ),
            ),
        )
    ) or 0
    return DashboardSummary(
        total_assets=total,
        active_assets=active,
        inactive_assets=total - active,
        monitored_assets=monitored,
        assets_in_alert_state=asset_alert_count,
        assets_in_warning_state=asset_warning_count,
        alert_counts_available=True,
        total_rules=rule_total,
        enabled_rules=enabled,
        disabled_rules=disabled,
        rules_normal=state_counts["normal"],
        rules_warning=state_counts["warning"],
        rules_alert=state_counts["alert"],
        rules_unknown=state_counts["unknown"],
        total_active_alerts=active_alert_count,
        unacknowledged_active_alerts=unacknowledged_count,
        latest_reading_at=latest,
    )