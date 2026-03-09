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
} from "@/lib/storage";
import type {
  ChatMessage,
  ChatSession,
  DatabaseCredential,
  QueryResult,
  QuerySuggestion,
  SchemaColumn,
} from "@/lib/types";

type ViewMode = "workspace" | "connections";

type AgentResponse = {
  summary: string;
  suggestions: QuerySuggestion[];
  toolCalls: Array<{ toolName: string; input: unknown }>;
};

type ProviderOption = "openai" | "google";

const providerModels: Record<ProviderOption, string[]> = {
  openai: ["gpt-5-mini", "gpt-4.1-mini"],
  google: ["gemini-2.5-flash", "gemini-2.5-pro"],
};

const chartColors = ["#2563eb", "#f97316", "#14b8a6"];

function credentialsPayload(database: DatabaseCredential) {
  return {
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
  };
}

function createEmptyDatabase(): Omit<DatabaseCredential, "id" | "createdAt" | "updatedAt"> {
  return {
    name: "",
    host: "localhost",
    port: 5432,
    database: "",
    user: "postgres",
    password: "",
  };
}

function formatToolCalls(toolCalls: AgentResponse["toolCalls"]) {
  if (!toolCalls.length) {
    return "I inspected the schema to prepare a few query options.";
  }
  return `Tools used: ${toolCalls.map((call) => call.toolName).join(", ")}.`;
}

function buildHistoryContent(message: ChatMessage) {
  const sections = [message.content];
  if (message.querySuggestions?.length) {
    sections.push(
      "Proposed SQL options:\n" +
        message.querySuggestions
          .map(
            (suggestion, index) =>
              `${index + 1}. ${suggestion.name}\n${suggestion.sql}\nWhy: ${suggestion.rationale}`,
          )
          .join("\n\n"),
    );
  }
  if (message.selectedQueryDraft) {
    sections.push(`Selected query:\n${message.selectedQueryDraft}`);
  }
  if (message.queryResult) {
    sections.push(
      `Last result summary: ${message.queryResult.rowCount} rows, ${message.queryResult.columns.length} columns, ${message.queryResult.executionTime}ms.`,
    );
  }
  return sections.join("\n\n");
}

