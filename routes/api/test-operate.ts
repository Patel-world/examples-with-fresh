import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const operateApiKey = Deno.env.get("OPERATE_API_KEY");
    const operateBaseUrl = Deno.env.get("OPERATE_BASE_URL") || "https://recharger-spotlight-virus.ngrok-free.dev";
    
    if (!operateApiKey) {
      return new Response(
        JSON.stringify({ error: "OPERATE_API_KEY environment variable not set" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    try {
      // Test the connection to Operate API
      const response = await fetch(`${operateBaseUrl}/api/health`, {
        headers: {
          "X-Operate-API-Key": operateApiKey,
        },
      });
      
      const data = await response.text();
      
      return new Response(
        JSON.stringify({
          status: response.status,
          url: `${operateBaseUrl}/api/health`,
          response: data,
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
      
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "Failed to connect to Operate API",
          details: error.message,
          url: `${operateBaseUrl}/api/health`,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
});