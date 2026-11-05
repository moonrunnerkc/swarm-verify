import { describe, expect, it } from "vitest";
import { withAccount } from "./container-user.ts";

const image = {
  passwd: "root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n",
  group: "root:x:0:\nnode:x:1000:\n",
};

describe("the checks' account in the image's files", () => {
  it("adds the uid and gid the image does not list", () => {
    const files = withAccount(image, 501, 20);
    expect(files.passwd).toBe(`${image.passwd}swarm-verify:x:501:20:swarm-verify:/tmp:/bin/sh\n`);
    expect(files.group).toBe(`${image.group}swarm-verify:x:20:\n`);
  });

  it("leaves an image that already lists them unchanged", () => {
    expect(withAccount(image, 1000, 1000)).toEqual(image);
    expect(withAccount(image, 0, 0)).toEqual(image);
  });

  it("adds a line break before the entry when the file ends without one", () => {
    const files = withAccount({ passwd: "root:x:0:0::/root:/bin/sh", group: "" }, 501, 20);
    expect(files.passwd.split("\n")).toEqual([
      "root:x:0:0::/root:/bin/sh",
      "swarm-verify:x:501:20:swarm-verify:/tmp:/bin/sh",
      "",
    ]);
    expect(files.group).toBe("swarm-verify:x:20:\n");
  });

  it("matches the id field, not an id that appears elsewhere in a line", () => {
    const files = withAccount({ passwd: "svc:x:5011:501::/srv:/bin/sh\n", group: "" }, 501, 20);
    expect(files.passwd).toContain("swarm-verify:x:501:20:");
  });
});