export default function Home() {
  const [viewMode, setViewMode] = useState<ViewMode>("workspace");
  const [databases, setDatabases] = useState<DatabaseCredential[]>([]);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string>("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [schema, setSchema] = useState<SchemaColumn[]>([]);
  const [schemaError, setSchemaError] = useState<string>("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeResult, setActiveResult] = useState<QueryResult | null>(null);
  const [editorMessageId, setEditorMessageId] = useState<string>("");
  const [editorSuggestionId, setEditorSuggestionId] = useState<string>("");
  const [editorSql, setEditorSql] = useState("");
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [editingDatabaseId, setEditingDatabaseId] = useState<string>("");
  const [connectionForm, setConnectionForm] = useState(createEmptyDatabase());
  const [provider, setProvider] = useState<ProviderOption>("openai");
  const [model, setModel] = useState<string>(providerModels.openai[0]);

  const selectedDatabase = useMemo(
    () => databases.find((database) => database.id === selectedDatabaseId) ?? null,
    [databases, selectedDatabaseId],
  );

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const hydrateDatabases = useCallback(async () => {
    const all = await listDatabases();
    const sorted = all.sort((a, b) => b.updatedAt - a.updatedAt);
    setDatabases(sorted);
    if (!selectedDatabaseId && sorted[0]) {
      setSelectedDatabaseId(sorted[0].id);
    }
  }, [selectedDatabaseId]);

  const hydrateSessions = useCallback(
    async (dbId: string) => {
      const all = await listSessions(dbId);
      setSessions(all);
      if (!all.find((session) => session.id === selectedSessionId)) {
        setSelectedSessionId(all[0]?.id ?? "");
      }
    },
    [selectedSessionId],
  );

  useEffect(() => {
    void hydrateDatabases();
  }, [hydrateDatabases]);

  useEffect(() => {
    setModel(providerModels[provider][0]);
  }, [provider]);

  useEffect(() => {
    if (selectedDatabaseId) {
      void hydrateSessions(selectedDatabaseId);
    } else {
      setSessions([]);
      setSelectedSessionId("");
    }
  }, [hydrateSessions, selectedDatabaseId]);

  useEffect(() => {
    if (selectedSessionId) {
      void hydrateMessages(selectedSessionId);
    } else {
      setMessages([]);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    if (selectedDatabase) {
      void loadSchema(selectedDatabase);
    } else {
      setSchema([]);
      setSchemaError("");
    }
  }, [selectedDatabase]);

  async function hydrateMessages(sessionId: string) {
    const all = await listMessages(sessionId);
    setMessages(all);
    const latest = [...all].reverse().find((message) => message.queryResult)?.queryResult ?? null;
    setActiveResult(latest);
  }

  async function loadSchema(database: DatabaseCredential) {
    try {
      setSchemaError("");
      const response = await fetch("/api/schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: credentialsPayload(database),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load schema.");
      }
      setSchema(payload as SchemaColumn[]);
    } catch (error) {
      setSchema([]);
      setSchemaError(error instanceof Error ? error.message : "Failed to load schema.");
    }
  }

  async function createSession() {
    if (!selectedDatabase) {
      return;
    }
    const session: ChatSession = {
      id: uuidv4(),
      dbId: selectedDatabase.id,
      title: "New exploration",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await upsertSession(session);
    await hydrateSessions(selectedDatabase.id);
    setSelectedSessionId(session.id);
    setMessages([]);
    setActiveResult(null);
  }

  async function saveConnection() {
    const now = Date.now();
    const record: DatabaseCredential = {
      id: editingDatabaseId || uuidv4(),
      createdAt: editingDatabaseId
        ? databases.find((database) => database.id === editingDatabaseId)?.createdAt ?? now
        : now,
      updatedAt: now,
      ...connectionForm,
    };
    await upsertDatabase(record);
    await hydrateDatabases();
    setSelectedDatabaseId(record.id);
    setShowConnectionForm(false);
    setEditingDatabaseId("");
    setConnectionForm(createEmptyDatabase());
  }

  async function deleteConnection(id: string) {
    await removeDatabase(id);
    await hydrateDatabases();
    if (selectedDatabaseId === id) {
      const next = (await listDatabases()).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      setSelectedDatabaseId(next?.id ?? "");
    }
  }

  async function deleteCurrentSession(sessionId: string) {
    if (!selectedDatabase) {
      return;
    }
    await removeSession(sessionId);
    await hydrateSessions(selectedDatabase.id);
  }

  async function wipeLocalData() {
    await clearAllLocalData();
    setDatabases([]);
    setSessions([]);
    setMessages([]);
    setSchema([]);
    setSelectedDatabaseId("");
    setSelectedSessionId("");
    setActiveResult(null);
    setViewMode("connections");
  }

  async function persistMessages(nextMessages: ChatMessage[]) {
    setMessages(nextMessages);
    await putMessages(nextMessages);
  }

  async function sendPrompt() {
    if (!input.trim() || !selectedDatabase || !selectedSession || busy) {
      return;
    }

    const prompt = input.trim();
    const userMessage: ChatMessage = {
      id: uuidv4(),
      sessionId: selectedSession.id,
      role: "user",
      content: prompt,
      createdAt: Date.now(),
    };

    const baseMessages = [...messages, userMessage];
    setInput("");
    setBusy(true);
    await persistMessages(baseMessages);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          credentials: credentialsPayload(selectedDatabase),
          prompt,
          history: messages.map((message) => ({
            role: message.role,
            content: buildHistoryContent(message),
          })),
        }),
      });

      const payload = (await response.json()) as AgentResponse | { error: string };
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Failed to generate suggestions.");
      }

      const assistantMessage: ChatMessage = {
        id: uuidv4(),
        sessionId: selectedSession.id,
        role: "assistant",
        content: `${payload.summary}\n\n${formatToolCalls(payload.toolCalls)}`,
        createdAt: Date.now(),
        querySuggestions: payload.suggestions,
        agentProvider: provider,
        agentModel: model,
      };

      const nextMessages = [...baseMessages, assistantMessage];
      await persistMessages(nextMessages);
      await upsertSession({
        ...selectedSession,
        title: prompt.slice(0, 48),
        updatedAt: assistantMessage.createdAt,
      });
      await hydrateSessions(selectedDatabase.id);
    } catch (error) {
      const failureMessage: ChatMessage = {
        id: uuidv4(),
        sessionId: selectedSession.id,
        role: "assistant",
        content: error instanceof Error ? error.message : "Failed to generate suggestions.",
        createdAt: Date.now(),
      };
      await persistMessages([...baseMessages, failureMessage]);
    } finally {
      setBusy(false);
    }
  }

  async function runQuery(messageId: string, suggestion: QuerySuggestion, sqlOverride?: string) {
    if (!selectedDatabase || !selectedSession || busy) {
      return;
    }
    const sql = (sqlOverride ?? suggestion.sql).trim();
    if (!sql) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: credentialsPayload(selectedDatabase),
          query: sql,
        }),
      });
      const payload = (await response.json()) as QueryResult | { error: string };
      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "Query failed.");
      }

      const nextMessages = messages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        return {
          ...message,
          selectedQueryId: suggestion.id,
          selectedQueryDraft: sql,
          queryResult: payload,
        };
      });
      await persistMessages(nextMessages);
      setActiveResult(payload);
      setEditorMessageId("");
      setEditorSql("");
    } catch (error) {
      const failureMessage: ChatMessage = {
        id: uuidv4(),
        sessionId: selectedSession.id,
        role: "assistant",
        content: error instanceof Error ? error.message : "Query failed.",
        createdAt: Date.now(),
      };
      await persistMessages([...messages, failureMessage]);
    } finally {
      setBusy(false);
    }
  }

  function openEditor(messageId: string, sql: string) {
    setEditorMessageId(messageId);
    const message = messages.find((entry) => entry.id === messageId);
    const suggestion = message?.querySuggestions?.find((entry) => entry.sql === sql);
    setEditorSuggestionId(suggestion?.id ?? "");
    setEditorSql(sql);
  }

  const numericColumns = useMemo(() => {
    const rows = activeResult?.rows ?? [];
    const columns = activeResult?.columns ?? [];
    if (!rows.length) {
      return [];
    }
    return columns.filter((column) => typeof rows[0]?.[column] === "number").slice(0, 3);
  }, [activeResult]);

  const chartRows = useMemo(() => {
    const rows = activeResult?.rows ?? [];
    return rows.slice(0, 12).map((row, index) => ({
      label: String(index + 1),
      ...row,
    }));
  }, [activeResult]);

  const schemaGroups = useMemo(() => {
    const groups = new Map<string, SchemaColumn[]>();
    for (const column of schema) {
      const key = `${column.schema}.${column.tableName}`;
      const current = groups.get(key) ?? [];
      current.push(column);
      groups.set(key, current);
    }
    return Array.from(groups.entries());
  }, [schema]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.2),_transparent_32%),linear-gradient(180deg,#07111f_0%,#0f172a_55%,#111827_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1600px] gap-4 p-4 md:p-6">
        <aside className="flex w-full max-w-sm flex-col rounded-3xl border border-white/10 bg-slate-950/70 p-4 shadow-2xl backdrop-blur md:w-80">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-sky-300">Metabase V2</p>
              <h1 className="font-serif text-2xl">Read-Only SQL Copilot</h1>
            </div>
            <button
              onClick={() => setViewMode(viewMode === "workspace" ? "connections" : "workspace")}
              className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 hover:border-sky-400 hover:text-white"
            >
              {viewMode === "workspace" ? "Connections" : "Workspace"}
            </button>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-400">Database</span>
              <button
                onClick={() => {
                  setEditingDatabaseId("");
                  setConnectionForm(createEmptyDatabase());
                  setShowConnectionForm(true);
                }}
                className="text-xs text-sky-300 hover:text-sky-200"
              >
                Add
              </button>
            </div>
            <select
              value={selectedDatabaseId}
              onChange={(event) => setSelectedDatabaseId(event.target.value)}
              className="w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm outline-none"
            >
              <option value="">Select a connection</option>
              {databases.map((database) => (
                <option key={database.id} value={database.id}>
                  {database.name}
                </option>
              ))}
            </select>
            {selectedDatabase ? (
              <p className="mt-2 text-xs text-slate-400">
                {selectedDatabase.host}:{selectedDatabase.port} / {selectedDatabase.database}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs uppercase tracking-[0.24em] text-slate-400">Chats</span>
            <button
              onClick={() => void createSession()}
              disabled={!selectedDatabase}
              className="rounded-full bg-sky-500 px-3 py-1 text-xs font-medium text-slate-950 disabled:opacity-40"
            >
              New chat
            </button>
          </div>

          <div className="mt-3 flex-1 space-y-2 overflow-auto">
            {sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => setSelectedSessionId(session.id)}
                className={`w-full rounded-2xl border px-3 py-3 text-left ${
                  session.id === selectedSessionId
                    ? "border-sky-400 bg-sky-500/10"
                    : "border-white/8 bg-white/5 hover:border-white/20"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="line-clamp-2 text-sm font-medium">{session.title}</span>
                  <span
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteCurrentSession(session.id);
                    }}
                    className="cursor-pointer text-xs text-slate-500 hover:text-rose-300"
                  >
                    Delete
                  </span>
                </div>
              </button>
            ))}
            {!sessions.length ? <p className="text-sm text-slate-500">Create a chat to start exploring.</p> : null}
          </div>

          <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-400">Schema</span>
              <button
                onClick={() => selectedDatabase && void loadSchema(selectedDatabase)}
                disabled={!selectedDatabase}
                className="text-xs text-sky-300 hover:text-sky-200"
              >
                Refresh
              </button>
            </div>
            <div className="max-h-64 space-y-3 overflow-auto pr-1 text-xs">
              {schemaError ? <p className="text-rose-300">{schemaError}</p> : null}
              {!schemaError && !schemaGroups.length ? <p className="text-slate-500">No schema loaded yet.</p> : null}
              {schemaGroups.map(([tableKey, columns]) => (
                <div key={tableKey} className="rounded-xl border border-white/8 bg-slate-900/60 p-2">
                  <p className="font-medium text-sky-200">{tableKey}</p>
                  <p className="mt-1 text-slate-400">
                    {columns.map((column) => `${column.columnName}: ${column.dataType}`).join(", ")}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={() => void wipeLocalData()}
            className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200 hover:bg-rose-500/20"
          >
            Clear all local data
          </button>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4">
          {viewMode === "connections" ? (
            <section className="rounded-3xl border border-white/10 bg-slate-950/70 p-6 shadow-2xl backdrop-blur">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.3em] text-sky-300">Connections</p>
                  <h2 className="font-serif text-3xl">Saved PostgreSQL sources</h2>
                </div>
                <button
                  onClick={() => {
                    setEditingDatabaseId("");
                    setConnectionForm(createEmptyDatabase());
                    setShowConnectionForm(true);
                  }}
                  className="rounded-full bg-sky-400 px-4 py-2 text-sm font-medium text-slate-950"
                >
                  Add connection
                </button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {databases.map((database) => (
                  <article key={database.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-lg font-medium">{database.name}</h3>
                        <p className="mt-1 text-sm text-slate-400">
                          {database.host}:{database.port} / {database.database}
                        </p>
                        <p className="text-sm text-slate-500">User: {database.user}</p>
                      </div>
                      <div className="flex gap-2 text-sm">
                        <button
                          onClick={() => {
                            setEditingDatabaseId(database.id);
                            setConnectionForm({
                              name: database.name,
                              host: database.host,
                              port: database.port,
                              database: database.database,
                              user: database.user,
                              password: database.password,
                            });
                            setShowConnectionForm(true);
                          }}
                          className="text-slate-300 hover:text-white"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => void deleteConnection(database.id)}
                          className="text-rose-300 hover:text-rose-200"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
                {!databases.length ? <p className="text-slate-400">No saved connections yet.</p> : null}
              </div>
            </section>
          ) : null}

          <section className="grid min-h-[80vh] gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="flex min-h-0 flex-col rounded-3xl border border-white/10 bg-slate-950/70 shadow-2xl backdrop-blur">
              <div className="border-b border-white/10 px-5 py-4">
                <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Agent Workspace</p>
                <h2 className="font-serif text-2xl">Natural language to query options</h2>
                <p className="mt-1 text-sm text-slate-400">
                  The agent inspects schema via tools, proposes multiple read-only SQL options, and waits for you to run one.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <label className="text-xs text-slate-400">
                    Provider
                    <select
                      value={provider}
                      onChange={(event) => setProvider(event.target.value as ProviderOption)}
                      className="mt-1 block rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="google">Google Gemini</option>
                    </select>
                  </label>
                  <label className="text-xs text-slate-400">
                    Model
                    <select
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      className="mt-1 block rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none"
                    >
                      {providerModels[provider].map((modelOption) => (
                        <option key={modelOption} value={modelOption}>
                          {modelOption}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="flex-1 space-y-4 overflow-auto px-5 py-4">
                {!selectedSession ? (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-6 text-sm text-slate-400">
                    Pick a database and create a chat to begin.
                  </div>
                ) : null}

                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={`rounded-3xl border p-4 ${
                      message.role === "user"
                        ? "ml-auto max-w-2xl border-sky-400/30 bg-sky-500/10"
                        : "max-w-3xl border-white/10 bg-white/5"
                    }`}
                  >
                    <p className="mb-2 text-xs uppercase tracking-[0.24em] text-slate-400">{message.role}</p>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{message.content}</p>

                    {message.querySuggestions?.length ? (
                      <div className="mt-4 space-y-3">
                        {message.querySuggestions.map((suggestion) => {
                          return (
                            <div key={suggestion.id} className="rounded-2xl border border-white/10 bg-slate-950/70 p-3">
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <h3 className="text-sm font-medium text-sky-200">{suggestion.name}</h3>
                                  <p className="mt-1 text-xs text-slate-400">{suggestion.rationale}</p>
                                </div>
                                <div className="flex gap-2 text-xs">
                                  <button
                                    onClick={() => openEditor(message.id, suggestion.sql)}
                                    className="rounded-full border border-white/10 px-3 py-1 text-slate-300 hover:border-sky-400 hover:text-white"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => void runQuery(message.id, suggestion)}
                                    disabled={busy}
                                    className="rounded-full bg-sky-400 px-3 py-1 font-medium text-slate-950 disabled:opacity-50"
                                  >
                                    Run
                                  </button>
                                </div>
                              </div>
                              <pre className="mt-3 overflow-x-auto rounded-xl bg-black/30 p-3 text-xs leading-6 text-emerald-300">
                                {suggestion.sql}
                              </pre>
                              {message.agentProvider && message.agentModel ? (
                                <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
                                  {message.agentProvider} / {message.agentModel}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {message.selectedQueryDraft ? (
                      <div className="mt-4 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-3">
                        <p className="text-xs uppercase tracking-[0.24em] text-emerald-200">Executed Query</p>
                        <pre className="mt-2 overflow-x-auto text-xs leading-6 text-emerald-100">{message.selectedQueryDraft}</pre>
                      </div>
                    ) : null}

                    {editorMessageId === message.id ? (
                      <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/10 p-3">
                        <p className="text-xs uppercase tracking-[0.24em] text-amber-200">Edit Query</p>
                        <textarea
                          value={editorSql}
                          onChange={(event) => setEditorSql(event.target.value)}
                          rows={8}
                          className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-xs leading-6 text-slate-100 outline-none"
                        />
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={() => {
                              const target =
                                message.querySuggestions?.find((suggestion) => suggestion.id === editorSuggestionId) ??
                                message.querySuggestions?.[0];
                              if (target) {
                                void runQuery(message.id, target, editorSql);
                              }
                            }}
                            className="rounded-full bg-amber-300 px-3 py-1 text-xs font-medium text-slate-950"
                          >
                            Run edited query
                          </button>
                          <button
                            onClick={() => {
                              setEditorMessageId("");
                              setEditorSuggestionId("");
                              setEditorSql("");
                            }}
                            className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>

              <div className="border-t border-white/10 px-5 py-4">
                <div className="rounded-3xl border border-white/10 bg-white/5 p-3">
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    rows={3}
                    placeholder="Ask a business question, like 'show weekly revenue by country for the last 90 days'"
                    className="w-full resize-none bg-transparent text-sm leading-6 text-white outline-none placeholder:text-slate-500"
                  />
                  <div className="mt-3 flex items-center justify-between">
                    <p className="text-xs text-slate-500">Queries remain read-only; execution happens only after you choose.</p>
                    <button
                      onClick={() => void sendPrompt()}
                      disabled={!selectedSession || !selectedDatabase || busy || !input.trim()}
                      className="rounded-full bg-sky-400 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50"
                    >
                      {busy ? "Working..." : "Generate options"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-col gap-4">
              <section className="rounded-3xl border border-white/10 bg-slate-950/70 p-5 shadow-2xl backdrop-blur">
                <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Results</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-xs text-slate-400">Rows</p>
                    <p className="text-2xl font-semibold">{activeResult?.rowCount ?? 0}</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-xs text-slate-400">Columns</p>
                    <p className="text-2xl font-semibold">{activeResult?.columns.length ?? 0}</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-xs text-slate-400">Time</p>
                    <p className="text-2xl font-semibold">{activeResult?.executionTime ?? 0}ms</p>
                  </div>
                </div>

                {activeResult && numericColumns.length ? (
                  <div className="mt-5 h-72 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartRows}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="label" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <Tooltip contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #1e293b" }} />
                        <Legend />
                        {numericColumns.map((column, index) => (
                          <Bar key={column} dataKey={column} fill={chartColors[index % chartColors.length]} radius={[6, 6, 0, 0]} />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="mt-5 rounded-2xl border border-dashed border-white/10 bg-white/5 p-5 text-sm text-slate-400">
                    Run a query to populate the result workspace and chart preview.
                  </div>
                )}
              </section>

              <section className="flex min-h-0 flex-1 flex-col rounded-3xl border border-white/10 bg-slate-950/70 p-5 shadow-2xl backdrop-blur">
                <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Data Grid</p>
                <div className="mt-4 min-h-0 flex-1 overflow-auto rounded-2xl border border-white/10 bg-slate-950/70">
                  <table className="min-w-full text-left text-sm">
                    <thead className="sticky top-0 bg-slate-900/95 text-slate-300">
                      <tr>
                        {(activeResult?.columns ?? []).map((column) => (
                          <th key={column} className="px-3 py-3 font-medium">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(activeResult?.rows ?? []).map((row, rowIndex) => (
                        <tr key={rowIndex} className="border-t border-white/5">
                          {(activeResult?.columns ?? []).map((column) => (
                            <td key={`${rowIndex}-${column}`} className="max-w-[280px] truncate px-3 py-2 text-slate-200">
                              {String(row[column] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </section>
        </main>
      </div>

      {showConnectionForm ? (
        <div className="fixed inset-0 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-slate-950 p-6 shadow-2xl">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-sky-300">Connection</p>
                <h3 className="font-serif text-2xl">{editingDatabaseId ? "Edit source" : "Add source"}</h3>
              </div>
              <button
                onClick={() => {
                  setShowConnectionForm(false);
                  setEditingDatabaseId("");
                }}
                className="text-sm text-slate-400 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={connectionForm.name}
                onChange={(event) => setConnectionForm({ ...connectionForm, name: event.target.value })}
                placeholder="Connection name"
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none"
              />
              <input
                value={connectionForm.host}
                onChange={(event) => setConnectionForm({ ...connectionForm, host: event.target.value })}
                placeholder="Host"
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none"
              />
              <input
                type="number"
                value={connectionForm.port}
                onChange={(event) => setConnectionForm({ ...connectionForm, port: Number(event.target.value) })}
                placeholder="Port"
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none"
              />
              <input
                value={connectionForm.database}
                onChange={(event) => setConnectionForm({ ...connectionForm, database: event.target.value })}
                placeholder="Database"
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none"
              />
              <input
                value={connectionForm.user}
                onChange={(event) => setConnectionForm({ ...connectionForm, user: event.target.value })}
                placeholder="User"
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none"
              />
              <input
                type="password"
                value={connectionForm.password}
                onChange={(event) => setConnectionForm({ ...connectionForm, password: event.target.value })}
                placeholder="Password"
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none"
              />
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowConnectionForm(false);
                  setEditingDatabaseId("");
                }}
                className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveConnection()}
                className="rounded-full bg-sky-400 px-4 py-2 text-sm font-medium text-slate-950"
              >
                Save connection
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
