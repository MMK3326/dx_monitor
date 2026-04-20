from __future__ import annotations

import csv
import json
import sqlite3
import threading
import time
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory
from pymcprotocol import Type3E


BASE_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_DIR = BASE_DIR / "config"
CONFIG_PATH = CONFIG_DIR / "lines.json"
ALARM_EXCLUSIONS_PATH = CONFIG_DIR / "alarm_exclusions.json"
DASHBOARD_DIR = BASE_DIR / "dashboard"
DATA_DIR = BASE_DIR / "data"
HISTORY_DIR = BASE_DIR / "history"
DB_PATH = DATA_DIR / "monitor.db"


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8-sig") as f:
        config = json.load(f)
    alarm_exclusions: dict[str, Any] = {}
    if ALARM_EXCLUSIONS_PATH.exists():
        with ALARM_EXCLUSIONS_PATH.open("r", encoding="utf-8-sig") as f:
            alarm_exclusions = json.load(f)
    for line in config.get("lines", []):
        alarm_sources_file = line.get("alarm_sources_file")
        if not alarm_sources_file:
            continue
        alarm_path = CONFIG_DIR / alarm_sources_file
        with alarm_path.open("r", encoding="utf-8-sig") as f:
            alarm_sources = json.load(f)
        line_exclusions = alarm_exclusions.get(str(line.get("id")), {})
        excluded_devices = set(line_exclusions.get("devices", []))
        excluded_labels = set(line_exclusions.get("labels", []))
        line["alarm_sources"] = [
            alarm
            for alarm in alarm_sources
            if alarm.get("device") not in excluded_devices and alarm.get("label") not in excluded_labels
        ]
        line["alarm_exclusions"] = {
            "devices": sorted(excluded_devices),
            "labels": sorted(excluded_labels),
        }
    return config


CONFIG = load_config()
POLL_INTERVAL_SEC = float(CONFIG.get("poll_interval_sec", 2))
SERVER_PORT = int(CONFIG.get("server_port", 5050))
config_lock = threading.Lock()


def parse_day_start_minute(value: Any, fallback_hour: int = 8) -> int:
    if isinstance(value, str) and ":" in value:
        hour_text, minute_text = value.split(":", 1)
        return ((int(hour_text) % 24) * 60) + max(0, min(59, int(minute_text)))
    if value is not None:
        return max(0, min(1439, int(value)))
    return (int(fallback_hour) % 24) * 60


LEGACY_DAY_START_MINUTE = parse_day_start_minute(
    CONFIG.get("legacy_day_start_time"),
    int(CONFIG.get("day_start_hour", 8)),
)
DAY_START_MINUTE = parse_day_start_minute(
    CONFIG.get("day_start_time") or CONFIG.get("day_start_minute"),
    int(CONFIG.get("day_start_hour", 8)),
)
DAY_START_EFFECTIVE_DAY = str(CONFIG.get("day_start_effective_day") or "")
DAY_START_HOUR = DAY_START_MINUTE // 60
MEAL_BREAKS = [
    {"label": "식사", "start": "12:00", "end": "13:00"},
    {"label": "식사", "start": "17:00", "end": "17:30"},
    {"label": "식사", "start": "00:00", "end": "01:00"},
]


def minute_time_label(minute: int) -> str:
    normalized = max(0, min(1439, int(minute)))
    return f"{normalized // 60:02d}:{normalized % 60:02d}"


def day_start_minute_for_day(day_key: str | None = None) -> int:
    if day_key and DAY_START_EFFECTIVE_DAY and day_key < DAY_START_EFFECTIVE_DAY:
        return LEGACY_DAY_START_MINUTE
    return DAY_START_MINUTE


def slot_hour_for_index(index: int, day_key: str | None = None) -> int:
    minute = (day_start_minute_for_day(day_key) + (int(index) * 60)) % 1440
    return minute // 60


def ordered_slot_hours(day_key: str | None = None) -> list[int]:
    return [slot_hour_for_index(index, day_key) for index in range(24)]


def clock_time_to_production_second(time_text: str, day_key: str | None = None) -> int:
    hour_text, minute_text = str(time_text or "00:00").split(":", 1)
    clock_minute = ((int(hour_text) % 24) * 60) + max(0, min(59, int(minute_text)))
    offset_minute = (clock_minute - day_start_minute_for_day(day_key) + 1440) % 1440
    return offset_minute * 60


def meal_break_blocks(day_key: str | None = None) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for item in MEAL_BREAKS:
        start_sec = clock_time_to_production_second(str(item["start"]), day_key)
        end_sec = clock_time_to_production_second(str(item["end"]), day_key)
        duration = end_sec - start_sec if end_sec > start_sec else (86400 - start_sec) + end_sec
        blocks.append({**item, "startSec": start_sec, "duration": duration})
    return blocks


def split_timeline_block_by_meal(block: dict[str, Any], day_key: str | None = None) -> list[dict[str, Any]]:
    start = max(0, min(86400, safe_int(block.get("startSec"))))
    end = max(start, min(86400, start + safe_int(block.get("duration"))))
    segments = [{**block, "startSec": start, "duration": end - start}]
    for meal in meal_break_blocks(day_key):
        meal_start = safe_int(meal.get("startSec"))
        meal_end = min(86400, meal_start + safe_int(meal.get("duration")))
        next_segments: list[dict[str, Any]] = []
        for segment in segments:
            seg_start = safe_int(segment.get("startSec"))
            seg_end = seg_start + safe_int(segment.get("duration"))
            overlap_start = max(seg_start, meal_start)
            overlap_end = min(seg_end, meal_end)
            if overlap_start >= overlap_end:
                next_segments.append(segment)
                continue
            if seg_start < overlap_start:
                next_segments.append({**segment, "startSec": seg_start, "duration": overlap_start - seg_start})
            next_segments.append({"status": "MEAL", "startSec": overlap_start, "duration": overlap_end - overlap_start})
            if overlap_end < seg_end:
                next_segments.append({**segment, "startSec": overlap_end, "duration": seg_end - overlap_end})
        segments = next_segments
    return [segment for segment in segments if safe_int(segment.get("duration")) > 0]


def timeline_blocks_with_meal(blocks: list[dict[str, Any]], day_key: str | None = None) -> list[dict[str, Any]]:
    return [segment for block in blocks for segment in split_timeline_block_by_meal(block, day_key)]


def production_slot_hour(ts: datetime, day_key: str | None = None) -> int:
    start_minute = day_start_minute_for_day(day_key)
    clock_minute = (ts.hour * 60) + ts.minute
    slot_index = ((clock_minute - start_minute) % 1440) // 60
    return slot_hour_for_index(slot_index, day_key)


def save_line_daily_target(line_id: int, target: int) -> dict[str, Any] | None:
    with config_lock:
        with CONFIG_PATH.open("r", encoding="utf-8-sig") as f:
            raw_config = json.load(f)
        raw_line = next((line for line in raw_config.get("lines", []) if safe_int(line.get("id")) == line_id), None)
        if raw_line is None:
            return None
        raw_line.setdefault("targets", {})["daily"] = target
        with CONFIG_PATH.open("w", encoding="utf-8") as f:
            json.dump(raw_config, f, ensure_ascii=False, indent=2)
            f.write("\n")

        loaded_line = next((line for line in CONFIG.get("lines", []) if safe_int(line.get("id")) == line_id), None)
        if loaded_line is not None:
            loaded_line.setdefault("targets", {})["daily"] = target
        monitor = next((item for item in monitors if item.config["id"] == line_id), None)
        if monitor is not None:
            monitor.config.setdefault("targets", {})["daily"] = target
        return {"line_id": line_id, "daily": target}


def production_day_key(now: datetime) -> str:
    base = now.date()
    clock_minute = (now.hour * 60) + now.minute
    if clock_minute < DAY_START_MINUTE:
        base = base - timedelta(days=1)
    return base.isoformat()


def previous_day_key(day_key: str) -> str:
    return (datetime.strptime(day_key, "%Y-%m-%d").date() - timedelta(days=1)).isoformat()


def day_key_range(start_day: str, end_day: str) -> list[str]:
    start_date = datetime.strptime(start_day, "%Y-%m-%d").date()
    end_date = datetime.strptime(end_day, "%Y-%m-%d").date()
    days: list[str] = []
    current = start_date
    while current <= end_date:
        days.append(current.isoformat())
        current += timedelta(days=1)
    return days


def week_start_day_key(day_key: str) -> str:
    current = datetime.strptime(day_key, "%Y-%m-%d").date()
    return (current - timedelta(days=current.weekday())).isoformat()


def month_start_day_key(day_key: str) -> str:
    current = datetime.strptime(day_key, "%Y-%m-%d").date()
    return current.replace(day=1).isoformat()


def month_range_for_key(month_key: str, current_day_key: str) -> tuple[str, str]:
    month_start = datetime.strptime(f"{month_key}-01", "%Y-%m-%d").date()
    if month_start.month == 12:
        next_month = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month = month_start.replace(month=month_start.month + 1)
    month_end = next_month - timedelta(days=1)
    return month_start.isoformat(), month_end.isoformat()


def safe_file_name(value: str, fallback: str = "export") -> str:
    return re.sub(r'[^0-9A-Za-z._-]+', "_", value).strip("._") or fallback


def recent_day_keys(day_key: str, count: int) -> list[str]:
    current = datetime.strptime(day_key, "%Y-%m-%d").date()
    return [(current - timedelta(days=index)).isoformat() for index in range(1, count + 1)]


def minute_floor(ts: datetime) -> str:
    return ts.replace(second=0, microsecond=0).isoformat(timespec="minutes")


def production_day_start(day_key: str) -> datetime:
    start_minute = day_start_minute_for_day(day_key)
    return datetime.combine(datetime.fromisoformat(day_key).date(), datetime.min.time()) + timedelta(minutes=start_minute)


def timeline_block_for_minute(day_key: str, ts: datetime, status_label: str) -> dict[str, Any]:
    day_start = production_day_start(day_key)
    if ts < day_start:
        day_start -= timedelta(days=1)
    minute_ts = ts.replace(second=0, microsecond=0)
    start_sec = max(0, int((minute_ts - day_start).total_seconds()))
    return {"status": status_label, "startSec": start_sec, "duration": 60}


ALARM_GROUP_WINDOW_SEC = 20


