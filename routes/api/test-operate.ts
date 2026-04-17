import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    console.log("🌐 [TestOperate] GET request received");
    
    const operateApiKey = Deno.env.get("OPERATE_API_KEY");
    const operateBaseUrl = Deno.env.get("OPERATE_BASE_URL") || "https://recharger-spotlight-virus.ngrok-free.dev/api";
    
    console.log("🔧 [TestOperate] Environment check:", {
      hasOperateKey: !!operateApiKey,
      operateKeyPrefix: operateApiKey?.substring(0, 12) + "..." || "not set",
      operateBaseUrl,
      requestUrl: ctx.req.url,
      userAgent: ctx.req.headers.get("user-agent") || "unknown"
    });
    
    if (!operateApiKey) {
      console.error("❌ [TestOperate] Missing OPERATE_API_KEY environment variable");
      return new Response(
        JSON.stringify({ 
          error: "OPERATE_API_KEY environment variable not set",
          timestamp: new Date().toISOString()
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    try {
      console.log("🔍 [TestOperate] Testing connection to Operate API...");
      // Test the connection to Operate API
      const testUrl = `${operateBaseUrl}/api/users`;
      console.log("📤 [TestOperate] Sending request:", {
        url: testUrl,
        headers: {
          "X-Operate-API-Key": operateApiKey.substring(0, 12) + "..."
        }
      });
      
      const response = await fetch(testUrl, {
        headers: {
          "X-Operate-API-Key": operateApiKey,
        },
      });
      
      console.log("📥 [TestOperate] Response received:", {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries())
      });
      
      const data = await response.text();
      console.log("📊 [TestOperate] Response body:", {
        length: data.length,
        preview: data.substring(0, 200) + (data.length > 200 ? "..." : ""),
        isEmpty: data.trim() === ""
      });
      
      const result = {
        success: true,
        status: response.status,
        statusText: response.statusText,
        url: testUrl,
        response: data,
        timestamp: new Date().toISOString(),
        environment: {
          hasApiKey: true,
          baseUrl: operateBaseUrl
        }
      };
      
      console.log("✅ [TestOperate] Test completed successfully");
      return new Response(
        JSON.stringify(result, null, 2),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
      
    } catch (error) {
      console.error("❌ [TestOperate] Error connecting to Operate API:", {
        error: error.message,
        stack: error.stack,
        name: error.name,
        url: `${operateBaseUrl}/api/health`
      });
      
      const errorResult = {
        success: false,
        error: "Failed to connect to Operate API",
        details: error.message,
        stack: error.stack,
        url: `${operateBaseUrl}/api/health`,
        timestamp: new Date().toISOString(),
        environment: {
          hasApiKey: !!operateApiKey,
          baseUrl: operateBaseUrl
        }
      };
      
      return new Response(
        JSON.stringify(errorResult, null, 2),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
});