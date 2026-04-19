import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const operateApiKey = Deno.env.get("OPERATE_API_KEY");
    const operateBaseUrl = Deno.env.get("OPERATE_BASE_URL") || "https://recharger-spotlight-virus.ngrok-free.dev/operate";
    
    if (!operateApiKey) {
      return new Response("OPERATE_API_KEY not set", { status: 500 });
    }

    // Test user creation with the same request that's failing
    try {
      const response = await fetch(`${operateBaseUrl}/api/users`, {
        method: "POST",
        headers: {
          "X-Operate-API-Key": operateApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "test@example.com",
          first_name: "Test"
        }),
      });

      const responseText = await response.text();
      
      return new Response(JSON.stringify({
        url: `${operateBaseUrl}/api/users`,
        method: "POST",
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseText,
        success: response.ok
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
      
    } catch (error) {
      return new Response(JSON.stringify({
        error: error.message,
        stack: error.stack
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  },
});