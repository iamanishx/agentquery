import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { executeReadOnlyQuery } from "@/lib/server-db";

const credentialsSchema = z.object({
  connectionString: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
});

const executeSchema = z.object({
  credentials: credentialsSchema,
  query: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const { credentials, query } = executeSchema.parse(await req.json());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeReadOnlyQuery(credentials as any, query);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Query failed." },
      { status: 500 },
    );
  }
}
