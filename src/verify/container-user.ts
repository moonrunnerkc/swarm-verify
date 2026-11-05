import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { docker } from "./sandbox.ts";

export interface AccountFiles {
  readonly passwd: string;
  readonly group: string;
}

/** A file bound read-only into every container, over the image's own at `dst`. */
export interface BoundFile {
  readonly src: string;
  readonly dst: string;
}

const listed = (text: string, id: number) =>
  text.split("\n").some((line) => line.split(":")[2] === String(id));

const appended = (text: string, entry: string) =>
  `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${entry}\n`;

/**
 * The image's account files with an entry for the uid and gid the checks run as, where they list
 * none. Checks run as the host's uid so the checkout stays the host user's; an image lists only
 * its own accounts, and a tool that looks its user up (ssh-keygen, os.userInfo, id -un) fails.
 */
export function withAccount(files: AccountFiles, uid: number, gid: number): AccountFiles {
  return {
    passwd: listed(files.passwd, uid)
      ? files.passwd
      : appended(files.passwd, `swarm-verify:x:${uid}:${gid}:swarm-verify:/tmp:/bin/sh`),
    group: listed(files.group, gid) ? files.group : appended(files.group, `swarm-verify:x:${gid}:`),
  };
}

/**
 * Writes the image's /etc/passwd and /etc/group, with the checks' account added, under `dir`,
 * and returns them as files to bind over the image's. An image whose account files cannot be
 * read gets none, and its checks run as they did without them.
 */
export async function accountFiles(
  image: string,
  dir: string,
  uid: number,
  gid: number,
): Promise<readonly BoundFile[]> {
  const read = async (path: string) => {
    const shown = await docker(
      ["run", "--rm", "--network", "none", "--entrypoint", "cat", image, path],
      120_000,
    );
    return shown.code === 0 ? shown.stdout : null;
  };
  const passwd = await read("/etc/passwd");
  const group = await read("/etc/group");
  if (passwd === null || group === null) return [];
  const files = withAccount({ passwd, group }, uid, gid);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await writeFile(join(dir, "passwd"), files.passwd, { mode: 0o644 });
  await writeFile(join(dir, "group"), files.group, { mode: 0o644 });
  return [
    { src: join(dir, "passwd"), dst: "/etc/passwd" },
    { src: join(dir, "group"), dst: "/etc/group" },
  ];
}
