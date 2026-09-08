import * as fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionFileSystem } from "../src/platform/sessionFileSystem";

export async function sessionFileSystemFixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "acode-session-"));
  const native = (uri: string) => fileURLToPath(uri);
  const host = ((uri: string) => {
    const path = native(uri);
    return {
      async exists() {
        try {
          await fs.stat(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      async readFile(encoding?: string) {
        const bytes = await fs.readFile(path);
        return encoding ? bytes.toString("utf8") : Uint8Array.from(bytes).buffer;
      },
      async writeFile(content: string | ArrayBuffer) {
        await fs.writeFile(path, typeof content === "string" ? content : new Uint8Array(content));
      },
      async createFile(name: string, content = "") {
        const target = join(path, name);
        await fs.writeFile(target, content, { flag: "wx" });
        return pathToFileURL(target).href;
      },
      async createDirectory(name: string) {
        const target = join(path, name);
        await fs.mkdir(target);
        return pathToFileURL(target).href;
      },
      async renameTo(name: string) {
        const target = join(dirname(path), name);
        await fs.rename(path, target);
        return pathToFileURL(target).href;
      },
      async delete() {
        await fs.rm(path, { recursive: true });
      },
      async stat() {
        const stat = await fs.stat(path);
        return {
          name: basename(path),
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          size: stat.size,
          modifiedDate: stat.mtimeMs,
        };
      },
      async lsDir() {
        return (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        }));
      },
    };
  }) as unknown as Acode.FS;
  const uri = pathToFileURL(join(root, "ai-agent")).href;
  const append = async (uri: string, content: string | Uint8Array) => {
    await fs.appendFile(native(uri), content);
  };
  return {
    adapter: new SessionFileSystem(uri, host, append),
    host,
    uri,
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