class Storage:
    def __init__(self, db_path: Path, history_dir: Path):
        self.db_path = db_path
        self.history_dir = history_dir
        self.lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    def _init_db(self) -> None:
        with self._connect() as con:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS hourly_metrics (
                    line_id INTEGER NOT NULL,
                    day_key TEXT NOT NULL,
                    hour INTEGER NOT NULL,
                    total_count INTEGER NOT NULL DEFAULT 0,
                    run_seconds INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (line_id, day_key, hour)
                )
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS uph_snapshots (
                    line_id INTEGER NOT NULL,
                    ts_minute TEXT NOT NULL,
                    day_key TEXT NOT NULL,
                    total_count INTEGER NOT NULL,
                    ok_count INTEGER,
                    ng_count INTEGER,
                    uph REAL NOT NULL,
                    PRIMARY KEY (line_id, ts_minute)
                )
                """
            )
            columns = {row["name"] for row in con.execute("PRAGMA table_info(uph_snapshots)").fetchall()}
            if "ok_count" not in columns:
                con.execute("ALTER TABLE uph_snapshots ADD COLUMN ok_count INTEGER")
            if "ng_count" not in columns:
                con.execute("ALTER TABLE uph_snapshots ADD COLUMN ng_count INTEGER")
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS status_snapshots (
                    line_id INTEGER NOT NULL,
                    ts_minute TEXT NOT NULL,
                    day_key TEXT NOT NULL,
                    status_label TEXT NOT NULL,
                    PRIMARY KEY (line_id, ts_minute)
                )
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS recovery_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    line_id INTEGER NOT NULL,
                    day_key TEXT NOT NULL,
                    ts TEXT NOT NULL,
                    recovered_count INTEGER NOT NULL
                )
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS alarm_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    line_id INTEGER NOT NULL,
                    device TEXT NOT NULL,
                    label TEXT NOT NULL,
                    day_key TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    occurrence_count INTEGER NOT NULL DEFAULT 1
                )
                """
            )
            con.commit()

    def add_hourly_increment(
        self,
        line_id: int,
        day_key: str,
        hour: int,
        total_delta: int,
        run_seconds_delta: int,
        updated_at: str,
    ) -> None:
        with self.lock, self._connect() as con:
            con.execute(
                """
                INSERT INTO hourly_metrics (line_id, day_key, hour, total_count, run_seconds, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(line_id, day_key, hour) DO UPDATE SET
                    total_count = total_count + excluded.total_count,
                    run_seconds = run_seconds + excluded.run_seconds,
                    updated_at = excluded.updated_at
                """,
                (line_id, day_key, hour, total_delta, run_seconds_delta, updated_at),
            )
            con.commit()

    def write_uph_snapshot(
        self,
        line_id: int,
        ts_minute: str,
        day_key: str,
        total_count: int,
        ok_count: int,
        ng_count: int,
        uph: float,
    ) -> None:
        with self.lock, self._connect() as con:
            con.execute(
                """
                INSERT INTO uph_snapshots (line_id, ts_minute, day_key, total_count, ok_count, ng_count, uph)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(line_id, ts_minute) DO UPDATE SET
                    total_count = excluded.total_count,
                    ok_count = excluded.ok_count,
                    ng_count = excluded.ng_count,
                    uph = excluded.uph
                """,
                (line_id, ts_minute, day_key, total_count, ok_count, ng_count, uph),
            )
            con.commit()

    def get_hourly_arrays(self, line_id: int, day_key: str) -> tuple[list[int], list[int]]:
        counts = [0] * 24
        run_minutes = [0] * 24
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT hour, total_count, run_seconds
                FROM hourly_metrics
                WHERE line_id = ? AND day_key = ?
                ORDER BY hour ASC
                """,
                (line_id, day_key),
            ).fetchall()
        for row in rows:
            hour = int(row["hour"])
            counts[hour] = int(row["total_count"])
            run_minutes[hour] = int(round(int(row["run_seconds"]) / 60))
        return counts, run_minutes

    def get_hourly_quality_arrays(self, line_id: int, day_key: str) -> tuple[list[int], list[int]]:
        ok_counts = [0] * 24
        ng_counts = [0] * 24
        latest_by_hour: dict[int, tuple[int | None, int | None]] = {}
        day_start = production_day_start(day_key)
        day_end = day_start + timedelta(days=1)
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT ts_minute, ok_count, ng_count
                FROM uph_snapshots
                WHERE line_id = ? AND day_key = ?
                ORDER BY ts_minute ASC
                """,
                (line_id, day_key),
            ).fetchall()
        for row in rows:
            try:
                ts = datetime.fromisoformat(row["ts_minute"])
            except ValueError:
                continue
            if ts < day_start or ts >= day_end:
                continue
            hour = production_slot_hour(ts, day_key)
            latest_by_hour[hour] = (
                None if row["ok_count"] is None else safe_int(row["ok_count"]),
                None if row["ng_count"] is None else safe_int(row["ng_count"]),
            )

        prev_ok = 0
        prev_ng = 0
        ordered_hours = ordered_slot_hours(day_key)
        for hour in ordered_hours:
            latest = latest_by_hour.get(hour)
            if latest is None:
                continue
            ok_total = prev_ok if latest[0] is None else latest[0]
            ng_total = prev_ng if latest[1] is None else latest[1]
            ok_counts[hour] = max(0, safe_int(ok_total) - prev_ok)
            ng_counts[hour] = max(0, safe_int(ng_total) - prev_ng)
            prev_ok = safe_int(ok_total)
            prev_ng = safe_int(ng_total)
        return ok_counts, ng_counts

    def get_uph_rows(self, line_id: int, day_key: str) -> list[dict[str, Any]]:
        hourly_counts, _ = self.get_hourly_arrays(line_id, day_key)
        day_start = production_day_start(day_key)
        day_end = day_start + timedelta(days=1)
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT ts_minute, total_count AS raw_total_count, uph
                FROM uph_snapshots
                WHERE line_id = ? AND day_key = ?
                ORDER BY ts_minute ASC
                """,
                (line_id, day_key),
            ).fetchall()

        latest_by_hour: dict[int, sqlite3.Row] = {}
        for row in rows:
            try:
                ts = datetime.fromisoformat(row["ts_minute"])
            except ValueError:
                continue
            if ts < day_start or ts >= day_end:
                continue
            hour = production_slot_hour(ts, day_key)
            latest_by_hour[hour] = row

        result: list[dict[str, Any]] = []
        for index, hour in enumerate(ordered_slot_hours(day_key)):
            row = latest_by_hour.get(hour)
            hourly_count = hourly_counts[hour] if 0 <= hour < len(hourly_counts) else 0
            if row is None and hourly_count == 0:
                continue
            slot_start = day_start + timedelta(hours=index)
            result.append({
                "ts_minute": slot_start.isoformat(timespec="minutes"),
                "total_count": hourly_count,
                "raw_total_count": None if row is None else int(row["raw_total_count"]),
                "uph": 0.0 if row is None else round(float(row["uph"]), 2),
            })
        return result

    def write_status_snapshot(self, line_id: int, ts_minute: str, day_key: str, status_label: str) -> None:
        with self.lock, self._connect() as con:
            con.execute(
                """
                INSERT INTO status_snapshots (line_id, ts_minute, day_key, status_label)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(line_id, ts_minute) DO UPDATE SET
                    status_label = excluded.status_label,
                    day_key = excluded.day_key
                """,
                (line_id, ts_minute, day_key, status_label),
            )
            con.commit()

    def add_recovery_event(self, line_id: int, day_key: str, ts: str, recovered_count: int) -> None:
        if recovered_count <= 0:
            return
        with self.lock, self._connect() as con:
            con.execute(
                """
                INSERT INTO recovery_events (line_id, day_key, ts, recovered_count)
                VALUES (?, ?, ?, ?)
                """,
                (line_id, day_key, ts, recovered_count),
            )
            con.commit()

    def get_recovery_total(self, line_id: int, day_key: str) -> int:
        with self._connect() as con:
            row = con.execute(
                """
                SELECT COALESCE(SUM(recovered_count), 0) AS total
                FROM recovery_events
                WHERE line_id = ? AND day_key = ?
                """,
                (line_id, day_key),
            ).fetchone()
        return safe_int(row["total"]) if row is not None else 0

    def get_latest_snapshot_total(self, line_id: int, day_key: str) -> int | None:
        with self._connect() as con:
            row = con.execute(
                """
                SELECT total_count
                FROM uph_snapshots
                WHERE line_id = ? AND day_key = ?
                ORDER BY ts_minute DESC
                LIMIT 1
                """,
                (line_id, day_key),
            ).fetchone()
        return None if row is None else safe_int(row["total_count"])

    def get_snapshot_total_before(self, line_id: int, day_key: str, ts_minute: str) -> int | None:
        with self._connect() as con:
            row = con.execute(
                """
                SELECT total_count
                FROM uph_snapshots
                WHERE line_id = ? AND day_key = ? AND ts_minute <= ?
                ORDER BY ts_minute DESC
                LIMIT 1
                """,
                (line_id, day_key, ts_minute),
            ).fetchone()
        return None if row is None else safe_int(row["total_count"])

    def get_snapshot_counts_before(self, line_id: int, day_key: str, ts_minute: str) -> dict[str, int | None]:
        with self._connect() as con:
            row = con.execute(
                """
                SELECT total_count, ok_count, ng_count
                FROM uph_snapshots
                WHERE line_id = ? AND day_key = ? AND ts_minute <= ?
                ORDER BY ts_minute DESC
                LIMIT 1
                """,
                (line_id, day_key, ts_minute),
            ).fetchone()
        if row is None:
            return {"total_count": None, "ok_count": None, "ng_count": None}
        return {
            "total_count": safe_int(row["total_count"]),
            "ok_count": None if row["ok_count"] is None else safe_int(row["ok_count"]),
            "ng_count": None if row["ng_count"] is None else safe_int(row["ng_count"]),
        }

    def get_status_minutes_before(self, line_id: int, day_key: str, ts_minute: str) -> dict[str, int]:
        counts = {"run_minutes": 0, "stop_minutes": 0, "alarm_minutes": 0, "observed_minutes": 0}
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT status_label, COUNT(*) AS minute_count
                FROM status_snapshots
                WHERE line_id = ? AND day_key = ? AND ts_minute <= ?
                GROUP BY status_label
                """,
                (line_id, day_key, ts_minute),
            ).fetchall()
        for row in rows:
            status = str(row["status_label"] or "")
            minute_count = safe_int(row["minute_count"])
            counts["observed_minutes"] += minute_count
            if status == "RUN":
                counts["run_minutes"] += minute_count
            elif status == "ALARM":
                counts["alarm_minutes"] += minute_count
            elif status in {"STOP", "ONLINE", "OFFLINE"}:
                counts["stop_minutes"] += minute_count
        return counts

    def record_alarm_transitions(
        self,
        line_id: int,
        day_key: str,
        now_iso: str,
        previous_devices: set[str],
        current_alarms: list[dict[str, str]],
    ) -> None:
        current_map = {alarm["device"]: alarm["label"] for alarm in current_alarms}
        activated = set(current_map) - previous_devices
        cleared = previous_devices - set(current_map)
        if not activated and not cleared:
            return

        with self.lock, self._connect() as con:
            for device in activated:
                existing_open = con.execute(
                    """
                    SELECT 1
                    FROM alarm_events
                    WHERE line_id = ? AND device = ? AND ended_at IS NULL
                    LIMIT 1
                    """,
                    (line_id, device),
                ).fetchone()
                if existing_open is None:
                    con.execute(
                        """
                        INSERT INTO alarm_events (line_id, device, label, day_key, started_at, ended_at, occurrence_count)
                        VALUES (?, ?, ?, ?, ?, NULL, 1)
                        """,
                        (line_id, device, current_map[device], day_key, now_iso),
                    )
            for device in cleared:
                con.execute(
                    """
                    UPDATE alarm_events
                    SET ended_at = ?
                    WHERE line_id = ? AND device = ? AND ended_at IS NULL
                    """,
                    (now_iso, line_id, device),
                )
            con.commit()

    @staticmethod
    def _excluded_devices_clause(excluded_devices: set[str] | None) -> tuple[str, tuple[str, ...]]:
        devices = tuple(sorted(excluded_devices or []))
        if not devices:
            return "", ()
        return f" AND device NOT IN ({','.join('?' for _ in devices)})", devices

    def get_alarm_summary(self, line_id: int, day_key: str, excluded_devices: set[str] | None = None) -> list[dict[str, Any]]:
        exclusion_sql, exclusion_params = self._excluded_devices_clause(excluded_devices)
        with self._connect() as con:
            rows = con.execute(
                f"""
                SELECT device, label, COUNT(*) AS occurrence_count
                FROM alarm_events
                WHERE line_id = ? AND day_key = ?
                {exclusion_sql}
                GROUP BY device, label
                ORDER BY occurrence_count DESC, label ASC
                LIMIT 10
                """,
                (line_id, day_key, *exclusion_params),
            ).fetchall()
        return [
            {"device": row["device"], "label": row["label"], "count": safe_int(row["occurrence_count"])}
            for row in rows
        ]

    def get_active_alarm_events(self, line_id: int, excluded_devices: set[str] | None = None) -> dict[str, dict[str, Any]]:
        exclusion_sql, exclusion_params = self._excluded_devices_clause(excluded_devices)
        with self._connect() as con:
            rows = con.execute(
                f"""
                SELECT device, MIN(started_at) AS started_at, MIN(label) AS label
                FROM alarm_events
                WHERE line_id = ? AND ended_at IS NULL
                {exclusion_sql}
                GROUP BY device
                ORDER BY MIN(started_at) ASC
                """,
                (line_id, *exclusion_params),
            ).fetchall()
        return {
            row["device"]: {"device": row["device"], "label": row["label"], "started_at": row["started_at"]}
            for row in rows
        }

    def _dedupe_alarm_events(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        deduped: list[dict[str, Any]] = []
        active_by_device: dict[str, dict[str, Any]] = {}
        closed_by_signature: dict[tuple[str, str, str], dict[str, Any]] = {}
        for event in events:
            device = str(event.get("device") or "")
            started_at = str(event.get("started_at") or "")
            ended_at = str(event.get("ended_at") or "")
            if not device:
                deduped.append(event)
                continue
            if not event.get("active"):
                signature = (device, ended_at, str(event.get("label") or ""))
                existing_closed = closed_by_signature.get(signature)
                if existing_closed is None:
                    closed_by_signature[signature] = dict(event)
                else:
                    existing_started = str(existing_closed.get("started_at") or "")
                    if started_at and (not existing_started or started_at < existing_started):
                        merged = dict(existing_closed)
                        merged["started_at"] = started_at
                        merged["duration_sec"] = self._group_duration(started_at, ended_at, False)
                        closed_by_signature[signature] = merged
                continue
            existing = active_by_device.get(device)
            if existing is None:
                active_by_device[device] = dict(event)
                continue
            existing_started = str(existing.get("started_at") or "")
            if started_at and (not existing_started or started_at < existing_started):
                active_by_device[device] = dict(event)
        deduped.extend(closed_by_signature.values())
        deduped.extend(active_by_device.values())
        deduped.sort(key=lambda item: item.get("started_at") or "", reverse=True)
        return deduped

    def _alarm_event_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        started_at = row["started_at"]
        ended_at = row["ended_at"]
        duration_sec = 0
        if started_at and ended_at:
            try:
                duration_sec = max(0, int((datetime.fromisoformat(ended_at) - datetime.fromisoformat(started_at)).total_seconds()))
            except ValueError:
                duration_sec = 0
        return {
            "id": safe_int(row["id"]) if "id" in row.keys() else None,
            "device": row["device"],
            "label": row["label"],
            "started_at": started_at,
            "ended_at": ended_at,
            "active": ended_at is None,
            "duration_sec": duration_sec,
        }

    def _group_alarm_events(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        sorted_events = sorted(events, key=lambda item: item.get("started_at") or "")
        groups: list[dict[str, Any]] = []
        for event in sorted_events:
            started_at = event.get("started_at")
            if not started_at:
                continue
            try:
                start_dt = datetime.fromisoformat(started_at)
            except ValueError:
                continue
            last = groups[-1] if groups else None
            if last:
                try:
                    last_start_dt = datetime.fromisoformat(last["started_at"])
                except ValueError:
                    last_start_dt = None
                if last_start_dt is not None and abs((start_dt - last_start_dt).total_seconds()) <= ALARM_GROUP_WINDOW_SEC:
                    last["items"].append(event)
                    last["started_at"] = min(last["started_at"], started_at)
                    if last["ended_at"] and event.get("ended_at"):
                        last["ended_at"] = max(last["ended_at"], event["ended_at"])
                    else:
                        last["ended_at"] = None
                    last["active"] = bool(last["active"] or event.get("active"))
                    last["duration_sec"] = self._group_duration(last["started_at"], last["ended_at"], bool(last["active"]))
                    continue
            groups.append(
                {
                    "started_at": started_at,
                    "ended_at": event.get("ended_at"),
                    "active": bool(event.get("active")),
                    "duration_sec": self._group_duration(started_at, event.get("ended_at"), bool(event.get("active"))),
                    "items": [event],
                }
            )
        for group in groups:
            first = group["items"][0] if group["items"] else {}
            extra = max(0, len(group["items"]) - 1)
            group["label"] = f"{first.get('label', '-')} 외 {extra}건" if extra else first.get("label", "-")
            group["count"] = len(group["items"])
        return list(reversed(groups))

    def _group_duration(self, started_at: str | None, ended_at: str | None, active: bool) -> int:
        if not started_at:
            return 0
        try:
            start_dt = datetime.fromisoformat(started_at)
            end_dt = datetime.now() if active or not ended_at else datetime.fromisoformat(ended_at)
            return max(0, int((end_dt - start_dt).total_seconds()))
        except ValueError:
            return 0

    def _alarm_window_bounds(self, day_key: str) -> tuple[datetime, datetime]:
        start_dt = production_day_start(day_key)
        return start_dt, start_dt + timedelta(days=1)

    def _clip_alarm_event_to_window(
        self,
        event: dict[str, Any],
        window_start: datetime,
        window_end: datetime,
    ) -> dict[str, Any] | None:
        started_at = event.get("started_at")
        if not started_at:
            return None
        try:
            start_dt = datetime.fromisoformat(str(started_at))
        except ValueError:
            return None

        raw_ended_at = event.get("ended_at")
        raw_active = bool(event.get("active"))
        now_dt = datetime.now()
        if raw_ended_at:
            try:
                end_dt = datetime.fromisoformat(str(raw_ended_at))
            except ValueError:
                end_dt = now_dt
        else:
            end_dt = now_dt

        clipped_start = max(start_dt, window_start)
        clipped_end = min(end_dt, window_end)
        if clipped_end <= clipped_start:
            return None

        visible_active = raw_active and window_start <= now_dt < window_end
        return {
            **event,
            "started_at": clipped_start.isoformat(timespec="seconds"),
            "ended_at": None if visible_active else clipped_end.isoformat(timespec="seconds"),
            "active": visible_active,
            "duration_sec": max(0, int((clipped_end - clipped_start).total_seconds())),
        }

    def get_alarm_events(self, line_id: int, day_key: str, limit: int | None = None, excluded_devices: set[str] | None = None) -> list[dict[str, Any]]:
        exclusion_sql, exclusion_params = self._excluded_devices_clause(excluded_devices)
        day_start, day_end = self._alarm_window_bounds(day_key)
        with self._connect() as con:
            query = f"""
                SELECT id, device, label, started_at, ended_at
                FROM alarm_events
                WHERE line_id = ?
                AND started_at < ?
                AND COALESCE(ended_at, '9999-12-31T23:59:59') > ?
                {exclusion_sql}
                ORDER BY started_at DESC
                """
            params: tuple[Any, ...] = (line_id, day_end.isoformat(timespec="seconds"), day_start.isoformat(timespec="seconds"), *exclusion_params)
            if limit is not None:
                query += " LIMIT ?"
                params = (line_id, day_end.isoformat(timespec="seconds"), day_start.isoformat(timespec="seconds"), *exclusion_params, limit)
            rows = con.execute(query, params).fetchall()
        clipped_events = []
        for row in rows:
            clipped = self._clip_alarm_event_to_window(self._alarm_event_from_row(row), day_start, day_end)
            if clipped is not None:
                clipped_events.append(clipped)
        return self._dedupe_alarm_events(clipped_events)

    def get_alarm_groups(self, line_id: int, day_key: str, excluded_devices: set[str] | None = None) -> list[dict[str, Any]]:
        return self._group_alarm_events(self.get_alarm_events(line_id, day_key, excluded_devices=excluded_devices))

    def get_alarm_group_stats_before(self, line_id: int, day_key: str, cutoff_iso: str, excluded_devices: set[str] | None = None) -> dict[str, int]:
        cutoff = datetime.fromisoformat(cutoff_iso)
        events = self.get_alarm_events(line_id, day_key, excluded_devices=excluded_devices)
        clipped_events: list[dict[str, Any]] = []
        for event in events:
            started_at = event.get("started_at")
            if not started_at:
                continue
            try:
                started_dt = datetime.fromisoformat(started_at)
            except ValueError:
                continue
            if started_dt > cutoff:
                continue
            ended_at = event.get("ended_at")
            if ended_at:
                try:
                    ended_dt = datetime.fromisoformat(ended_at)
                except ValueError:
                    ended_dt = cutoff
            else:
                ended_dt = cutoff
            if ended_dt > cutoff:
                ended_dt = cutoff
            clipped_events.append(
                {
                    "device": event.get("device"),
                    "label": event.get("label"),
                    "started_at": started_at,
                    "ended_at": ended_dt.isoformat(timespec="seconds"),
                    "active": False,
                    "duration_sec": max(0, int((ended_dt - started_dt).total_seconds())),
                }
            )
        groups = self._group_alarm_events(clipped_events)
        return {
            "count": len(groups),
            "duration_sec": sum(safe_int(group.get("duration_sec")) for group in groups),
        }

    def get_daily_metrics_range(self, line_id: int, start_day: str, end_day: str) -> list[dict[str, Any]]:
        days = day_key_range(start_day, end_day)
        daily_map = {
            day: {"day_key": day, "total_count": 0, "run_minutes": 0, "ok_count": None, "ng_count": None}
            for day in days
        }
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT day_key, COALESCE(SUM(total_count), 0) AS total_count, COALESCE(SUM(run_seconds), 0) AS run_seconds
                FROM hourly_metrics
                WHERE line_id = ? AND day_key BETWEEN ? AND ?
                GROUP BY day_key
                ORDER BY day_key ASC
                """,
                (line_id, start_day, end_day),
            ).fetchall()
            snapshot_rows = con.execute(
                """
                SELECT day_key, ts_minute, total_count, ok_count, ng_count
                FROM uph_snapshots
                WHERE line_id = ? AND day_key BETWEEN ? AND ?
                ORDER BY day_key ASC, ts_minute ASC
                """,
                (line_id, start_day, end_day),
            ).fetchall()
        for row in rows:
            day_key = row["day_key"]
            if day_key not in daily_map:
                continue
            daily_map[day_key]["total_count"] = safe_int(row["total_count"])
            daily_map[day_key]["run_minutes"] = int(round(safe_int(row["run_seconds"]) / 60))
        latest_snapshot_by_day: dict[str, sqlite3.Row] = {}
        for row in snapshot_rows:
            day_key = row["day_key"]
            if day_key not in daily_map:
                continue
            try:
                ts = datetime.fromisoformat(row["ts_minute"])
            except (KeyError, ValueError):
                continue
            day_start = production_day_start(day_key)
            if ts < day_start or ts >= day_start + timedelta(days=1):
                continue
            latest_snapshot_by_day[day_key] = row
        for row in latest_snapshot_by_day.values():
            day_key = row["day_key"]
            if day_key not in daily_map:
                continue
            ok_count = None if row["ok_count"] is None else safe_int(row["ok_count"])
            ng_count = None if row["ng_count"] is None else safe_int(row["ng_count"])
            if ok_count is not None and ng_count is not None:
                daily_map[day_key]["total_count"] = ok_count + ng_count
            daily_map[day_key]["ok_count"] = ok_count
            daily_map[day_key]["ng_count"] = ng_count
        return [daily_map[day] for day in days]

    def get_alarm_daily_counts(self, line_id: int, start_day: str, end_day: str) -> list[dict[str, Any]]:
        days = day_key_range(start_day, end_day)
        daily_map = {day: {"day_key": day, "count": 0} for day in days}
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT day_key, COUNT(*) AS occurrence_count
                FROM alarm_events
                WHERE line_id = ? AND day_key BETWEEN ? AND ?
                GROUP BY day_key
                ORDER BY day_key ASC
                """,
                (line_id, start_day, end_day),
            ).fetchall()
        for row in rows:
            day_key = row["day_key"]
            if day_key not in daily_map:
                continue
            daily_map[day_key]["count"] = safe_int(row["occurrence_count"])
        return [daily_map[day] for day in days]

    def get_alarm_daily_stats(self, line_id: int, start_day: str, end_day: str, excluded_devices: set[str] | None = None) -> list[dict[str, Any]]:
        days = day_key_range(start_day, end_day)
        daily_stats: list[dict[str, Any]] = []
        for day in days:
            groups = self.get_alarm_groups(line_id, day, excluded_devices)
            daily_stats.append(
                {
                    "day_key": day,
                    "count": len(groups),
                    "duration_sec": sum(safe_int(group.get("duration_sec")) for group in groups),
                }
            )
        return daily_stats

    def get_status_daily_stats(self, line_id: int, start_day: str, end_day: str) -> list[dict[str, Any]]:
        stats: list[dict[str, Any]] = []
        for day_key in day_key_range(start_day, end_day):
            run_sec = 0
            stop_sec = 0
            alarm_sec = 0
            no_data_sec = 0
            meal_sec = 0
            for block in timeline_blocks_with_meal(self.get_timeline_blocks(line_id, day_key), day_key):
                duration = safe_int(block.get("duration"))
                status = block.get("status")
                if status == "RUN":
                    run_sec += duration
                elif status == "ALARM":
                    alarm_sec += duration
                elif status == "MEAL":
                    meal_sec += duration
                elif status == "NO_DATA":
                    no_data_sec += duration
                elif status in {"STOP", "ONLINE", "OFFLINE"}:
                    stop_sec += duration
            stats.append(
                {
                    "day_key": day_key,
                    "run_seconds": run_sec,
                    "stop_seconds": stop_sec,
                    "alarm_seconds": alarm_sec,
                    "meal_seconds": meal_sec,
                    "no_data_seconds": no_data_sec,
                }
            )
        return stats

    def get_alarm_summary_range(self, line_id: int, start_day: str, end_day: str, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT device, label, COUNT(*) AS occurrence_count
                FROM alarm_events
                WHERE line_id = ? AND day_key BETWEEN ? AND ?
                GROUP BY device, label
                ORDER BY occurrence_count DESC, label ASC
                LIMIT ?
                """,
                (line_id, start_day, end_day, limit),
            ).fetchall()
        return [
            {"device": row["device"], "label": row["label"], "count": safe_int(row["occurrence_count"])}
            for row in rows
        ]

    def get_alarm_events_range(self, line_id: int, start_day: str, end_day: str, limit: int | None = None, excluded_devices: set[str] | None = None) -> list[dict[str, Any]]:
        exclusion_sql, exclusion_params = self._excluded_devices_clause(excluded_devices)
        range_start, _ = self._alarm_window_bounds(start_day)
        _, range_end = self._alarm_window_bounds(end_day)
        with self._connect() as con:
            query = f"""
                SELECT id, device, label, started_at, ended_at
                FROM alarm_events
                WHERE line_id = ?
                AND started_at < ?
                AND COALESCE(ended_at, '9999-12-31T23:59:59') > ?
                {exclusion_sql}
                ORDER BY started_at DESC
                """
            params: tuple[Any, ...] = (line_id, range_end.isoformat(timespec="seconds"), range_start.isoformat(timespec="seconds"), *exclusion_params)
            if limit is not None:
                query += " LIMIT ?"
                params = (line_id, range_end.isoformat(timespec="seconds"), range_start.isoformat(timespec="seconds"), *exclusion_params, limit)
            rows = con.execute(query, params).fetchall()
        clipped_events = []
        for row in rows:
            clipped = self._clip_alarm_event_to_window(self._alarm_event_from_row(row), range_start, range_end)
            if clipped is not None:
                clipped_events.append(clipped)
        return self._dedupe_alarm_events(clipped_events)

    def get_alarm_groups_range(self, line_id: int, start_day: str, end_day: str, excluded_devices: set[str] | None = None) -> list[dict[str, Any]]:
        return self._group_alarm_events(self.get_alarm_events_range(line_id, start_day, end_day, excluded_devices=excluded_devices))

    def delete_alarm_events(self, line_id: int, event_ids: list[int]) -> int:
        ids = sorted({safe_int(event_id) for event_id in event_ids if safe_int(event_id) > 0})
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        with self.lock, self._connect() as con:
            cur = con.execute(
                f"DELETE FROM alarm_events WHERE line_id = ? AND id IN ({placeholders})",
                (line_id, *ids),
            )
            con.commit()
            return safe_int(cur.rowcount)

    def get_timeline_blocks(self, line_id: int, day_key: str) -> list[dict[str, Any]]:
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT ts_minute, status_label
                FROM status_snapshots
                WHERE line_id = ? AND day_key = ?
                ORDER BY ts_minute ASC
                """,
                (line_id, day_key),
            ).fetchall()

        day_start = production_day_start(day_key)
        day_end = day_start + timedelta(days=1)

        if not rows:
            return [{"status": "NO_DATA", "startSec": 0, "duration": 86400}]

        blocks: list[dict[str, Any]] = []
        current_status: str | None = None
        current_start: datetime | None = None
        previous_ts: datetime | None = None
        expected_ts = day_start

        for row in rows:
            ts = datetime.fromisoformat(row["ts_minute"])
            status = row["status_label"]
            if ts > expected_ts:
                gap_start_sec = max(0, int((expected_ts - day_start).total_seconds()))
                gap_end_sec = min(86400, int((ts - day_start).total_seconds()))
                if gap_end_sec > gap_start_sec:
                    blocks.append({"status": "NO_DATA", "startSec": gap_start_sec, "duration": gap_end_sec - gap_start_sec})
            contiguous = previous_ts is not None and (ts - previous_ts) == timedelta(minutes=1)
            if current_status is None:
                current_status = status
                current_start = ts
            elif status != current_status or not contiguous:
                assert current_start is not None and previous_ts is not None
                start_sec = max(0, int((current_start - day_start).total_seconds()))
                end_sec = max(start_sec + 60, int((previous_ts - day_start).total_seconds()) + 60)
                blocks.append({"status": current_status, "startSec": start_sec, "duration": end_sec - start_sec})
                current_status = status
                current_start = ts
            previous_ts = ts
            expected_ts = ts + timedelta(minutes=1)

        if current_status is not None and current_start is not None and previous_ts is not None:
            start_sec = max(0, int((current_start - day_start).total_seconds()))
            end_sec = max(start_sec + 60, int((previous_ts - day_start).total_seconds()) + 60)
            blocks.append({"status": current_status, "startSec": start_sec, "duration": end_sec - start_sec})

        if expected_ts < day_end:
            gap_start_sec = max(0, int((expected_ts - day_start).total_seconds()))
            gap_end_sec = 86400
            if gap_end_sec > gap_start_sec:
                blocks.append({"status": "NO_DATA", "startSec": gap_start_sec, "duration": gap_end_sec - gap_start_sec})

        blocks.sort(key=lambda block: safe_int(block.get("startSec")))
        return blocks

    def export_day_csv(self, line_name: str, line_id: int, day_key: str) -> None:
        safe_name = safe_file_name(line_name, f"line_{line_id}")
        hourly_path = self.history_dir / f"{day_key}_{safe_name}_hourly.csv"
        uph_path = self.history_dir / f"{day_key}_{safe_name}_uph.csv"

        counts, run_minutes = self.get_hourly_arrays(line_id, day_key)
        with hourly_path.open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["day_key", "line_id", "line_name", "hour", "hourly_count", "run_minutes"])
            for hour in range(24):
                writer.writerow([day_key, line_id, line_name, hour, counts[hour], run_minutes[hour]])

        uph_rows = self.get_uph_rows(line_id, day_key)
        with uph_path.open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["day_key", "line_id", "line_name", "ts_minute", "hourly_count", "uph"])
            for row in uph_rows:
                writer.writerow([day_key, line_id, line_name, row["ts_minute"], row["total_count"], row["uph"]])


