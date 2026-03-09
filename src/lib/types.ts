export interface DatabaseCredential {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  createdAt: number;
  updatedAt: number;
}

export interface SchemaColumn {
  schema: string;
  tableName: string;
  columnName: string;
  dataType: string;
  isNullable: boolean;
}

export interface QuerySuggestion {
  id: string;
  name: string;
  sql: string;
  rationale: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  executionTime: number;
  rowCount: number;
}

export interface ChatSession {
  id: string;
  dbId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  querySuggestions?: QuerySuggestion[];
  selectedQueryId?: string;
  selectedQueryDraft?: string;
  queryResult?: QueryResult;
  agentProvider?: "openai" | "google";
  agentModel?: string;
}
