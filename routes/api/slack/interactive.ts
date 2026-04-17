import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    console.log("🌐 [SlackInteractive] POST request received");
    
    try {
      console.log("📥 [SlackInteractive] Parsing form data...");
      // Handle Slack interactive components if needed
      const formData = await ctx.req.formData();
      
      console.log("📄 [SlackInteractive] Form data entries:", {
        keys: Array.from(formData.keys()),
        hasPayload: formData.has("payload")
      });
      
      const payloadString = formData.get("payload") as string;
      console.log("🔍 [SlackInteractive] Raw payload string:", {
        length: payloadString?.length || 0,
        preview: payloadString?.substring(0, 200) + "..."
      });
      
      const payload = JSON.parse(payloadString);
      console.log("📊 [SlackInteractive] Parsed payload:", {
        type: payload.type,
        user: payload.user?.id || "unknown",
        team: payload.team?.id || "unknown",
        actions: payload.actions?.length || 0,
        hasCallbackId: !!payload.callback_id
      });
      
      console.log("📄 [SlackInteractive] Full payload details:", payload);
      
      // For now, just acknowledge the request
      console.log("✅ [SlackInteractive] Returning OK response");
      return new Response("OK", { status: 200 });
      
    } catch (error) {
      console.error("❌ [SlackInteractive] Error processing Slack interactive:", {
        error: error.message,
        stack: error.stack,
        name: error.name
      });
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});