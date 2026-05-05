"""SQL Mate validation sidecar.

Reads JSON requests from stdin (one per line), parses the SQL with sqlglot,
walks the AST to enforce read-only-by-construction, and resolves table and
column references against the user's canonical schema model.

Wire protocol pinned by docs/decisions/0009-python-sidecar-lifecycle.md.

Security: this sidecar is a load-bearing control. Any change here requires a
security review. The validator must be conservative: when in doubt, reject.
"""

from __future__ import annotations

import json
import sys
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set

import sqlglot
from sqlglot import expressions as exp
from sqlglot.errors import ParseError

PROTOCOL_VERSION = 1

# Node types that are *expected* in a read-only query tree. Anything appearing
# in the AST that is not on this allowlist (and is a subclass of
# exp.Expression) triggers a write_statement rejection.
_ALLOWED_TOP_LEVEL = (
    exp.Select,
    exp.Subquery,
    exp.Union,
    exp.Intersect,
    exp.Except,
    exp.With,
    exp.CTE,
)

# Concrete mutating node types we always reject if seen anywhere in the tree.
_FORBIDDEN_NODE_TYPES = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Drop,
    exp.Create,
    exp.Alter,
    exp.AlterColumn,
    exp.TruncateTable,
    exp.Merge,
    exp.Command,
    exp.Use,
    exp.SetItem,
    exp.Set,
    exp.Pragma,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
)

# System / metadata schemas that the LLM should never query. The validator
# checks both the schema-qualified name and a few well-known unqualified ones.
_SYSTEM_SCHEMAS = {
    "information_schema",
    "pg_catalog",
    "pg_internal",
    "pg_temp",
    "pg_toast",
    "sys",
    "mysql",
    "performance_schema",
}

_SYSTEM_TABLES_UNQUALIFIED = {
    "sqlite_master",
    "sqlite_temp_master",
    "sqlite_sequence",
}

# Dialect-specific function denylist. Functions that would let SQL execute
# arbitrary code, read filesystem, or escape the read-only constraint.
_FUNCTION_DENYLIST = {
    # Postgres
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_stat_file",
    "lo_import",
    "lo_export",
    "dblink",
    "dblink_exec",
    "copy_to",
    "copy_from",
    # SQL Server
    "xp_cmdshell",
    "xp_dirtree",
    "xp_fileexist",
    "openrowset",
    "opendatasource",
    "openquery",
    # MySQL
    "load_file",
    "sys_exec",
    "sys_eval",
    # SQLite
    "load_extension",
    "readfile",
    "writefile",
}


@dataclass
class Reject:
    category: str
    message: str
    detail: Optional[str] = None


def main() -> int:
    handshake = {
        "ready": True,
        "protocol": PROTOCOL_VERSION,
        "sqlglot_version": sqlglot.__version__,
    }
    _write(handshake)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _write({
                "id": "?",
                "ok": False,
                "category": "parse_error",
                "message": f"invalid request JSON: {e}",
            })
            continue
        try:
            resp = _handle(req)
        except Exception as e:  # belt and suspenders
            traceback.print_exc(file=sys.stderr)
            resp = {
                "id": req.get("id", "?"),
                "ok": False,
                "category": "internal_error",
                "message": f"sidecar exception: {e}",
            }
        _write(resp)
    return 0


