import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText, tool } from "ai";
import { z } from "zod";
import {
  buildTablePreviewQuery,
  executeReadOnlyQuery,
  fetchSchema,
  summarizeSchema,
} from "@/lib/server-db";

export const credentialsSchema = z.object({
  connectionString: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
});

export const agentRequestSchema = z.object({
  provider: z.enum(["openai", "google"]).default("openai"),
  model: z.string().min(1),
  credentials: credentialsSchema,
  prompt: z.string().min(1),
  apiKeys: z
    .object({
      openai: z.string().optional(),
      google: z.string().optional(),
    })
    .optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
});

const outputSchema = z.object({
  summary: z.string(),
  suggestions: z
    .array(
      z.object({
        name: z.string(),
        sql: z.string(),
        rationale: z.string(),
      }),
    )
    .min(2)
    .max(3),
});

function resolveModel(
  provider: "openai" | "google",
  model: string,
  apiKeys?: { openai?: string; google?: string },
) {
  if (provider === "google") {
    const google = createGoogleGenerativeAI({
      apiKey: apiKeys?.google ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
    });
    return google(model);
  }
  const openai = createOpenAI({
    apiKey: apiKeys?.openai ?? process.env.OPENAI_API_KEY ?? "",
  });
  return openai(model);
}

type AgentResult = {
  output: z.infer<typeof outputSchema>;
  toolCalls: Array<{ toolName: string; input: unknown }>;
};

export async function createSqlAgent(
  provider: "openai" | "google",
  model: string,
  credentials: z.infer<typeof credentialsSchema>,
  apiKeys?: { openai?: string; google?: string },
) {
  const llm = resolveModel(provider, model, apiKeys);
  const tools = createSqlTools(credentials);

  return {
    generate: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      const userQuestion = messages[messages.length - 1]?.content ?? "";

      // Re-run exploration with the actual user question
      const exploreResult = await generateText({
        model: llm,
        system: [
          "You are a PostgreSQL analytics agent.",
          "Use the provided tools to inspect the database schema and sample tables as needed.",
          "Gather enough context to propose 2-3 excellent read-only SQL queries for the user's question.",
        ].join(" "),
        messages: [{ role: "user" as const, content: `Inspect the database to help answer: ${userQuestion}` }],
        tools,
        maxSteps: 5,
      });

      const toolCallsOut: Array<{ toolName: string; input: unknown }> = [];
      for (const step of exploreResult.steps) {
        for (const tc of step.toolCalls ?? []) {
          toolCallsOut.push({ toolName: tc.toolName, input: tc.args });
        }
      }

      const ctx = exploreResult.text || "Schema explored.";

      const historyMessages = messages.slice(0, -1).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const { object: result } = await generateObject({
        model: llm,
        schema: outputSchema,
        system: [
          "You are a PostgreSQL analytics agent. Propose 2-3 read-only SQL queries.",
          "Rules: SELECT only, add LIMIT, proper PostgreSQL syntax.",
          "Each suggestion needs: name (short title), sql (valid SQL), rationale (why it answers the question).",
        ].join(" "),
        messages: [
          ...historyMessages,
          {
            role: "user" as const,
            content: `Database schema context:\n${ctx}\n\nUser question: ${userQuestion}`,
          },
        ],
      });

      return {
        output: result,
        toolCalls: toolCallsOut,
      } as AgentResult;
    },
  };
}

export function createSqlTools(credentials: z.infer<typeof credentialsSchema>) {
  return {
    get_schema: tool({
      description: "Inspect the Postgres schema — returns all tables and columns.",
      parameters: z.object({}),
      execute: async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const schema = await fetchSchema(credentials as any);
        return {
          summary: summarizeSchema(schema),
          raw: schema,
        };
      },
    }),
    sample_table: tool({
      description: "Read up to 5 rows from a specific table for context.",
      parameters: z.object({
        schema: z.string().min(1),
        table: z.string().min(1),
      }),
      execute: async ({ schema, table }) => {
        const query = buildTablePreviewQuery(schema, table);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return executeReadOnlyQuery(credentials as any, query);
      },
    }),
  };
}
