#!/usr/bin/env node
// Synthetic values in credential shapes, for CI fixtures. Built from pieces so the repository
// itself holds no credential-shaped string; none is a real credential.
const join = (...parts) => parts.join("");
const body = Buffer.from("synthetic key body, not a key").toString("base64");
process.stdout.write(
  `${JSON.stringify({
    github: join("gh", "p_", "Zq9xW2vK7m".repeat(4)),
    aws: join("AK", "IA", "7".repeat(8), "QWERTYUI"),
    password: "correct-horse-battery-staple",
    privateKey: join(
      "-----BEGIN OPENSSH ",
      "PRIVATE KEY-----\n",
      body,
      "\n-----END OPENSSH ",
      "PRIVATE KEY-----",
    ),
  })}\n`,
);
