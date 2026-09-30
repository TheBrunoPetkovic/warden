/**
 * Workspace registry -- the equivalent of Herd's "spaces".
 *
 * A workspace is a named directory that owns one agent session and one or more
 * terminals. Deliberately *not* a view over the runtime's own storage: Warden
 * creates what it owns, so the sidebar only ever shows sessions we launched.
 */
import { mkdir, readFile, writeFile, rm, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface Workspace {
  id: string;
  name: string;
  /** Absolute, symlink-resolved path. */
  path: string;
  createdAt: number;
  /** Agent session bound to this workspace, once started. */
  sessionId?: string;
}

const DATA_DIR = join(homedir(), ".warden");
const STORE = join(DATA_DIR, "workspaces.json");

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ws";

/**
 * Workspace names become directory names, so a traversal attempt here would
 * mean writing outside the sandbox root. Reject rather than sanitise silently.
 */
function assertSafeName(name: string) {
  const n = name.trim();
  if (!n) throw new HttpError(400, "workspace name is required");
  if (n.length > 60) throw new HttpError(400, "workspace name too long (max 60)");
  if (!/^[\w][\w .-]*$/.test(n)) {
    throw new HttpError(400, "letters, digits, space, dot, dash and underscore only");
  }
  if (n === "." || n === ".." || n.startsWith(".")) {
    throw new HttpError(400, "name cannot start with a dot");
  }
  return n;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class WorkspaceStore {
  private cache: Workspace[] | null = null;
  private writing: Promise<void> = Promise.resolve();

  private async load(): Promise<Workspace[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(STORE, "utf8");
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  /** Serialised so two concurrent requests can't clobber the file. */
  private async persist() {
    const snapshot = this.cache ?? [];
    this.writing = this.writing.then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(STORE, JSON.stringify(snapshot, null, 2));
    });
    return this.writing;
  }

  async list(): Promise<Workspace[]> {
    return [...(await this.load())].sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string) {
    return (await this.load()).find(w => w.id === id) ?? null;
  }

  /**
   * Whether the directory behind a record is still there.
   *
   * The registry is a JSON file and the directories live outside it, so the two
   * drift: cleaning out ~/.warden, a test removing its own sandbox, or an
   * unmounted volume all leave records pointing at nothing. Nothing reconciles
   * them, so every route that touches a workspace has to ask before it assumes
   * the path is real -- otherwise a missing directory surfaces as a 500 from
   * deep inside node-pty, which reads like a bug in the PTY pool.
   *
   * Deliberately not self-healing. A path that is briefly unreachable (a
   * network volume, a not-yet-mounted disk) is the same shape as one that is
   * gone, and silently deleting registry entries on read would turn a mount
   * delay into data loss. The record stays; the UI shows it as broken and the
   * user deletes it.
   */
  missing(ws: Workspace) {
    return !existsSync(ws.path);
  }

  /**
   * Creates the directory if missing, then records the workspace. A custom
   * path is allowed only if it already exists -- creating a tree at an
   * arbitrary absolute location is how you end up with ~/a/b/c surprises.
   */
  async create(name: string, path?: string): Promise<Workspace> {
    const clean = assertSafeName(name);
    const all = await this.load();

    const dir = path
      ? resolve(path)
      : join(DATA_DIR, "workspaces", `${slug(clean)}`);

    if (path && !isAbsolute(path)) throw new HttpError(400, "path must be absolute");

    if (!existsSync(dir)) {
      if (path) throw new HttpError(400, `path does not exist: ${dir}`);
      await mkdir(dir, { recursive: true });
    }
    const st = await stat(dir);
    if (!st.isDirectory()) throw new HttpError(400, `not a directory: ${dir}`);

    const real = await realpath(dir);
    if (all.some(w => w.path === real)) {
      throw new HttpError(409, `workspace already exists for ${real}`);
    }

    const ws: Workspace = {
      id: randomUUID().slice(0, 8),
      name: clean,
      path: real,
      createdAt: Date.now(),
    };
    all.push(ws);
    await this.persist();
    return ws;
  }

  async update(id: string, patch: Partial<Pick<Workspace, "name" | "sessionId">>) {
    const ws = await this.get(id);
    if (!ws) throw new HttpError(404, "workspace not found");
    if (patch.name) ws.name = assertSafeName(patch.name);
    if (patch.sessionId !== undefined) ws.sessionId = patch.sessionId;
    await this.persist();
    return ws;
  }

    /**
     * Removes the registry entry. The directory itself is only deleted when it
     * lives under Warden's own sandbox root -- pointing this at ~/Projects would
     * otherwise make a stray click in the UI destructive.
     *
     * `force` matters here: this is also how a record whose directory was
     * removed out of band gets purged, and that rm has nothing left to remove.
     */

  async remove(id: string, opts: { deleteFiles?: boolean } = {}) {
    const all = await this.load();
    const i = all.findIndex(w => w.id === id);
    if (i === -1) throw new HttpError(404, "workspace not found");
    const [ws] = all.splice(i, 1);
    await this.persist();

    const sandboxRoot = join(DATA_DIR, "workspaces");
    const owned = ws.path === sandboxRoot || ws.path.startsWith(sandboxRoot + sep);
    if (opts.deleteFiles && owned) await rm(ws.path, { recursive: true, force: true });
    return { workspace: ws, filesDeleted: Boolean(opts.deleteFiles && owned) };
  }
}

export const DEFAULT_TERM = process.env.WARDEN_SHELL || process.env.SHELL || "/bin/zsh";
