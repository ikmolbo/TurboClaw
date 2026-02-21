import { writeOutgoing } from "../../lib/queue";
import type { Config } from "../../config/index";

export async function sendCommand(args: string[], config?: Config): Promise<void> {
  // Get agent ID from env
  const agentId = process.env.TURBOCLAW_AGENT_ID;
  if (!agentId) {
    console.error("Error: TURBOCLAW_AGENT_ID environment variable is not set");
    process.exit(1);
  }

  // Parse --message flag
  const msgIndex = args.indexOf("--message");
  const message = msgIndex !== -1 ? args[msgIndex + 1] : undefined;

  if (!message) {
    console.error("Error: --message flag is required");
    process.exit(1);
  }

  if (message.trim() === "") {
    console.error("Error: --message value cannot be empty");
    process.exit(1);
  }

  // Get queue dir from env or use default
  const queueDir = process.env.TURBOCLAW_QUEUE_DIR;

  // Get agent config for telegram details
  const agentConfig = config?.agents?.[agentId];
  const botToken = agentConfig?.telegram?.bot_token;
  const chatId = agentConfig?.telegram?.chat_id;

  // Write to outgoing queue
  await writeOutgoing(
    {
      channel: "telegram",
      senderId: chatId ? String(chatId) : agentId,
      message,
      timestamp: Date.now(),
      ...(botToken && { botToken }),
    },
    queueDir
  );
}
