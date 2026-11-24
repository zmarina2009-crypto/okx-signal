import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function createJsonStateStore(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new TypeError("A state file path is required.");
  }

  const absolutePath = path.resolve(filePath);
  let writeQueue = Promise.resolve();

  async function load(fallback = {}) {
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const value = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("The persisted state must be a JSON object.");
      }
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return structuredClone(fallback);
      throw new Error("Could not load persisted state: " + error.message, { cause: error });
    }
  }

  function save(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return Promise.reject(new TypeError("The state snapshot must be an object."));
    }

    const task = writeQueue.then(async () => {
      const directory = path.dirname(absolutePath);
      await fs.mkdir(directory, { recursive: true });

      // A unique temporary file plus a per-process queue avoids workers racing
      // over the same shared .tmp filename and replacing each other's writes.
      const tempPath = absolutePath + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(tempPath, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx" });
        await fs.rename(tempPath, absolutePath);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw new Error("Could not persist state: " + error.message, { cause: error });
      }
    });

    // Keep the queue usable after a failed write; return the original task to its caller.
    writeQueue = task.catch(() => {});
    return task;
  }

  return { load, save, filePath: absolutePath };
}
