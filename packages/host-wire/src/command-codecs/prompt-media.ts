import { fail } from "../errors.js";
import { boundedArray, boundedMap, boundedText, controlFree, safeRelativePath, safeSeq } from "../guards.js";
import { artifactId, entryId, imageId, leaseId, turnId } from "../ids.js";
import { ARTIFACT_CHUNK_BASE64_BYTES, ARTIFACT_CHUNK_BYTES, ARTIFACT_MAX_BYTES, IMAGE_UPLOAD_CHUNK_BASE64_BYTES, IMAGE_UPLOAD_CHUNK_BYTES, IMAGE_UPLOAD_MAX_BYTES, MAX_STRING_BYTES, PROMPT_IMAGE_MAX_COUNT, TRANSCRIPT_IMAGE_CHUNK_BASE64_BYTES, TRANSCRIPT_IMAGE_CHUNK_BYTES, TRANSCRIPT_IMAGE_MAX_BYTES } from "../limits.js";
import { args, result, strictArgs } from "./shared.js";
import { PROMPT_IMAGE_MIME_TYPES, type ArtifactReadArguments, type ArtifactReadChunk, type CommandResult, type PromptImageMimeType, type SessionImageBeginArguments, type SessionImageChunkArguments, type SessionImageDiscardArguments, type SessionImageReadArguments, type SessionPromptArguments, type TurnReviewApplyResult } from "./types.js";

