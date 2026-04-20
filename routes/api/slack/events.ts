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

function parseSSEEvent(line: string): StreamEvent | null {
  if (!line.startsWith('data: ')) return null;
  
  const data = line.slice(6).trim(); // Remove 'data: ' prefix
  if (!data || data === '[DONE]') return null;

  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}

function handleStreamEvent(event: StreamEvent): string {
  switch (event.event_type) {
    case 'tool_call':
      return `🔧 **${event.data.tool}**: ${event.data.command}\n`;

    case 'tool_result':
      const isError = event.data.is_error;
      const emoji = isError ? '❌' : '✅';
      return `${emoji} **Result** (exit ${event.data.exit_code}):\n\`\`\`\n${event.data.output || 'No output'}\n\`\`\`\n\n`;

    case 'message':
      return event.data.content || '';

    case 'complete':
      // Don't add extra content for completion - the final message is already sent
      return '';

    case 'error':
      throw new Error(`Operate error: ${event.data.code} - ${event.data.message}`);

    default:
      console.log(`🤷 [handleStreamEvent] Unknown event type: ${event.event_type}`, event);
      return '';
  }
}

async function tryStreamingEndpoint(operateBaseUrl: string, operateApiKey: string, operateUserId: string, question: string): Promise<string> {
  const investigationUrl = `${operateBaseUrl}/api/agent/chat/stream`;
  const investigationPayload = { message: question, history: [] };
  
  console.log("📤 [tryStreamingEndpoint] Attempting streaming request:", { url: investigationUrl });
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
  
  const response = await fetch(investigationUrl, {
    method: "POST",
    headers: {
      "X-Operate-API-Key": operateApiKey,
      "X-Operate-User-Id": operateUserId,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity", // Prevent gzip buffering for Safari
      "Cache-Control": "no-cache"
    },
    body: JSON.stringify(investigationPayload),
    signal: controller.signal,
  });
  
  clearTimeout(timeoutId);
  
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
      
      // Check for early termination or unexpected EOF
      if (buffer.includes('unexpected EOF')) {
        throw new Error("Stream terminated unexpectedly (unexpected EOF)");
      }
      
      // Process complete lines - split by newline like the Operate frontend
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        // Skip keepalive and empty lines
        if (!line.trim() || line.startsWith(': ')) continue;
        
        const parsed = parseSSEEvent(line);
        if (parsed) {
          eventCount++;
          console.log(`📨 [tryStreamingEndpoint] SSE event ${eventCount}:`, parsed);
          
          try {
            const content = handleStreamEvent(parsed);
            finalContent += content;
            
            // Break on completion events
            if (parsed.event_type === 'complete') {
              break;
            }
          } catch (eventError) {
            console.error("❌ [tryStreamingEndpoint] Event handling error:", eventError.message);
            throw eventError;
          }
        }
      }
    }
    
    // If we got no events but the stream ended, that's suspicious
    if (eventCount === 0 && finalContent.length === 0) {
      throw new Error("Stream ended without any valid SSE events");
    }
    
    // Process any remaining buffer content
    if (buffer.trim()) {
      const parsed = parseSSEEvent(buffer);
      if (parsed) {
        finalContent += handleStreamEvent(parsed);
      }
    }
    
  } catch (error) {
    reader.releaseLock();
    throw error;
  } finally {
    if (reader.locked) {
      reader.releaseLock();
    }
  }
  
  console.log(`📊 [tryStreamingEndpoint] Processed ${eventCount} events, final content length: ${finalContent.length}`);
  return finalContent.trim();
}

// Note: No fallback endpoints exist in Operate backend - only streaming is supported
async function tryFallbackEndpoints(operateBaseUrl: string, operateApiKey: string, operateUserId: string, question: string): Promise<string> {
  console.log("⚠️ [tryFallbackEndpoints] No fallback endpoints available - Operate only supports streaming");
  throw new Error("Only streaming endpoint is available - no fallback options");
}

