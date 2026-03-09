import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchSchema } from "@/lib/server-db";

const credentialsSchema = z.object({
  connectionString: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { credentials } = z
      .object({ credentials: credentialsSchema })
      .parse(await req.json());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = await fetchSchema(credentials as any);
    return NextResponse.json(schema);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load schema." },
      { status: 500 },
    );
  }
}
