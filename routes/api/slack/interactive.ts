import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    try {
      // Handle Slack interactive components if needed
      const formData = await ctx.req.formData();
      const payload = JSON.parse(formData.get("payload") as string);
      
      console.log("Interactive payload:", payload);
      
      // For now, just acknowledge the request
      return new Response("OK", { status: 200 });
      
    } catch (error) {
      console.error("Error processing Slack interactive:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});