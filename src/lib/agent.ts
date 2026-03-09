import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { Output, ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import {
  buildTablePreviewQuery,
  executeReadOnlyQuery,
  fetchSchema,
  summarizeSchema,
} from "@/lib/server-db";

const credentialsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
});

export const agentRequestSchema = z.object({
  provider: z.enum(["openai", "google"]).default("openai"),
  model: z.string().min(1),
  credentials: credentialsSchema,
  prompt: z.string().min(1),
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
  suggestions: z.array(
    z.object({
      name: z.string(),
      sql: z.string(),
      rationale: z.string(),
    }),
  ).min(2).max(3),
});

function resolveModel(provider: "openai" | "google", model: string) {
  return provider === "google" ? google(model) : openai(model);
}

export function createSqlAgent(
  provider: "openai" | "google",
  model: string,
  credentials: z.infer<typeof credentialsSchema>,
) {
  return new ToolLoopAgent({
    model: resolveModel(provider, model),
    instructions: [
      "You are a PostgreSQL analytics agent.",
      "Your job is to inspect schema with tools and propose 2 or 3 read-only SQL options.",
      "Always inspect schema first unless the conversation already clearly established the relevant tables.",
      "Use sample_table only when a small preview would help disambiguate columns or meanings.",
      "Never propose mutations or admin commands.",
      "Keep SQL executable in PostgreSQL and add LIMIT to open-ended result sets.",
      "Return concise rationales focused on why each query is useful.",
    ].join(" "),
    stopWhen: stepCountIs(6),
    output: Output.object({ schema: outputSchema }),
    tools: createSqlTools(credentials),
    providerOptions:
      provider === "openai"
        ? {
            openai: {
              textVerbosity: "low",
              reasoningSummary: "auto",
              parallelToolCalls: false,
              store: false,
            },
          }
        : {
            google: {
              structuredOutputs: true,
            },
          },
  });
}

export function createSqlTools(credentials: z.infer<typeof credentialsSchema>) {
  return {
    get_schema: tool({
      description: "Inspect the Postgres schema with table and column details.",
      inputSchema: z.object({}),
      execute: async () => {
        const schema = await fetchSchema(credentials);
        return {
          summary: summarizeSchema(schema),
          raw: schema,
        };
      },
    }),
    sample_table: tool({
      description: "Read up to 5 rows from a specific table for context before proposing queries.",
      inputSchema: z.object({
        schema: z.string().min(1),
        table: z.string().min(1),
      }),
      execute: async ({ schema, table }) => {
        const query = buildTablePreviewQuery(schema, table);
        return executeReadOnlyQuery(credentials, query);
      },
    }),
  };
}
