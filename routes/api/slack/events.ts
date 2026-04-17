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
  console.log("🚀 [handleAppMention] Starting processing app mention:", JSON.stringify(event, null, 2));
  
  const slackToken = Deno.env.get("SLACK_BOT_TOKEN");
  const operateApiKey = Deno.env.get("OPERATE_API_KEY");
  const operateBaseUrl = Deno.env.get("OPERATE_BASE_URL") || "https://recharger-spotlight-virus.ngrok-free.dev/api";
  
  console.log("🔧 [handleAppMention] Environment check:", {
    hasSlackToken: !!slackToken,
    slackTokenPrefix: slackToken?.substring(0, 12) + "...",
    hasOperateKey: !!operateApiKey,
    operateKeyPrefix: operateApiKey?.substring(0, 12) + "...",
    operateBaseUrl
  });
  
  if (!slackToken || !operateApiKey) {
    console.error("❌ [handleAppMention] Missing required environment variables", {
      slackToken: !!slackToken,
      operateApiKey: !!operateApiKey
    });
    return;
  }

  console.log("📱 [handleAppMention] Creating Slack WebClient...");
  const slack = new WebClient(slackToken);
  
  try {
    console.log("👤 [handleAppMention] Step 3: Checking cache for user mapping...");
    // Step 3: Check cache for user mapping
    let operateUserId = userCache.get(event.user);
    console.log("💾 [handleAppMention] Cache lookup result:", {
      userId: event.user,
      foundInCache: !!operateUserId,
      operateUserId: operateUserId || "not found"
    });
    
    if (!operateUserId) {
      console.log("📧 [handleAppMention] Step 4: Getting user email from Slack...");
      // Step 4: Get user email from Slack
      const userInfo = await slack.users.info({ user: event.user });
      console.log("👥 [handleAppMention] Slack user info received:", {
        ok: userInfo.ok,
        hasUser: !!userInfo.user,
        hasProfile: !!userInfo.user?.profile,
        email: userInfo.user?.profile?.email || "not found"
      });
      
      const email = userInfo.user?.profile?.email;
      
      if (!email) {
        console.warn("⚠️ [handleAppMention] No email found in Slack profile");
        await slack.chat.postMessage({
          channel: event.channel,
          text: "Sorry, I couldn't find your email address. Please make sure your Slack profile has an email set.",
          thread_ts: event.ts,
        });
        return;
      }
      
      console.log("✅ [handleAppMention] Email found:", email);
      
      console.log("🔍 [handleAppMention] Step 5: Checking if user exists in Operate...");
      // Step 5: Check if user exists in Operate using search endpoint
      const getUserUrl = `${operateBaseUrl}/api/users/search?email=${email}`;
      console.log("🌐 [handleAppMention] Fetching user from Operate:", getUserUrl);
      
      const getUserResponse = await fetch(getUserUrl, {
        headers: {
          "X-Operate-API-Key": operateApiKey,
        },
      });
      
      console.log("📥 [handleAppMention] Get user response:", {
        status: getUserResponse.status,
        ok: getUserResponse.ok,
        statusText: getUserResponse.statusText
      });
      
      // Handle HTML responses gracefully
      const responseText = await getUserResponse.text();
      console.log("📄 [handleAppMention] Raw response:", {
        length: responseText.length,
        isHTML: responseText.trim().startsWith('<!'),
        preview: responseText.substring(0, 200) + "..."
      });
      
      let userData;
      try {
        userData = JSON.parse(responseText);
        console.log("👤 [handleAppMention] User data received:", userData);
      } catch (parseError) {
        console.error("❌ [handleAppMention] Failed to parse response as JSON:", {
          error: parseError.message,
          responsePreview: responseText.substring(0, 300),
          isHTML: responseText.trim().startsWith('<!')
        });
        
        // If we get HTML, likely an auth/endpoint issue
        if (responseText.trim().startsWith('<!')) {
          throw new Error(`Operate API returned HTML instead of JSON. Check API endpoint and authentication. Response: ${responseText.substring(0, 100)}...`);
        } else {
          throw new Error(`Invalid JSON response from Operate API: ${parseError.message}`);
        }
      }
      
      if (userData.users && userData.users.length > 0) {
        operateUserId = userData.users[0].id;
        console.log("✅ [handleAppMention] User found in Operate:", operateUserId);
      } else {
        console.log("➕ [handleAppMention] User not found, creating new user...");
        // Create new user in Operate
        const firstName = userInfo.user?.profile?.first_name || userInfo.user?.real_name?.split(" ")[0] || "User";
        
        const createUserPayload = {
          email,
          first_name: firstName,
        };
        console.log("📤 [handleAppMention] Creating user with payload:", createUserPayload);
        
        const createUserResponse = await fetch(`${operateBaseUrl}/api/users`, {
          method: "POST",
          headers: {
            "X-Operate-API-Key": operateApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(createUserPayload),
        });
        
        console.log("📥 [handleAppMention] Create user response:", {
          status: createUserResponse.status,
          ok: createUserResponse.ok,
          statusText: createUserResponse.statusText
        });
        
        const newUserData = await createUserResponse.json();
        console.log("👤 [handleAppMention] New user data:", newUserData);
        operateUserId = newUserData.id;
      }
      
      console.log("💾 [handleAppMention] Caching user mapping:", {
        slackUserId: event.user,
        operateUserId
      });
      // Cache the mapping
      userCache.set(event.user, operateUserId);
    }
    
    console.log("❓ [handleAppMention] Step 6: Extracting question from mention...");
    // Step 6: Extract question from the mention
    const question = event.text.replace(/<@[^>]+>/g, "").trim();
    console.log("🗨️ [handleAppMention] Question extracted:", {
      originalText: event.text,
      extractedQuestion: question,
      hasQuestion: !!question
    });
    
    if (!question) {
      console.warn("⚠️ [handleAppMention] No question found in mention");
      await slack.chat.postMessage({
        channel: event.channel,
        text: "Hi! Please ask me a specific question about your system. For example: 'Why is checkout failing?' or 'What's causing the API slowdown?'",
        thread_ts: event.ts,
      });
      return;
    }
    
    console.log("🔧 [handleAppMention] Step 7: Triggering investigation in Operate...");
    // Step 7: Trigger investigation in Operate
    // Try different possible endpoints
    const possibleEndpoints = [
      '/api/agent-interactions',
      '/api/interactions', 
      '/api/chat',
      '/api/query',
      '/api/ask'
    ];
    
    const investigationUrl = `${operateBaseUrl}${possibleEndpoints[0]}`;
    const investigationPayload = {
      query: question,
    };
    
    console.log("📤 [handleAppMention] Sending investigation request:", {
      url: investigationUrl,
      payload: investigationPayload,
      headers: {
        "X-Operate-API-Key": operateApiKey?.substring(0, 12) + "...",
        "X-Operate-User-Id": operateUserId,
        "Content-Type": "application/json"
      }
    });
    
    const investigationResponse = await fetch(investigationUrl, {
      method: "POST",
      headers: {
        "X-Operate-API-Key": operateApiKey,
        "X-Operate-User-Id": operateUserId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(investigationPayload),
    });
    
    console.log("📥 [handleAppMention] Investigation response:", {
      status: investigationResponse.status,
      ok: investigationResponse.ok,
      statusText: investigationResponse.statusText,
      headers: Object.fromEntries(investigationResponse.headers.entries())
    });
    
    if (!investigationResponse.ok) {
      const errorText = await investigationResponse.text();
      console.error("❌ [handleAppMention] Operate API error:", {
        status: investigationResponse.status,
        statusText: investigationResponse.statusText,
        errorBody: errorText,
        url: investigationUrl
      });
      
      // If 404/405, the endpoint might not exist - try alternative endpoints
      if (investigationResponse.status === 404 || investigationResponse.status === 405) {
        console.log("🔄 [handleAppMention] Trying alternative endpoints...");
        for (let i = 1; i < possibleEndpoints.length; i++) {
          const altUrl = `${operateBaseUrl}${possibleEndpoints[i]}`;
          console.log(`📤 [handleAppMention] Trying endpoint: ${altUrl}`);
          
          try {
            const altResponse = await fetch(altUrl, {
              method: "POST",
              headers: {
                "X-Operate-API-Key": operateApiKey,
                "X-Operate-User-Id": operateUserId,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(investigationPayload),
            });
            
            if (altResponse.ok) {
              console.log(`✅ [handleAppMention] Alternative endpoint worked: ${altUrl}`);
              const result = await altResponse.json();
              console.log("📊 [handleAppMention] Investigation result:", result);
              
              // Post result back to Slack
              const responseText = `🔍 Investigation complete!\n\n${result.response || result.answer || result.message || "I've analyzed your system but couldn't find specific details about this issue. Please check the Operate dashboard for more information."}`;
              
              await slack.chat.postMessage({
                channel: event.channel,
                text: responseText,
                thread_ts: event.ts,
              });
              
              console.log("✅ [handleAppMention] Successfully completed app mention processing with alternative endpoint");
              return; // Exit successfully
            }
          } catch (altError) {
            console.log(`❌ [handleAppMention] Alternative endpoint ${altUrl} failed:`, altError.message);
          }
        }
      }
      
      throw new Error(`Operate API error: ${investigationResponse.status} - ${errorText}`);
    }
    
    const result = await investigationResponse.json();
    console.log("📊 [handleAppMention] Investigation result:", result);
    
    console.log("💬 [handleAppMention] Step 8: Posting result back to Slack...");
    // Step 8: Post result back to Slack
    const responseText = `🔍 Investigation complete!\n\n${result.response || result.answer || "I've analyzed your system but couldn't find specific details about this issue. Please check the Operate dashboard for more information."}`;
    
    console.log("📤 [handleAppMention] Slack message payload:", {
      channel: event.channel,
      thread_ts: event.ts,
      textPreview: responseText.substring(0, 100) + "..."
    });
    
    await slack.chat.postMessage({
      channel: event.channel,
      text: responseText,
      thread_ts: event.ts,
    });
    
    console.log("✅ [handleAppMention] Successfully completed app mention processing");
    
  } catch (error) {
    console.error("❌ [handleAppMention] Error handling app mention:", {
      error: error.message,
      stack: error.stack,
      name: error.name
    });
    
    try {
      console.log("📱 [handleAppMention] Posting error message to Slack...");
      await slack.chat.postMessage({
        channel: event.channel,
        text: `❌ Sorry, I encountered an error while investigating your question. Please try again later or check the Operate dashboard directly.`,
        thread_ts: event.ts,
      });
      console.log("✅ [handleAppMention] Error message posted to Slack successfully");
    } catch (postError) {
      console.error("❌ [handleAppMention] Error posting error message to Slack:", {
        error: postError.message,
        stack: postError.stack
      });
    }
  }
}

export const handler = define.handlers({
  async POST(ctx) {
    console.log("🌐 [SlackEvents] POST request received");
    
    try {
      const body: SlackEvent = await ctx.req.json();
      console.log("📥 [SlackEvents] Request body parsed:", {
        type: body.type,
        hasChallenge: !!body.challenge,
        hasEvent: !!body.event,
        eventType: body.event?.type || "none"
      });
      
      // Handle URL verification challenge
      if (body.challenge) {
        console.log("🔗 [SlackEvents] URL verification challenge received:", body.challenge);
        return new Response(body.challenge, {
          headers: { "Content-Type": "text/plain" },
        });
      }
      
      // Handle app mention events AND message events that mention the bot
      if (body.type === "event_callback" && 
          (body.event?.type === "app_mention" || 
           (body.event?.type === "message" && body.event?.text?.includes("<@") && !body.event?.bot_id))) {
        
        // Prevent processing our own bot messages or messages in threads we already responded to
        if (body.event?.bot_id) {
          console.log("🤖 [SlackEvents] Ignoring bot message");
          return new Response("OK", { status: 200 });
        }
        
        console.log("💬 [SlackEvents] Bot mention detected:", {
          eventType: body.event.type,
          isAppMention: body.event.type === "app_mention",
          isMessageMention: body.event.type === "message" && body.event?.text?.includes("<@"),
          text: body.event?.text,
          user: body.event?.user,
          channel: body.event?.channel,
          hasThreadTs: !!body.event?.thread_ts
        });
        
        // Process async to avoid Slack timeout
        handleAppMention(body.event).catch((error) => {
          console.error("❌ [SlackEvents] Error in async handleAppMention:", {
            error: error.message,
            stack: error.stack
          });
        });
        
        console.log("✅ [SlackEvents] Returning OK response to Slack");
        return new Response("OK", { status: 200 });
      }
      
      console.log("⚠️ [SlackEvents] Event not handled:", {
        type: body.type,
        eventType: body.event?.type
      });
      return new Response("Event not handled", { status: 200 });
      
    } catch (error) {
      console.error("❌ [SlackEvents] Error processing Slack event:", {
        error: error.message,
        stack: error.stack,
        name: error.name
      });
      return new Response("Internal Server Error", { status: 500 });
    }
  },
});