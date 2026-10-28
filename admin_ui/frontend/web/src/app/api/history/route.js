import sql from "@/app/api/utils/sql";

export async function GET(request) {
  try {
    const calls =
      await sql`SELECT * FROM call_history ORDER BY start_time DESC LIMIT 50`;
    return Response.json(calls);
  } catch (error) {
    // Fallback for mock if DB not ready
    const mockCalls = Array.from({ length: 10 }).map((_, i) => ({
      id: i,
      caller_number: `+1 (555) 00${i}-${Math.floor(Math.random() * 9000) + 1000}`,
      caller_name: "Unknown",
      start_time: new Date().toISOString(),
      duration: "00:02:14",
      provider: "OpenAI Realtime",
      context: "Support Agent",
      outcome: i % 3 === 0 ? "Success" : "User Hangup",
    }));
    return Response.json(mockCalls);
  }
}
