"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  clearAllLocalData,
  listDatabases,
  listMessages,
  listSessions,
  putMessages,
  removeDatabase,
  removeSession,
  upsertDatabase,
  upsertSession,
  getSetting,
  setSetting,
  deleteSetting,
} from "@/lib/storage";
import type {
  ChatMessage,
  ChatSession,
  DatabaseCredential,
  QueryResult,
  QuerySuggestion,
  SchemaColumn,
} from "@/lib/types";

/* ─── types ─────────────────────────────────────────────── */
type AgentResponse = {
  summary: string;
  suggestions: QuerySuggestion[];
  toolCalls: Array<{ toolName: string; input: unknown }>;
};
type ProviderOption = "openai" | "google";
type Modal = "none" | "connection" | "settings" | "results" | "schema" | "query";

const providerModels: Record<ProviderOption, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  google: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
};

/* ─── helpers ───────────────────────────────────────────── */
function credentialsPayload(db: DatabaseCredential) {
  return {
    connectionString: db.connectionString || undefined,
    host: db.host || undefined,
    port: db.port || undefined,
    database: db.database || undefined,
    user: db.user || undefined,
    password: db.password || undefined,
  };
}

function emptyDb(): Omit<DatabaseCredential, "id" | "createdAt" | "updatedAt"> {
  return { name: "", connectionString: "", host: "localhost", port: 5432, database: "", user: "postgres", password: "" };
}

function buildHistoryContent(m: ChatMessage) {
  const parts = [m.content];
  if (m.querySuggestions?.length)
    parts.push("SQL options:\n" + m.querySuggestions.map((s, i) => `${i + 1}. ${s.name}\n${s.sql}`).join("\n\n"));
  if (m.selectedQueryDraft) parts.push(`Executed:\n${m.selectedQueryDraft}`);
  if (m.queryResult) parts.push(`Result: ${m.queryResult.rowCount} rows, ${m.queryResult.executionTime}ms`);
  return parts.join("\n\n");
}

/* ─── icon helpers (inline SVG, no deps) ────────────────── */
function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const PlusIcon = () => <Icon d="M12 5v14M5 12h14" />;
const SettingsIcon = () => <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm6.93-3a6.001 6.001 0 0 0-1.07-3.27l1.41-1.41-1.42-1.42-1.41 1.41A6.001 6.001 0 0 0 13 3.07V1h-2v2.07A6.001 6.001 0 0 0 7.59 6.31L6.17 4.9 4.76 6.31l1.41 1.41A6.001 6.001 0 0 0 5.07 11H3v2h2.07a6.001 6.001 0 0 0 1.07 3.27l-1.41 1.41 1.42 1.42 1.41-1.41A6.001 6.001 0 0 0 11 20.93V23h2v-2.07a6.001 6.001 0 0 0 3.27-1.07l1.41 1.41 1.42-1.42-1.41-1.41A6.001 6.001 0 0 0 18.93 15H21v-2h-2.07z" />;
const CloseIcon = () => <Icon d="M18 6L6 18M6 6l12 12" />;
const TrashIcon = () => <Icon d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" size={14} />;
const SendIcon = () => <Icon d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" size={14} />;
const DBIcon = () => <Icon d="M12 2C7.58 2 4 3.79 4 6v12c0 2.21 3.58 4 8 4s8-1.79 8-4V6c0-2.21-3.58-4-8-4zm0 2c3.87 0 6 1.5 6 2s-2.13 2-6 2-6-1.5-6-2 2.13-2 6-2zm6 14c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23C7.74 17.55 9.76 18 12 18s4.26-.45 6-1.23V18zm0-4c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23C7.74 13.55 9.76 14 12 14s4.26-.45 6-1.23V14zm0-4c0 .5-2.13 2-6 2s-6-1.5-6-2V8.77C7.74 9.55 9.76 10 12 10s4.26-.45 6-1.23V10z" />;

