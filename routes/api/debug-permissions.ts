import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    console.log("🔍 [DebugPermissions] Testing API key permissions...");
    
    const operateApiKey = Deno.env.get("OPERATE_API_KEY");
    const operateBaseUrl = Deno.env.get("OPERATE_BASE_URL") || "https://recharger-spotlight-virus.ngrok-free.dev/operate";
    
    if (!operateApiKey) {
      return new Response(
        JSON.stringify({ error: "OPERATE_API_KEY not set" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const testEndpoints = [
      { name: "User Search (working)", method: "GET", url: `${operateBaseUrl}/api/users/search?email=test@example.com` },
      { name: "User Creation", method: "POST", url: `${operateBaseUrl}/api/users`, body: { email: "test@example.com", first_name: "Test" } },
      { name: "User List", method: "GET", url: `${operateBaseUrl}/api/users` },
      { name: "API Keys List", method: "GET", url: `${operateBaseUrl}/api/api-keys` },
      { name: "Agent Interactions", method: "POST", url: `${operateBaseUrl}/api/agent-interactions`, body: { query: "test question" } },
    ];

    const results = [];

    for (const test of testEndpoints) {
      try {
        console.log(`🌐 [DebugPermissions] Testing: ${test.method} ${test.url}`);
        
        const requestOptions = {
          method: test.method,
          headers: {
            "X-Operate-API-Key": operateApiKey,
            "Content-Type": "application/json",
          }
        };

        if (test.body) {
          requestOptions.body = JSON.stringify(test.body);
        }

        const response = await fetch(test.url, requestOptions);
        const responseText = await response.text();
        
        results.push({
          endpoint: test.name,
          method: test.method,
          url: test.url,
          status: response.status,
          statusText: response.statusText,
          success: response.ok,
          responsePreview: responseText.substring(0, 200) + "...",
          responseLength: responseText.length
        });

      } catch (error) {
        results.push({
          endpoint: test.name,
          method: test.method,
          url: test.url,
          error: error.message,
          failed: true
        });
      }
    }

    return new Response(
      JSON.stringify({ 
        timestamp: new Date().toISOString(),
        apiKey: operateApiKey.substring(0, 20) + "...",
        results,
        summary: {
          total: testEndpoints.length,
          successful: results.filter(r => r.success).length,
          unauthorized: results.filter(r => r.status === 401).length,
          forbidden: results.filter(r => r.status === 403).length,
          not_found: results.filter(r => r.status === 404).length
        }
      }, null, 2),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  },
});