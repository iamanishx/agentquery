import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchSchema } from "@/lib/server-db";

const credentialsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
});

export async function POST(req: NextRequest) {
  try {
    const { credentials } = z
      .object({ credentials: credentialsSchema })
      .parse(await req.json());

    const schema = await fetchSchema(credentials);
    return NextResponse.json(schema);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load schema." },
      { status: 500 },
    );
  }
}
