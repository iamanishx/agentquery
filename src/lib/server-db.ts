import postgres from "postgres";
import type { QueryResult, SchemaColumn } from "@/lib/types";

type Credentials = {
  connectionString?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

const connections = new Map<string, postgres.Sql>();

function getKey(credentials: Credentials) {
  if (credentials.connectionString) return credentials.connectionString;
  return [
    credentials.host,
    credentials.port,
    credentials.database,
    credentials.user,
  ].join(":");
}

export function getConnection(credentials: Credentials) {
  const key = getKey(credentials);
  const existing = connections.get(key);
  if (existing) {
    return existing;
  }

  const client = credentials.connectionString
    ? postgres(credentials.connectionString, {
        max: 1,
        prepare: false,
        idle_timeout: 10,
        connect_timeout: 10,
      })
    : postgres({
        host: credentials.host,
        port: credentials.port,
        database: credentials.database,
        user: credentials.user,
        password: credentials.password,
        max: 1,
        prepare: false,
        idle_timeout: 10,
        connect_timeout: 10,
      });

  connections.set(key, client);
  return client;
}

export function isReadOnlyQuery(query: string) {
  const normalized = query.trim().replace(/^\(+/, "").toLowerCase();
  if (!normalized) {
    return false;
  }
  const forbidden = [
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "truncate",
    "grant",
    "revoke",
    "comment",
    "merge",
    "copy",
    "call",
    "refresh",
  ];
  if (forbidden.some((keyword) => normalized.startsWith(keyword))) {
    return false;
  }
  return normalized.startsWith("select") || normalized.startsWith("with") || normalized.startsWith("values") || normalized.startsWith("show");
}

export async function fetchSchema(credentials: Credentials): Promise<SchemaColumn[]> {
  const sql = getConnection(credentials);
  const rows = await sql<SchemaColumn[]>`
    SELECT
      c.table_schema AS schema,
      c.table_name AS "tableName",
      c.column_name AS "columnName",
      c.data_type AS "dataType",
      (c.is_nullable = 'YES') AS "isNullable"
    FROM information_schema.columns c
    INNER JOIN information_schema.tables t
      ON c.table_schema = t.table_schema
      AND c.table_name = t.table_name
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
  `;
  return rows;
}

export function summarizeSchema(schema: SchemaColumn[]) {
  const grouped = new Map<string, SchemaColumn[]>();
  for (const column of schema) {
    const key = `${column.schema}.${column.tableName}`;
    const current = grouped.get(key) ?? [];
    current.push(column);
    grouped.set(key, current);
  }

  return Array.from(grouped.entries())
    .map(([table, columns]) => {
      const cols = columns
        .map((column) => `${column.columnName} ${column.dataType}${column.isNullable ? "" : " not null"}`)
        .join(", ");
      return `${table}: ${cols}`;
    })
    .join("\n");
}

export async function executeReadOnlyQuery(credentials: Credentials, query: string): Promise<QueryResult> {
  if (!isReadOnlyQuery(query)) {
    throw new Error("Only read-only queries are allowed.");
  }

  const sql = getConnection(credentials);
  const startedAt = Date.now();
  const rows = await sql.unsafe<Record<string, unknown>[]>(query);
  const executionTime = Date.now() - startedAt;
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    columns: safeRows.length > 0 ? Object.keys(safeRows[0]) : [],
    rows: safeRows,
    executionTime,
    rowCount: safeRows.length,
  };
}

export function buildTablePreviewQuery(schema: string, table: string) {
  return `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} LIMIT 5`;
}