def safe_int(value: Any) -> int:
    if value is None:
        return 0
    return int(value)


@dataclass
class LineState:
    connected: bool = False
    run: bool = False
    alarm: bool = False
    status_label: str = "OFFLINE"
    model: str = "-"
    total: int = 0
    ok: int = 0
    ng: int = 0
    uph: float = 0.0
    active_alarms: list[dict[str, str]] = field(default_factory=list)
    previous_alarm_devices: set[str] = field(default_factory=set)
    recovery_today: int = 0
    last_seen: str | None = None
    last_error: str | None = None
    last_total: int | None = None
    last_uph_minute: str | None = None
    last_status_minute: str | None = None


@dataclass
class LineMonitor:
    config: dict[str, Any]
    storage: Storage
    poll_interval_sec: float
    state: LineState = field(default_factory=LineState)
    _client: Type3E | None = None
    _client_lock: threading.Lock = field(default_factory=threading.Lock)
    _state_lock: threading.Lock = field(default_factory=threading.Lock)

    def _display_name(self) -> str:
        return str(self.config.get("display_name") or self.config["name"])

    def _excluded_alarm_devices(self) -> set[str]:
        return set(self.config.get("alarm_exclusions", {}).get("devices", []))

    def start(self) -> None:
        thread = threading.Thread(target=self._run_loop, daemon=True, name=f"line-{self.config['id']}")
        thread.start()

    def snapshot(self) -> dict[str, Any]:
        with self._state_lock:
            current = LineState(**self.state.__dict__)
        now = datetime.now()
        day_key = production_day_key(now)
        display_name = self._display_name()
        yesterday_key = previous_day_key(day_key)
        today_counts, today_run, _, _ = self._hourly_arrays_with_current(day_key, current, now)
        yest_counts, _ = self.storage.get_hourly_arrays(self.config["id"], yesterday_key)
        yest_ok, yest_ng = self.storage.get_hourly_quality_arrays(self.config["id"], yesterday_key)
        yest_counts = self._production_counts_from_quality(yest_counts, yest_ok, yest_ng)
        today_timeline = self.storage.get_timeline_blocks(self.config["id"], day_key)
        yest_timeline = self.storage.get_timeline_blocks(self.config["id"], yesterday_key)
        if not today_timeline and current.connected:
            today_timeline = [timeline_block_for_minute(day_key, now, current.status_label)]
        recovery_today = self.storage.get_recovery_total(self.config["id"], day_key)
        excluded_alarm_devices = self._excluded_alarm_devices()
        alarm_summary = self.storage.get_alarm_summary(self.config["id"], day_key, excluded_alarm_devices)
        active_alarm_events = self.storage.get_active_alarm_events(self.config["id"], excluded_alarm_devices)
        active_alarms = []
        for alarm in current.active_alarms:
            event = active_alarm_events.get(alarm.get("device"))
            active_alarms.append({**alarm, "started_at": event.get("started_at") if event else None})

        day_start = production_day_start(day_key)
        if now < day_start:
            day_start -= timedelta(days=1)
        elapsed_seconds = max(0, int((now.replace(second=0, microsecond=0) - day_start).total_seconds()))
        availability_seconds = {"run_seconds": 0, "stop_seconds": 0, "alarm_seconds": 0, "meal_seconds": 0, "no_data_seconds": 0}
        for block in timeline_blocks_with_meal(today_timeline, day_key):
            status = str(block.get("status") or "")
            start_sec = max(0, safe_int(block.get("startSec")))
            end_sec = min(elapsed_seconds, start_sec + safe_int(block.get("duration")))
            if end_sec <= start_sec:
                continue
            duration = end_sec - start_sec
            if status == "RUN":
                availability_seconds["run_seconds"] += duration
            elif status == "ALARM":
                availability_seconds["alarm_seconds"] += duration
            elif status == "MEAL":
                availability_seconds["meal_seconds"] += duration
            elif status == "NO_DATA":
                availability_seconds["no_data_seconds"] += duration
            else:
                availability_seconds["stop_seconds"] += duration
        observed_seconds = availability_seconds["run_seconds"] + availability_seconds["stop_seconds"] + availability_seconds["alarm_seconds"]
        run_minutes = int(round(availability_seconds["run_seconds"] / 60))
        stop_minutes = int(round((availability_seconds["stop_seconds"] + availability_seconds["alarm_seconds"]) / 60))
        avail = round((availability_seconds["run_seconds"] / observed_seconds) * 100, 1) if observed_seconds > 0 else 0.0
        comparisons = self._build_comparisons(now, day_key, current.total, current.ok, current.ng)

        target = safe_int(self.config.get("targets", {}).get("daily", 0))
        total_for_quality = current.ok + current.ng
        display_total = total_for_quality if total_for_quality > 0 else current.total
        achieve = round((display_total / target) * 100, 1) if target > 0 else 0.0
        if total_for_quality > 0:
            qual = round((current.ok / total_for_quality) * 100, 1)
        elif current.total > 0 and "ok" not in self.config.get("devices", {}):
            qual = 100.0
        else:
            qual = 0.0

        return {
            "id": self.config["id"],
            "name": display_name,
            "cycle_time_sec": self.config.get("cycle_time_sec"),
            "day_start_minute": day_start_minute_for_day(day_key),
            "day_start_time": minute_time_label(day_start_minute_for_day(day_key)),
            "connected": current.connected,
            "last_seen": current.last_seen,
            "last_error": current.last_error,
            "status": {
                "run": current.run,
                "alarm": current.alarm,
                "connected": current.connected,
                "label": current.status_label,
            },
            "model": current.model,
            "counts": {"total": display_total, "ok": current.ok, "ng": current.ng},
            "kpis": {"avail": avail, "achieve": achieve, "qual": qual, "uph": round(current.uph, 1)},
            "sub": {"run_min": run_minutes, "stop_min": stop_minutes, "target": target, "act": display_total, "uph": round(current.uph, 1)},
            "comparisons": comparisons,
            "recovery": {"today": recovery_today},
            "ng_counts": alarm_summary,
            "active_alarms": active_alarms,
            "hourly_today": today_counts,
            "hourly_yesterday": yest_counts,
            "hourly_run_mins": today_run,
            "timeline_today": today_timeline,
            "timeline_yesterday": yest_timeline,
            "new_alarm": None,
        }

    def _production_counts_from_quality(self, counts: list[int], ok_counts: list[int], ng_counts: list[int]) -> list[int]:
        if any(safe_int(value) > 0 for value in ok_counts) or any(safe_int(value) > 0 for value in ng_counts):
            return [
                safe_int(ok_counts[index] if index < len(ok_counts) else 0)
                + safe_int(ng_counts[index] if index < len(ng_counts) else 0)
                for index in range(24)
            ]
        return [safe_int(counts[index] if index < len(counts) else 0) for index in range(24)]

    def _hourly_arrays_with_current(
        self,
        day_key: str,
        current: LineState,
        now: datetime,
    ) -> tuple[list[int], list[int], list[int], list[int]]:
        hourly_counts, hourly_run = self.storage.get_hourly_arrays(self.config["id"], day_key)
        hourly_ok, hourly_ng = self.storage.get_hourly_quality_arrays(self.config["id"], day_key)
        if day_key != production_day_key(now):
            hourly_counts = self._production_counts_from_quality(hourly_counts, hourly_ok, hourly_ng)
            return hourly_counts, hourly_run, hourly_ok, hourly_ng

        day_start = production_day_start(day_key)
        if now < day_start:
            day_start -= timedelta(days=1)
        elapsed_seconds = max(0, int((now.replace(second=0, microsecond=0) - day_start).total_seconds()))
        current_slot_index = min(23, max(0, elapsed_seconds // 3600))
        current_slot_hour = slot_hour_for_index(current_slot_index, day_key)
        today_ok_delta = safe_int(current.ok) - sum(safe_int(value) for value in hourly_ok)
        today_ng_delta = safe_int(current.ng) - sum(safe_int(value) for value in hourly_ng)
        if 0 <= current_slot_hour < 24:
            if today_ok_delta > 0:
                hourly_ok[current_slot_hour] += today_ok_delta
            if today_ng_delta > 0:
                hourly_ng[current_slot_hour] += today_ng_delta
        hourly_counts = self._production_counts_from_quality(hourly_counts, hourly_ok, hourly_ng)
        return hourly_counts, hourly_run, hourly_ok, hourly_ng

    def _build_comparisons(self, now: datetime, day_key: str, current_total: int, current_ok: int, current_ng: int) -> dict[str, Any]:
        day_start = production_day_start(day_key)
        if now < day_start:
            day_start -= timedelta(days=1)
        now_minute = now.replace(second=0, microsecond=0)
        elapsed_minutes = max(0, int((now_minute - day_start).total_seconds() / 60))
        elapsed_hour_index = min(23, max(0, elapsed_minutes // 60))
        compare_hours = [slot_hour_for_index(index, day_key) for index in range(elapsed_hour_index + 1)]
        compare_minutes = min(1440, (elapsed_hour_index + 1) * 60)
        as_of = now_minute.isoformat(timespec="minutes")
        previous_day = previous_day_key(day_key)
        week_days = [day for day in day_key_range(week_start_day_key(day_key), previous_day) if day < day_key]
        if not week_days:
            week_days = list(reversed(recent_day_keys(day_key, 5)))
        fallback_start_day = min([previous_day, *week_days]) if week_days else previous_day
        fallback_daily_metrics = self.storage.get_daily_metrics_range(self.config["id"], fallback_start_day, previous_day)
        fallback_daily_map = {item["day_key"]: item for item in fallback_daily_metrics}

        def calc_direct_yield(ok_count: int | None, ng_count: int | None) -> float | None:
            if ok_count is None or ng_count is None:
                return None
            total = safe_int(ok_count) + safe_int(ng_count)
            if total <= 0:
                return None
            return round((safe_int(ok_count) / total) * 100, 1)

        def fallback_direct_yield(compare_day_key: str) -> float | None:
            item = fallback_daily_map.get(compare_day_key) or {}
            return calc_direct_yield(item.get("ok_count"), item.get("ng_count"))

        def sum_hours(values: list[int], hours: list[int]) -> int:
            return sum(safe_int(values[hour]) for hour in hours if 0 <= hour < len(values))

        def timeline_minutes_for_day(compare_day_key: str, cutoff_sec: int) -> dict[str, int]:
            totals = {"run_minutes": 0, "stop_minutes": 0, "alarm_minutes": 0, "meal_minutes": 0, "no_data_minutes": 0, "observed_minutes": 0}
            blocks = timeline_blocks_with_meal(self.storage.get_timeline_blocks(self.config["id"], compare_day_key), compare_day_key)
            cutoff = max(0, min(86400, safe_int(cutoff_sec)))
            for block in blocks:
                status = str(block.get("status") or "")
                if status not in {"RUN", "STOP", "ONLINE", "OFFLINE", "ALARM", "MEAL", "NO_DATA"}:
                    continue
                start_sec = max(0, safe_int(block.get("startSec")))
                end_sec = min(cutoff, start_sec + safe_int(block.get("duration")))
                if end_sec <= start_sec:
                    continue
                minutes = int(round((end_sec - start_sec) / 60))
                if status == "RUN":
                    totals["observed_minutes"] += minutes
                    totals["run_minutes"] += minutes
                elif status == "ALARM":
                    totals["observed_minutes"] += minutes
                    totals["alarm_minutes"] += minutes
                elif status == "NO_DATA":
                    totals["no_data_minutes"] += minutes
                elif status == "MEAL":
                    totals["meal_minutes"] += minutes
                else:
                    totals["observed_minutes"] += minutes
                    totals["stop_minutes"] += minutes
            return totals

        def metrics_for_day(compare_day_key: str, total_override: int | None = None, ok_override: int | None = None, ng_override: int | None = None) -> dict[str, int | float | bool | None]:
            compare_start = production_day_start(compare_day_key)
            compare_cutoff = compare_start + timedelta(minutes=compare_minutes)
            compare_minute = compare_cutoff.isoformat(timespec="minutes")
            hourly_counts, hourly_run = self.storage.get_hourly_arrays(self.config["id"], compare_day_key)
            hourly_ok, hourly_ng = self.storage.get_hourly_quality_arrays(self.config["id"], compare_day_key)
            hourly_counts = self._production_counts_from_quality(hourly_counts, hourly_ok, hourly_ng)
            total_count = total_override if total_override is not None else sum_hours(hourly_counts, compare_hours)
            ok_count = ok_override if ok_override is not None else sum_hours(hourly_ok, compare_hours)
            ng_count = ng_override if ng_override is not None else sum_hours(hourly_ng, compare_hours)
            if total_count is None:
                snapshot_counts = self.storage.get_snapshot_counts_before(self.config["id"], compare_day_key, compare_minute)
                total_count = snapshot_counts.get("total_count")
                ok_count = snapshot_counts.get("ok_count")
                ng_count = snapshot_counts.get("ng_count")
            status_counts = timeline_minutes_for_day(compare_day_key, compare_minutes * 60)
            alarm_stats = self.storage.get_alarm_group_stats_before(self.config["id"], compare_day_key, compare_minute, self._excluded_alarm_devices())
            observed = safe_int(status_counts.get("observed_minutes"))
            has_data = bool(observed or total_count)
            alarm_count = safe_int(alarm_stats.get("count"))
            alarm_duration_min = round(safe_int(alarm_stats.get("duration_sec")) / 60, 1)
            mttr_min = round(alarm_duration_min / alarm_count, 1) if alarm_count > 0 else None
            run_minutes = safe_int(status_counts.get("run_minutes"))
            mtbf_min = round(run_minutes / alarm_count, 1) if alarm_count > 0 else None
            direct_yield = calc_direct_yield(ok_count, ng_count)
            if direct_yield is None and total_override is None:
                direct_yield = fallback_direct_yield(compare_day_key)
            alarm_minutes = safe_int(status_counts.get("alarm_minutes"))
            stop_minutes = safe_int(status_counts.get("stop_minutes"))
            meal_minutes = safe_int(status_counts.get("meal_minutes"))
            no_data_minutes = safe_int(status_counts.get("no_data_minutes"))
            return {
                "day_key": compare_day_key,
                "cutoff": compare_minute,
                "production": None if total_count is None else safe_int(total_count),
                "run_minutes": run_minutes,
                "stop_minutes": stop_minutes,
                "alarm_minutes": alarm_minutes,
                "meal_minutes": meal_minutes,
                "no_data_minutes": no_data_minutes,
                "alarm_count": alarm_count,
                "mttr_min": mttr_min,
                "mtbf_min": mtbf_min,
                "direct_yield": direct_yield,
                "has_data": has_data,
            }

        def average_metrics(items: list[dict[str, int | bool | None]]) -> dict[str, Any]:
            valid = [item for item in items if item.get("has_data")]
            if not valid:
                return {
                    "production": None,
                    "run_minutes": None,
                    "stop_minutes": None,
                    "alarm_minutes": None,
                    "meal_minutes": None,
                    "alarm_count": None,
                    "mttr_min": None,
                    "mtbf_min": None,
                    "direct_yield": None,
                    "sample_size": 0,
                }
            def avg(key: str) -> int:
                values = [safe_int(item.get(key)) for item in valid if item.get(key) is not None]
                if not values:
                    return 0
                return int(round(sum(values) / len(values)))
            def avg_float(key: str) -> float | None:
                values = [float(item.get(key)) for item in valid if item.get(key) is not None]
                if not values:
                    return None
                return round(sum(values) / len(values), 1)
            return {
                "production": avg("production"),
                "run_minutes": avg("run_minutes"),
                "stop_minutes": avg("stop_minutes"),
                "alarm_minutes": avg("alarm_minutes"),
                "meal_minutes": avg("meal_minutes"),
                "alarm_count": avg("alarm_count"),
                "mttr_min": avg_float("mttr_min"),
                "mtbf_min": avg_float("mtbf_min"),
                "direct_yield": avg_float("direct_yield"),
                "sample_size": len(valid),
            }

        current_quality_total = safe_int(current_ok) + safe_int(current_ng)
        today_metrics = metrics_for_day(
            day_key,
            total_override=current_quality_total if current_quality_total > 0 else current_total,
            ok_override=current_ok,
            ng_override=current_ng,
        )
        yesterday_metrics = metrics_for_day(previous_day)
        yesterday_metrics["basis_mismatch"] = day_start_minute_for_day(previous_day) != day_start_minute_for_day(day_key)
        week_samples = [metrics_for_day(compare_day) for compare_day in week_days]
        week_average = average_metrics(week_samples)
        if week_average.get("direct_yield") is None:
            fallback_week_yields = [fallback_direct_yield(compare_day) for compare_day in week_days]
            fallback_week_yields = [value for value in fallback_week_yields if value is not None]
            if fallback_week_yields:
                week_average["direct_yield"] = round(sum(fallback_week_yields) / len(fallback_week_yields), 1)
        week_average["basis_mismatch"] = any(day_start_minute_for_day(day) != day_start_minute_for_day(day_key) for day in week_days)

        def history_availability(compare_day_key: str, cutoff_sec: int) -> dict[str, int | float | bool | None]:
            totals = timeline_minutes_for_day(compare_day_key, cutoff_sec)
            run_minutes = safe_int(totals.get("run_minutes"))
            stop_minutes = safe_int(totals.get("stop_minutes"))
            alarm_minutes = safe_int(totals.get("alarm_minutes"))
            no_data_minutes = safe_int(totals.get("no_data_minutes"))
            meal_minutes = safe_int(totals.get("meal_minutes"))
            observed = run_minutes + stop_minutes + alarm_minutes
            return {
                "run_minutes": run_minutes,
                "stop_minutes": stop_minutes,
                "alarm_minutes": alarm_minutes,
                "meal_minutes": meal_minutes,
                "no_data_minutes": no_data_minutes,
                "availability": round((run_minutes / observed) * 100, 1) if observed > 0 else None,
                "has_data": bool(observed),
            }

        today_full_availability = history_availability(day_key, elapsed_minutes * 60)
        yesterday_full_availability = history_availability(previous_day, 86400)
        week_full_availability_samples = [history_availability(compare_day, 86400) for compare_day in week_days]
        week_full_valid = [item for item in week_full_availability_samples if item.get("has_data")]
        week_full_availability = round(
            sum(float(item["availability"]) for item in week_full_valid if item.get("availability") is not None) / len(week_full_valid),
            1,
        ) if week_full_valid else None

        def delta_map(current_metrics: dict[str, Any], baseline_metrics: dict[str, Any]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key in ("production", "run_minutes", "stop_minutes", "alarm_minutes", "alarm_count", "mttr_min", "mtbf_min", "direct_yield"):
                current_value = current_metrics.get(key)
                baseline_value = baseline_metrics.get(key)
                if current_value is None or baseline_value is None:
                    result[key] = None
                else:
                    if isinstance(current_value, float) or isinstance(baseline_value, float):
                        result[key] = round(float(current_value) - float(baseline_value), 1)
                    else:
                        result[key] = safe_int(current_value) - safe_int(baseline_value)
            return result

        return {
            "as_of": as_of,
            "elapsed_minutes": compare_minutes,
            "day_start_minute": day_start_minute_for_day(day_key),
            "day_start_time": minute_time_label(day_start_minute_for_day(day_key)),
            "legacy_day_start_time": minute_time_label(LEGACY_DAY_START_MINUTE),
            "basis_effective_day": DAY_START_EFFECTIVE_DAY or None,
            "today": today_metrics,
            "yesterday": yesterday_metrics,
            "week_avg": week_average,
            "availability_history": {
                "today": today_full_availability,
                "yesterday": yesterday_full_availability,
                "week_avg": {"availability": week_full_availability, "sample_size": len(week_full_valid)},
            },
            "delta_vs_yesterday": delta_map(today_metrics, yesterday_metrics),
            "delta_vs_week_avg": delta_map(today_metrics, week_average),
        }

    def history(self, month_key: str | None = None, range_start_key: str | None = None, range_end_key: str | None = None) -> dict[str, Any]:
        with self._state_lock:
            current = LineState(**self.state.__dict__)
        now = datetime.now()
        day_key = production_day_key(now)
        yesterday_key = previous_day_key(day_key)
        week_start = range_start_key or week_start_day_key(day_key)
        week_end = range_end_key or (datetime.strptime(week_start, "%Y-%m-%d").date() + timedelta(days=6)).isoformat()
        selected_month = month_key or day_key[:7]
        month_start, month_end = month_range_for_key(selected_month, day_key)
        display_name = self._display_name()
        today_counts, today_run, today_ok, today_ng = self._hourly_arrays_with_current(day_key, current, now)
        yest_counts, yest_run = self.storage.get_hourly_arrays(self.config["id"], yesterday_key)
        yest_ok, yest_ng = self.storage.get_hourly_quality_arrays(self.config["id"], yesterday_key)
        yest_counts = self._production_counts_from_quality(yest_counts, yest_ok, yest_ng)
        day_start = production_day_start(day_key)
        if now < day_start:
            day_start -= timedelta(days=1)
        elapsed_seconds = max(0, int((now.replace(second=0, microsecond=0) - day_start).total_seconds()))
        current_quality_total = safe_int(current.ok) + safe_int(current.ng)
        today_timeline = self.storage.get_timeline_blocks(self.config["id"], day_key)
        availability_seconds = {"run_seconds": 0, "stop_seconds": 0, "alarm_seconds": 0, "meal_seconds": 0, "no_data_seconds": 0}
        for block in timeline_blocks_with_meal(today_timeline, day_key):
            status = str(block.get("status") or "")
            start_sec = max(0, safe_int(block.get("startSec")))
            end_sec = min(elapsed_seconds, start_sec + safe_int(block.get("duration")))
            if end_sec <= start_sec:
                continue
            duration = end_sec - start_sec
            if status == "RUN":
                availability_seconds["run_seconds"] += duration
            elif status == "ALARM":
                availability_seconds["alarm_seconds"] += duration
            elif status == "MEAL":
                availability_seconds["meal_seconds"] += duration
            elif status == "NO_DATA":
                availability_seconds["no_data_seconds"] += duration
            else:
                availability_seconds["stop_seconds"] += duration
        observed_seconds = availability_seconds["run_seconds"] + availability_seconds["stop_seconds"] + availability_seconds["alarm_seconds"]
        availability_summary = {
            **availability_seconds,
            "avail": round((availability_seconds["run_seconds"] / observed_seconds) * 100, 1) if observed_seconds > 0 else 0.0,
        }
        excluded_alarm_devices = self._excluded_alarm_devices()

        def daily_hourly_blocks(start_day: str, end_day: str) -> list[dict[str, Any]]:
            blocks: list[dict[str, Any]] = []
            for range_day_key in day_key_range(start_day, end_day):
                if range_day_key == day_key:
                    hourly_counts, hourly_run = today_counts, today_run
                    hourly_ok, hourly_ng = today_ok, today_ng
                else:
                    hourly_counts, hourly_run = self.storage.get_hourly_arrays(self.config["id"], range_day_key)
                    hourly_ok, hourly_ng = self.storage.get_hourly_quality_arrays(self.config["id"], range_day_key)
                    hourly_counts = self._production_counts_from_quality(hourly_counts, hourly_ok, hourly_ng)
                blocks.append({
                    "day_key": range_day_key,
                    "day_start_minute": day_start_minute_for_day(range_day_key),
                    "day_start_time": minute_time_label(day_start_minute_for_day(range_day_key)),
                    "hourly_counts": hourly_counts,
                    "hourly_ok_counts": hourly_ok,
                    "hourly_ng_counts": hourly_ng,
                    "run_minutes": hourly_run,
                    "timeline": self.storage.get_timeline_blocks(self.config["id"], range_day_key),
                    "alarm_groups": self.storage.get_alarm_groups(self.config["id"], range_day_key, excluded_alarm_devices),
                })
            return blocks

        def daily_metrics_with_current(start_day: str, end_day: str) -> list[dict[str, Any]]:
            rows = self.storage.get_daily_metrics_range(self.config["id"], start_day, end_day)
            if not (start_day <= day_key <= end_day):
                return rows
            for row in rows:
                if row.get("day_key") != day_key:
                    continue
                if current_quality_total > 0:
                    row["total_count"] = current_quality_total
                    row["ok_count"] = safe_int(current.ok)
                    row["ng_count"] = safe_int(current.ng)
                else:
                    row["total_count"] = safe_int(current.total)
                break
            return rows

        return {
            "line_id": self.config["id"],
            "line_name": display_name,
            "today": {
                "day_key": day_key,
                "day_start_minute": day_start_minute_for_day(day_key),
                "day_start_time": minute_time_label(day_start_minute_for_day(day_key)),
                "hourly_counts": today_counts,
                "hourly_ok_counts": today_ok,
                "hourly_ng_counts": today_ng,
                "run_minutes": today_run,
                "uph_rows": self.storage.get_uph_rows(self.config["id"], day_key),
                "timeline": today_timeline,
                "alarm_summary": self.storage.get_alarm_summary(self.config["id"], day_key, excluded_alarm_devices),
                "alarm_events": self.storage.get_alarm_events(self.config["id"], day_key, excluded_devices=excluded_alarm_devices),
                "alarm_groups": self.storage.get_alarm_groups(self.config["id"], day_key, excluded_alarm_devices),
                "availability_summary": availability_summary,
            },
            "yesterday": {
                "day_key": yesterday_key,
                "day_start_minute": day_start_minute_for_day(yesterday_key),
                "day_start_time": minute_time_label(day_start_minute_for_day(yesterday_key)),
                "hourly_counts": yest_counts,
                "hourly_ok_counts": yest_ok,
                "hourly_ng_counts": yest_ng,
                "run_minutes": yest_run,
                "uph_rows": self.storage.get_uph_rows(self.config["id"], yesterday_key),
                "timeline": self.storage.get_timeline_blocks(self.config["id"], yesterday_key),
                "alarm_summary": self.storage.get_alarm_summary(self.config["id"], yesterday_key, excluded_alarm_devices),
                "alarm_events": self.storage.get_alarm_events(self.config["id"], yesterday_key, excluded_devices=excluded_alarm_devices),
                "alarm_groups": self.storage.get_alarm_groups(self.config["id"], yesterday_key, excluded_alarm_devices),
            },
            "week": {
                "start_day_key": week_start,
                "end_day_key": week_end,
                "is_custom_range": bool(range_start_key and range_end_key),
                "daily_metrics": daily_metrics_with_current(week_start, week_end),
                "alarm_daily_stats": self.storage.get_alarm_daily_stats(self.config["id"], week_start, week_end, excluded_alarm_devices),
                "alarm_groups": self.storage.get_alarm_groups_range(self.config["id"], week_start, week_end, excluded_alarm_devices),
                "status_daily_stats": self.storage.get_status_daily_stats(self.config["id"], week_start, week_end),
                "daily_hourly_blocks": daily_hourly_blocks(week_start, week_end),
            },
            "month": {
                "start_day_key": month_start,
                "end_day_key": month_end,
                "selected_month": selected_month,
                "daily_metrics": daily_metrics_with_current(month_start, month_end),
                "alarm_daily_stats": self.storage.get_alarm_daily_stats(self.config["id"], month_start, month_end, excluded_alarm_devices),
                "alarm_groups": self.storage.get_alarm_groups_range(self.config["id"], month_start, month_end, excluded_alarm_devices),
                "status_daily_stats": self.storage.get_status_daily_stats(self.config["id"], month_start, month_end),
                "daily_hourly_blocks": daily_hourly_blocks(month_start, month_end),
            },
        }

    def export_production_csv(self, start_day: str, end_day: str) -> dict[str, Any]:
        line_id = safe_int(self.config["id"])
        line_name = self._display_name()
        safe_name = safe_file_name(line_name, f"line_{line_id}")
        desktop_dir = Path.home() / "Desktop"
        if not desktop_dir.exists():
            desktop_dir = Path.home()
        prefix = f"{start_day}_{end_day}_{safe_name}_production"
        daily_path = desktop_dir / f"{prefix}_daily.csv"
        hourly_path = desktop_dir / f"{prefix}_hourly_matrix.csv"
        days = day_key_range(start_day, end_day)
        excluded_alarm_devices = self._excluded_alarm_devices()

        daily_metrics = {item["day_key"]: item for item in self.storage.get_daily_metrics_range(line_id, start_day, end_day)}
        status_stats = {item["day_key"]: item for item in self.storage.get_status_daily_stats(line_id, start_day, end_day)}
        alarm_stats = {item["day_key"]: item for item in self.storage.get_alarm_daily_stats(line_id, start_day, end_day, excluded_alarm_devices)}

        with daily_path.open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow([
                "date",
                "line_id",
                "line_name",
                "total_count",
                "ok_count",
                "ng_count",
                "run_minutes",
                "stop_minutes",
                "alarm_minutes",
                "availability_percent",
                "direct_yield_percent",
                "alarm_count",
            ])
            for day in days:
                metrics = daily_metrics.get(day, {})
                status = status_stats.get(day, {})
                alarm = alarm_stats.get(day, {})
                run_sec = safe_int(status.get("run_seconds"))
                stop_sec = safe_int(status.get("stop_seconds"))
                alarm_sec = safe_int(status.get("alarm_seconds"))
                observed_sec = run_sec + stop_sec + alarm_sec
                ok_count = metrics.get("ok_count")
                ng_count = metrics.get("ng_count")
                quality_total = None if ok_count is None or ng_count is None else safe_int(ok_count) + safe_int(ng_count)
                writer.writerow([
                    day,
                    line_id,
                    line_name,
                    safe_int(metrics.get("total_count")),
                    "" if ok_count is None else safe_int(ok_count),
                    "" if ng_count is None else safe_int(ng_count),
                    round(run_sec / 60, 1),
                    round(stop_sec / 60, 1),
                    round(alarm_sec / 60, 1),
                    "" if observed_sec <= 0 else round((run_sec / observed_sec) * 100, 1),
                    "" if not quality_total else round((safe_int(ok_count) / quality_total) * 100, 1),
                    safe_int(alarm.get("count")),
                ])

        day_counts: dict[str, list[int]] = {}
        for day in days:
            counts, _ = self.storage.get_hourly_arrays(line_id, day)
            ok_counts, ng_counts = self.storage.get_hourly_quality_arrays(line_id, day)
            counts = self._production_counts_from_quality(counts, ok_counts, ng_counts)
            day_counts[day] = [
                safe_int(counts[slot_hour_for_index(index, day)]) if 0 <= slot_hour_for_index(index, day) < len(counts) else 0
                for index in range(24)
            ]
        display_start_minute = DAY_START_MINUTE if any(day_start_minute_for_day(day) == DAY_START_MINUTE for day in days) else day_start_minute_for_day(days[-1])
        with hourly_path.open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["time", *days, "average"])
            for index in range(24):
                values = [day_counts[day][index] for day in days]
                non_zero = [value for value in values if value > 0]
                minute = (display_start_minute + (index * 60)) % 1440
                writer.writerow([
                    minute_time_label(minute),
                    *values,
                    "" if not non_zero else round(sum(non_zero) / len(non_zero), 1),
                ])
            totals = [sum(day_counts[day]) for day in days]
            non_zero_totals = [value for value in totals if value > 0]
            writer.writerow(["total", *totals, "" if not non_zero_totals else round(sum(non_zero_totals) / len(non_zero_totals), 1)])

        return {
            "daily_path": str(daily_path),
            "hourly_path": str(hourly_path),
            "start_day": start_day,
            "end_day": end_day,
        }

    def hourly_comparison(self, range_start_key: str | None = None, range_end_key: str | None = None) -> dict[str, Any]:
        with self._state_lock:
            current = LineState(**self.state.__dict__)
        now = datetime.now()
        day_key = production_day_key(now)
        yesterday_key = previous_day_key(day_key)
        week_start = week_start_day_key(day_key)
        month_start = month_start_day_key(day_key)
        current_start_minute = day_start_minute_for_day(day_key)
        today_counts, today_run, _, _ = self._hourly_arrays_with_current(day_key, current, now)
        yesterday_counts, _ = self.storage.get_hourly_arrays(self.config["id"], yesterday_key)
        yesterday_ok, yesterday_ng = self.storage.get_hourly_quality_arrays(self.config["id"], yesterday_key)
        yesterday_counts = self._production_counts_from_quality(yesterday_counts, yesterday_ok, yesterday_ng)

        def average_counts(start_day: str, end_day: str, exclude_today: bool = False) -> dict[str, Any]:
            days = [
                day
                for day in day_key_range(start_day, end_day)
                if not (exclude_today and day == day_key)
            ]
            active_days: list[str] = []
            sums = [0] * 24
            for target_day in days:
                counts, _ = self.storage.get_hourly_arrays(self.config["id"], target_day)
                ok_counts, ng_counts = self.storage.get_hourly_quality_arrays(self.config["id"], target_day)
                counts = self._production_counts_from_quality(counts, ok_counts, ng_counts)
                if sum(counts) <= 0:
                    continue
                active_days.append(target_day)
                for hour, value in enumerate(counts):
                    sums[hour] += safe_int(value)
            if not active_days:
                return {"counts": [None] * 24, "sample_days": 0, "start_day_key": start_day, "end_day_key": end_day}
            return {
                "counts": [round(value / len(active_days), 1) for value in sums],
                "sample_days": len(active_days),
                "start_day_key": active_days[0],
                "end_day_key": active_days[-1],
            }

        week_avg = average_counts(week_start, day_key, exclude_today=True)
        month_avg = average_counts(month_start, day_key, exclude_today=True)
        custom_avg = None
        if range_start_key and range_end_key:
            custom_avg = average_counts(range_start_key, range_end_key)

        today_status = self.storage.get_timeline_blocks(self.config["id"], day_key)
        run_seconds = [0] * 24
        alarm_seconds = [0] * 24
        stop_seconds = [0] * 24
        meal_seconds = [0] * 24
        for block in timeline_blocks_with_meal(today_status, day_key):
            status = str(block.get("status") or "")
            start_sec = safe_int(block.get("startSec"))
            end_sec = min(86400, start_sec + safe_int(block.get("duration")))
            for hour in range(24):
                slot_start = hour * 3600
                slot_end = slot_start + 3600
                overlap = max(0, min(end_sec, slot_end) - max(start_sec, slot_start))
                if overlap <= 0:
                    continue
                actual_hour = slot_hour_for_index(hour, day_key)
                if status == "RUN":
                    run_seconds[actual_hour] += overlap
                elif status == "ALARM":
                    alarm_seconds[actual_hour] += overlap
                elif status == "MEAL":
                    meal_seconds[actual_hour] += overlap
                elif status != "NO_DATA":
                    stop_seconds[actual_hour] += overlap
        return {
            "line_id": self.config["id"],
            "line_name": self._display_name(),
            "today_day_key": day_key,
            "yesterday_day_key": yesterday_key,
            "day_start_minute": current_start_minute,
            "day_start_time": minute_time_label(current_start_minute),
            "legacy_day_start_time": minute_time_label(LEGACY_DAY_START_MINUTE),
            "basis_effective_day": DAY_START_EFFECTIVE_DAY or None,
            "today_counts": today_counts,
            "yesterday_counts": yesterday_counts,
            "week_avg": week_avg,
            "month_avg": month_avg,
            "custom_avg": custom_avg,
            "today_run_seconds": run_seconds,
            "today_stop_seconds": stop_seconds,
            "today_alarm_seconds": alarm_seconds,
            "today_meal_seconds": meal_seconds,
            "low_threshold_pct": 70,
        }

    def alarm_day_history(self, day_key: str) -> dict[str, Any]:
        return {
            "line_id": self.config["id"],
            "line_name": self._display_name(),
            "day_key": day_key,
            "alarm_groups": self.storage.get_alarm_groups(self.config["id"], day_key, self._excluded_alarm_devices()),
        }

    def _run_loop(self) -> None:
        while True:
            started = time.time()
            try:
                self._poll_once()
            except Exception as exc:
                now = datetime.now()
                day_key = production_day_key(now)
                minute_key = minute_floor(now)
                with self._state_lock:
                    self.state.connected = False
                    self.state.status_label = "OFFLINE"
                    self.state.last_error = str(exc)
                    if self.state.last_status_minute != minute_key:
                        self.state.last_status_minute = minute_key
                        self.storage.write_status_snapshot(self.config["id"], minute_key, day_key, "OFFLINE")
                self._close_client()
            elapsed = time.time() - started
            time.sleep(max(0.2, self.poll_interval_sec - elapsed))

    def _poll_once(self) -> None:
        now = datetime.now()
        day_key = production_day_key(now)
        devices = self.config.get("devices", {})
        total = self._read_word(devices["total"]) if devices.get("total") else None
        ok = self._read_word(devices["ok"]) if devices.get("ok") else safe_int(total)
        ng = self._read_word(devices["ng"]) if devices.get("ng") else max(0, safe_int(total) - ok)
        if total is None:
            total = ok + ng

        status_cfg = self.config.get("status", {})
        run_bit = status_cfg.get("run_bit")
        alarm_bit = status_cfg.get("alarm_bit")
        has_real_status = bool(run_bit or alarm_bit)
        run = self._read_bit(run_bit) if run_bit else False
        alarm = self._read_bit(alarm_bit) if alarm_bit else False
        scan_requires_total_bit = bool(self.config.get("alarm_scan_requires_total_bit", True))
        should_scan_active_alarms = (alarm or not alarm_bit) if scan_requires_total_bit else True
        active_alarms = self._read_active_alarms() if should_scan_active_alarms else []
        if active_alarms:
            alarm = True

        model_cfg = self.config.get("model", {})
        model = model_cfg.get("default_label", "-")
        for bit_device, label in model_cfg.get("bits", {}).items():
            if self._read_bit(bit_device):
                model = label
                break

        with self._state_lock:
            last_total = self.state.last_total
            previous_alarm_devices = set(self.state.previous_alarm_devices)
            self.state.connected = True
            self.state.run = bool(run)
            self.state.alarm = bool(alarm)
            self.state.status_label = self._status_label(run, alarm, has_real_status)
            self.state.model = model
            self.state.total = total
            self.state.ok = ok
            self.state.ng = ng
            self.state.active_alarms = active_alarms
            self.state.previous_alarm_devices = {alarm_item["device"] for alarm_item in active_alarms}
            self.state.last_seen = now.strftime("%Y-%m-%d %H:%M:%S")
            self.state.last_error = None
            self.state.last_total = total

        total_delta = 0
        if last_total is None:
            latest_total = self.storage.get_latest_snapshot_total(self.config["id"], day_key)
            if latest_total is not None and total >= latest_total:
                recovered = total - latest_total
                if recovered > 0:
                    self.storage.add_recovery_event(self.config["id"], day_key, now.isoformat(timespec="seconds"), recovered)
        elif total >= last_total:
            total_delta = total - last_total

        self.storage.record_alarm_transitions(
            self.config["id"],
            day_key,
            now.isoformat(timespec="seconds"),
            previous_alarm_devices,
            active_alarms,
        )

        run_seconds_delta = int(self.poll_interval_sec) if (run if has_real_status else True) else 0

        if total_delta or run_seconds_delta:
            self.storage.add_hourly_increment(
                self.config["id"],
                day_key,
                production_slot_hour(now, day_key),
                total_delta,
                run_seconds_delta,
                now.isoformat(timespec="seconds"),
            )
            self.storage.export_day_csv(self.config["name"], self.config["id"], day_key)

        uph = self._calculate_uph(day_key, now)
        minute_key = minute_floor(now)
        should_write_uph = False
        should_write_status = False
        status_label = self._status_label(run, alarm, has_real_status)
        with self._state_lock:
            self.state.uph = uph
            if self.state.last_uph_minute != minute_key:
                self.state.last_uph_minute = minute_key
                should_write_uph = True
            if self.state.last_status_minute != minute_key:
                self.state.last_status_minute = minute_key
                should_write_status = True
        if should_write_uph:
            self.storage.write_uph_snapshot(self.config["id"], minute_key, day_key, total, ok, ng, uph)
            self.storage.export_day_csv(self.config["name"], self.config["id"], day_key)
        if should_write_status:
            self.storage.write_status_snapshot(self.config["id"], minute_key, day_key, status_label)

    def _calculate_uph(self, day_key: str, now: datetime) -> float:
        today_counts, _ = self.storage.get_hourly_arrays(self.config["id"], day_key)
        today_ok, today_ng = self.storage.get_hourly_quality_arrays(self.config["id"], day_key)
        today_counts = self._production_counts_from_quality(today_counts, today_ok, today_ng)
        total_today = sum(today_counts)
        day_start = production_day_start(day_key)
        if now < day_start:
            day_start -= timedelta(days=1)
        elapsed_hours = max((now - day_start).total_seconds() / 3600.0, 0.0)
        if elapsed_hours <= 0:
            return 0.0
        return round(total_today / elapsed_hours, 1)

    def _status_label(self, run: bool, alarm: bool, has_real_status: bool) -> str:
        if alarm:
            return "ALARM"
        if has_real_status and run:
            return "RUN"
        if has_real_status:
            return "STOP"
        return "ONLINE"

    def _read_word(self, device: str) -> int:
        client = self._ensure_client()
        try:
            return safe_int(client.batchread_wordunits(device, 1)[0])
        except Exception:
            self._close_client()
            client = self._ensure_client()
            return safe_int(client.batchread_wordunits(device, 1)[0])

    def _read_bit(self, device: str) -> bool:
        parsed = self._parse_device(device)
        if parsed and parsed[0] == "D":
            _, word_no, bit_no = parsed
            word_value = self._read_word(f"D{word_no}")
            if bit_no is None:
                return word_value != 0
            return bool(word_value & (1 << bit_no))
        client = self._ensure_client()
        try:
            return bool(safe_int(client.batchread_bitunits(device, 1)[0]))
        except Exception:
            self._close_client()
            client = self._ensure_client()
            return bool(safe_int(client.batchread_bitunits(device, 1)[0]))

    def _read_active_alarms(self) -> list[dict[str, str]]:
        active: list[dict[str, str]] = []
        alarm_sources = self.config.get("alarm_sources", [])
        active_devices = self._read_devices_bulk(alarm_cfg.get("device") for alarm_cfg in alarm_sources)
        for alarm_cfg in alarm_sources:
            device = alarm_cfg.get("device")
            label = alarm_cfg.get("label", device or "-")
            if not device:
                continue
            try:
                if active_devices.get(device, False):
                    active.append({"device": device, "label": label})
            except Exception:
                continue
        return active

    def _read_devices_bulk(self, devices: list[str] | Any) -> dict[str, bool]:
        parsed_devices: list[tuple[str, str, int, int | None]] = []
        results: dict[str, bool] = {}
        for device in devices:
            if not device:
                continue
            parsed = self._parse_device(device)
            if parsed is None:
                try:
                    results[str(device)] = self._read_bit(str(device))
                except Exception:
                    results[str(device)] = False
                continue
            prefix, number, bit_no = parsed
            parsed_devices.append((str(device), prefix, number, bit_no))
        grouped: dict[tuple[str, str], list[tuple[str, int, int | None]]] = {}
        for device, prefix, number, bit_no in parsed_devices:
            device_type = "word" if prefix == "D" else "bit"
            grouped.setdefault((device_type, prefix), []).append((device, number, bit_no))
        for (device_type, prefix), items in grouped.items():
            items.sort(key=lambda item: item[1])
            start_index = 0
            while start_index < len(items):
                end_index = start_index
                while end_index + 1 < len(items) and items[end_index + 1][1] == items[end_index][1] + 1:
                    end_index += 1
                block = items[start_index : end_index + 1]
                start_no = block[0][1]
                count = block[-1][1] - start_no + 1
                try:
                    values = self._batch_read(prefix, start_no, count, device_type)
                except Exception:
                    for device, _, _ in block:
                        try:
                            results[device] = self._read_bit(device)
                        except Exception:
                            results[device] = False
                else:
                    for device, number, bit_no in block:
                        offset = number - start_no
                        value = safe_int(values[offset])
                        results[device] = bool(value & (1 << bit_no)) if bit_no is not None else bool(value)
                start_index = end_index + 1
        return results

    def _batch_read(self, prefix: str, start_no: int, count: int, device_type: str) -> list[Any]:
        client = self._ensure_client()
        start_device = f"{prefix}{start_no}"
        try:
            if device_type == "word":
                return client.batchread_wordunits(start_device, count)
            return client.batchread_bitunits(start_device, count)
        except Exception:
            self._close_client()
            client = self._ensure_client()
            if device_type == "word":
                return client.batchread_wordunits(start_device, count)
            return client.batchread_bitunits(start_device, count)

    @staticmethod
    def _parse_device(device: str) -> tuple[str, int, int | None] | None:
        match = re.fullmatch(r"([A-Za-z]+)(\d+)(?:\.([0-9A-Fa-f]))?", str(device).strip())
        if not match:
            return None
        bit_no = int(match.group(3), 16) if match.group(3) is not None else None
        return match.group(1).upper(), int(match.group(2)), bit_no

    def _ensure_client(self) -> Type3E:
        with self._client_lock:
            if self._client is None:
                client = Type3E()
                client.connect(self.config["host"], int(self.config["port"]))
                self._client = client
            return self._client

    def _close_client(self) -> None:
        with self._client_lock:
            if self._client is not None:
                try:
                    self._client.close()
                except Exception:
                    pass
                self._client = None


storage = Storage(DB_PATH, HISTORY_DIR)
monitors = [LineMonitor(config=line_cfg, storage=storage, poll_interval_sec=POLL_INTERVAL_SEC) for line_cfg in CONFIG["lines"]]
viewer_lock = threading.Lock()
viewer_heartbeats: dict[str, float] = {}
VIEWER_TTL_SEC = 15

app = Flask(__name__, static_folder=str(DASHBOARD_DIR), static_url_path="")


def active_viewer_count(now: float | None = None) -> int:
    current = now if now is not None else time.time()
    with viewer_lock:
        expired = [client_id for client_id, seen_at in viewer_heartbeats.items() if current - seen_at > VIEWER_TTL_SEC]
        for client_id in expired:
            viewer_heartbeats.pop(client_id, None)
        return len(viewer_heartbeats)


@app.after_request
def add_no_cache_headers(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.route("/")
def index():
    return send_from_directory(DASHBOARD_DIR, "index.html")


@app.route("/api/dashboard")
def dashboard_api():
    return jsonify({
        "build": int(time.time()),
        "day_start_hour": DAY_START_HOUR,
        "day_start_minute": DAY_START_MINUTE,
        "day_start_time": minute_time_label(DAY_START_MINUTE),
        "legacy_day_start_time": minute_time_label(LEGACY_DAY_START_MINUTE),
        "day_start_effective_day": DAY_START_EFFECTIVE_DAY or None,
        "viewer_count": active_viewer_count(),
        "lines": [monitor.snapshot() for monitor in monitors],
    })


@app.route("/api/viewers/heartbeat", methods=["POST"])
def viewers_heartbeat_api():
    payload = request.get_json(silent=True) or {}
    client_id = str(payload.get("client_id") or "").strip()
    if not client_id:
        return jsonify({"error": "missing client_id"}), 400
    with viewer_lock:
        viewer_heartbeats[client_id[:128]] = time.time()
    return jsonify({"viewer_count": active_viewer_count()})


@app.route("/api/lines/<int:line_id>/target", methods=["POST"])
def line_target_api(line_id: int):
    payload = request.get_json(silent=True) or {}
    target_raw = payload.get("daily")
    try:
        target = int(target_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "daily target must be a number"}), 400
    if target < 0:
        return jsonify({"error": "daily target must be zero or greater"}), 400
    if target > 10_000_000:
        return jsonify({"error": "daily target is too large"}), 400
    saved = save_line_daily_target(line_id, target)
    if saved is None:
        return jsonify({"error": "unknown line"}), 404
    return jsonify(saved)


@app.route("/api/history/<int:line_id>")
def history_api(line_id: int):
    monitor = next((item for item in monitors if item.config["id"] == line_id), None)
    if monitor is None:
        return jsonify({"error": "unknown line"}), 404
    month_key = request.args.get("month")
    if month_key and not re.fullmatch(r"\d{4}-\d{2}", month_key):
        return jsonify({"error": "invalid month"}), 400
    start_day = request.args.get("start_day")
    end_day = request.args.get("end_day")
    if bool(start_day) != bool(end_day):
        return jsonify({"error": "start_day and end_day are required together"}), 400
    if start_day and end_day:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start_day) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_day):
            return jsonify({"error": "invalid date range"}), 400
        start_date = datetime.strptime(start_day, "%Y-%m-%d").date()
        end_date = datetime.strptime(end_day, "%Y-%m-%d").date()
        if start_date > end_date:
            return jsonify({"error": "start_day must be before end_day"}), 400
        if (end_date - start_date).days > 92:
            return jsonify({"error": "date range is too long"}), 400
    return jsonify(monitor.history(month_key, start_day, end_day))


@app.route("/api/history/<int:line_id>/production-export", methods=["POST"])
def production_export_api(line_id: int):
    monitor = next((item for item in monitors if item.config["id"] == line_id), None)
    if monitor is None:
        return jsonify({"error": "unknown line"}), 404
    payload = request.get_json(silent=True) or {}
    start_day = payload.get("start_day")
    end_day = payload.get("end_day")
    if not isinstance(start_day, str) or not isinstance(end_day, str):
        return jsonify({"error": "start_day and end_day are required"}), 400
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start_day) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_day):
        return jsonify({"error": "invalid date range"}), 400
    start_date = datetime.strptime(start_day, "%Y-%m-%d").date()
    end_date = datetime.strptime(end_day, "%Y-%m-%d").date()
    if start_date > end_date:
        return jsonify({"error": "start_day must be before end_day"}), 400
    if (end_date - start_date).days > 92:
        return jsonify({"error": "date range is too long"}), 400
    return jsonify(monitor.export_production_csv(start_day, end_day))


