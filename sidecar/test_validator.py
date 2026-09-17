"""Sidecar validation test suite (P0-1).

Run with:  python -m pytest sidecar/test_validator.py  (from project root)
         or: python sidecar/test_validator.py  (runs the lightweight self-runner)

These tests directly call the internal _validate helper rather than spawning
a subprocess, so they run without Tauri or Rust in the loop.
"""

from __future__ import annotations

import sys
import os

# Allow running from the project root: add sidecar/ to path.
sys.path.insert(0, os.path.dirname(__file__))

from main import _validate  # noqa: E402  (after sys.path mutation)

# ---------------------------------------------------------------------------
# Minimal schema fixture shared across tests
# ---------------------------------------------------------------------------

SCHEMA = {
    "schemas": [
        {
            "name": "public",
            "tables": [
                {
                    "name": "users",
                    "excluded": False,
                    "primary_key": ["id"],
                    "foreign_keys": [],
                    "columns": [
                        {"name": "id", "data_type": "int4", "nullable": False},
                        {"name": "name", "data_type": "text", "nullable": True},
                        {"name": "active", "data_type": "bool", "nullable": True},
                    ],
                    "user_annotation": None,
                },
                {
                    "name": "orders",
                    "excluded": False,
                    "primary_key": ["id"],
                    "foreign_keys": [
                        {
                            "columns": ["user_id"],
                            "references_schema": "public",
                            "references_table": "users",
                            "references_columns": ["id"],
                        }
                    ],
                    "columns": [
                        {"name": "id", "data_type": "int4", "nullable": False},
                        {"name": "user_id", "data_type": "int4", "nullable": False},
                        {"name": "amount", "data_type": "numeric", "nullable": True},
                    ],
                    "user_annotation": None,
                },
            ],
        }
    ]
}

EMPTY_SCHEMA = {"schemas": []}