def _write(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _handle(req: Dict[str, Any]) -> Dict[str, Any]:
    rid = req.get("id", "?")
    kind = req.get("kind", "")
    if kind == "ping":
        return {"id": rid, "ok": True}
    if kind == "validate":
        return _validate(rid, req)
    return {
        "id": rid,
        "ok": False,
        "category": "parse_error",
        "message": f"unknown request kind: {kind!r}",
    }


def _validate(rid: str, req: Dict[str, Any]) -> Dict[str, Any]:
    sql: str = req.get("sql") or ""
    dialect: str = req.get("dialect") or "postgres"
    schema: Dict[str, Any] = req.get("schema") or {}

    if not sql.strip():
        return _err(rid, "empty", "empty SQL")

    # Parse all statements; if there's more than one we reject (no semicolon-
    # smuggling a DROP after a SELECT).
    try:
        statements = sqlglot.parse(sql, dialect=dialect)
    except ParseError as e:
        return _err(rid, "parse_error", str(e))
    statements = [s for s in statements if s is not None]
    if not statements:
        return _err(rid, "empty", "no parseable statements")
    if len(statements) > 1:
        return _err(
            rid,
            "write_statement",
            "multiple statements detected; only a single SELECT is allowed",
            detail=f"{len(statements)} statements",
        )
    tree = statements[0]

    # Top-level shape check.
    if not isinstance(tree, _ALLOWED_TOP_LEVEL):
        return _err(
            rid,
            "write_statement",
            f"top-level statement is {type(tree).__name__}, not a SELECT",
            detail=type(tree).__name__,
        )

    # SELECT ... INTO is a write.
    if isinstance(tree, exp.Select) and tree.args.get("into") is not None:
        return _err(rid, "write_statement", "SELECT ... INTO is not allowed")

    # Walk the tree for any forbidden node anywhere.
    for node in tree.walk():
        if isinstance(node, _FORBIDDEN_NODE_TYPES):
            return _err(
                rid,
                "write_statement",
                f"forbidden node {type(node).__name__} found inside the query",
                detail=type(node).__name__,
            )
        # Function denylist.
        if isinstance(node, exp.Anonymous):
            name = (node.name or "").lower()
            if name in _FUNCTION_DENYLIST:
                return _err(
                    rid,
                    "denylisted_function",
                    f"function {name} is not allowed",
                    detail=name,
                )
        if isinstance(node, exp.Func):
            name = (node.sql_name() or type(node).__name__).lower()
            if name in _FUNCTION_DENYLIST:
                return _err(
                    rid,
                    "denylisted_function",
                    f"function {name} is not allowed",
                    detail=name,
                )

    # Resolve table references against the schema.
    schema_tables = _build_schema_index(schema)
    referenced: List[str] = []
    cte_names: Set[str] = {
        cte.alias_or_name for cte in tree.find_all(exp.CTE)
    }

    for table in tree.find_all(exp.Table):
        if table.name in cte_names and not table.db:
            # Reference to a WITH clause; not a real table.
            continue
        schema_name = (table.db or _default_schema(dialect)).lower()
        table_name = table.name.lower()

        if schema_name in _SYSTEM_SCHEMAS or table_name in _SYSTEM_TABLES_UNQUALIFIED:
            return _err(
                rid,
                "system_table",
                f"system table {schema_name}.{table_name} is not allowed",
                detail=f"{schema_name}.{table_name}",
            )

        full = f"{schema_name}.{table_name}"
        if full not in schema_tables:
            return _err(
                rid,
                "unknown_table",
                f"table {full} does not exist in the extracted schema",
                detail=full,
            )
        referenced.append(full)

    # Best-effort column resolution: for fully qualified column references
    # (table.column or schema.table.column), check the column exists.
    # Unqualified column references aren't resolved here — Phase 3 walking
    # skeleton accepts them. Phase 7 should tighten this with a proper scope
    # walker.
    for column in tree.find_all(exp.Column):
        table_alias = column.table
        if not table_alias:
            continue
        # Resolve alias to underlying schema.table.
        target = _resolve_alias(tree, table_alias, schema_tables, dialect)
        if target is None:
            continue  # alias for a CTE or subquery — accept
        col_name = (column.name or "").lower()
        if col_name and col_name not in schema_tables[target]:
            return _err(
                rid,
                "unknown_column",
                f"column {target}.{col_name} does not exist in the extracted schema",
                detail=f"{target}.{col_name}",
            )

    return {
        "id": rid,
        "ok": True,
        "referenced_tables": sorted(set(referenced)),
    }


def _err(rid: str, category: str, message: str, detail: Optional[str] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {"id": rid, "ok": False, "category": category, "message": message}
    if detail is not None:
        out["detail"] = detail
    return out


def _default_schema(dialect: str) -> str:
    if dialect in {"postgres", "postgresql"}:
        return "public"
    if dialect == "mysql":
        return ""  # MySQL has no schema layer
    if dialect == "tsql":
        return "dbo"
    return ""


def _build_schema_index(schema: Dict[str, Any]) -> Dict[str, Set[str]]:
    """Flatten the canonical SchemaModel JSON into a dict of
    "schema.table" -> set of column names (all lower-cased)."""
    out: Dict[str, Set[str]] = {}
    for db_schema in schema.get("schemas", []) or []:
        sname = (db_schema.get("name") or "").lower()
        for table in db_schema.get("tables", []) or []:
            if table.get("excluded"):
                continue
            tname = (table.get("name") or "").lower()
            cols: Set[str] = {
                (c.get("name") or "").lower() for c in (table.get("columns") or [])
            }
            out[f"{sname}.{tname}"] = cols
    return out


def _resolve_alias(tree, alias: str, schema_tables: Dict[str, Set[str]], dialect: str) -> Optional[str]:
    """Given an alias appearing in `column.table`, return "schema.table" if it
    refers to a real table; None if it refers to a CTE/subquery or can't be
    resolved at this validator depth."""
    alias_lc = alias.lower()
    for table in tree.find_all(exp.Table):
        local_alias = (table.alias or table.name).lower()
        if local_alias == alias_lc:
            schema_name = (table.db or _default_schema(dialect)).lower()
            full = f"{schema_name}.{table.name.lower()}"
            if full in schema_tables:
                return full
            return None
    return None


if __name__ == "__main__":
    sys.exit(main())
