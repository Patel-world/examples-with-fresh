import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    console.log("🔍 [DebugOperate] Testing multiple API endpoints...");
    
    const operateApiKey = Deno.env.get("OPERATE_API_KEY");
    const baseHost = "https://recharger-spotlight-virus.ngrok-free.dev";
    
    if (!operateApiKey) {
      return new Response(
        JSON.stringify({ error: "OPERATE_API_KEY not set" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const testEndpoints = [
      `${baseHost}/api/users`,
      `${baseHost}/v1/api/users`,
      `${baseHost}:8080/api/users`,
      `${baseHost}:3000/api/users`,
      `${baseHost}/backend/api/users`,
      `${baseHost}/server/api/users`,
      `${baseHost}/api/health`,
      `${baseHost}/health`,
      `${baseHost}/status`,
    ];

    const results = [];

    for (const endpoint of testEndpoints) {
      try {
        console.log(`🌐 [DebugOperate] Testing: ${endpoint}`);
        
        const response = await fetch(endpoint, {
          headers: {
            "X-Operate-API-Key": operateApiKey,
          },
        });

        const responseText = await response.text();
        
        results.push({
          endpoint,
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get("content-type") || "unknown",
          isJSON: responseText.trim().startsWith("{") || responseText.trim().startsWith("["),
          isHTML: responseText.trim().startsWith("<!"),
          responsePreview: responseText.substring(0, 150) + "...",
          responseLength: responseText.length
        });

      } catch (error) {
        results.push({
          endpoint,
          error: error.message,
          failed: true
        });
      }
    }

    return new Response(
      JSON.stringify({ 
        timestamp: new Date().toISOString(),
        results,
        summary: {
          total: testEndpoints.length,
          successful: results.filter(r => !r.failed && r.status < 400).length,
          failed: results.filter(r => r.failed || r.status >= 400).length,
          returning_json: results.filter(r => r.isJSON).length,
          returning_html: results.filter(r => r.isHTML).length
        }
      }, null, 2),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  },
});