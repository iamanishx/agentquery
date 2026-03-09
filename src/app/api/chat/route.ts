import { NextRequest, NextResponse } from "next/server";
import { agentRequestSchema, createSqlAgent } from "@/lib/agent";

export async function POST(req: NextRequest) {
  try {
    const payload = agentRequestSchema.parse(await req.json());
    const { credentials, prompt, history, provider, model } = payload;
    const agent = createSqlAgent(provider, model, credentials);
    const result = await agent.generate({
      messages: [
        ...history.map((message) => ({ role: message.role, content: message.content })),
        { role: "user", content: prompt },
      ],
    });

    const suggestions = result.output.suggestions.map((suggestion, index) => ({
      id: `query-${Date.now()}-${index}`,
      ...suggestion,
    }));

    return NextResponse.json({
      summary: result.output.summary,
      suggestions,
      toolCalls: result.toolCalls?.map((call) => ({ toolName: call.toolName, input: call.input })) ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate SQL suggestions." },
      { status: 500 },
    );
  }
}
