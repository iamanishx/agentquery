import { NextRequest, NextResponse } from "next/server";
import { agentRequestSchema, createSqlAgent } from "@/lib/agent";

export async function POST(req: NextRequest) {
  try {
    const payload = agentRequestSchema.parse(await req.json());
    const { credentials, prompt, history, provider, model, apiKeys } = payload;
    const agent = await createSqlAgent(provider, model, credentials, apiKeys);
    const result = await agent.generate({
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: prompt },
      ],
    });

    const suggestions = result.output.suggestions.map(
      (s: { name: string; sql: string; rationale: string }, i: number) => ({
        id: `query-${Date.now()}-${i}`,
        ...s,
      }),
    );

    return NextResponse.json({
      summary: result.output.summary,
      suggestions,
      toolCalls: result.toolCalls ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate SQL suggestions." },
      { status: 500 },
    );
  }
}