@app.route("/api/history/<int:line_id>/alarms/<day_key>")
def alarm_day_history_api(line_id: int, day_key: str):
    monitor = next((item for item in monitors if item.config["id"] == line_id), None)
    if monitor is None:
        return jsonify({"error": "unknown line"}), 404
    return jsonify(monitor.alarm_day_history(day_key))


@app.route("/api/hourly-comparison/<int:line_id>")
def hourly_comparison_api(line_id: int):
    monitor = next((item for item in monitors if item.config["id"] == line_id), None)
    if monitor is None:
        return jsonify({"error": "unknown line"}), 404
    start_day = request.args.get("start_day")
    end_day = request.args.get("end_day")
    if bool(start_day) != bool(end_day):
        return jsonify({"error": "start_day and end_day are required together"}), 400
    if start_day and end_day:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start_day) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_day):
            return jsonify({"error": "invalid date range"}), 400
        start_date = datetime.strptime(start_day, "%Y-%m-%d").date()
        end_date = datetime.strptime(end_day, "%Y-%m-%d").date()
        if start_date > end_date:
            return jsonify({"error": "start_day must be before end_day"}), 400
        if (end_date - start_date).days > 92:
            return jsonify({"error": "date range is too long"}), 400
    return jsonify(monitor.hourly_comparison(start_day, end_day))


@app.route("/api/alarm-events/delete", methods=["POST"])
def alarm_events_delete_api():
    payload = request.get_json(silent=True) or {}
    line_id = safe_int(payload.get("line_id"))
    event_ids = payload.get("event_ids") or []
    if not any(item.config["id"] == line_id for item in monitors):
        return jsonify({"error": "unknown line"}), 404
    if not isinstance(event_ids, list):
        return jsonify({"error": "event_ids must be a list"}), 400
    deleted = storage.delete_alarm_events(line_id, [safe_int(event_id) for event_id in event_ids])
    return jsonify({"deleted": deleted})


def main() -> None:
    for monitor in monitors:
        monitor.start()
    app.run(host="0.0.0.0", port=SERVER_PORT, debug=False, threaded=True)


if __name__ == "__main__":
    main()
