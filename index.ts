import { handleRequest } from "./lib/app";

const port = Number(Bun.env.PORT ?? 3000);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch: handleRequest,
});

console.log(`Listening on http://localhost:${port}`);
