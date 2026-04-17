import { define } from "../../../utils.ts";
import { WebClient } from "@slack/web-api";

// In-memory cache for user mappings (in production, use Redis/KV)
const userCache = new Map<string, string>(); // slack_user_id -> operate_user_id

interface SlackEvent {
  type: string;
  event: {
    type: string;
    user: string;
    text: string;
    channel: string;
    ts: string;
  };
  challenge?: string;
}

async function handleAppMention(event: SlackEvent["event"]) {
  console.log("Processing app mention:", event);
  
  const slackToken = Deno.env.get("SLACK_BOT_TOKEN");
  const operateApiKey = Deno.env.get("OPERATE_API_KEY");
  const operateBaseUrl = Deno.env.get("OPERATE_BASE_URL") || "https://recharger-spotlight-virus.ngrok-free.dev";
  
  if (!slackToken || !operateApiKey) {
    console.error("Missing required environment variables");
    return;
  }

  const slack = new WebClient(slackToken);
  
  try {
    // Step 3: Check cache for user mapping
    let operateUserId = userCache.get(event.user);
    
    if (!operateUserId) {
      // Step 4: Get user email from Slack
      const userInfo = await slack.users.info({ user: event.user });
      const email = userInfo.user?.profile?.email;
      
      if (!email) {
        await slack.chat.postMessage({
          channel: event.channel,
          text: "Sorry, I couldn't find your email address. Please make sure your Slack profile has an email set.",
          thread_ts: event.ts,
        });
        return;
      }
      
      // Step 5: Check if user exists in Operate
      const getUserResponse = await fetch(`${operateBaseUrl}/api/users?email=${email}`, {
        headers: {
          "X-Operate-API-Key": operateApiKey,
        },
      });
      
      const userData = await getUserResponse.json();
      
      if (userData.users && userData.users.length > 0) {
        operateUserId = userData.users[0].id;
      } else {
        // Create new user in Operate
        const firstName = userInfo.user?.profile?.first_name || userInfo.user?.real_name?.split(" ")[0] || "User";
        
        const createUserResponse = await fetch(`${operateBaseUrl}/api/users`, {
          method: "POST",
          headers: {
            "X-Operate-API-Key": operateApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email,
            first_name: firstName,
          }),
        });
        
        const newUserData = await createUserResponse.json();
        operateUserId = newUserData.id;
      }
      
      // Cache the mapping
      userCache.set(event.user, operateUserId);
    }
    
    // Step 6: Extract question from the mention
    const question = event.text.replace(/<@[^>]+>/g, "").trim();
    
    if (!question) {
      await slack.chat.postMessage({
        channel: event.channel,
        text: "Hi! Please ask me a specific question about your system. For example: 'Why is checkout failing?' or 'What's causing the API slowdown?'",
        thread_ts: event.ts,
      });
      return;
    }
    
    // Step 7: Trigger investigation in Operate
    const investigationResponse = await fetch(`${operateBaseUrl}/api/agent-interactions`, {
      method: "POST",
      headers: {
        "X-Operate-API-Key": operateApiKey,
        "X-Operate-User-Id": operateUserId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: question,
      }),
    });
    
    if (!investigationResponse.ok) {
      throw new Error(`Operate API error: ${investigationResponse.status}`);
    }
    
    const result = await investigationResponse.json();
    
    // Step 8: Post result back to Slack
    await slack.chat.postMessage({
      channel: event.channel,
      text: `🔍 Investigation complete!\n\n${result.response || result.answer || "I've analyzed your system but couldn't find specific details about this issue. Please check the Operate dashboard for more information."}`,
      thread_ts: event.ts,
    });
    
  } catch (error) {
    console.error("Error handling app mention:", error);
    
    try {
      await slack.chat.postMessage({
        channel: event.channel,
        text: `❌ Sorry, I encountered an error while investigating your question. Please try again later or check the Operate dashboard directly.`,
        thread_ts: event.ts,
      });
    } catch (postError) {
      console.error("Error posting error message to Slack:", postError);
    }
  }
}

export const handler = define.handlers({
  async POST(ctx) {
    try {
      const body: SlackEvent = await ctx.req.json();
      
      // Handle URL verification challenge
      if (body.challenge) {
        return new Response(body.challenge, {
          headers: { "Content-Type": "text/plain" },
        });
      }
      
      // Handle app mention events
      if (body.type === "event_callback" && body.event?.type === "app_mention") {
        // Process async to avoid Slack timeout
        handleAppMention(body.event).catch(console.error);
        
        return new Response("OK", { status: 200 });
      }
      
      return new Response("Event not handled", { status: 200 });
      
    } catch (error) {
      console.error("Error processing Slack event:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});