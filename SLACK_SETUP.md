# Slack Integration Setup

This project integrates Slack with the Operate platform to provide AI-powered debugging assistance.

## Environment Variables

Create a `.env` file with the following variables:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
OPERATE_API_KEY=op_live_abc123...
OPERATE_BASE_URL=https://recharger-spotlight-virus.ngrok-free.dev/operate/api
```

## Slack App Configuration

1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From an app manifest"
3. Copy the contents of `slack-app-manifest.yaml`
4. Install the app to your workspace
5. Copy the Bot User OAuth Token to `SLACK_BOT_TOKEN`

## Deployment

1. Deploy to Deno Deploy using the provided Deno button or manually
2. Update the request URLs in your Slack app settings to point to your deployed endpoint
3. The endpoints will be:
   - Events: `https://examples-with-fresh.pateldp2024.deno.net/api/slack/events`
   - Interactive: `https://examples-with-fresh.pateldp2024.deno.net/api/slack/interactive`

## Environment Setup for Deno Deploy

Set these environment variables in your Deno Deploy dashboard:
- `SLACK_BOT_TOKEN`: Get from your Slack app's OAuth & Permissions page  
- `OPERATE_API_KEY`: Your Operate API key (format: `op_live_...`)
- `OPERATE_BASE_URL`: `https://recharger-spotlight-virus.ngrok-free.dev/operate/api`

## Flow

1. Engineer mentions `@operate` in Slack: "@operate why is checkout failing?"
2. Slack sends `app_mention` event to `/api/slack/events`
3. System looks up user by Slack ID → email → Operate user ID
4. If user doesn't exist in Operate, creates them automatically
5. Sends question to Operate API with proper authentication
6. Posts Operate's response back to Slack thread

## Testing Locally

```bash
deno task dev
```

For local testing with Slack, you'll need to expose your local server using ngrok or similar:

```bash
ngrok http 8000
```

Then update your Slack app's request URLs to use the ngrok URL.