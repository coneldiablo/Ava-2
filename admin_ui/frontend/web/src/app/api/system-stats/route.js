export async function GET(request) {
  const stats = {
    cpu: Math.floor(Math.random() * 30) + 10,
    memory: Math.floor(Math.random() * 20) + 40,
    disk: 15,
    asterisk: "Connected",
    activeCalls: Math.floor(Math.random() * 5),
    uptime: "12d 4h 32m",
    version: "v2.4.1",
  };

  return Response.json(stats);
}