def _req(sql: str, dialect: str = "postgres", schema=None) -> dict:
    return {
        "id": "test",
        "kind": "validate",
        "sql": sql,
        "dialect": dialect,
        "schema": schema if schema is not None else SCHEMA,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ok(result: dict) -> bool:
    return result.get("ok") is True


def rejected(result: dict, category: str | None = None) -> bool:
    if result.get("ok") is not False:
        return False
    if category is not None:
        return result.get("category") == category
    return True


# ---------------------------------------------------------------------------
# Acceptance tests
# ---------------------------------------------------------------------------

def test_plain_select_postgres():
    r = _validate("t", _req("SELECT id, name FROM users WHERE active = true", "postgres"))
    assert ok(r), f"expected ok, got {r}"


def test_plain_select_mysql():
    schema_mysql = {
        "schemas": [
            {
                "name": "",
                "tables": [
                    {
                        "name": "users",
                        "excluded": False,
                        "primary_key": ["id"],
                        "foreign_keys": [],
                        "columns": [
                            {"name": "id", "data_type": "int", "nullable": False},
                            {"name": "name", "data_type": "varchar", "nullable": True},
                        ],
                        "user_annotation": None,
                    }
                ],
            }
        ]
    }
    r = _validate("t", _req("SELECT id, name FROM users", "mysql", schema_mysql))
    assert ok(r), f"expected ok, got {r}"


def test_cte_select():
    sql = "WITH q AS (SELECT id FROM users) SELECT * FROM q"
    r = _validate("t", _req(sql))
    assert ok(r), f"CTE select should pass: {r}"


def test_join_query():
    sql = "SELECT u.name, o.amount FROM users u JOIN orders o ON o.user_id = u.id"
    r = _validate("t", _req(sql))
    assert ok(r), f"JOIN select should pass: {r}"


# ---------------------------------------------------------------------------
# Rejection: write statements
# ---------------------------------------------------------------------------

def test_rejects_drop():
    r = _validate("t", _req("DROP TABLE users", "postgres", EMPTY_SCHEMA))
    assert rejected(r, "write_statement"), f"DROP must be rejected: {r}"


def test_rejects_update():
    r = _validate("t", _req("UPDATE users SET name = 'x' WHERE id = 1", "postgres", EMPTY_SCHEMA))
    assert rejected(r, "write_statement"), f"UPDATE must be rejected: {r}"


def test_rejects_delete():
    r = _validate("t", _req("DELETE FROM users WHERE id = 1", "postgres", EMPTY_SCHEMA))
    assert rejected(r, "write_statement"), f"DELETE must be rejected: {r}"


def test_rejects_insert():
    r = _validate("t", _req("INSERT INTO users (name) VALUES ('x')", "postgres", EMPTY_SCHEMA))
    assert rejected(r, "write_statement"), f"INSERT must be rejected: {r}"


def test_rejects_create_table():
    r = _validate("t", _req("CREATE TABLE foo (id int)", "postgres", EMPTY_SCHEMA))
    assert rejected(r, "write_statement"), f"CREATE TABLE must be rejected: {r}"


def test_rejects_alter_table():
    r = _validate("t", _req("ALTER TABLE users ADD COLUMN email text", "postgres", EMPTY_SCHEMA))
    assert rejected(r, "write_statement"), f"ALTER TABLE must be rejected: {r}"


def test_rejects_truncate():
    r = _validate("t", _req("TRUNCATE users", "postgres", EMPTY_SCHEMA))
    assert rejected(r), f"TRUNCATE must be rejected: {r}"


def test_rejects_select_into():
    r = _validate("t", _req("SELECT id INTO temp_users FROM users", "postgres", SCHEMA))
    assert rejected(r, "write_statement"), f"SELECT INTO must be rejected: {r}"


# ---------------------------------------------------------------------------
# Rejection: CTE wrapping a mutation
# ---------------------------------------------------------------------------

def test_rejects_cte_wrapping_delete():
    sql = "WITH cte AS (DELETE FROM users WHERE id = 1 RETURNING id) SELECT * FROM cte"
    r = _validate("t", _req(sql, "postgres", SCHEMA))
    assert rejected(r, "write_statement"), f"CTE wrapping DELETE must be rejected: {r}"


def test_rejects_cte_wrapping_update():
    sql = "WITH cte AS (UPDATE users SET name = 'x' RETURNING id) SELECT * FROM cte"
    r = _validate("t", _req(sql, "postgres", SCHEMA))
    assert rejected(r, "write_statement"), f"CTE wrapping UPDATE must be rejected: {r}"


# ---------------------------------------------------------------------------
# Rejection: multiple statements
# ---------------------------------------------------------------------------

def test_rejects_multiple_statements():
    sql = "SELECT 1; DROP TABLE users"
    r = _validate("t", _req(sql, "postgres", EMPTY_SCHEMA))
    assert rejected(r, "write_statement"), f"multiple statements must be rejected: {r}"


# ---------------------------------------------------------------------------
# Rejection: denylisted functions
# ---------------------------------------------------------------------------

def test_rejects_pg_read_file():
    sql = "SELECT pg_read_file('/etc/passwd')"
    r = _validate("t", _req(sql, "postgres", EMPTY_SCHEMA))
    assert rejected(r, "denylisted_function"), f"pg_read_file must be rejected: {r}"


def test_rejects_xp_cmdshell():
    sql = "SELECT xp_cmdshell('whoami')"
    r = _validate("t", _req(sql, "tsql", EMPTY_SCHEMA))
    assert rejected(r, "denylisted_function"), f"xp_cmdshell must be rejected: {r}"


def test_rejects_load_file_mysql():
    sql = "SELECT load_file('/etc/passwd')"
    r = _validate("t", _req(sql, "mysql", EMPTY_SCHEMA))
    assert rejected(r, "denylisted_function"), f"load_file must be rejected: {r}"


def test_rejects_dblink():
    sql = "SELECT * FROM dblink('dbname=other', 'SELECT 1') AS t(x int)"
    r = _validate("t", _req(sql, "postgres", EMPTY_SCHEMA))
    assert rejected(r, "denylisted_function"), f"dblink must be rejected: {r}"


# ---------------------------------------------------------------------------
# Rejection: system tables
# ---------------------------------------------------------------------------

def test_rejects_information_schema():
    sql = "SELECT table_name FROM information_schema.tables"
    r = _validate("t", _req(sql, "postgres", EMPTY_SCHEMA))
    assert rejected(r, "system_table"), f"information_schema must be rejected: {r}"


def test_rejects_pg_catalog():
    sql = "SELECT relname FROM pg_catalog.pg_class"
    r = _validate("t", _req(sql, "postgres", EMPTY_SCHEMA))
    assert rejected(r, "system_table"), f"pg_catalog must be rejected: {r}"


def test_rejects_sqlite_master():
    sql = "SELECT name FROM sqlite_master WHERE type = 'table'"
    r = _validate("t", _req(sql, "sqlite", EMPTY_SCHEMA))
    assert rejected(r, "system_table"), f"sqlite_master must be rejected: {r}"


# ---------------------------------------------------------------------------
# Rejection: unknown / unschema'd tables
# ---------------------------------------------------------------------------

def test_rejects_unknown_table():
    sql = "SELECT id FROM nonexistent_table"
    r = _validate("t", _req(sql, "postgres", SCHEMA))
    assert rejected(r, "unknown_table"), f"unknown table must be rejected: {r}"


# ---------------------------------------------------------------------------
# Test runner (no pytest dependency required)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import traceback

    tests = [
        v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)
    ]
    passed = failed = 0
    for fn in tests:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {fn.__name__}: {e}")
            failed += 1
        except Exception:
            print(f"  ERROR {fn.__name__}:")
            traceback.print_exc()
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
