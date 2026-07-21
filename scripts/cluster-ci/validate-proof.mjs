import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateImagePublicationManifest,
  validateProofManifest,
} from "./proof-contract.mjs";

export async function validateProofFile(path, { imagesOnly = false } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`proof artifact ${path} is not valid JSON`, { cause: error });
  }
  return imagesOnly
    ? validateImagePublicationManifest(manifest)
    : validateProofManifest(manifest);
}

function parseArguments(args) {
  const options = { imagesOnly: false };
  for (const argument of args) {
    if (argument === "--images-only") options.imagesOnly = true;
    else if (!options.path) options.path = argument;
    else throw new Error(`unexpected argument ${argument}`);
  }
  if (!options.path) throw new Error("usage: validate-proof.mjs PATH [--images-only]");
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const { path, imagesOnly } = parseArguments(process.argv.slice(2));
    await validateProofFile(path, { imagesOnly });
    console.log(`Validated ${imagesOnly ? "image publication" : "cluster proof"} artifact ${path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