/* ─── component ─────────────────────────────────────────── */
export default function Home() {
  /* state */
  const [databases, setDatabases] = useState<DatabaseCredential[]>([]);
  const [selectedDbId, setSelectedDbId] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [schema, setSchema] = useState<SchemaColumn[]>([]);
  const [schemaError, setSchemaError] = useState("");
  const [manualQuery, setManualQuery] = useState("");
  const [manualQueryResult, setManualQueryResult] = useState<QueryResult | null>(null);
  const [manualQueryLoading, setManualQueryLoading] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeResult, setActiveResult] = useState<QueryResult | null>(null);
  const [editorMsgId, setEditorMsgId] = useState("");
  const [editorSugId, setEditorSugId] = useState("");
  const [editorSql, setEditorSql] = useState("");
  const [provider, setProvider] = useState<ProviderOption>("openai");
  const [model, setModel] = useState(providerModels.openai[0]);
  /* modal state */
  const [modal, setModal] = useState<Modal>("none");
  const [editingDbId, setEditingDbId] = useState("");
  const [connForm, setConnForm] = useState(emptyDb());
  const [useConnStr, setUseConnStr] = useState(false);
  /* api key state — persisted in localStorage */
  const [openaiKey, setOpenaiKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  /* derived */
  const selectedDb = useMemo(() => databases.find((d) => d.id === selectedDbId) ?? null, [databases, selectedDbId]);
  const selectedSession = useMemo(() => sessions.find((s) => s.id === selectedSessionId) ?? null, [sessions, selectedSessionId]);

  /* load keys from IndexedDB on mount */
  useEffect(() => {
    getSetting("openai_key").then((v) => { if (v) setOpenaiKey(v); });
    getSetting("google_key").then((v) => { if (v) setGoogleKey(v); });
  }, []);

  /* persist keys to IndexedDB when changed (including clear on empty) */
  useEffect(() => {
    if (openaiKey === "") deleteSetting("openai_key");
    else setSetting("openai_key", openaiKey);
  }, [openaiKey]);
  useEffect(() => {
    if (googleKey === "") deleteSetting("google_key");
    else setSetting("google_key", googleKey);
  }, [googleKey]);

  /* reset model when provider changes */
  useEffect(() => { setModel(providerModels[provider][0]); }, [provider]);

  /* ── data loading ── */
  const hydrateDbs = useCallback(async () => {
    const all = (await listDatabases()).sort((a, b) => b.updatedAt - a.updatedAt);
    setDatabases(all);
    if (!selectedDbId && all[0]) setSelectedDbId(all[0].id);
  }, [selectedDbId]);

  const hydrateSessions = useCallback(async (dbId: string) => {
    const all = await listSessions(dbId);
    setSessions(all);
    if (!all.find((s) => s.id === selectedSessionId)) setSelectedSessionId(all[0]?.id ?? "");
  }, [selectedSessionId]);

  useEffect(() => { void hydrateDbs(); }, [hydrateDbs]);

  useEffect(() => {
    if (selectedDbId) void hydrateSessions(selectedDbId);
    else { setSessions([]); setSelectedSessionId(""); }
  }, [hydrateSessions, selectedDbId]);

  useEffect(() => {
    if (selectedSessionId) void hydrateMessages(selectedSessionId);
    else setMessages([]);
  }, [selectedSessionId]);

  useEffect(() => {
    if (selectedDb) void loadSchema(selectedDb);
    else { setSchema([]); setSchemaError(""); }
  }, [selectedDb]);

  async function hydrateMessages(sessionId: string) {
    const all = await listMessages(sessionId);
    setMessages(all);
    setActiveResult([...all].reverse().find((m) => m.queryResult)?.queryResult ?? null);
  }

  async function loadSchema(db: DatabaseCredential) {
    try {
      setSchemaError("");
      const res = await fetch("/api/schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: credentialsPayload(db) }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Failed to load schema.");
      setSchema(payload as SchemaColumn[]);
    } catch (e) {
      setSchema([]);
      setSchemaError(e instanceof Error ? e.message : "Failed to load schema.");
    }
  }

  /* ── sessions ── */
  async function createSession() {
    if (!selectedDb) return;
    const s: ChatSession = { id: uuidv4(), dbId: selectedDb.id, title: "New chat", createdAt: Date.now(), updatedAt: Date.now() };
    await upsertSession(s);
    await hydrateSessions(selectedDb.id);
    setSelectedSessionId(s.id);
    setMessages([]);
    setActiveResult(null);
  }

  async function deleteSession(id: string) {
    if (!selectedDb) return;
    await removeSession(id);
    await hydrateSessions(selectedDb.id);
  }

  /* ── connections ── */
  function openAddConn() {
    setEditingDbId("");
    setConnForm(emptyDb());
    setUseConnStr(false);
    setModal("connection");
  }

  function openEditConn(db: DatabaseCredential) {
    setEditingDbId(db.id);
    setConnForm({ name: db.name, connectionString: db.connectionString ?? "", host: db.host ?? "localhost", port: db.port ?? 5432, database: db.database ?? "", user: db.user ?? "postgres", password: db.password ?? "" });
    setUseConnStr(!!(db.connectionString));
    setModal("connection");
  }

  async function saveConn() {
    try {
      const now = Date.now();
      const record: DatabaseCredential = {
        id: editingDbId || uuidv4(),
        createdAt: editingDbId ? (databases.find((d) => d.id === editingDbId)?.createdAt ?? now) : now,
        updatedAt: now,
        name: connForm.name,
        connectionString: useConnStr ? connForm.connectionString : "",
        host: useConnStr ? "" : connForm.host,
        port: useConnStr ? 0 : connForm.port,
        database: useConnStr ? "" : connForm.database,
        user: useConnStr ? "" : connForm.user,
        password: useConnStr ? "" : connForm.password,
      };
      await upsertDatabase(record);
      await hydrateDbs();
      setSelectedDbId(record.id);
      setModal("none");
    } catch (err) {
      console.error("Failed to save connection:", err);
      alert(err instanceof Error ? err.message : "Failed to save connection");
    }
  }

  async function deleteConn(id: string) {
    await removeDatabase(id);
    await hydrateDbs();
    if (selectedDbId === id) {
      const next = (await listDatabases()).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      setSelectedDbId(next?.id ?? "");
    }
  }

  async function wipeData() {
    await clearAllLocalData();
    setDatabases([]); setSessions([]); setMessages([]); setSchema([]);
    setSelectedDbId(""); setSelectedSessionId(""); setActiveResult(null);
  }

  /* ── messaging ── */
  async function persistMessages(next: ChatMessage[]) {
    setMessages(next);
    await putMessages(next);
  }

  async function sendPrompt() {
    if (!input.trim() || !selectedDb || !selectedSession || busy) return;
    const prompt = input.trim();
    const userMsg: ChatMessage = { id: uuidv4(), sessionId: selectedSession.id, role: "user", content: prompt, createdAt: Date.now() };
    const base = [...messages, userMsg];
    setInput("");
    setBusy(true);
    await persistMessages(base);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider, model,
          credentials: credentialsPayload(selectedDb),
          apiKeys: { openai: openaiKey || undefined, google: googleKey || undefined },
          prompt,
          history: messages.map((m) => ({ role: m.role, content: buildHistoryContent(m) })),
        }),
      });
      const payload = (await res.json()) as AgentResponse | { error: string };
      if (!res.ok || "error" in payload) throw new Error("error" in payload ? payload.error : "Failed.");
      const aMsg: ChatMessage = {
        id: uuidv4(), sessionId: selectedSession.id, role: "assistant",
        content: payload.summary,
        createdAt: Date.now(),
        querySuggestions: payload.suggestions,
        agentProvider: provider, agentModel: model,
      };
      const next = [...base, aMsg];
      await persistMessages(next);
      await upsertSession({ ...selectedSession, title: prompt.slice(0, 50), updatedAt: aMsg.createdAt });
      await hydrateSessions(selectedDb.id);
    } catch (e) {
      const errMsg: ChatMessage = { id: uuidv4(), sessionId: selectedSession.id, role: "assistant", content: e instanceof Error ? e.message : "Error", createdAt: Date.now() };
      await persistMessages([...base, errMsg]);
    } finally { setBusy(false); }
  }

  async function runQuery(msgId: string, suggestion: QuerySuggestion, override?: string) {
    if (!selectedDb || !selectedSession || busy) return;
    const sql = (override ?? suggestion.sql).trim();
    if (!sql) return;
    setBusy(true);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: credentialsPayload(selectedDb), query: sql }),
      });
      const payload = (await res.json()) as QueryResult | { error: string };
      if (!res.ok || "error" in payload) throw new Error("error" in payload ? payload.error : "Query failed.");
      const next = messages.map((m) => m.id !== msgId ? m : { ...m, selectedQueryId: suggestion.id, selectedQueryDraft: sql, queryResult: payload as QueryResult });
      await persistMessages(next);
      setActiveResult(payload as QueryResult);
      setEditorMsgId(""); setEditorSql("");
    } catch (e) {
      const errMsg: ChatMessage = { id: uuidv4(), sessionId: selectedSession.id, role: "assistant", content: e instanceof Error ? e.message : "Query failed.", createdAt: Date.now() };
      await persistMessages([...messages, errMsg]);
    } finally { setBusy(false); }
  }

  function openEditor(msgId: string, sql: string) {
    setEditorMsgId(msgId);
    const sug = messages.find((m) => m.id === msgId)?.querySuggestions?.find((s) => s.sql === sql);
    setEditorSugId(sug?.id ?? "");
    setEditorSql(sql);
  }

  /* ── chart helpers ── */
  const numericCols = useMemo(() => {
    const rows = activeResult?.rows ?? [];
    const cols = activeResult?.columns ?? [];
    if (!rows.length) return [];
    return cols.filter((c) => typeof rows[0]?.[c] === "number").slice(0, 3);
  }, [activeResult]);

  const chartRows = useMemo(() => (activeResult?.rows ?? []).slice(0, 14).map((r, i) => ({ label: String(i + 1), ...r })), [activeResult]);

  const schemaGroups = useMemo(() => {
    const g = new Map<string, SchemaColumn[]>();
    for (const col of schema) {
      const k = `${col.schema}.${col.tableName}`;
      g.set(k, [...(g.get(k) ?? []), col]);
    }
    return Array.from(g.entries());
  }, [schema]);

  const apiKeyMissing = (provider === "openai" && !openaiKey) || (provider === "google" && !googleKey);
  const chartColors = ["#171717", "#71717a", "#d4d4d8"];

  function exportCsv() {
    if (!activeResult) return;
    const header = activeResult.columns.join(",");
    const rows = activeResult.rows.map((row) =>
      activeResult.columns
        .map((col) => {
          const val = String(row[col] ?? "");
          return val.includes(",") || val.includes('"') || val.includes("\n")
            ? `"${val.replace(/"/g, '""')}"`
            : val;
        })
        .join(","),
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query-result-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ═══════════════════════════════════════════════════════ */
  return (
    <div className="min-h-screen bg-white text-neutral-900 antialiased">
      {/* ── top bar ──────────────────────────────────────── */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-neutral-100 bg-white px-6">
        <div className="flex items-center gap-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900 text-white">
            <DBIcon />
          </span>
          <span className="text-sm font-bold tracking-tight">AgentQuery</span>
          <span className="hidden text-xs text-neutral-400 sm:block">PostgreSQL · read-only AI</span>
        </div>
        <div className="flex items-center gap-2">
          {apiKeyMissing && (
            <button
              onClick={() => setModal("settings")}
              className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 transition-colors"
            >
              <span>⚠</span> Add API key
            </button>
          )}
          <button
            onClick={() => setModal("settings")}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 transition-colors"
            title="Settings / API keys"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      <div className="flex h-[calc(100vh-56px)]">
        {/* ── sidebar ──────────────────────────────────── */}
        <aside className="flex w-64 flex-col border-r border-neutral-100 bg-neutral-50/60 overflow-hidden shrink-0">
          {/* database selector */}
          <div className="border-b border-neutral-100 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">Database</span>
              <button onClick={openAddConn} className="flex items-center gap-1 text-[11px] font-semibold text-neutral-600 hover:text-neutral-900">
                <PlusIcon /> Add
              </button>
            </div>
            <div className="relative">
              <select
                value={selectedDbId}
                onChange={(e) => setSelectedDbId(e.target.value)}
                className="w-full appearance-none rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-800 outline-none focus:border-neutral-400 focus:ring-2 focus:ring-neutral-100 transition-shadow cursor-pointer"
              >
                <option value="">Select a connection…</option>
                {databases.map((db) => (
                  <option key={db.id} value={db.id}>{db.name}</option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400">▾</span>
            </div>
            {selectedDb && (
              <div className="mt-2 flex items-center justify-between">
                <p className="truncate text-[11px] text-neutral-400">
                  {selectedDb.connectionString ? "connection string" : `${selectedDb.host}:${selectedDb.port}`}
                </p>
                <button onClick={() => openEditConn(selectedDb)} className="text-[11px] font-medium text-neutral-400 hover:text-neutral-700">
                  Edit
                </button>
              </div>
            )}
          </div>

          {/* sessions */}
          <div className="flex flex-1 flex-col overflow-hidden p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">Sessions</span>
              <button
                onClick={() => void createSession()}
                disabled={!selectedDb}
                className="flex items-center gap-1 text-[11px] font-semibold text-neutral-600 hover:text-neutral-900 disabled:opacity-30"
              >
                <PlusIcon /> New
              </button>
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto pr-1">
              {!sessions.length && (
                <p className="py-4 text-center text-xs text-neutral-400">No sessions yet.</p>
              )}
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSessionId(s.id)}
                  className={`group w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                    s.id === selectedSessionId
                      ? "bg-neutral-900 text-white"
                      : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 font-medium">{s.title}</span>
                    <span
                      onClick={(e) => { e.stopPropagation(); void deleteSession(s.id); }}
                      className={`shrink-0 opacity-0 transition-opacity group-hover:opacity-100 ${s.id === selectedSessionId ? "text-neutral-400 hover:text-white" : "text-neutral-400 hover:text-red-500"}`}
                    >
                      <TrashIcon />
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* schema */}
          <div className="border-t border-neutral-100 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">Schema</span>
              <div className="flex gap-2">
                <button
                  onClick={() => selectedDb && void loadSchema(selectedDb)}
                  disabled={!selectedDb}
                  className="text-[11px] font-medium text-neutral-400 hover:text-neutral-700 disabled:opacity-30"
                  title="Refresh schema"
                >
                  ↻
                </button>
                <button
                  onClick={() => setModal("schema")}
                  disabled={!selectedDb || !schemaGroups.length}
                  className="text-[11px] font-medium text-neutral-400 hover:text-neutral-700 disabled:opacity-30"
                  title="Expand schema view"
                >
                  ⤢
                </button>
              </div>
            </div>
            <div className="max-h-32 space-y-2 overflow-y-auto text-xs">
              {schemaError && <p className="text-red-500">{schemaError}</p>}
              {!schemaError && !schemaGroups.length && <p className="text-neutral-400">Not loaded.</p>}
              {schemaGroups.slice(0, 5).map(([key, cols]) => (
                <div key={key}>
                  <p className="font-bold text-neutral-700">{key}</p>
                  <p className="mt-0.5 leading-relaxed text-neutral-400">
                    {cols.map((c) => c.columnName).join(", ")}
                  </p>
                </div>
              ))}
              {schemaGroups.length > 5 && (
                <p className="text-neutral-400 italic">+{schemaGroups.length - 5} more tables</p>
              )}
            </div>
            <button
              onClick={() => setModal("query")}
              disabled={!selectedDb}
              className="mt-3 w-full rounded-md border border-neutral-200 bg-white py-1.5 text-[11px] font-semibold text-neutral-600 hover:bg-neutral-50 disabled:opacity-30"
            >
              + Run Query
            </button>
          </div>

          <div className="border-t border-neutral-100 p-3">
            <button
              onClick={() => void wipeData()}
              className="w-full rounded-md py-1.5 text-[11px] font-semibold text-neutral-400 hover:text-red-500 transition-colors"
            >
              Clear all data
            </button>
          </div>
        </aside>

        {/* ── main ─────────────────────────────────────── */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 gap-0 overflow-hidden">
            {/* chat pane */}
            <div className="flex flex-1 flex-col border-r border-neutral-100 overflow-hidden">
              {/* chat header */}
              <div className="flex items-center gap-4 border-b border-neutral-100 px-5 py-3">
                <div className="flex-1">
                  <h2 className="text-sm font-bold text-neutral-900">
                    {selectedSession ? selectedSession.title : "Query Generator"}
                  </h2>
                  <p className="text-[11px] text-neutral-400">AI inspects your schema and proposes read-only SQL options</p>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <label className="flex items-center gap-1.5 font-medium text-neutral-500">
                    <span className="text-[10px] uppercase tracking-widest">Provider</span>
                    <select
                      value={provider}
                      onChange={(e) => setProvider(e.target.value as ProviderOption)}
                      className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs font-semibold text-neutral-800 outline-none focus:border-neutral-400"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="google">Google Gemini</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 font-medium text-neutral-500">
                    <span className="text-[10px] uppercase tracking-widest">Model</span>
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs font-semibold text-neutral-800 outline-none focus:border-neutral-400"
                    >
                      {providerModels[provider].map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              {/* messages */}
              <div className="flex-1 space-y-5 overflow-y-auto p-5">
                {!selectedSession && (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-400">
                    <DBIcon />
                    <p className="text-sm font-medium">Select a database and start a session.</p>
                  </div>
                )}

                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[78%] space-y-3 ${msg.role === "user" ? "items-end" : "items-start"} flex flex-col`}>
                      {/* bubble */}
                      <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "rounded-tr-sm bg-neutral-900 text-white"
                          : "rounded-tl-sm border border-neutral-200 bg-white text-neutral-800 shadow-sm"
                      }`}>
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                        {msg.agentModel && (
                          <p className={`mt-2 text-[10px] font-medium ${msg.role === "user" ? "text-neutral-400" : "text-neutral-400"}`}>
                            {msg.agentProvider} / {msg.agentModel}
                          </p>
                        )}
                      </div>

                      {/* suggestions */}
                      {msg.querySuggestions?.map((sug) => (
                        <div key={sug.id} className="w-full rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
                          <div className="flex items-start justify-between gap-3 p-4 pb-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold text-neutral-900">{sug.name}</p>
                              <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{sug.rationale}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                onClick={() => openEditor(msg.id, sug.sql)}
                                className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-50 transition-colors"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => void runQuery(msg.id, sug)}
                                disabled={busy}
                                className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-neutral-700 disabled:opacity-40 transition-colors"
                              >
                                Run
                              </button>
                            </div>
                          </div>
                          <div className="border-t border-neutral-100 bg-neutral-50 px-4 py-3">
                            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-neutral-700">{sug.sql}</pre>
                          </div>
                        </div>
                      ))}

                      {/* executed query badge */}
                      {msg.selectedQueryDraft && (
                        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          <p className="text-[11px] font-semibold text-neutral-500">Query executed</p>
                          {msg.queryResult && (
                            <p className="text-[11px] text-neutral-400">
                              · {msg.queryResult.rowCount} rows · {msg.queryResult.executionTime}ms
                            </p>
                          )}
                        </div>
                      )}

                      {/* inline editor */}
                      {editorMsgId === msg.id && (
                        <div className="w-full rounded-xl border border-neutral-300 bg-white shadow-lg overflow-hidden">
                          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5">
                            <p className="text-xs font-bold uppercase tracking-widest text-neutral-500">Edit SQL</p>
                            <button onClick={() => { setEditorMsgId(""); setEditorSql(""); }} className="text-neutral-400 hover:text-neutral-700">
                              <CloseIcon />
                            </button>
                          </div>
                          <div className="p-4">
                            <textarea
                              value={editorSql}
                              onChange={(e) => setEditorSql(e.target.value)}
                              rows={7}
                              className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 font-mono text-sm text-neutral-800 outline-none focus:border-neutral-400 focus:ring-2 focus:ring-neutral-100"
                            />
                            <div className="mt-3 flex items-center gap-2">
                              <button
                                onClick={() => {
                                  const target = msg.querySuggestions?.find((s) => s.id === editorSugId) ?? msg.querySuggestions?.[0];
                                  if (target) void runQuery(msg.id, target, editorSql);
                                }}
                                disabled={busy}
                                className="rounded-md bg-neutral-900 px-4 py-2 text-xs font-bold text-white hover:bg-neutral-700 disabled:opacity-40"
                              >
                                Execute
                              </button>
                              <button
                                onClick={() => { setEditorMsgId(""); setEditorSql(""); }}
                                className="rounded-md border border-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-600 hover:bg-neutral-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {busy && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl rounded-tl-sm border border-neutral-200 bg-white px-4 py-3 shadow-sm">
                      <div className="flex items-center gap-2 text-xs text-neutral-400 font-medium">
                        <span className="inline-flex gap-1">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:0ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:150ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:300ms]" />
                        </span>
                        Thinking…
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* input */}
              <div className="border-t border-neutral-100 bg-white p-4">
                {apiKeyMissing && (
                  <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-100 bg-amber-50 px-3 py-2">
                    <p className="text-xs font-semibold text-amber-700">
                      No {provider === "openai" ? "OpenAI" : "Google"} API key set.
                    </p>
                    <button onClick={() => setModal("settings")} className="text-xs font-bold text-amber-700 underline">
                      Add key →
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm focus-within:border-neutral-400 focus-within:ring-2 focus-within:ring-neutral-100 transition-all">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendPrompt(); } }}
                    rows={2}
                    placeholder="Ask a question like 'show signups by country this month'…"
                    disabled={!selectedSession}
                    className="flex-1 resize-none bg-transparent text-sm text-neutral-800 outline-none placeholder:text-neutral-400 disabled:opacity-40"
                  />
                  <button
                    onClick={() => void sendPrompt()}
                    disabled={!selectedSession || !selectedDb || busy || !input.trim()}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-30 transition-colors"
                  >
                    <SendIcon />
                  </button>
                </div>
                <p className="mt-1.5 px-1 text-[10px] text-neutral-400">Enter to send · Shift+Enter for new line · read-only queries only</p>
              </div>
            </div>

            {/* results pane */}
            <div className="flex w-[380px] shrink-0 flex-col overflow-hidden">
              {/* stats */}
              <div className="border-b border-neutral-100 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">Last Result</p>
                  {activeResult && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={exportCsv}
                        className="flex items-center gap-1 text-[11px] font-semibold text-neutral-500 hover:text-neutral-900 transition-colors"
                        title="Export CSV"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        CSV
                      </button>
                      <button
                        onClick={() => setModal("results")}
                        className="flex items-center gap-1 text-[11px] font-semibold text-neutral-500 hover:text-neutral-900 transition-colors"
                        title="Expand full view"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                        Expand
                      </button>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Rows", value: activeResult?.rowCount ?? "—" },
                    { label: "Cols", value: activeResult?.columns.length ?? "—" },
                    { label: "Time", value: activeResult ? `${activeResult.executionTime}ms` : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} className="rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2.5 text-center">
                      <p className="text-[10px] font-bold uppercase text-neutral-400">{label}</p>
                      <p className="mt-0.5 text-base font-bold text-neutral-900">{value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* chart */}
              <div className="border-b border-neutral-100 p-4">
                <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-neutral-400">Chart</p>
                {activeResult && numericCols.length ? (
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartRows} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f4f4f5" />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#a1a1aa", fontSize: 10 }} dy={6} />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: "#a1a1aa", fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: "#fff", border: "1px solid #e4e4e7", borderRadius: 8, fontSize: 12 }}
                          itemStyle={{ color: "#171717", fontWeight: 600 }}
                        />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                        {numericCols.map((col, i) => (
                          <Bar key={col} dataKey={col} fill={chartColors[i % chartColors.length]} radius={[3, 3, 0, 0]} maxBarSize={32} />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-neutral-200 text-xs font-medium text-neutral-400">
                    Run a query to see a chart.
                  </div>
                )}
              </div>

              {/* data grid */}
              <div className="flex flex-1 flex-col overflow-hidden p-4">
                <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-neutral-400">Data Grid</p>
                <div className="flex-1 overflow-auto rounded-lg border border-neutral-100">
                  {activeResult?.rows.length ? (
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="sticky top-0 bg-neutral-50">
                        <tr>
                          {activeResult.columns.map((col) => (
                            <th key={col} className="whitespace-nowrap border-b border-neutral-200 px-3 py-2 font-bold text-neutral-600">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-50">
                        {activeResult.rows.map((row, ri) => (
                          <tr key={ri} className="hover:bg-neutral-50 transition-colors">
                            {activeResult.columns.map((col) => (
                              <td key={`${ri}-${col}`} className="max-w-[160px] truncate px-3 py-2 text-neutral-700">
                                {String(row[col] ?? "")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs font-medium text-neutral-400">
                      No data.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* ══ MODAL: Expanded Results ════════════════════════ */}
      {modal === "results" && activeResult && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          {/* header */}
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-100 px-6">
            <div className="flex items-center gap-4">
              <p className="text-sm font-bold text-neutral-900">Query Results</p>
              <div className="flex items-center gap-3 text-xs text-neutral-500">
                <span className="rounded-md bg-neutral-100 px-2 py-1 font-semibold">{activeResult.rowCount} rows</span>
                <span className="rounded-md bg-neutral-100 px-2 py-1 font-semibold">{activeResult.columns.length} cols</span>
                <span className="rounded-md bg-neutral-100 px-2 py-1 font-semibold">{activeResult.executionTime}ms</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={exportCsv}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export CSV
              </button>
              <button
                onClick={() => setModal("none")}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 hover:bg-neutral-50 transition-colors"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          {/* body: chart + grid side by side when numeric cols exist, otherwise full grid */}
          <div className="flex flex-1 overflow-hidden">
            {/* chart panel — only shown when numeric data exists */}
            {numericCols.length > 0 && (
              <div className="flex w-[380px] shrink-0 flex-col border-r border-neutral-100 p-5">
                <p className="mb-4 text-[10px] font-bold uppercase tracking-widest text-neutral-400">Chart</p>
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartRows} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f4f4f5" />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#a1a1aa", fontSize: 11 }} dy={6} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "#a1a1aa", fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#fff", border: "1px solid #e4e4e7", borderRadius: 8, fontSize: 12 }}
                        itemStyle={{ color: "#171717", fontWeight: 600 }}
                      />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
                      {numericCols.map((col, i) => (
                        <Bar key={col} dataKey={col} fill={chartColors[i % chartColors.length]} radius={[3, 3, 0, 0]} maxBarSize={40} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* full data grid */}
            <div className="flex flex-1 flex-col overflow-hidden p-5">
              <p className="mb-4 text-[10px] font-bold uppercase tracking-widest text-neutral-400">Data Grid</p>
              <div className="flex-1 overflow-auto rounded-xl border border-neutral-100">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-neutral-50 shadow-[0_1px_0_#e5e7eb]">
                    <tr>
                      {activeResult.columns.map((col) => (
                        <th key={col} className="whitespace-nowrap px-4 py-3 text-xs font-bold text-neutral-600">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeResult.rows.map((row, ri) => (
                      <tr key={ri} className={`border-t border-neutral-50 hover:bg-neutral-50 transition-colors ${ri % 2 === 0 ? "" : "bg-neutral-50/40"}`}>
                        {activeResult.columns.map((col) => (
                          <td key={`${ri}-${col}`} className="px-4 py-2.5 text-neutral-700">
                            {String(row[col] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL: Expanded Schema ════════════════════════ */}
      {modal === "schema" && (
        <ModalBackdrop onClose={() => setModal("none")}>
          <div className="flex h-[80vh] w-full max-w-4xl flex-col">
            <ModalHeader title="Database Schema" onClose={() => setModal("none")} />
            <div className="flex-1 overflow-y-auto p-4">
              {schemaError && <p className="text-red-500">{schemaError}</p>}
              {!schemaError && !schemaGroups.length && <p className="text-neutral-400">No schema loaded.</p>}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {schemaGroups.map(([tableName, cols]) => (
                  <div key={tableName} className="rounded-lg border border-neutral-200 p-3">
                    <p className="mb-2 font-bold text-neutral-800">{tableName}</p>
                    <div className="space-y-1">
                      {cols.map((c) => (
                        <div key={c.columnName} className="flex items-center justify-between text-xs">
                          <span className="font-mono text-neutral-600">{c.columnName}</span>
                          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-400">{c.dataType}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ModalBackdrop>
      )}

      {/* ══ MODAL: Manual Query ════════════════════════════ */}
      {modal === "query" && (
        <ModalBackdrop onClose={() => { setModal("none"); setManualQuery(""); setManualQueryResult(null); }}>
          <div className="flex h-[80vh] w-full max-w-4xl flex-col">
            <ModalHeader title="Run SQL Query" onClose={() => { setModal("none"); setManualQuery(""); setManualQueryResult(null); }} />
            <div className="flex flex-1 flex-col gap-4 p-4 overflow-hidden">
              <div className="flex shrink-0 items-center gap-2">
                <textarea
                  value={manualQuery}
                  onChange={(e) => setManualQuery(e.target.value)}
                  placeholder="SELECT * FROM table_name LIMIT 100;"
                  className="flex-1 resize-none rounded-lg border border-neutral-200 p-3 font-mono text-sm focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-100"
                  rows={4}
                  spellCheck={false}
                />
              </div>
              <div className="flex shrink-0 items-center justify-between">
                <button
                  onClick={async () => {
                    if (!selectedDb || !manualQuery.trim()) return;
                    setManualQueryLoading(true);
                    try {
                      const res = await fetch("/api/query", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          credentials: credentialsPayload(selectedDb),
                          sql: manualQuery.trim(),
                        }),
                      });
                      const data = await res.json();
                      if (!res.ok || data.error) throw new Error(data.error || "Query failed");
                      setManualQueryResult(data);
                    } catch (err) {
                      alert(err instanceof Error ? err.message : "Query failed");
                    } finally {
                      setManualQueryLoading(false);
                    }
                  }}
                  disabled={!selectedDb || !manualQuery.trim() || manualQueryLoading}
                  className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {manualQueryLoading ? "Running..." : "Run Query"}
                </button>
                {manualQueryResult && (
                  <span className="text-xs text-neutral-500">
                    {manualQueryResult.rowCount} rows · {manualQueryResult.executionTime}ms
                  </span>
                )}
              </div>
              {manualQueryResult && (
                <div className="flex-1 overflow-auto rounded-lg border border-neutral-200">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="sticky top-0 bg-neutral-50">
                      <tr>
                        {manualQueryResult.columns.map((col) => (
                          <th key={col} className="border-b border-neutral-200 px-3 py-2 font-semibold text-neutral-600">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {manualQueryResult.rows.map((row, i) => (
                        <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-neutral-50/50"}>
                          {manualQueryResult.columns.map((col) => (
                            <td key={col} className="border-b border-neutral-100 px-3 py-2 text-neutral-700">
                              {row[col] === null ? <span className="text-neutral-400 italic">null</span> : String(row[col])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </ModalBackdrop>
      )}

      {/* ══ MODAL: Connection ══════════════════════════════ */}
      {modal === "connection" && (
        <ModalBackdrop onClose={() => { setModal("none"); setEditingDbId(""); }}>
          <div className="w-full max-w-md">
            <ModalHeader
              title={editingDbId ? "Edit connection" : "New connection"}
              onClose={() => { setModal("none"); setEditingDbId(""); }}
            />
            <div className="mt-5 space-y-4">
              <Field label="Name">
                <input
                  value={connForm.name}
                  onChange={(e) => setConnForm({ ...connForm, name: e.target.value })}
                  placeholder="e.g. Production DB"
                  className={inputCls}
                />
              </Field>

              {/* tabs */}
              <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
                <TabBtn active={!useConnStr} onClick={() => setUseConnStr(false)}>Fields</TabBtn>
                <TabBtn active={useConnStr} onClick={() => setUseConnStr(true)}>Connection String</TabBtn>
              </div>

              {useConnStr ? (
                <Field label="Connection URL">
                  <input
                    value={connForm.connectionString ?? ""}
                    onChange={(e) => setConnForm({ ...connForm, connectionString: e.target.value })}
                    placeholder="postgresql://user:pass@host:5432/dbname"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Host" wide>
                    <input value={connForm.host} onChange={(e) => setConnForm({ ...connForm, host: e.target.value })} placeholder="localhost" className={inputCls} />
                  </Field>
                  <Field label="Port">
                    <input type="number" value={connForm.port} onChange={(e) => setConnForm({ ...connForm, port: Number(e.target.value) })} placeholder="5432" className={inputCls} />
                  </Field>
                  <Field label="Database" wide>
                    <input value={connForm.database} onChange={(e) => setConnForm({ ...connForm, database: e.target.value })} placeholder="postgres" className={inputCls} />
                  </Field>
                  <Field label="User">
                    <input value={connForm.user} onChange={(e) => setConnForm({ ...connForm, user: e.target.value })} placeholder="postgres" className={inputCls} />
                  </Field>
                  <Field label="Password">
                    <input type="password" value={connForm.password} onChange={(e) => setConnForm({ ...connForm, password: e.target.value })} placeholder="••••••••" className={inputCls} />
                  </Field>
                </div>
              )}
            </div>
            <ModalFooter>
              <button onClick={() => { setModal("none"); setEditingDbId(""); }} className={secondaryCls}>Cancel</button>
              <button onClick={() => void saveConn()} disabled={!connForm.name.trim()} className={primaryCls}>
                Save connection
              </button>
            </ModalFooter>
          </div>
        </ModalBackdrop>
      )}

      {/* ══ MODAL: Settings / API Keys ═════════════════════ */}
      {modal === "settings" && (
        <ModalBackdrop onClose={() => setModal("none")}>
          <div className="w-full max-w-md">
            <ModalHeader title="Settings" onClose={() => setModal("none")} />
            <div className="mt-5 space-y-5">
              <div>
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-neutral-500">AI API Keys</p>
                <p className="mb-4 text-xs leading-relaxed text-neutral-500">
                  Keys are stored in <strong>IndexedDB</strong> — they persist across page refreshes and are never sent anywhere except the AI provider.
                </p>
                <div className="space-y-3">
                  <KeyField
                    label="OpenAI API Key"
                    placeholder="sk-..."
                    value={openaiKey}
                    onChange={setOpenaiKey}
                    show={!!showKeys["openai"]}
                    onToggleShow={() => setShowKeys((p) => ({ ...p, openai: !p.openai }))}
                  />
                  <KeyField
                    label="Google Gemini API Key"
                    placeholder="AIza..."
                    value={googleKey}
                    onChange={setGoogleKey}
                    show={!!showKeys["google"]}
                    onToggleShow={() => setShowKeys((p) => ({ ...p, google: !p.google }))}
                  />
                </div>
              </div>

              <div className="border-t border-neutral-100 pt-4">
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-neutral-500">Saved Connections</p>
                {databases.length === 0 && <p className="text-xs text-neutral-400">No connections yet.</p>}
                <div className="space-y-2">
                  {databases.map((db) => (
                    <div key={db.id} className="flex items-center justify-between rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2.5">
                      <div>
                        <p className="text-sm font-semibold text-neutral-800">{db.name}</p>
                        <p className="text-[11px] text-neutral-400">
                          {db.connectionString ? "Connection string" : `${db.host}:${db.port} / ${db.database}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button onClick={() => { openEditConn(db); }} className="text-xs font-semibold text-neutral-500 hover:text-neutral-800">Edit</button>
                        <button onClick={() => void deleteConn(db.id)} className="text-xs font-semibold text-red-400 hover:text-red-600">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={openAddConn} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-200 py-2 text-xs font-semibold text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 transition-colors">
                  <PlusIcon /> Add connection
                </button>
              </div>

              <div className="border-t border-neutral-100 pt-4">
                <button onClick={() => { void wipeData(); setModal("none"); }} className="w-full rounded-lg border border-red-100 bg-red-50 py-2 text-xs font-bold text-red-500 hover:bg-red-100 transition-colors">
                  Clear all local data
                </button>
              </div>
            </div>
            <ModalFooter>
              <button onClick={() => setModal("none")} className={primaryCls}>Done</button>
            </ModalFooter>
          </div>
        </ModalBackdrop>
      )}
    </div>
  );
}

/* ─── small shared UI primitives ───────────────────────── */
const inputCls = "w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-neutral-400 focus:ring-2 focus:ring-neutral-100 transition-shadow";
const primaryCls = "rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-bold text-white hover:bg-neutral-700 disabled:opacity-30 transition-colors";
const secondaryCls = "rounded-lg border border-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-600 hover:bg-neutral-50 transition-colors";

function ModalBackdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-black/5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-lg font-bold text-neutral-900">{title}</h3>
      <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 transition-colors">
        <CloseIcon />
      </button>
    </div>
  );
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex justify-end gap-2">{children}</div>;
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`block ${wide ? "col-span-2" : ""}`}>
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md py-1.5 text-xs font-bold transition-colors ${active ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700"}`}
    >
      {children}
    </button>
  );
}

function KeyField({ label, placeholder, value, onChange, show, onToggleShow }: {
  label: string; placeholder: string; value: string;
  onChange: (v: string) => void; show: boolean; onToggleShow: () => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-neutral-500">{label}</span>
      <div className="flex gap-2">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${inputCls} flex-1 font-mono text-xs`}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="shrink-0 rounded-lg border border-neutral-200 px-3 text-xs font-semibold text-neutral-500 hover:bg-neutral-50"
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
      {value && <p className="mt-1 text-[10px] text-green-600 font-medium">✓ Key set</p>}
    </label>
  );
}
