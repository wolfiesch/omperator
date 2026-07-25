export const PROTOCOL_VERSION = "omp-app/1" as const;
/** Schema compatibility version, intentionally independent from the T4 release package version. */
export const APP_WIRE_VERSION = "0.7.0" as const;
export const MAX_INPUT_BYTES = 1_048_576;
export const MAX_TRANSCRIPT_LINE_BYTES = 10_485_760;
export const MAX_STRING_BYTES = 65_536;
export const MAX_ID_BYTES = 256;
export const MAX_ARRAY_ITEMS = 1_000;
export const MAX_MAP_KEYS = 512;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 20_000;
export const MAX_CAPABILITIES = 128;
export const MAX_TERMINAL_OUTPUT_BYTES = 256_000;
export const MAX_FILE_BYTES = 768 * 1024;
/** Raw bytes carried by one base64 image-upload command. */
export const IMAGE_UPLOAD_CHUNK_BYTES = 256 * 1024;
export const IMAGE_UPLOAD_CHUNK_BASE64_BYTES = Math.ceil(IMAGE_UPLOAD_CHUNK_BYTES / 3) * 4;
export const IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const PROMPT_IMAGE_MAX_COUNT = 8;
/** Raw bytes returned by one transcript-image read command. */
export const TRANSCRIPT_IMAGE_CHUNK_BYTES = 256 * 1024;
export const TRANSCRIPT_IMAGE_CHUNK_BASE64_BYTES = Math.ceil(TRANSCRIPT_IMAGE_CHUNK_BYTES / 3) * 4;
export const TRANSCRIPT_IMAGE_MAX_BYTES = IMAGE_UPLOAD_MAX_BYTES;
export const TRANSCRIPT_IMAGE_MAX_COUNT = 64;
/** Maximum descriptors retained on one durable entry. */
export const MAX_ARTIFACTS_PER_ENTRY = 64;
/** Maximum file summaries retained for one turn review. */
export const MAX_TURN_FILE_CHANGES = 4_096;
/** Raw bytes returned by one generic artifact read command. */
export const ARTIFACT_CHUNK_BYTES = 256 * 1024;
export const ARTIFACT_CHUNK_BASE64_BYTES = Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4;
export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
/** Raw bytes returned by one preview-capture read command. */
export const PREVIEW_CAPTURE_CHUNK_BYTES = 256 * 1024;
export const PREVIEW_CAPTURE_CHUNK_BASE64_BYTES = Math.ceil(PREVIEW_CAPTURE_CHUNK_BYTES / 3) * 4;
export const PREVIEW_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
export const PREVIEW_CAPTURE_MAX_PIXELS = 16 * 1024 * 1024;
export const PREVIEW_MAX_PER_SESSION = 8;
export const PREVIEW_TEXT_INPUT_BYTES = 8 * 1024;
export const PREVIEW_SCROLL_DELTA_LIMIT = 100_000;
export const PREVIEW_SELECTOR_BYTES = 4 * 1024;
export const PREVIEW_HANDOFF_MESSAGE_BYTES = 2 * 1024;
export const PREVIEW_LEASE_TTL_MAX_MS = 10 * 60 * 1000;
export const PREVIEW_HANDOFF_TIMEOUT_MAX_MS = 10 * 60 * 1000;
export const MAX_SAVED_CURSORS = 128;
export const MAX_EPOCH_BYTES = 128;
