import { define } from "../../../utils.ts";
import { WebClient } from "@slack/web-api";

interface StreamEvent {
  event_type: string;
  data: {
    content?: string;
    code?: string;
    message?: string;
    response_message?: string;
  };
}

function parseSSEEvent(eventString: string): StreamEvent | null {
  const lines = eventString.split('\n');
  let data = '';

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      data = line.slice(6); // Remove 'data: ' prefix
      break;
    }
  }

  if (!data || data === '[DONE]') return null;

  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}

function handleStreamEvent(event: StreamEvent): string {
  switch (event.event_type) {
    case 'content_delta':
    case 'message_chunk':
      return event.data.content || '';

    case 'content_complete':
      return '\n\n---\n\n';

    case 'completion':
      return event.data.response_message || '';

    case 'error':
      throw new Error(`Operate error: ${event.data.code} - ${event.data.message}`);

    case 'tool_use_start':
      return `🔧 Using tool...\n`;

    case 'tool_use_complete':
      return `✅ Tool completed\n`;

    default:
      console.log(`🤷 [handleStreamEvent] Unknown event type: ${event.event_type}`);
      return '';
  }
}

async function tryStreamingEndpoint(operateBaseUrl: string, operateApiKey: string, operateUserId: string, question: string): Promise<string> {
  const investigationUrl = `${operateBaseUrl}/api/agent/chat/stream`;
  const investigationPayload = { message: question, history: [] };
  
  console.log("📤 [tryStreamingEndpoint] Attempting streaming request:", { url: investigationUrl });
  
  const response = await fetch(investigationUrl, {
    method: "POST",
    headers: {
      "X-Operate-API-Key": operateApiKey,
      "X-Operate-User-Id": operateUserId,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache"
    },
    body: JSON.stringify(investigationPayload),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Streaming API error: ${response.status} - ${errorText}`);
  }
  
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body reader available");
  
  const decoder = new TextDecoder();
  let buffer = '';
  let finalContent = '';
  let eventCount = 0;
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE events (separated by \n\n)
      const events = buffer.split('\n\n');
      buffer = events.pop() || ''; // Keep incomplete event in buffer
      
      for (const eventString of events) {
        if (eventString.trim()) {
          const parsed = parseSSEEvent(eventString);
          if (parsed) {
            eventCount++;
            console.log(`📨 [tryStreamingEndpoint] SSE event ${eventCount}:`, parsed);
            
            try {
              const content = handleStreamEvent(parsed);
              finalContent += content;
              
              // Break on completion events
              if (parsed.event_type === 'completion') {
                break;
              }
            } catch (eventError) {
              console.error("❌ [tryStreamingEndpoint] Event handling error:", eventError.message);
              throw eventError;
            }
          }
        }
      }
    }
    
    // Process any remaining buffer content
    if (buffer.trim()) {
      const parsed = parseSSEEvent(buffer);
      if (parsed) {
        finalContent += handleStreamEvent(parsed);
      }
    }
    
  } finally {
    reader.releaseLock();
  }
  
  console.log(`📊 [tryStreamingEndpoint] Processed ${eventCount} events, final content length: ${finalContent.length}`);
  return finalContent.trim();
}

async function tryFallbackEndpoints(operateBaseUrl: string, operateApiKey: string, operateUserId: string, question: string): Promise<string> {
  const endpoints = [
    `${operateBaseUrl}/api/agent/chat`,
    `${operateBaseUrl}/api/agent-interactions`,
    `${operateBaseUrl}/api/chat`
  ];
  
  for (const endpoint of endpoints) {
    try {
      console.log(`📤 [tryFallbackEndpoints] Trying: ${endpoint}`);
      
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "X-Operate-API-Key": operateApiKey,
          "X-Operate-User-Id": operateUserId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: question,
          query: question, // Some APIs might expect 'query' instead
          history: []
        }),
      });
      
      if (response.ok) {
        const data = await response.text();
        console.log(`✅ [tryFallbackEndpoints] Success with: ${endpoint}`);
        
        try {
          const json = JSON.parse(data);
          return json.response || json.message || json.answer || JSON.stringify(json);
        } catch {
          return data; // Return raw text if not JSON
        }
      }
      
      console.log(`❌ [tryFallbackEndpoints] Failed ${endpoint}: ${response.status}`);
    } catch (error) {
      console.log(`❌ [tryFallbackEndpoints] Error with ${endpoint}:`, error.message);
    }
  }
  
  throw new Error("All API endpoints failed");
}

function splitMessageForSlack(content: string, maxLength = 2900): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];
  let currentChunk = '';

  const lines = content.split('\n');

  for (const line of lines) {
    // If adding this line would exceed the limit
    if (currentChunk.length + line.length + 1 > maxLength) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If a single line is too long, split it by sentences or words
      if (line.length > maxLength) {
        const words = line.split(' ');
        let wordChunk = '';
        
        for (const word of words) {
          if (wordChunk.length + word.length + 1 > maxLength) {
            if (wordChunk.trim()) {
              chunks.push(wordChunk.trim());
              wordChunk = '';
            }
          }
          wordChunk += (wordChunk ? ' ' : '') + word;
        }
        
        if (wordChunk.trim()) {
          currentChunk = wordChunk;
        }
      } else {
        currentChunk = line;
      }
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

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
  const operateBaseUrl = Deno.env.get("OPERATE_BASE_URL") || "https://recharger-spotlight-virus.ngrok-free.dev/operate";
  
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
      
      if (userData.items && userData.items.length > 0) {
        operateUserId = userData.items[0].id;
        console.log("✅ [handleAppMention] User found in Operate:", operateUserId);
      } else {
        console.log("➕ [handleAppMention] User not found, creating new user...");
        // Create new user in Operate
        const firstName = userInfo.user?.profile?.first_name || userInfo.user?.real_name?.split(" ")[0] || "User";
        
        const createUserPayload = {
          email,
          first_name: firstName,
          role: "member",
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
        
        if (createUserResponse.ok) {
          const newUserData = await createUserResponse.json();
          console.log("👤 [handleAppMention] New user data:", newUserData);
          operateUserId = newUserData.id;
        } else {
          const errorText = await createUserResponse.text();
          console.error("❌ [handleAppMention] User creation failed:", {
            status: createUserResponse.status,
            error: errorText
          });
          
          // If user creation fails, we can't proceed without a user ID
          await slack.chat.postMessage({
            channel: event.channel,
            text: "Sorry, I couldn't set up your account in Operate. Please contact your admin to create an account for you, then try again.",
            thread_ts: event.ts,
          });
          return;
        }
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
    
    let responseMessage = "";
    
    // Try streaming endpoint first, fallback to regular chat if it fails
    try {
      responseMessage = await tryStreamingEndpoint(operateBaseUrl, operateApiKey, operateUserId, question);
    } catch (streamError) {
      console.log("⚠️ [handleAppMention] Streaming failed, trying fallback endpoints...", streamError.message);
      responseMessage = await tryFallbackEndpoints(operateBaseUrl, operateApiKey, operateUserId, question);
    }
    
    console.log("📊 [handleAppMention] Final response message:", {
      length: responseMessage.length,
      preview: responseMessage.substring(0, 200) + "..."
    });
    
    console.log("💬 [handleAppMention] Step 8: Posting result back to Slack...");
    // Step 8: Post result back to Slack with chunking for long responses
    const finalMessage = responseMessage.trim() || "I've analyzed your system but couldn't find specific details about this issue. Please check the Operate dashboard for more information.";
    const responseText = `🔍 Investigation complete!\n\n${finalMessage}`;
    
    // Split message if it exceeds Slack's limits
    const messageChunks = splitMessageForSlack(responseText);
    
    console.log("📤 [handleAppMention] Sending response in chunks:", {
      channel: event.channel,
      thread_ts: event.ts,
      totalChunks: messageChunks.length,
      originalLength: responseText.length
    });
    
    // Send each chunk as a separate message in the thread
    for (let i = 0; i < messageChunks.length; i++) {
      const chunk = messageChunks[i];
      const isFirstChunk = i === 0;
      const isLastChunk = i === messageChunks.length - 1;
      
      let messageText = chunk;
      
      // Add chunk indicators for multi-part messages
      if (messageChunks.length > 1) {
        if (isFirstChunk) {
          messageText = `${chunk}\n\n_[Part ${i + 1} of ${messageChunks.length}]_`;
        } else if (isLastChunk) {
          messageText = `_[Part ${i + 1} of ${messageChunks.length}]_\n\n${chunk}`;
        } else {
          messageText = `_[Part ${i + 1} of ${messageChunks.length}]_\n\n${chunk}`;
        }
      }
      
      await slack.chat.postMessage({
        channel: event.channel,
        text: messageText,
        thread_ts: event.ts,
        mrkdwn: true, // Enable Slack markdown formatting
      });
      
      // Small delay between chunks to avoid rate limits
      if (!isLastChunk) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
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