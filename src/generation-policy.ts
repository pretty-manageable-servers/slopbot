// Execution bounds are shared by native streaming and the envelope parser.
export const DEFAULT_MAX_TOOL_ROUNDS = 64;
export const MAX_TOOL_CALLS_PER_BATCH = 64;
export const MAX_TOOL_ARGUMENT_CHARS = 64000;
export const MAX_PROVIDER_EVENT_CHARS = 2000000;
// An engineering allowance for the file reader's bounded image frames, not a
// billing token count. Encoded image bytes are not literal model text tokens.
export const IMAGE_INPUT_RESERVE = 8192;
