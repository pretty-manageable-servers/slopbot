import { z } from "zod";

export const Conversation = z.object({ server: z.string().min(1), channel: z.string().min(1) });

/** The provider tool call ID, or call_<stableOperationId(turn.id, index)> (src/agent-runner.ts:335). */
export const CallId = z.string().min(1).max(256);

export const ToolStatus = z.enum(["running", "completed", "rejected", "failed", "delegated"]);

export const ChatMessage = z.object({            // the same fields as TranscriptMessage, src/run-events.ts:71
  id: z.string(), channel: z.string(), author: z.string(), authorName: z.string(),
  username: z.string().nullable(), avatarUrl: z.string().nullable(), text: z.string(),
  timestamp: z.number().nullable(), editedAt: z.number().nullable(), slopbot: z.boolean(),
  runIds: z.array(z.string()), used: z.boolean(),
  images: z.array(z.object({ imageId: z.string(), name: z.string(), contentType: z.string(), size: z.number() })).optional(),
  remoteImages: z.array(z.object({ src: z.string(), name: z.string(), size: z.number() })).optional(),
  files: z.array(z.unknown()).optional(),        // ChatFileView, src/web-chat-files.ts:19
  ui: z.object({ id: z.string(), revision: z.number().int(), document: z.unknown() }).optional(),
});

const turn = z.string().min(1);                  // the request message ID
const run = z.string().min(1);                   // one model round

export const EngineEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn.start"), turn }),
  z.object({ type: z.literal("round.start"), turn, run }),
  z.object({ type: z.literal("text.delta"), turn, run, text: z.string() }),
  z.object({ type: z.literal("thinking.delta"), turn, run, text: z.string() }),
  z.object({ type: z.literal("tool.input"), turn, run, call: CallId, name: z.string(), text: z.string() }),
  z.object({ type: z.literal("tool.status"), turn, call: CallId, name: z.string(), status: ToolStatus,
    input: z.unknown().optional(),                // full arguments, never cut to 300 characters
    result: z.string().max(500).optional(),       // MAX_RESULT_CHARS, src/web-transcripts.ts
    reason: z.string().max(2000).optional(), code: z.string().optional(),
    parent: CallId.optional(), durationMs: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("turn.end"), turn, status: z.enum(["done", "failed", "interrupted"]) }),
  z.object({ type: z.literal("message.upsert"), message: ChatMessage }),
  z.object({ type: z.literal("message.delete"), id: z.string() }),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;

export const EngineEnvelope = z.object({
  seq: z.number().int().positive(), at: z.number().int(), conversation: Conversation, event: EngineEvent,
});
export type EngineEnvelope = z.infer<typeof EngineEnvelope>;
