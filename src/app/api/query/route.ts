import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { executeReadOnlyQuery, fetchSchema } from "@/lib/server-db";

const credentialsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
});

const executeSchema = z.object({
  credentials: credentialsSchema,
  query: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const { credentials, query } = executeSchema.parse(await req.json());
    const result = await executeReadOnlyQuery(credentials, query);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Query failed." },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const raw = searchParams.get("credentials");
    if (!raw) {
      return NextResponse.json({ error: "Missing credentials." }, { status: 400 });
    }

    const credentials = credentialsSchema.parse(JSON.parse(decodeURIComponent(raw)));
    const schema = await fetchSchema(credentials);
    return NextResponse.json(schema);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load schema." },
      { status: 500 },
    );
  }
}