async function tryStreamingEndpointWithCallbacks(
  operateBaseUrl: string, 
  operateApiKey: string, 
  operateUserId: string, 
  question: string,
  callbacks: {
    onToolCall: (tool: string, command: string) => void;
    onToolResult: (exitCode: number, isError: boolean, output: string) => void;
    onMessage: (content: string) => void;
    onComplete: () => void;
    onError: (error: string) => void;
  }
): Promise<void> {
  const investigationUrl = `${operateBaseUrl}/api/agent/chat/stream`;
  const investigationPayload = { message: question, history: [] };
  
  console.log("📤 [tryStreamingEndpointWithCallbacks] Starting stream:", { url: investigationUrl });
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log("⏰ [tryStreamingEndpointWithCallbacks] Stream timeout after 60 seconds");
    controller.abort();
  }, 60000); // 60 second timeout for long AI processing
  
  try {
    const response = await fetch(investigationUrl, {
      method: "POST",
      headers: {
        "X-Operate-API-Key": operateApiKey,
        "X-Operate-User-Id": operateUserId,
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache"
      },
      body: JSON.stringify(investigationPayload),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Streaming API error: ${response.status} - ${errorText}`);
    }
    
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body reader available");
    
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;
    
    // Recursive processing function like Operate frontend
    const processChunk = async (): Promise<void> => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`📡 [tryStreamingEndpointWithCallbacks] Stream ended - received ${eventCount} events`);
          if (eventCount === 0) {
            callbacks.onError('No events received from backend - possible authentication or processing error');
          } else {
            callbacks.onComplete();
          }
          return;
        }
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        
        // Process each line immediately like Operate frontend
        for (const line of lines) {
          if (!line.trim() || line.startsWith(': ')) continue;
          
          const parsed = parseSSEEvent(line);
          if (parsed) {
            eventCount++;
            console.log(`📨 [tryStreamingEndpointWithCallbacks] Event ${eventCount}:`, parsed.event_type);
            
            try {
              switch (parsed.event_type) {
                case 'tool_call':
                  callbacks.onToolCall(parsed.data.tool || 'unknown', parsed.data.command || '');
                  break;
                case 'tool_result':
                  callbacks.onToolResult(
                    parsed.data.exit_code || 0,
                    parsed.data.is_error || false,
                    parsed.data.output || ''
                  );
                  break;
                case 'message':
                  callbacks.onMessage(parsed.data.content || '');
                  break;
                case 'complete':
                  callbacks.onComplete();
                  return; // End stream processing
                case 'error':
                  callbacks.onError(`${parsed.data.code} - ${parsed.data.message}`);
                  return;
              }
            } catch (eventError) {
              console.error("❌ [tryStreamingEndpointWithCallbacks] Event error:", eventError);
            }
          }
        }
        
        // Continue processing recursively
        await processChunk();
      } catch (readError) {
        console.log("📡 [tryStreamingEndpointWithCallbacks] Stream read error:", readError.message);
        // Check if this is unexpected EOF
        if (readError.message.includes('unexpected EOF') || readError.message.includes('EOF')) {
          callbacks.onError('Backend stream terminated unexpectedly - possible server-side processing error');
        } else {
          // Stream closed or aborted normally
          callbacks.onComplete();
        }
      }
    };
    
    await processChunk();
    
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === 'AbortError') {
      callbacks.onError('Request timeout');
    } else {
      callbacks.onError(error.message || 'Network error');
    }
    throw error;
  }
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
    
    console.log("🔧 [handleAppMention] Step 7: Starting streaming investigation...");
    
    // Post initial loading message
    const loadingResponse = await slack.chat.postMessage({
      channel: event.channel,
      text: "🔍 Investigating your question...",
      thread_ts: event.ts,
      mrkdwn: true,
    });
    
    const messageTs = loadingResponse.ts;
    if (!messageTs) {
      throw new Error("Failed to get message timestamp for updates");
    }

    // Stream content and update message in real-time
    let streamingContent = "";
    let toolTrace: string[] = [];
    
    const streamCallbacks = {
      onToolCall: (tool: string, command: string) => {
        toolTrace.push(`🔧 **${tool}**: \`${command}\``);
        updateSlackMessage();
      },
      onToolResult: (exitCode: number, isError: boolean, output: string) => {
        const emoji = isError ? '❌' : '✅';
        toolTrace[toolTrace.length - 1] += `\n${emoji} **Result** (exit ${exitCode}):\n\`\`\`\n${output.substring(0, 500)}${output.length > 500 ? '...' : ''}\n\`\`\``;
        updateSlackMessage();
      },
      onMessage: (content: string) => {
        streamingContent = content;
        updateSlackMessage();
      },
      onComplete: () => {
        console.log("✅ [handleAppMention] Stream completed successfully");
      },
      onError: (error: string) => {
        console.error("❌ [handleAppMention] Stream error:", error);
      }
    };

    const updateSlackMessage = async () => {
      try {
        const toolSection = toolTrace.length > 0 ? toolTrace.join('\n\n') + '\n\n---\n\n' : '';
        const messageSection = streamingContent || "🔍 Processing...";
        const fullText = `🔍 **Investigation in progress...**\n\n${toolSection}${messageSection}`;
        
        const chunks = splitMessageForSlack(fullText);
        await slack.chat.update({
          channel: event.channel,
          ts: messageTs,
          text: chunks[0], // Use first chunk for update
          mrkdwn: true,
        });
        
        // If there are additional chunks, post them as follow-ups
        for (let i = 1; i < chunks.length; i++) {
          await slack.chat.postMessage({
            channel: event.channel,
            text: `_[Continued ${i + 1}/${chunks.length}]_\n\n${chunks[i]}`,
            thread_ts: event.ts,
            mrkdwn: true,
          });
        }
      } catch (updateError) {
        console.error("❌ [updateSlackMessage] Failed to update:", updateError);
      }
    };

    // Try streaming with real-time updates
    try {
      await tryStreamingEndpointWithCallbacks(operateBaseUrl, operateApiKey, operateUserId, question, streamCallbacks);
      
      // Final update with completion status
      const toolSection = toolTrace.length > 0 ? toolTrace.join('\n\n') + '\n\n---\n\n' : '';
      const finalText = `✅ **Investigation complete!**\n\n${toolSection}${streamingContent || "No specific details found. Please check the Operate dashboard."}`;
      
      const chunks = splitMessageForSlack(finalText);
      await slack.chat.update({
        channel: event.channel,
        ts: messageTs,
        text: chunks[0],
        mrkdwn: true,
      });
      
    } catch (streamError) {
      console.error("❌ [handleAppMention] Streaming failed:", {
        error: streamError.message,
        stack: streamError.stack,
        operateBaseUrl,
        hasApiKey: !!operateApiKey,
        hasUserId: !!operateUserId
      });
      
      await slack.chat.update({
        channel: event.channel,
        ts: messageTs,
        text: `❌ **Investigation failed**\n\nStreaming error: ${streamError.message}\n\nPlease try again or check the Operate dashboard.`,
        mrkdwn: true,
      });
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