export function decodeSessionPromptArguments(value: unknown): SessionPromptArguments {
	const x = args(value);
	const keys = Object.keys(x);
	if (!Object.hasOwn(x, "message") || keys.some(key => key !== "message" && key !== "leaseId" && key !== "images"))
		fail("INVALID_FRAME", "session.prompt accepts only message, leaseId, and images", "args");
	const message = boundedText(x.message, "args.message", MAX_STRING_BYTES);
	const images =
		x.images === undefined
			? undefined
			: boundedArray(x.images, "args.images", PROMPT_IMAGE_MAX_COUNT).map((value, index) => {
					const ref = boundedMap(value, `args.images[${index}]`);
					if (Object.keys(ref).length !== 1 || !Object.hasOwn(ref, "imageId"))
						fail("INVALID_FRAME", "image reference must contain only imageId", `args.images[${index}]`);
					return { imageId: imageId(ref.imageId, `args.images[${index}].imageId`) };
				});
	if (images?.length === 0) fail("BOUNDS", "prompt images must not be empty", "args.images");
	if (message.length === 0 && images === undefined)
		fail("BOUNDS", "prompt message must be non-empty without images", "args.message");
	const lease = x.leaseId === undefined ? undefined : leaseId(x.leaseId, "args.leaseId");
	return {
		message,
		...(lease === undefined ? {} : { leaseId: lease }),
		...(images === undefined ? {} : { images }),
	};
}
export function decodeImageMimeType(value: unknown, path: string): PromptImageMimeType {
	const mimeType = controlFree(value, path, 32);
	if (!(PROMPT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType))
		fail("INVALID_FRAME", "unsupported prompt image MIME type", path);
	return mimeType as PromptImageMimeType;
}
export function decodeSha256(value: unknown, path: string): string {
	const sha256 = controlFree(value, path, 64);
	if (!/^[a-f0-9]{64}$/u.test(sha256)) fail("INVALID_FRAME", "sha256 must be lowercase hexadecimal", path);
	return sha256;
}
export function decodeImageBegin(value: unknown): SessionImageBeginArguments {
	const x = strictArgs(value, ["mimeType", "size", "sha256"]);
	const size = x.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > IMAGE_UPLOAD_MAX_BYTES)
		fail("BOUNDS", "image size exceeds the upload limit", "args.size");
	return {
		mimeType: decodeImageMimeType(x.mimeType, "args.mimeType"),
		size,
		sha256: decodeSha256(x.sha256, "args.sha256"),
	};
}
export function decodeImageChunk(value: unknown): SessionImageChunkArguments {
	const x = strictArgs(value, ["imageId", "offset", "content"]);
	const offset = safeSeq(x.offset, "args.offset");
	if (offset > IMAGE_UPLOAD_MAX_BYTES) fail("BOUNDS", "image chunk offset exceeds the upload limit", "args.offset");
	const content = boundedText(x.content, "args.content", IMAGE_UPLOAD_CHUNK_BASE64_BYTES);
	if (content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(content))
		fail("INVALID_FRAME", "image chunk content must be canonical base64", "args.content");
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (
		(padding === 2 && (alphabet.indexOf(content[content.length - 3]!) & 0x0f) !== 0) ||
		(padding === 1 && (alphabet.indexOf(content[content.length - 2]!) & 0x03) !== 0)
	)
		fail("INVALID_FRAME", "image chunk content has non-canonical padding bits", "args.content");
	const decodedBytes = (content.length / 4) * 3 - padding;
	if (decodedBytes <= 0 || decodedBytes > IMAGE_UPLOAD_CHUNK_BYTES)
		fail("BOUNDS", "decoded image chunk exceeds the raw chunk limit", "args.content");
	return { imageId: imageId(x.imageId, "args.imageId"), offset, content };
}
export function decodeImageDiscard(value: unknown): SessionImageDiscardArguments {
	const x = strictArgs(value, ["imageId"]);
	return { imageId: imageId(x.imageId, "args.imageId") };
}
export function decodeArtifactRead(value: unknown): ArtifactReadArguments {
	const x = strictArgs(value, ["artifactId", "offset"]);
	const offset = safeSeq(x.offset, "args.offset");
	if (offset >= ARTIFACT_MAX_BYTES) fail("BOUNDS", "artifact offset exceeds the artifact limit", "args.offset");
	return { artifactId: artifactId(x.artifactId, "args.artifactId"), offset };
}
export function decodeArtifactReadChunk(value: unknown): ArtifactReadChunk {
	const x = result(value);
	const expected = ["artifactId", "kind", "mediaType", "size", "offset", "nextOffset", "complete", "content"];
	if (Object.keys(x).length !== expected.length || expected.some(key => !Object.hasOwn(x, key)))
		fail("INVALID_FRAME", "invalid artifact read result", "result");
	artifactId(x.artifactId, "result.artifactId");
	const kind = controlFree(x.kind, "result.kind", 16);
	if (!["image", "text", "patch", "binary"].includes(kind))
		fail("INVALID_FRAME", "unsupported artifact kind", "result.kind");
	const mediaType = controlFree(x.mediaType, "result.mediaType", 128);
	if (!/^[!#$&^_.+*/-]+\/[!#$&^_.+*/-]+$/u.test(mediaType))
		fail("INVALID_FRAME", "artifact mediaType must be a MIME type", "result.mediaType");
	const size = safeSeq(x.size, "result.size");
	if (size <= 0 || size > ARTIFACT_MAX_BYTES)
		fail("BOUNDS", "artifact size exceeds the artifact limit", "result.size");
	const offset = safeSeq(x.offset, "result.offset");
	const nextOffset = safeSeq(x.nextOffset, "result.nextOffset");
	if (offset >= size || nextOffset <= offset || nextOffset > size)
		fail("INVALID_FRAME", "artifact result offsets are invalid", "result.nextOffset");
	if (typeof x.complete !== "boolean" || x.complete !== (nextOffset === size))
		fail("INVALID_FRAME", "artifact completion does not match its offsets", "result.complete");
	const content = boundedText(x.content, "result.content", ARTIFACT_CHUNK_BASE64_BYTES);
	if (content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(content))
		fail("INVALID_FRAME", "artifact content must be canonical base64", "result.content");
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (
		(padding === 2 && (alphabet.indexOf(content[content.length - 3]!) & 0x0f) !== 0) ||
		(padding === 1 && (alphabet.indexOf(content[content.length - 2]!) & 0x03) !== 0)
	)
		fail("INVALID_FRAME", "artifact content has non-canonical padding bits", "result.content");
	const decodedBytes = (content.length / 4) * 3 - padding;
	if (decodedBytes <= 0 || decodedBytes > ARTIFACT_CHUNK_BYTES || nextOffset - offset !== decodedBytes)
		fail("INVALID_FRAME", "artifact content does not match its offsets", "result.content");
	return x as unknown as ArtifactReadChunk;
}
export function decodeTurnReviewApplyResult(value: unknown): TurnReviewApplyResult {
	const x = result(value);
	const expected = ["turnId", "path", "action", "state", "resultingRevision"];
	if (Object.keys(x).length !== expected.length || expected.some(key => !Object.hasOwn(x, key)))
		fail("INVALID_FRAME", "invalid turn review action result", "result");
	const decodedTurnId = turnId(x.turnId, "result.turnId");
	const path = safeRelativePath(x.path, "result.path");
	if (x.action !== "keep" && x.action !== "discard")
		fail("INVALID_FRAME", "invalid turn review action", "result.action");
	if (x.state !== "applied" && x.state !== "discarded")
		fail("INVALID_FRAME", "invalid turn review action state", "result.state");
	const resultingRevision = controlFree(x.resultingRevision, "result.resultingRevision", 128);
	return {
		turnId: decodedTurnId,
		path,
		action: x.action,
		state: x.state,
		resultingRevision,
	};
}
export function decodeImageRead(value: unknown): SessionImageReadArguments {
	const x = strictArgs(value, ["entryId", "sha256", "offset"]);
	const offset = safeSeq(x.offset, "args.offset");
	if (offset >= TRANSCRIPT_IMAGE_MAX_BYTES)
		fail("BOUNDS", "transcript image offset exceeds the image limit", "args.offset");
	return {
		entryId: entryId(x.entryId, "args.entryId"),
		sha256: decodeSha256(x.sha256, "args.sha256"),
		offset,
	};
}

export function decodeImageReadResult(value: unknown): CommandResult {
	const x = result(value);
	const expected = ["sha256", "mimeType", "size", "offset", "nextOffset", "complete", "content"];
	if (Object.keys(x).length !== expected.length || expected.some(key => !Object.hasOwn(x, key)))
		fail("INVALID_FRAME", "invalid transcript image read result", "result");
	decodeSha256(x.sha256, "result.sha256");
	decodeImageMimeType(x.mimeType, "result.mimeType");
	const size = safeSeq(x.size, "result.size");
	if (size <= 0 || size > TRANSCRIPT_IMAGE_MAX_BYTES)
		fail("BOUNDS", "transcript image size exceeds the image limit", "result.size");
	const offset = safeSeq(x.offset, "result.offset");
	const nextOffset = safeSeq(x.nextOffset, "result.nextOffset");
	if (offset >= size || nextOffset <= offset || nextOffset > size)
		fail("INVALID_FRAME", "transcript image result offsets are invalid", "result.nextOffset");
	if (typeof x.complete !== "boolean" || x.complete !== (nextOffset === size))
		fail("INVALID_FRAME", "transcript image completion does not match its offsets", "result.complete");
	const content = boundedText(x.content, "result.content", TRANSCRIPT_IMAGE_CHUNK_BASE64_BYTES);
	if (content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(content))
		fail("INVALID_FRAME", "transcript image content must be canonical base64", "result.content");
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (
		(padding === 2 && (alphabet.indexOf(content[content.length - 3]!) & 0x0f) !== 0) ||
		(padding === 1 && (alphabet.indexOf(content[content.length - 2]!) & 0x03) !== 0)
	)
		fail("INVALID_FRAME", "transcript image content has non-canonical padding bits", "result.content");
	const decodedBytes = (content.length / 4) * 3 - padding;
	if (decodedBytes <= 0 || decodedBytes > TRANSCRIPT_IMAGE_CHUNK_BYTES || nextOffset - offset !== decodedBytes)
		fail("INVALID_FRAME", "transcript image content does not match its offsets", "result.content");
	return x;
}
