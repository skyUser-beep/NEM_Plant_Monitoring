from datetime import datetime
from app.schemas.common import ORMModel
# specify exactly what summary information the backend should return to the frontend dashboard
class DashboardSummary(ORMModel):
    total_assets: int
    active_assets: int
    inactive_assets: int
    monitored_assets: int
    assets_in_alert_state: int
    assets_in_warning_state: int
    alert_counts_available: bool
    total_rules: int
    enabled_rules: int
    disabled_rules: int
    rules_normal: int
    rules_warning: int
    rules_alert: int
    rules_unknown: int
    total_active_alerts: int
    unacknowledged_active_alerts: int
    latest_reading_at: datetime | None
